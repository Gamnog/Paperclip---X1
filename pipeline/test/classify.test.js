// Plain node+assert tests for lib/classify.js (repo has no test framework).
// Network is fully mocked — no live Anthropic calls.
const assert = require('assert');
const {
  parseRelevance,
  classifyByKeywords,
  makeClassifier,
} = require('../lib/classify');

let passed = 0;
function t(name, fn) {
  return fn().then(
    () => { passed++; console.log(`  ok  ${name}`); },
    (err) => { console.error(`FAIL  ${name}\n      ${err && err.message}`); process.exitCode = 1; }
  );
}
const sync = (name, fn) => t(name, async () => fn());

// Build a fake Anthropic response.
function anthropicText(text) {
  return { ok: true, status: 200, json: async () => ({ content: [{ text }] }) };
}
function httpError(status) {
  return { ok: false, status, text: async () => `err ${status}` };
}

async function run() {
  // --- parseRelevance ---
  await sync('parseRelevance: clean JSON true', () => {
    assert.deepStrictEqual(parseRelevance('{"relevant": true}'), { relevant: true, reason: undefined });
  });
  await sync('parseRelevance: JSON embedded in prose', () => {
    assert.strictEqual(parseRelevance('Sure: {"relevant": false} done').relevant, false);
  });
  await sync('parseRelevance: reason passed through', () => {
    assert.strictEqual(parseRelevance('{"relevant": true, "reason": "konkurs"}').reason, 'konkurs');
  });
  await sync('parseRelevance: non-boolean relevant -> null', () => {
    assert.strictEqual(parseRelevance('{"relevant": "yes"}'), null);
  });
  await sync('parseRelevance: garbage -> null', () => {
    assert.strictEqual(parseRelevance('no json here'), null);
  });
  await sync('parseRelevance: empty -> null', () => {
    assert.strictEqual(parseRelevance(''), null);
  });

  // --- classifyByKeywords ---
  await sync('keywords: title match', () => {
    assert.strictEqual(classifyByKeywords({ title: 'Insolvenční řízení', text: '' }, ['insolven']).relevant, true);
  });
  await sync('keywords: body-only match', () => {
    assert.strictEqual(classifyByKeywords({ title: 'Daň z přidané hodnoty', text: '...konkurs...' }, ['konkurs']).relevant, true);
  });
  await sync('keywords: no match', () => {
    assert.strictEqual(classifyByKeywords({ title: 'Stavební řízení', text: 'nic' }, ['insolven']).relevant, false);
  });
  await sync('keywords: empty keyword list matches all', () => {
    assert.strictEqual(classifyByKeywords({ title: 'x', text: 'y' }, []).relevant, true);
  });

  // --- makeClassifier: offline path (no key) never calls fetch ---
  await t('makeClassifier: no key -> keyword fallback, no fetch', async () => {
    let called = false;
    global.fetch = async () => { called = true; throw new Error('should not fetch'); };
    const clf = makeClassifier({ keywords: ['insolven'] });
    assert.strictEqual(clf.kind, 'keyword-fallback');
    assert.strictEqual((await clf.classify({ title: 'insolvenční', text: '' })).relevant, true);
    assert.strictEqual((await clf.classify({ title: 'nic', text: '' })).relevant, false);
    assert.strictEqual(called, false);
  });

  // --- makeClassifier: anthropic path, valid response ---
  await t('makeClassifier: valid anthropic response', async () => {
    global.fetch = async () => anthropicText('{"relevant": true}');
    const clf = makeClassifier({ apiKey: 'k', keywords: [] });
    assert.strictEqual(clf.kind, 'anthropic');
    assert.strictEqual((await clf.classify({ title: 'x', text: 'konkurs' })).relevant, true);
  });

  // --- makeClassifier: unparseable response -> falls back after retries ---
  await t('makeClassifier: unparseable -> keyword fallback', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return anthropicText('I cannot answer'); };
    const clf = makeClassifier({ apiKey: 'k', keywords: ['konkurs'] });
    const v = await clf.classify({ title: 'x', text: 'obsahuje konkurs' });
    assert.strictEqual(calls, 3, `expected 3 retries, got ${calls}`);
    assert.strictEqual(v.relevant, true); // fallback keyword matched
    assert.ok(/fallback/.test(v.reason));
  });

  // --- makeClassifier: HTTP 500 -> falls back after retries ---
  await t('makeClassifier: HTTP 500 -> keyword fallback', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return httpError(500); };
    const clf = makeClassifier({ apiKey: 'k', keywords: ['insolven'] });
    const v = await clf.classify({ title: 'nesouvisející', text: 'nic' });
    assert.strictEqual(calls, 3, `expected 3 retries, got ${calls}`);
    assert.strictEqual(v.relevant, false); // fallback: no keyword match
  });

  console.log(`\nclassify.test.js: ${passed} assertions passed`);
}

run();
