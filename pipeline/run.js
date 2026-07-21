#!/usr/bin/env node
// Firezard pilot pipeline — multi-source orchestrator (FIR-17, M1+M2)
//
// Sources:
//   M1 (active):   NS Sbírka senate 29 — full decision parser
//   M2 (active):   ÚS NALUS, insolvence.justice.cz, PSP RSS, Senát RSS, ASIS, ČNB
//   M2 (pending):  ISIR SOAP, e-Sbírka, e-Legislativa (registration needed)
//
// Usage: node pipeline/run.js
// Cadence: run weekly, Monday morning CET — see pipeline/README.md

const path = require('path');
const fs = require('fs');

const { fetchFeed, parseFeedItems } = require('./lib/fetchFeed');
const { extractDecisions } = require('./lib/extractDecisions');
const { filterNsSbirkaDecisions } = require('./lib/filter');
const { SeenStore } = require('./lib/dedupe');
const { makeSummarizer } = require('./lib/summarize');
const { buildDigestMarkdown } = require('./lib/digest');
const { recordRun } = require('./lib/monitor');
const { SOURCES } = require('./sources/registry');

const NS_SBIRKA_FEED_URL = 'https://sbirka.nsoud.cz/feed/';
const OUTPUT_DIR = path.join(__dirname, 'output');

async function runNsSbirka(seen) {
  console.log(`[ns-sbirka] fetching ${NS_SBIRKA_FEED_URL}`);
  const xml = await fetchFeed(NS_SBIRKA_FEED_URL);
  const feedItems = parseFeedItems(xml);
  const allDecisions = [];
  for (const post of feedItems) {
    allDecisions.push(...extractDecisions(post.contentEncoded, { sourceUrl: post.link }));
  }
  console.log(`[ns-sbirka] ${allDecisions.length} decisions extracted, ${feedItems.length} posts`);
  const relevant = filterNsSbirkaDecisions(allDecisions);
  console.log(`[ns-sbirka] ${relevant.length} pass senate-29 filter`);
  return relevant
    .filter((d) => {
      if (seen.has(d.caseRef)) return false;
      seen.markSeen(d.caseRef, { number: d.number, url: d.url, sourceId: 'ns-sbirka' });
      return true;
    })
    .map((d) => ({ type: 'ns-decision', decision: d, sourceId: 'ns-sbirka', sourceName: 'NS Sbírka (senate 29)' }));
}

async function runGenericSources(seen, sourceResults) {
  // Every active source except ns-sbirka (which has a bespoke parser wired in
  // main()) exposes a module with fetchItems() returning the common Item shape:
  // rss-generic for feed sources, nss-sbirka-scrape for the NSS scraper, etc.
  // Dispatch by the source's own module rather than assuming RSS.
  const activeSources = SOURCES.filter(
    (s) => s.status === 'active' && s.id !== 'ns-sbirka'
  );

  const allItems = [];
  for (const src of activeSources) {
    try {
      const mod = require(src.module);
      console.log(`[${src.id}] fetching (${path.basename(src.module)})`);
      const items = await mod.fetchItems({
        ...src.config,
        sourceId: src.id,
        sourceName: src.name,
        seenHasId: (id) => seen.has(id),
      });
      const newItems = items.filter((item) => {
        if (!item.id || seen.has(item.id)) return false;
        seen.markSeen(item.id, { title: item.title, url: item.url, sourceId: src.id });
        return true;
      });
      console.log(`[${src.id}] ${items.length} relevant, ${newItems.length} new`);
      allItems.push(...newItems.map((item) => ({ type: 'generic', item, sourceId: src.id, sourceName: src.name })));
      sourceResults.push({ sourceId: src.id, ok: true, itemCount: newItems.length });
    } catch (err) {
      console.error(`[${src.id}] ERROR: ${err.message}`);
      sourceResults.push({ sourceId: src.id, ok: false, error: err.message });
    }
  }
  return allItems;
}

async function runPendingSources() {
  const pendingSources = SOURCES.filter((s) => s.status === 'pending_registration');
  for (const src of pendingSources) {
    const mod = require(src.module);
    await mod.fetchItems({ sourceId: src.id, sourceName: src.name, ...src.config });
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const seenPath = path.join(__dirname, 'data', 'seen_all.json');
  const seen = new SeenStore(seenPath);
  const summarizer = makeSummarizer();
  console.log(`[summarize] using ${summarizer.kind} summarizer`);

  const sourceResults = [];

  // ns-sbirka runs its own parser (not the generic RSS module) and must not
  // take down the rest of the run if the site is unreachable — isolate it
  // the same way runGenericSources isolates each of its sources.
  let nsItems = [];
  try {
    nsItems = await runNsSbirka(seen);
    sourceResults.push({ sourceId: 'ns-sbirka', ok: true, itemCount: nsItems.length });
  } catch (err) {
    console.error(`[ns-sbirka] ERROR: ${err.message}`);
    sourceResults.push({ sourceId: 'ns-sbirka', ok: false, error: err.message });
  }

  const genericItems = await runGenericSources(seen, sourceResults);
  await runPendingSources();

  const summarized = [];

  for (const entry of nsItems) {
    const summary = await summarizer.summarize(entry.decision);
    summarized.push({
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      title: `${entry.decision.caseRef} — sešit ${entry.decision.number}`,
      url: entry.decision.url,
      summary,
    });
  }

  for (const entry of genericItems) {
    // No caseRef: signals summarize.js to use the generic (non-court) prompt.
    const fakeDecision = { headline: entry.item.title, legalBasis: entry.item.summary, caseRef: '', url: entry.item.url, sourceName: entry.sourceName };
    const summary = await summarizer.summarize(fakeDecision);
    summarized.push({
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      title: entry.item.title,
      url: entry.item.url,
      summary,
    });
  }

  seen.save();

  const weekLabel = new Date().toISOString().slice(0, 10);
  const markdown = buildMultiSourceDigest(summarized, { weekLabel });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `digest_${weekLabel}.md`);
  fs.writeFileSync(outPath, markdown, 'utf8');
  console.log(`[digest] wrote ${outPath} (${summarized.length} item(s) from ${new Set(summarized.map(i => i.sourceId)).size} source(s))`);

  recordRun({ startedAt, sourceResults, itemCount: summarized.length, outPath });
  const failedSources = sourceResults.filter((s) => !s.ok);
  if (failedSources.length > 0) {
    console.warn(`[monitor] ${failedSources.length}/${sourceResults.length} source(s) failed this run: ${failedSources.map(s => s.sourceId).join(', ')}`);
  }

  return { nsItems, genericItems, summarized, outPath, sourceResults };
}

function buildMultiSourceDigest(items, { weekLabel } = {}) {
  const header = `# Firezard Legal Digest — Insolvency & Restructuring${weekLabel ? ` (${weekLabel})` : ''}\n`;
  if (items.length === 0) {
    return header + '\nNo new relevant items this period.\n';
  }
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.sourceName]) grouped[item.sourceName] = [];
    grouped[item.sourceName].push(item);
  }
  let body = '';
  for (const [sourceName, sourceItems] of Object.entries(grouped)) {
    body += `\n## ${sourceName}\n\n`;
    for (const item of sourceItems) {
      body += `### ${item.title}\n`;
      body += `**Source:** ${item.sourceName} | **Link:** ${item.url}\n\n`;
      body += item.summary + '\n\n---\n\n';
    }
  }
  return header + body;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[error]', err);
    process.exitCode = 1;
  });
}

module.exports = { main };
