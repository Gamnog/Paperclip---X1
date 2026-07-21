// Relevance classifier for the NSS Sbírka scraper (FIR-25 / FIR-33).
//
// The CEO's directive (2026-07-21) replaced the NSS scraper's keyword
// pre-filter with an LLM relevance decision over the FULL decision text: scrape
// every decision, extract the ruling body, and let Claude decide whether it is
// insolvency/restructuring related. Rationale: keyword matching on the headnote
// misses decisions whose insolvency relevance lives in the body but not in the
// cited-statute line.
//
// This mirrors lib/summarize.js's pluggable shape: makeClassifier() returns
// { kind, classify(item) } and picks the Anthropic path when ANTHROPIC_API_KEY
// is set, else a pure-offline keyword heuristic so the pipeline still runs
// (and tests run) with no network/key. Binary classification over up to ~4700
// docs is a cost/latency job, so it uses Haiku, NOT the summarizer's Sonnet.

const { withRetry } = require('./retry');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// How much of the ruling body we send to the classifier. Full NSS rulings can
// be long; the relevance signal (cited statutes, subject matter) is dense near
// the top, so a generous head slice keeps token cost bounded without hurting
// recall.
const MAX_CHARS = 12000;

const SCOPE = [
  'creditor-side disputes in insolvency',
  'avoidance / contestation actions (odpůrčí žaloby)',
  'reorganizace (reorganization)',
  'konkurs (bankruptcy)',
  'oddlužení (debt relief)',
  'úpadek (insolvency/distress)',
  'insolvenční řízení (insolvency proceedings)',
  'distressed M&A',
  'zákon č. 182/2006 Sb. (insolvenční zákon) and its application',
].join('; ');

// Offline heuristic — also the fallback when the API call/parse fails. Matches
// the previous behaviour so nothing regresses when the key is absent.
function classifyByKeywords({ title, text }, keywords) {
  if (!keywords || keywords.length === 0) {
    return { relevant: true, reason: 'keyword fallback: no keywords configured (matches all)' };
  }
  const hay = `${title || ''} ${text || ''}`.toLowerCase();
  const hit = keywords.find((kw) => hay.includes(String(kw).toLowerCase()));
  return hit
    ? { relevant: true, reason: `keyword fallback matched "${hit}"` }
    : { relevant: false, reason: 'keyword fallback: no match' };
}

// Defensively extract { "relevant": bool } from model output. Returns null if
// no parseable JSON object with a boolean `relevant` is present — callers treat
// null as a failed call and fall back.
function parseRelevance(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (typeof obj.relevant !== 'boolean') return null;
    return { relevant: obj.relevant, reason: typeof obj.reason === 'string' ? obj.reason : undefined };
  } catch {
    return null;
  }
}

// One Anthropic classification call. Throws on non-200 or unparseable output so
// withRetry can retry, and so makeClassifier's catch can fall back after the
// retries are exhausted. Mirrors lib/summarize.js's fetch/header style.
async function classifyInsolvencyRelevance({ title, text }, { apiKey, model = DEFAULT_MODEL } = {}) {
  const body = String(text || '').slice(0, MAX_CHARS);
  const prompt = `You are triaging Czech court decisions for a weekly legal digest whose readers are insolvency & restructuring lawyers. Decide whether the following Nejvyšší správní soud (Supreme Administrative Court) decision is RELEVANT to insolvency/restructuring practice, defined as: ${SCOPE}.

A decision is relevant if its subject matter or reasoning materially touches any of the above — including tax, public-law, or procedural claims asserted WITHIN insolvency proceedings, or that turn on the insolvenční zákon. It is NOT relevant if insolvency is merely mentioned in passing with no bearing on the holding.

Answer with STRICT JSON only, no prose, no code fence:
{"relevant": true} or {"relevant": false}

Title: ${title || '(none)'}
Decision text:
${body}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic classify call failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const parsed = parseRelevance(json.content?.[0]?.text);
  if (!parsed) {
    throw new Error('Anthropic classify: unparseable relevance response');
  }
  return parsed;
}

// Pluggable classifier. classify(item) -> Promise<{ relevant, reason }>.
// item = { title, text }.
function makeClassifier({ apiKey = process.env.ANTHROPIC_API_KEY, keywords = [], model = DEFAULT_MODEL } = {}) {
  if (apiKey) {
    return {
      kind: 'anthropic',
      model,
      classify: async (item) => {
        try {
          return await withRetry(
            () => classifyInsolvencyRelevance(item, { apiKey, model }),
            { label: 'classify' }
          );
        } catch (err) {
          console.warn(`[classify] anthropic failed (${err.message}); using keyword fallback`);
          return classifyByKeywords(item, keywords);
        }
      },
    };
  }
  console.warn('[classify] ANTHROPIC_API_KEY not set — using offline keyword fallback heuristic');
  return {
    kind: 'keyword-fallback',
    classify: async (item) => classifyByKeywords(item, keywords),
  };
}

module.exports = {
  classifyInsolvencyRelevance,
  makeClassifier,
  classifyByKeywords,
  parseRelevance,
};
