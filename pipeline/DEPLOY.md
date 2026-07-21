# Deploying the Firezard weekly digest (unattended cadence)

Status as of **2026-07-21 (FIR-28 verification)**: the pipeline runs end-to-end
against live sources and produces a real digest; the email send path is verified
against a real SMTP server. What is **not** yet done is hosting it so it runs on
its own weekly cadence. That last step needs an account holder — the actions
below cannot be performed by an agent (repo creation and secrets are outside the
sandbox).

The GitHub Actions workflow is already committed at
`.github/workflows/weekly-digest.yml`. Once the two account-holder steps below
are done, the pipeline runs every Monday morning with nothing to trigger.

## One-time account-holder steps

1. **Create a GitHub repo** (private is fine) and push this `pipeline/`
   directory to it so the repo root contains `pipeline/`. From the parent of
   this folder:

   ```bash
   cd ..                       # to the dir that contains pipeline/
   git init
   git add pipeline
   git commit -m "Firezard pilot digest pipeline"
   git branch -M main
   git remote add origin git@github.com:<org>/<repo>.git
   git push -u origin main
   ```

   `node_modules/` is gitignored and restored by `npm ci` in CI. The de-dupe
   state (`data/seen_all.json`), run log, and `output/` **are** committed — the
   workflow commits the updated state back after each run so items aren't
   re-sent (see `.gitignore` note).

2. **Add repo secrets** (Settings → Secrets and variables → Actions):

   | Secret | Required? | Purpose |
   |---|---|---|
   | `SMTP_HOST` | yes | SMTP server hostname |
   | `SMTP_PORT` | yes | usually `587` (or `465` for implicit TLS) |
   | `SMTP_USER` | yes | SMTP auth user / from-address |
   | `SMTP_PASS` | yes | SMTP auth password / app password |
   | `DIGEST_FROM` | recommended | e.g. `Firezard Digest <digest@firezard.cz>` |
   | `ANTHROPIC_API_KEY` | optional | enables AI summarization; absent = extractive fallback |

3. **Add pilot contacts** to `lib/contacts.js` once FIR-26 recruiting confirms
   them. Until then the scheduled run still executes and writes the digest to
   `output/` — it just has no one to email (logged as "No pilot contacts yet").

## Verify after deploy

- Trigger the workflow manually: repo → **Actions** → *Weekly Firezard digest* →
  **Run workflow**. Confirm it completes green and (if contacts + SMTP are set)
  that a digest email arrives.
- The scheduled cron is `30 5 * * 1` (Mon 07:30 CEST / 06:30 CET). Do not add a
  second cron for DST — it would double-send.

## What "unattended" requires (summary)

| Requirement | State |
|---|---|
| Pipeline runs end-to-end, real digest | ✅ verified live (FIR-28) |
| Email send path works | ✅ verified against real SMTP (FIR-28) |
| Runs on its own schedule | ⛔ needs steps 1–2 above (account holder) |
| Actually emails pilot users | ⛔ needs SMTP secrets **and** contacts (step 2 + 3) |
| AI-quality summaries | ⚠️ optional `ANTHROPIC_API_KEY`; extractive otherwise |
