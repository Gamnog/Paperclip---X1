// Plain node+assert tests for sources/nss-sbirka-scrape.js (FIR-33 rev 4).
// Network fully mocked — no live sbirka.nssoud.cz calls. Proves:
//   1. NO stage-1 keyword gate: a decision whose list-page title/snippet carry
//      no insolvency keyword is STILL detail-fetched and, if the classifier
//      approves it on body text, returned; jud text is cached keyed by pid;
//      only classifier-approved items are returned.
//   2. A second run against the same cache does 0 detail fetches (cache reuse).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchItems } = require('../sources/nss-sbirka-scrape');

// --- fixtures ---
// p1000: NO insolvency keyword in the list title/snippet (plain tax matter),
// but the ruling BODY mentions "konkurs" -> proves relevance can hide in body.
// p2000: nothing insolvency-related anywhere -> classifier rejects.
const LIST_HTML = `
<div class="list-item"><h3><span class="num-tag">1/2026</span> Daňové řízení a správa daní</h3>
<p class="content">k § 100 daňového řádu — běžná daňová věc</p> Datum: <span>15.04.2026</span>
<a href="/cz/danove-rizeni.p1000.html?q=">detail</a></div>
<div class="list-item"><h3><span class="num-tag">2/2026</span> Stavební povolení</h3>
<p class="content">k § 10 stavebního zákona</p> Datum: <span>10.03.2026</span>
<a href="/cz/stavebni.p2000.html?q=">detail</a></div>`;

const DETAIL = {
  1000: `<h2>Daňová pohledávka za dlužníkem v konkursu</h2>
<div class="jud">k otázce uspokojení daňové pohledávky po prohlášení konkursu podle zákona č. 182/2006 Sb.</div></div>`,
  2000: `<h2>Stavební povolení</h2><div class="jud">běžná stavební věc bez vazby na insolvenci</div></div>`,
};

// classifier stub: relevant iff the (full) text mentions konkurs.
const stubClassifier = {
  kind: 'stub',
  classify: async ({ text }) => ({ relevant: /konkurs/i.test(text || '') }),
};

function makeFetch(detailCounter) {
  return async (url) => {
    if (url.includes('/cz/vyhledavani')) {
      return { ok: true, status: 200, text: async () => LIST_HTML };
    }
    const m = url.match(/\.p(\d+)\.html/);
    if (m) {
      detailCounter.n++;
      return { ok: true, status: 200, text: async () => DETAIL[m[1]] };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err && err.message}`); process.exitCode = 1; }
}

async function run() {
  const cachePath = path.join(os.tmpdir(), `nss-cache-test-${process.pid}.json`);
  try { fs.unlinkSync(cachePath); } catch {}

  await t('run 1: no stage-1 gate, classifier decides, jud cached, only relevant returned', async () => {
    const counter = { n: 0 };
    global.fetch = makeFetch(counter);
    const items = await fetchItems({
      sourceId: 'nss-sbirka',
      sourceName: 'NSS Sbírka',
      maxPages: 1,
      requestDelayMs: 0,
      classifier: stubClassifier,
      cachePath,
    });
    // Both decisions were detail-fetched even though p1000/p2000 have no
    // keyword in their list rows -> proves the stage-1 keyword gate is gone.
    assert.strictEqual(counter.n, 2, `expected 2 detail fetches, got ${counter.n}`);
    // Only the classifier-approved decision (p1000, konkurs in body) is returned.
    assert.strictEqual(items.length, 1, `expected 1 relevant item, got ${items.length}`);
    assert.strictEqual(items[0].id, 'nss-sbirka-p1000');
    assert.strictEqual(items[0].pubDate, '2026-04-15T00:00:00.000Z');
    assert.ok(/konkurs/i.test(items[0].summary), 'summary should carry the cached jud body');
    // Cache holds BOTH decisions' jud text, keyed by pid.
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.ok(/konkurs/i.test(cache['1000'].text), 'p1000 jud text cached');
    assert.ok(cache['2000'] && typeof cache['2000'].text === 'string', 'p2000 also cached');
    assert.strictEqual(cache['1000'].url, 'https://sbirka.nssoud.cz/cz/danove-rizeni.p1000.html');
  });

  await t('run 2: same cache -> 0 detail fetches (reuse)', async () => {
    const counter = { n: 0 };
    global.fetch = makeFetch(counter);
    const items = await fetchItems({
      sourceId: 'nss-sbirka',
      sourceName: 'NSS Sbírka',
      maxPages: 1,
      requestDelayMs: 0,
      classifier: stubClassifier,
      cachePath,
    });
    assert.strictEqual(counter.n, 0, `expected 0 detail fetches on cached re-run, got ${counter.n}`);
    assert.strictEqual(items.length, 1, 'still returns the one relevant item from cache');
    assert.strictEqual(items[0].id, 'nss-sbirka-p1000');
  });

  // FIR-25 rate-limit hardening: a full-archive backfill must NOT crash when the
  // server throttles a listing page with HTTP 429 (that is exactly what killed
  // the earlier run). It should skip the throttled page after exhausting retries,
  // still seed the pages it could reach, and complete normally.
  await t('backfill: a 429-throttled listing page is skipped, run still completes', async () => {
    const cachePath2 = path.join(os.tmpdir(), `nss-cache-test429-${process.pid}.json`);
    try { fs.unlinkSync(cachePath2); } catch {}

    // Stub timers so withRetry's exponential backoff does not actually sleep.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (cb) => realSetTimeout(cb, 0);

    // Page 1 lists p1000 (+ a pagination link to _page=2 so hardCap=2). Page 2
    // always returns HTTP 429 -> exhausts retries -> must be skipped, not fatal.
    const PAGE1 = `${LIST_HTML}\n<a href="/cz/vyhledavani?_page=2">2</a>`;
    let p2Attempts = 0;
    global.fetch = async (url) => {
      if (url.includes('_page=2')) {
        p2Attempts++;
        return { ok: false, status: 429, headers: { get: () => null }, text: async () => '' };
      }
      if (url.includes('/cz/vyhledavani')) {
        return { ok: true, status: 200, text: async () => PAGE1 };
      }
      const m = url.match(/\.p(\d+)\.html/);
      if (m) return { ok: true, status: 200, text: async () => DETAIL[m[1]] };
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      const items = await fetchItems({
        sourceId: 'nss-sbirka',
        sourceName: 'NSS Sbírka',
        fullBackfill: true,
        requestDelayMs: 0,
        classifier: stubClassifier,
        cachePath: cachePath2,
      });
      assert.strictEqual(p2Attempts, 5, `page 2 should be retried 5x before skip, got ${p2Attempts}`);
      // Page 1's relevant decision (p1000) still surfaces despite page 2 dying.
      assert.strictEqual(items.length, 1, `expected 1 item from reachable pages, got ${items.length}`);
      assert.strictEqual(items[0].id, 'nss-sbirka-p1000');
    } finally {
      global.setTimeout = realSetTimeout;
      try { fs.unlinkSync(cachePath2); } catch {}
    }
  });

  try { fs.unlinkSync(cachePath); } catch {}
  console.log(`\nnss-sbirka-scrape.test.js: ${passed} tests passed`);
}

run();
