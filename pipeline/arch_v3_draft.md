# Pilot MVP Pipeline — Architecture & Build Plan (FIR-17)
**Date:** 2026-07-21
**Status:** M1, M2, M3 complete and verified. Pipeline is functionally end-to-end. M4 (hardening + hosting) tracked in FIR-23.

**Inputs this depends on:**
- Cleared source list & scope rules — FIR-16 (`compliance-review` doc): 21 sources cleared as-is, ISIR restricted to corporate proceedings only, epravo.cz/profipravo.cz restricted to free content only.
- Full source catalog with access methods — FIR-14 (`CZ_Legal_Source_Catalog_v1.md`).
- Pilot scope & digest spec — FIR-13 (specialization, cadence: weekly Monday 07:30 CET).

## 1. Pipeline stages

1. **Ingest** — per-source fetcher polling on each source's confirmed cadence. Tier A sources (10) active or stubbed; Tier B/C deferred to M4.
2. **Filter** — hard compliance gates at ingestion: ISIR corporate-only (stub pending registration), epravo.cz/profipravo.cz public content only, senate-29 relevance filter for NS Sbírka, keyword + recency filter for RSS sources.
3. **De-dupe / new-item detection** — `data/seen_all.json` keyed by case ref / URL. Confirmed working: 0 items on re-run.
4. **AI summarize** — extractive fallback active; Anthropic summarizer activates automatically when `ANTHROPIC_API_KEY` env var is set. No code change needed.
5. **Assemble digest** — multi-source markdown digest grouped by source. Per-contact personalization hooks in `lib/contacts.js` (sub-focus field); v1 adds name/firm header; full content filtering in next iteration.
6. **Deliver** — `lib/emailDelivery.js` (nodemailer). `scheduler.js` runs every Monday 07:30 CET.

## 2. Build milestones & status

- **M1 — NS Sbírka (senate 29) vertical slice — DONE.** Live ingest, decision parser, senate-29 filter, de-dupe, summarize, markdown digest. Verified 2026-07-21.
- **M2 — Tier A source fetchers (6 live, 3 pending) — DONE (FIR-21 closed).** Live: ÚS NALUS, insolvence.justice.cz, PSP RSS, Senát RSS, ASIS, ČNB. Pending: ISIR SOAP (endpoint URL needed from technickapodpora.isir@msp.justice.cz), e-Sbírka (MV registration), e-Legislativa (MV registration). All source stubs print clear registration instructions on run.
- **M3 — Digest assembly + email delivery + weekly scheduler — DONE (FIR-22 closed).** `scheduler.js` next fire: Monday 2026-07-27 07:30 CET. Contacts file ready for FIR-15 entries. Email delivery requires SMTP credentials in deployment env.
- **M4 — Tier B/C sources + hardening + hosting — FIR-23, mostly done.**
  Done: error handling/retry (`lib/retry.js`, wired into every network
  fetcher), per-source failure isolation (one source failing doesn't kill
  the run), basic run monitoring (`lib/monitor.js` → `data/run_log.json`),
  epravo.cz added as a live Tier B source, and the hosting decision has a
  concrete recommendation (see README "Hosting decision" and
  `.github-workflow-draft-weekly-digest.yml`). Still open: 7 Tier B/C
  sources (profipravo.cz, NSS, zakonyprolidi.cz, EUR-Lex, Hlídač státu, ČAK,
  msp.gov.cz) are stubbed pending a confirmed feed/API URL — each has a
  documented next step in `sources/registry.js`; and actually standing up
  the recommended GitHub Actions hosting requires a repo + secrets decision
  from the CEO, which this pipeline can't self-provision.

## 3. What's needed to start sending digests

1. **SMTP credentials** — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, DIGEST_FROM (owner: CEO/tech team)
2. **Pilot contacts** — add to `pipeline/lib/contacts.js` when FIR-15 recruits them
3. **Hosting** — where `node scheduler.js` runs persistently (cloud run job, VM, etc.) — open decision
4. **ANTHROPIC_API_KEY** — optional but recommended; enables AI summarization vs. extractive fallback

## 4. Code structure (`pipeline/` in project workspace)

```
run.js              — orchestrator (M1+M2 sources)
scheduler.js        — weekly cadence + email delivery (M3)
package.json        — dependencies (nodemailer)
lib/
  fetchFeed.js      — RSS/Atom fetcher (generic)
  extractDecisions.js — NS Sbírka decision parser
  filter.js         — senate-29 relevance filter
  dedupe.js         — JSON-file seen-store
  summarize.js      — extractive + Anthropic summarizer
  digest.js         — M1 single-source digest builder (legacy, superseded by run.js)
  contacts.js       — pilot contact registry (empty until FIR-15)
  emailDelivery.js  — nodemailer delivery wrapper
sources/
  registry.js       — source definitions + config
  rss-generic.js    — handles all RSS/Atom feeds with keyword + date filter
  isir-soap.js      — stub (pending endpoint URL registration)
  esbirka.js        — stub (pending MV API registration)
  elegislativa.js   — stub (pending MV API registration)
data/
  seen_all.json     — de-dupe state (all sources)
  seen_ns_sbirka.json — M1 legacy de-dupe (NS Sbírka)
output/
  digest_*.md       — generated weekly digests
```
