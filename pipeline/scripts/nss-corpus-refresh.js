#!/usr/bin/env node
// One-time NSS Sbírka full-text corpus rebuild (FIR-37).
//
// Why this exists: the earlier FIR-25/FIR-33 backfill cached only the ~470-char
// headnote of each decision (the FIR-36 extraction bug), not the full ruling
// body. The extraction fix (FIR-36, merged to main as 2b9075d) only affects
// decisions scraped AFTER it — cached pids are never re-fetched — so the existing
// data/nss_sbirka_cache.json (4,708 decisions) is still headnote-only.
//
// This rebuilds the corpus by re-fetching the full <div class="jud"> body for
// every cached decision whose stored text predates the fix (cache schema v<2).
// Per the CEO's 2026-07-22 decision (Option A) the full body is kept in git.
//
// What it does (and deliberately does NOT do):
//   - Walks the KNOWN pids in the existing cache directly (no ~4740-page search
//     pagination) and re-fetches each detail page for the full body. This, plus
//     skipping classification, is what makes the re-crawl fast (~2h vs the
//     ~5-7h full backfill) while keeping the FIR-25 429-safe request pacing.
//   - Does NOT classify, does NOT touch the seen-store, does NOT email. The
//     seen-store is already seeded from the earlier backfill; this run only
//     replaces headnote-only bodies with full text. (A separate re-classification
//     over the now-full corpus — to recover any FIR-36 recall gap — is tracked
//     as a follow-up.)
//   - Resumable: an already-refreshed (v2) entry is skipped, the cache is flushed
//     incrementally, and a long stretch of fetch failures stops the run so it
//     commits progress; a re-run picks up where it left off.
//
// Run: node scripts/nss-corpus-refresh.js
// In CI: dispatched manually via .github/workflows/nss-corpus-refresh.yml.
// Pacing override: NSS_SBIRKA_REQUEST_DELAY_MS (default 1200ms — see FIR-25;
// lower is faster but risks the server's 429 limiter, though the run resumes).

const { refreshCorpus } = require('../sources/nss-sbirka-scrape');

async function main() {
  console.log('[nss-corpus-refresh] starting NSS Sbírka full-text corpus rebuild (FIR-37)');
  const res = await refreshCorpus({});
  console.log(`[nss-corpus-refresh] summary: ${JSON.stringify(res)}`);
  if (res.remaining > 0) {
    console.log(
      `[nss-corpus-refresh] ${res.remaining} decision(s) still stale — re-run this workflow to continue ` +
        '(resumes from the committed cache).'
    );
  } else {
    console.log('[nss-corpus-refresh] corpus is fully rebuilt: every cached decision now holds full text.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[nss-corpus-refresh] ERROR:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
