// Pluggable summarizer. Two implementations behind the same interface:
//
// - ExtractiveSummarizer (default, no external calls): NS decisions already
//   ship with an official court-drafted headnote ("právní věta") — this is
//   the standard citable summary lawyers use for these decisions. We reshape
//   it into digest format without paraphrasing.
// - AnthropicSummarizer (used automatically when ANTHROPIC_API_KEY is set in
//   the deployment environment): produces a shorter, plain-language rewrite
//   per the FIR-13 digest spec ("3-6 sentences: what changed/was decided and
//   why it matters"), while still citing the source and never reproducing
//   full decision text (FIR-16 §5 summarize-with-attribution model).
//
// Neither implementation ever forwards the full decision text anywhere —
// only headline + official headnote (both already short, publicly-published
// summaries, not the underlying ruling).

function summarizeExtractive(decision) {
  const parts = [decision.headline, decision.legalBasis].filter(Boolean);
  let text = parts.join(' — ');
  if (text.length > 700) text = text.slice(0, 697) + '...';
  return text;
}

async function summarizeWithAnthropic(decision, { apiKey, model = 'claude-sonnet-5' }) {
  // Only NS Sbírka items carry a caseRef and an official court headnote. Every
  // other active source (ministry methodologies, ČNB/PSP/Senát, epravo,
  // profipravo, Advokátní deník, ...) is legal news/methodology/legislation —
  // it must NOT be framed as a Supreme Court ruling, or the digest asserts a
  // false document type for 5 of 7 sources. Branch the prompt on doc type.
  const isCourtDecision = Boolean(decision.caseRef);
  const prompt = isCourtDecision
    ? `You are drafting one item of a weekly legal digest for Czech insolvency & restructuring lawyers.
Summarize the following Nejvyšší soud (Czech Supreme Court) decision in 3-6 plain-language sentences: what the court decided and why it matters for creditor-side disputes, avoidance actions (odpůrčí žaloby), reorganization, or distressed M&A practice. Do not invent facts beyond what's given. Do not reproduce the legal text verbatim beyond short quoted terms. Write the summary in Czech.

Case: ${decision.caseRef}
Headline: ${decision.headline}
Official legal headnote (právní věta): ${decision.legalBasis}`
    : `You are drafting one item of a weekly legal digest for Czech insolvency & restructuring lawyers.
The following item comes from a Czech legal source (${decision.sourceName || 'legal source'}). It is legal news, a ministry methodology, legislation, or a court-adjacent update — NOT necessarily a court ruling; do not describe it as a court decision unless the text clearly is one. Summarize it in 3-6 plain-language sentences: what it is, what changed, and why it matters for creditor-side disputes, avoidance actions (odpůrčí žaloby), reorganization, or distressed M&A practice. If it is not actually relevant to insolvency/restructuring, say so in one sentence instead. Do not invent facts beyond what's given. Do not reproduce the source text verbatim beyond short quoted terms. Write the summary in Czech.

Title: ${decision.headline}
Source detail: ${decision.legalBasis}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic summarize call failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.content?.[0]?.text?.trim() || summarizeExtractive(decision);
}

function makeSummarizer({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (apiKey) {
    return {
      kind: 'anthropic',
      summarize: (decision) => summarizeWithAnthropic(decision, { apiKey }),
    };
  }
  return {
    kind: 'extractive',
    summarize: async (decision) => summarizeExtractive(decision),
  };
}

module.exports = { makeSummarizer, summarizeExtractive, summarizeWithAnthropic };
