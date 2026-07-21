// Relevance filter for the insolvency & restructuring specialization (FIR-13 scope).
// NS senate 29 (29 ICdo / 29 NSČR / 29 Cdo) is the dedicated insolvency senate —
// per FIR-14 catalog entry #1, this is the primary relevance signal for NS Sbírka.

const SENATE_29_RE = /^29\s+(ICdo|NSČR|Cdo)\b/i;

function isSenate29(caseRef) {
  return SENATE_29_RE.test(caseRef.trim());
}

// Applied at the ingestion layer per source, before any summarization step —
// see FIR-16 compliance-review, §3 (ISIR corporate-only restriction is the
// concrete example this generalizes from). NS Sbírka has no personal-data
// scope restriction, so this only applies the senate-29 relevance filter.
function filterNsSbirkaDecisions(decisions) {
  return decisions.filter((d) => isSenate29(d.caseRef));
}

module.exports = { isSenate29, filterNsSbirkaDecisions, SENATE_29_RE };
