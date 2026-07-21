#!/usr/bin/env node
// Firezard pilot pipeline — weekly cadence scheduler (M3, FIR-17).
//
// Cadence: every Monday at 07:30 CET (05:30 UTC in winter, 06:30 UTC in summer).
// FIR-13 spec: "Weekly, fixed day (proposed: Monday morning CET)".
//
// Usage: node pipeline/scheduler.js
// Run this as a long-lived process (e.g. via PM2, systemd, or a cloud run job).
//
// Uses Node.js built-in setInterval + next-fire calculation rather than cron or
// node-cron, so there are zero runtime dependencies beyond nodemailer.
//
// Environment variables (set in deployment):
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / DIGEST_FROM  — email delivery
//   ANTHROPIC_API_KEY  — enables AI summarization (optional; falls back to extractive)
//   DIGEST_DRY_RUN=true  — print email to stdout instead of sending (testing)
//   PIPELINE_TIMEZONE_OFFSET_HOURS  — UTC offset in hours for "Monday 07:30" (default: 2 for CET/CEST summer)

const { main: runPipeline } = require('./run.js');
const { CONTACTS } = require('./lib/contacts.js');
const { sendDigest } = require('./lib/emailDelivery.js');
const path = require('path');
const fs = require('fs');

const TARGET_DAY = 1;    // Monday
const TARGET_HOUR = 7;   // 07:30 local
const TARGET_MINUTE = 30;
const TZ_OFFSET = parseInt(process.env.PIPELINE_TIMEZONE_OFFSET_HOURS || '2', 10);

function nextFire() {
  const now = new Date();
  // Convert to target tz
  const localNow = new Date(now.getTime() + TZ_OFFSET * 3600 * 1000);
  const day = localNow.getUTCDay();
  const hour = localNow.getUTCHours();
  const minute = localNow.getUTCMinutes();

  let daysUntil = (TARGET_DAY - day + 7) % 7;
  if (daysUntil === 0 && (hour > TARGET_HOUR || (hour === TARGET_HOUR && minute >= TARGET_MINUTE))) {
    daysUntil = 7;
  }

  const fire = new Date(localNow);
  fire.setUTCDate(localNow.getUTCDate() + daysUntil);
  fire.setUTCHours(TARGET_HOUR, TARGET_MINUTE, 0, 0);
  // Convert back to UTC
  return new Date(fire.getTime() - TZ_OFFSET * 3600 * 1000);
}

async function runAndDeliver() {
  console.log(`[scheduler] ${new Date().toISOString()} — starting weekly pipeline run`);
  const result = await runPipeline();

  const digestPath = result.outPath;
  const digestMarkdown = fs.readFileSync(digestPath, 'utf8');
  const weekLabel = new Date().toISOString().slice(0, 10);
  const subject = `Firezard Legal Digest — insolvence & restrukturalizace (${weekLabel})`;

  if (CONTACTS.length === 0) {
    console.log('[scheduler] No pilot contacts yet (FIR-15 pending). Digest written to file only.');
    console.log(`[scheduler] Digest: ${digestPath}`);
    return;
  }

  for (const contact of CONTACTS) {
    const personalizedBody = personalizeDigest(digestMarkdown, contact);
    console.log(`[scheduler] delivering to ${contact.name} <${contact.email}>`);
    try {
      await sendDigest({
        to: contact.email,
        name: contact.name,
        subject,
        markdownBody: personalizedBody,
      });
      console.log(`[scheduler] sent to ${contact.email}`);
    } catch (err) {
      console.error(`[scheduler] ERROR delivering to ${contact.email}: ${err.message}`);
    }
  }
}

function personalizeDigest(markdown, contact) {
  if (!contact.subFocus || contact.subFocus === 'all') return markdown;
  // v1 personalization: no content filtering yet — add contact's name to header.
  // Full sub-focus filtering will be added in M3 once contacts confirm their preferences.
  return markdown.replace(
    /^(# Firezard Legal Digest.+)/m,
    `$1\n_Pro: ${contact.name}, ${contact.firm}_`
  );
}

function scheduleNext() {
  const fire = nextFire();
  const msUntil = fire.getTime() - Date.now();
  console.log(`[scheduler] next run scheduled for ${fire.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(async () => {
    try {
      await runAndDeliver();
    } catch (err) {
      console.error('[scheduler] pipeline run failed:', err);
    }
    scheduleNext();
  }, msUntil);
}

if (require.main === module) {
  if (process.argv.includes('--once')) {
    // Run-and-exit mode for external schedulers (cron, GitHub Actions, cloud
    // scheduled jobs) that already handle the "when" — avoids paying for a
    // persistent process for a once-a-week job. See FIR-23 hosting decision.
    console.log('[scheduler] --once: running a single pass and exiting.');
    runAndDeliver()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[scheduler] pipeline run failed:', err);
        process.exit(1);
      });
  } else {
    console.log('[scheduler] Firezard pilot digest scheduler starting.');
    console.log(`[scheduler] Cadence: every Monday at ${TARGET_HOUR}:${String(TARGET_MINUTE).padStart(2,'0')} CET`);
    console.log(`[scheduler] Contacts: ${CONTACTS.length} (add confirmed contacts to lib/contacts.js when FIR-15 completes)`);
    scheduleNext();
  }
}

module.exports = { runAndDeliver, personalizeDigest, nextFire };
