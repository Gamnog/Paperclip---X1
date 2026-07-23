#!/usr/bin/env node
// One-time NSS Sbírka full-text RE-CLASSIFICATION (FIR-38).
//
// Why this exists: the FIR-25/FIR-33 backfill classified every decision over the
// FIR-36 headnote-only body (~470 chars). The FIR-33 premise is that insolvency
// relevance can live in the ruling BODY, not just the headnote — so that seed
// classification almost certainly REJECTED body-relevant decisions that were
// never seeded into data/seen_all.json and never surfaced. FIR-37 rebuilt the
// corpus with full v2 bodies (data/nss_sbirka_cache/shard-NNN.json); this closes
// the recall gap by re-running the classifier over the full body of every
// cached-but-not-yet-seen decision and SEEDING any that now qualify.
//
// What it does (and deliberately does NOT do):
//   - Reads the committed full-text cache — NO NSS network fetches — so it is
//     fast, cheap, resumable, and carries zero 429 risk (crawl = network-bound;
//     this = API-bound against Anthropic Haiku).
//   - Classifies each candidate's FULL body via lib/classify.js and SEEDS the
//     newly-relevant ones into data/seen_all.json (marks them seen; does NOT
//     email — default seed-only per the FIR-38 product note).
//   - Records every classified pid in data/nss_reclassify_ledger.json so a
//     re-run never re-pays: a pid already in the ledger at the current corpus
//     version, or already seen, is skipped.
//   - Writes a human-readable evidence report to output/nss_reclassify_<date>.md
//     listing every newly-qualified decision (date, title, link, snippet).
//
// SEED vs SURFACE: newly-found historical decisions are SEEDED only (safe). If
// the CEO decides any should also be SURFACED in a pilot digest, that is a
// separate follow-up — this script never emails.
//
// Depends on: FIR-37 corpus refresh completing (v2 full bodies). Stale (v<2)
// entries are skipped and reported so the operator finishes the refresh first.
//
// Run: node scripts/nss-reclassify.js   (needs ANTHROPIC_API_KEY for real recall;
// without it, classify.js falls back to the offline keyword heuristic — useless
// for this pass, so the script refuses unless FIR38_ALLOW_FALLBACK=1).
// In CI: dispatched manually via .github/workflows/nss-reclassify.yml.

const path = require('path');
const fs = require('fs');

const { SeenStore } = require('../lib/dedupe');
const { SOURCES } = require('../sources/registry');
const { reclassifyCorpus } = require('../sources/nss-sbirka-scrape');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'nss_reclassify_ledger.json');

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LEDGER_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1), 'utf8');
  fs.renameSync(tmp, LEDGER_PATH);
}

async function main() {
  const src = SOURCES.find((s) => s.id === 'nss-sbirka');
  if (!src) throw new Error('nss-sbirka source not found in registry');

  // Guard: without the key, classify.js silently uses the offline keyword
  // fallback, which cannot recover the body-relevance recall gap this pass
  // exists for. Refuse rather than seed garbage — unless explicitly allowed.
  if (!process.env.ANTHROPIC_API_KEY && process.env.FIR38_ALLOW_FALLBACK !== '1') {
    throw new Error(
      'ANTHROPIC_API_KEY not set — reclassification would fall back to the offline ' +
        'keyword heuristic and defeat the point of FIR-38. Set the key (recommended) ' +
        'or FIR38_ALLOW_FALLBACK=1 to run the keyword fallback deliberately.'
    );
  }

  const seenPath = path.join(DATA_DIR, 'seen_all.json');
  const seen = new SeenStore(seenPath);
  const ledger = loadLedger();

  const nssSeenBefore = Object.keys(seen.data).filter((id) => id.startsWith('nss-sbirka-')).length;
  const ledgerBefore = Object.keys(ledger).length;
  console.log(
    `[nss-reclassify] starting (seen before: ${nssSeenBefore} nss-sbirka ids; ledger: ${ledgerBefore} classified)`
  );

  const persist = () => {
    saveLedger(ledger);
    seen.save();
  };

  const res = await reclassifyCorpus({
    classifier: undefined, // default makeClassifier (Haiku when key set)
    keywords: (src.config && src.config.keywords) || [],
    seen,
    ledger,
    persist,
  });
  persist(); // final flush

  // Build the evidence report from the SEEN-STORE (via marker), not just this
  // run's return, so a resumed run still produces a complete report.
  const seeded = Object.entries(seen.data)
    .filter(([, meta]) => meta && meta.via === 'fir38-reclassify')
    .map(([id, meta]) => ({ id, ...meta }))
    .sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `nss_reclassify_${stamp}.md`);

  const classifierMode = process.env.ANTHROPIC_API_KEY
    ? 'Claude classifier (claude-haiku-4-5-20251001) over FULL decision body'
    : 'OFFLINE KEYWORD FALLBACK (ANTHROPIC_API_KEY not set — results are only approximate)';

  let md = `# NSS Sbírka re-classification — recall-gap recovery (FIR-38, ${stamp})\n\n`;
  md += `Source: ${src.name}\n`;
  md += `Relevance filter: ${classifierMode}\n\n`;
  md += `Re-classified over the FIR-37 full-text corpus. This run: ${res.classified} classified, `;
  md += `${res.newlyRelevant.length} newly relevant. `;
  md += `Candidates left for a re-run: ${res.remaining}. `;
  md += `Headnote-only (stale) entries skipped: ${res.staleCount}.\n\n`;
  md += `**${seeded.length}** historical decision(s) total have been recovered and SEEDED by this pass `;
  md += `(marked seen, NOT emailed). Whether any should also be surfaced in a pilot digest is an open CEO product call.\n\n---\n\n`;
  for (const it of seeded) {
    const date = it.pubDate ? String(it.pubDate).slice(0, 10) : '(no date)';
    md += `### ${it.title || it.id}\n`;
    md += `**Date:** ${date} | **Link:** ${it.url || '(no url)'}\n\n`;
    if (it.reason) md += `_${it.reason}_\n\n`;
    md += `---\n\n`;
  }
  fs.writeFileSync(outPath, md, 'utf8');

  const nssSeenAfter = Object.keys(seen.data).filter((id) => id.startsWith('nss-sbirka-')).length;
  console.log(`[nss-reclassify] summary: ${JSON.stringify(res)}`);
  console.log(`[nss-reclassify] seeded ${seeded.length} total via reclassify; wrote report ${path.relative(process.cwd(), outPath)}`);
  console.log(`[nss-reclassify] nss-sbirka seen: ${nssSeenBefore} -> ${nssSeenAfter}`);
  if (res.remaining > 0) {
    console.log(`[nss-reclassify] ${res.remaining} candidate(s) still unclassified — re-run to continue (resumes from the committed ledger).`);
  } else {
    console.log('[nss-reclassify] every candidate classified: recall-gap recovery complete.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[nss-reclassify] ERROR:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
