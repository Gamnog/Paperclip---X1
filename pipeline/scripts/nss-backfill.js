#!/usr/bin/env node
// One-time NSS Sbírka backfill / history seeding (FIR-25).
//
// Why this exists: the weekly digest only scans the newest `maxPages` of the
// NSS Sbírka archive (config.maxPages, default 5 ≈ 50 newest decisions), which
// for an administrative court rarely contains an insolvency-relevant ruling —
// so NSS surfaced nothing and the seen-store had zero nss-sbirka entries. The
// full-archive backfill walks all ~474 search pages once to find every
// insolvency-relevant decision the curated Sbírka has ever published.
//
// What it does (and deliberately does NOT do):
//   - Runs the nss-sbirka scraper in fullBackfill mode against live sources.
//   - SEEDS the matched decisions into data/seen_all.json (marks them "seen")
//     so the regular weekly digest does NOT re-dump the entire historical
//     archive as if it were "new this week". Going forward, only genuinely new
//     NSS insolvency decisions surface in the weekly digest.
//   - Writes a human-readable evidence report to output/nss_backfill_<date>.md
//     listing every decision found (date, title, link, headnote summary) — the
//     proof that the scraper works end-to-end.
//   - Does NOT summarize via the LLM and does NOT email anyone. It is a
//     controlled seeding step, safe to run in CI without touching pilot inboxes.
//
// Run: node scripts/nss-backfill.js
// In CI: dispatched manually via .github/workflows/nss-backfill.yml.

const path = require('path');
const fs = require('fs');

const { SeenStore } = require('../lib/dedupe');
const { SOURCES } = require('../sources/registry');

async function main() {
  const src = SOURCES.find((s) => s.id === 'nss-sbirka');
  if (!src) throw new Error('nss-sbirka source not found in registry');

  const mod = require(src.module);
  const seenPath = path.join(__dirname, '..', 'data', 'seen_all.json');
  const seen = new SeenStore(seenPath);

  const seenBefore = Object.keys(seen.data).filter((id) => id.startsWith('nss-sbirka-')).length;
  console.log(`[nss-backfill] starting full-archive backfill (seen before: ${seenBefore} nss-sbirka ids)`);

  const items = await mod.fetchItems({
    ...src.config,
    sourceId: src.id,
    sourceName: src.name,
    fullBackfill: true,
    seenHasId: (id) => seen.has(id),
  });

  console.log(`[nss-backfill] scraper returned ${items.length} insolvency-relevant decision(s) not already seen`);

  // Seed each into the seen-store so the weekly digest treats them as history.
  const seeded = [];
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.markSeen(item.id, { title: item.title, url: item.url, sourceId: src.id });
    seeded.push(item);
  }
  seen.save();

  // Newest-first for the report.
  seeded.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `nss_backfill_${stamp}.md`);

  const classifierMode = process.env.ANTHROPIC_API_KEY
    ? 'Claude classifier (claude-haiku-4-5-20251001) over full decision text'
    : 'OFFLINE KEYWORD FALLBACK (ANTHROPIC_API_KEY not set — relevance is only approximate; re-run with the key set)';

  let md = `# NSS Sbírka backfill — insolvency & restructuring (${stamp})\n\n`;
  md += `Source: ${src.name}\n`;
  md += `Relevance filter: ${classifierMode}\n\n`;
  md += `Found and seeded **${seeded.length}** insolvency-relevant decision(s) from the full Sbírka archive.\n`;
  md += `These are marked seen; the weekly digest will surface only NEW NSS decisions from here on.\n\n---\n\n`;
  for (const it of seeded) {
    const date = it.pubDate ? it.pubDate.slice(0, 10) : '(no date)';
    md += `### ${it.title}\n`;
    md += `**Date:** ${date} | **Link:** ${it.url}\n\n`;
    md += `${it.summary}\n\n---\n\n`;
  }
  fs.writeFileSync(outPath, md, 'utf8');

  console.log(`[nss-backfill] seeded ${seeded.length} decision(s); wrote report ${path.relative(process.cwd(), outPath)}`);
  console.log(`[nss-backfill] seen after: ${seenBefore + seeded.length} nss-sbirka ids`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[nss-backfill] ERROR:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
