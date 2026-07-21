// Assembles a digest from summarized items. M1 produces one generic digest
// (no per-contact personalization yet — that's M3, once FIR-15 contacts and
// their stated sub-focus exist). Format matches the FIR-13 digest spec:
// title/type, source+citation, date, AI summary, source link.

function buildDigestMarkdown(items, { weekLabel } = {}) {
  const header = `# Firezard Legal Digest — Insolvency & Restructuring${weekLabel ? ` (${weekLabel})` : ''}\n`;
  if (items.length === 0) {
    return header + '\nNo new relevant decisions this period.\n';
  }
  const body = items
    .map((item) => {
      return [
        `## ${item.decision.caseRef} — sešit ${item.decision.number}`,
        `**Source:** Nejvyšší soud, Sbírka soudních rozhodnutí a stanovisek | **Link:** ${item.decision.url}`,
        '',
        item.summary,
        '',
      ].join('\n');
    })
    .join('\n---\n\n');
  return header + '\n' + body;
}

module.exports = { buildDigestMarkdown };
