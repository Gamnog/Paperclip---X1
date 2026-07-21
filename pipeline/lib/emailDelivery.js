// Email delivery for the weekly digest (M3).
// Uses nodemailer with SMTP credentials from environment variables.
//
// Required env vars:
//   SMTP_HOST     — SMTP server hostname
//   SMTP_PORT     — SMTP port (default 587)
//   SMTP_USER     — SMTP auth username / address
//   SMTP_PASS     — SMTP auth password
//   DIGEST_FROM   — "From" display address (e.g. "Firezard Digest <digest@firezard.cz>")
//
// Set these in the deployment environment (not committed to source).
// For local dev/testing: set DIGEST_DRY_RUN=true to print email to stdout without sending.

const nodemailer = require('nodemailer');

function markdownToHtml(markdown) {
  // Minimal MD → HTML: headings, bold, horizontal rules, links, paragraphs.
  // Keeps it readable without pulling in a full renderer.
  return markdown
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#2c3e50;border-bottom:1px solid #eee;padding-bottom:4px">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#34495e">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#2980b9">$1</a>')
    .replace(/\n\n/g, '</p><p style="margin:8px 0 0">')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#222;max-width:700px;margin:0 auto">')
    .replace(/$/, '</p>');
}

function wrapHtmlEmail(bodyHtml, subject) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="background:#f4f4f4;padding:24px">
<div style="background:#fff;border-radius:6px;padding:32px;max-width:720px;margin:0 auto;font-family:Georgia,serif">
${bodyHtml}
<hr style="border:none;border-top:1px solid #eee;margin-top:32px">
<p style="font-size:12px;color:#999;font-family:sans-serif">
  Firezard Legal Digest — pilot. Tuto zprávu dostáváte jako účastník pilotního programu monitoringu insolvencního a restrukturalizacního práva.
  Pro odhlásení nebo úpravu preferencí kontaktujte odesílatele.<br>
  This digest contains AI-assisted summaries for informational purposes; not legal advice.
</p>
</div>
</body>
</html>`;
}

function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendDigest({ to, name, subject, markdownBody }) {
  if (process.env.DIGEST_DRY_RUN === 'true') {
    console.log(`[email:dry-run] To: ${name} <${to}>\nSubject: ${subject}\n---\n${markdownBody.slice(0, 800)}\n...`);
    return { dryRun: true };
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Email delivery requires SMTP_HOST, SMTP_USER, SMTP_PASS env vars. Set DIGEST_DRY_RUN=true to skip.');
  }

  const html = wrapHtmlEmail(markdownToHtml(markdownBody), subject);
  const transport = makeTransport();
  const result = await transport.sendMail({
    from: process.env.DIGEST_FROM || `"Firezard Digest" <${process.env.SMTP_USER}>`,
    to: `${name} <${to}>`,
    subject,
    text: markdownBody,
    html,
  });
  return result;
}

module.exports = { sendDigest, markdownToHtml, wrapHtmlEmail };
