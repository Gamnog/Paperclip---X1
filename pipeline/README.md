# Firezard pilot pipeline (FIR-17 / FIR-21 / FIR-22 / FIR-23)

Monitoring → AI-summarization → digest pipeline for Czech insolvency &
restructuring legal sources, per the `pipeline-architecture` doc on FIR-17.

## What it does

`node run.js` runs one pass across all active sources (10 live Tier A/B/C RSS
sources + the specialized NS Sbírka parser; 8 more pending either external
API registration or manual feed-URL verification — see `sources/registry.js`):

1. **Ingest** — per-source fetcher (RSS/generic or NS Sbírka's own parser),
   each with automatic retry (`lib/retry.js`: 3 attempts, 1s backoff) and
   failure isolation — one source failing does not stop the others or kill
   the run (FIR-23).
2. **Parse** — NS Sbírka: extracts individual decisions (case ref, headline,
   official court headnote "právní věta") from "sešit" issue announcements.
   Other sources: standard RSS/Atom items.
3. **Filter** — NS Sbírka: senate 29 only (`29 ICdo`/`29 NSČR`/`29 Cdo` —
   insolvency senate). Other sources: keyword match against the FIR-13
   specialization (creditor disputes, odpůrčí žaloby, reorganization,
   distressed M&A); ISIR will need the corporate-proceedings-only filter
   from FIR-16 §3 once its SOAP endpoint is registered.
4. **De-dupe** — `data/seen_all.json`, keyed per source; only unseen items
   proceed.
5. **Summarize** — pluggable (`lib/summarize.js`): uses Anthropic's API if
   `ANTHROPIC_API_KEY` is set, otherwise extractive fallback (no external
   calls needed to prove the pipeline end-to-end).
6. **Digest** — writes `output/digest_<date>.md`, grouped by source.
7. **Deliver** (`scheduler.js`) — weekly Monday 07:30 CET run, emails each
   confirmed pilot contact (`lib/contacts.js`, empty until FIR-15 lands) via
   `lib/emailDelivery.js` (nodemailer + SMTP_* env vars); falls back to
   file-only output when there are no contacts yet.
8. **Monitor** (`lib/monitor.js`) — every run appends a record to
   `data/run_log.json` (which sources succeeded/failed, item counts, digest
   path) so "did this week's run work" is answerable without reading logs.

## What's still open

- **M4 (FIR-23) — done, per CEO disposition 2026-07-21.** Retry/error
  isolation, basic run monitoring, and Tier B/C source coverage are shipped.
  10 sources active: the FIR-17/21 batch plus `epravo.cz`,
  `advokatnidenik.cz`, and `profipravo.cz` (obchodněprávní shrnutí feed,
  all verified live 2026-07-21).
- **Hosting — GitHub Actions workflow now committed & deploy-ready (FIR-28).**
  The draft was promoted to the active path at
  `.github/workflows/weekly-digest.yml`; **see `DEPLOY.md`** for the two
  account-holder steps that turn it on (create a GitHub repo + push, add SMTP/
  `ANTHROPIC_API_KEY` secrets). Until those are done it runs manually via
  `scheduler.js --once` (scheduled-run mode) or `node scheduler.js` (persistent
  loop). It is **not yet running unattended** — that needs the repo + secrets.
- **zakonyprolidi.cz + nssoud.cz — spun out to a follow-up ticket assigned
  to the CEO** (feed URLs need a human browser session / judgment call that
  an agent can't self-provision). See the FIR-23 child issue.
- **EUR-Lex, Hlídač státu — skipped for the pilot** (CEO decision
  2026-07-21): registering external accounts wasn't worth the setup time
  right now. See `sources/registry.js` notes for the revisit condition.
- **Other pending source registrations** — ISIR SOAP (email
  technickapodpora.isir@msp.justice.cz for the endpoint), e-Sbírka and
  e-Legislativa (Ministry of Interior API registration), msp.gov.cz (low
  priority, likely redundant with insolvence.justice.cz). See
  `sources/registry.js` `pending_registration` entries.
- **Real AI summarization** needs `ANTHROPIC_API_KEY` provisioned wherever
  this ends up hosted — swap-in is automatic once the key is present.
- **Pilot contacts** (FIR-15) — `lib/contacts.js` is empty; the scheduler
  writes digests to file only until contacts are confirmed.

## Files

- `run.js` — orchestrator / CLI entry point.
- `scheduler.js` — weekly cadence + email delivery loop (M3).
- `lib/fetchFeed.js` — NS Sbírka RSS fetch + parse (retries via `lib/retry.js`).
- `lib/extractDecisions.js` — sešit HTML → individual decision records.
- `lib/filter.js` — senate-29 relevance filter.
- `lib/dedupe.js` — JSON-file seen-store.
- `lib/summarize.js` — extractive / Anthropic summarizer.
- `lib/digest.js` — markdown digest assembly.
- `lib/emailDelivery.js` — nodemailer SMTP delivery.
- `lib/contacts.js` — pilot contact registry (populated by FIR-15).
- `lib/retry.js` — shared fetch retry helper (M4/FIR-23).
- `lib/monitor.js` — per-run success/failure log (M4/FIR-23).
- `sources/registry.js` — source list + status (active/pending_registration).
- `sources/rss-generic.js`, `sources/isir-soap.js`, `sources/esbirka.js`,
  `sources/elegislativa.js` — per-source fetchers.
- `sources/pendingStub.js` — shared stub for Tier B/C sources without a
  confirmed live feed/API yet; prints the documented next step per source
  instead of guessing at an unverified URL.
- `data/seen_all.json` — de-dupe state.
- `data/run_log.json` — run monitoring log (last 100 runs).
- `output/digest_*.md` — generated digests.
- `.github/workflows/weekly-digest.yml` — active hosting workflow (FIR-28);
  runs once repo + secrets exist. See `DEPLOY.md`.
- `DEPLOY.md` — turnkey deploy steps for unattended weekly runs.
- `.gitignore` — keeps `node_modules/` out; **keeps** de-dupe state in.
