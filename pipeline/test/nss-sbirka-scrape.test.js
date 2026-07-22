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
const {
  fetchItems,
  refreshCorpus,
  isFreshCacheEntry,
  FULLTEXT_CACHE_VERSION,
  extractJudInner,
  parseDecisionDetail,
} = require('../sources/nss-sbirka-scrape');

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

  // FIR-36 regression: the real jud container nests the headnote and the full
  // reasoning in inner <div>s. The old non-greedy regex stopped at the FIRST
  // </div></div> and captured only the headnote (~470 of ~11k chars). The
  // balanced walker must capture the ENTIRE body, past every nested div.
  await t('extractJudInner: captures full body across nested divs (not just headnote)', async () => {
    const html = `<h2>Title</h2>
<div class="jud">
  <div class="pravni-veta"><div class="nadpis">HEADNOTE</div> k § 1 zákona</div>
  <div class="oduvodneni">FULL REASONING para 1. <div class="cite">§ 2</div> para 2 END_OF_BODY</div>
</div>
<div class="footer">unrelated</div>`;
    const inner = extractJudInner(html);
    assert.ok(/HEADNOTE/.test(inner), 'headnote present');
    assert.ok(/FULL REASONING/.test(inner), 'reasoning present');
    assert.ok(/END_OF_BODY/.test(inner), 'captures through the last nested div, not just the headnote');
    assert.ok(!/unrelated/.test(inner), 'stops at the matching close, does not leak the trailing div');
    const detail = parseDecisionDetail(html);
    assert.ok(/END_OF_BODY/.test(detail.text), 'parseDecisionDetail exposes the full body');
    assert.strictEqual(detail.title, 'Title');
  });

  await t('extractJudInner: absent div -> empty string', async () => {
    assert.strictEqual(extractJudInner('<h2>x</h2><p>no jud here</p>'), '');
  });

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

  // FIR-37: the one-time corpus rebuild. A pre-fix cache holds headnote-only
  // bodies (schema v<2). refreshCorpus() must re-fetch the FULL body for every
  // stale entry, mark it v2, keep the full text (Option A — past the old 6k cap),
  // and leave already-fresh (v2) entries untouched (0 re-fetch).
  await t('refreshCorpus: re-fetches stale (v<2) entries to full body, marks v2, keeps v2 entries', async () => {
    const cp = path.join(os.tmpdir(), `nss-cache-refresh-${process.pid}.json`);
    // A full ruling body deliberately longer than the old 6000-char cap, to prove
    // Option A keeps the whole thing (no truncation).
    const longBody = 'k § 100 daňového řádu — ' + 'odůvodnění konkurs '.repeat(600); // ~11k chars
    const LONG_DETAIL = {
      1000: `<h2>Daňová pohledávka v konkursu</h2><div class="jud">${longBody}</div></div>`,
      2000: `<h2>Stavební povolení</h2><div class="jud">běžná stavební věc</div></div>`,
    };
    // Seed: p1000 stale (headnote-only, no v); p2000 already fresh (v2).
    const seeded = {
      1000: { url: 'https://sbirka.nssoud.cz/cz/danove-rizeni.p1000.html', title: 'old', text: 'k § 100 headnote only' },
      2000: { url: 'https://sbirka.nssoud.cz/cz/stavebni.p2000.html', title: 'ok', text: 'already full body', v: FULLTEXT_CACHE_VERSION },
    };
    fs.writeFileSync(cp, JSON.stringify(seeded), 'utf8');

    const counter = { n: 0 };
    global.fetch = async (url) => {
      const m = url.match(/\.p(\d+)\.html/);
      if (m) { counter.n++; return { ok: true, status: 200, text: async () => LONG_DETAIL[m[1]] }; }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      const res = await refreshCorpus({ cachePath: cp, requestDelayMs: 0 });
      assert.strictEqual(counter.n, 1, `only the stale entry should be re-fetched, got ${counter.n}`);
      assert.strictEqual(res.refreshed, 1);
      assert.strictEqual(res.remaining, 0, 'no stale entries left after refresh');

      const cache = JSON.parse(fs.readFileSync(cp, 'utf8'));
      // p1000 now carries the FULL body (past the old 6k cap) at v2.
      assert.strictEqual(cache['1000'].v, FULLTEXT_CACHE_VERSION);
      assert.ok(cache['1000'].text.length > 6000, `full body kept uncapped, got ${cache['1000'].text.length} chars`);
      assert.ok(/konkurs/i.test(cache['1000'].text), 'full body content present');
      assert.ok(cache['1000'].refreshedAt, 'refresh timestamp recorded');
      // p2000 was already v2 -> untouched.
      assert.strictEqual(cache['2000'].text, 'already full body', 'fresh entry left untouched');

      // Resume: a second run re-fetches nothing (all v2 now).
      counter.n = 0;
      const res2 = await refreshCorpus({ cachePath: cp, requestDelayMs: 0 });
      assert.strictEqual(counter.n, 0, `re-run should re-fetch 0 entries, got ${counter.n}`);
      assert.strictEqual(res2.refreshed, 0);
    } finally {
      try { fs.unlinkSync(cp); } catch {}
    }
  });

  // FIR-37: a normal fetchItems run must also treat a stale (v<2) cached candidate
  // as needing a re-scrape, not trust the headnote-only body.
  await t('isFreshCacheEntry: v<2 / missing text is stale, v2 with text is fresh', async () => {
    assert.strictEqual(isFreshCacheEntry(undefined), false);
    assert.strictEqual(isFreshCacheEntry({ text: 'x' }), false, 'no version -> stale');
    assert.strictEqual(isFreshCacheEntry({ text: 'x', v: 1 }), false, 'old version -> stale');
    assert.strictEqual(isFreshCacheEntry({ v: FULLTEXT_CACHE_VERSION }), false, 'no text -> stale');
    assert.strictEqual(isFreshCacheEntry({ text: 'x', v: FULLTEXT_CACHE_VERSION }), true, 'v2 + text -> fresh');
  });

  try { fs.unlinkSync(cachePath); } catch {}
  console.log(`\nnss-sbirka-scrape.test.js: ${passed} tests passed`);
}

run();
