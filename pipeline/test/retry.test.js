// Plain node+assert tests for lib/retry.js (FIR-25 rate-limit hardening).
// Proves the withRetry contract used by the NSS backfill to survive HTTP 429:
//   - default options preserve the original linear backoff (back-compat);
//   - exponential backoff via factor, capped by maxDelayMs;
//   - a server Retry-After (err.retryAfterMs) overrides the computed backoff;
//   - shouldRetry:false stops immediately (no wasted attempts on a 4xx);
//   - the thrown message reports the actual number of attempts made.
// Timers are stubbed so waits are asserted, not slept.

const assert = require('assert');
const { withRetry } = require('../lib/retry');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err && err.stack}`); process.exitCode = 1; }
}

// Capture each backoff wait without actually sleeping.
function withStubbedTimers(fn) {
  const realSetTimeout = global.setTimeout;
  const waits = [];
  global.setTimeout = (cb, ms) => { waits.push(ms); return realSetTimeout(cb, 0); };
  return Promise.resolve()
    .then(() => fn(waits))
    .finally(() => { global.setTimeout = realSetTimeout; });
}

function failingFn(times, makeErr = () => new Error('boom')) {
  let n = 0;
  return async () => {
    n += 1;
    if (n <= times) throw makeErr(n);
    return `ok-after-${n}`;
  };
}

async function run() {
  await t('default options: linear backoff, succeeds after transient failures', async () => {
    await withStubbedTimers(async (waits) => {
      const out = await withRetry(failingFn(2), { label: 'x' });
      assert.strictEqual(out, 'ok-after-3');
      assert.deepStrictEqual(waits, [1000, 1000], 'default is linear 1000ms');
    });
  });

  await t('exponential backoff with factor + maxDelayMs cap', async () => {
    await withStubbedTimers(async (waits) => {
      await assert.rejects(
        withRetry(failingFn(99), { attempts: 5, delayMs: 2000, factor: 2, maxDelayMs: 10000, label: 'x' }),
        /failed after 5 attempts/
      );
      // 2000, 4000, 8000, then capped at 10000 (not 16000).
      assert.deepStrictEqual(waits, [2000, 4000, 8000, 10000]);
    });
  });

  await t('Retry-After (err.retryAfterMs) overrides computed backoff', async () => {
    await withStubbedTimers(async (waits) => {
      const fn = failingFn(1, () => Object.assign(new Error('429'), { retryAfterMs: 45000 }));
      const out = await withRetry(fn, { delayMs: 2000, factor: 2, label: 'x' });
      assert.strictEqual(out, 'ok-after-2');
      assert.deepStrictEqual(waits, [45000], 'server cool-down wins over 2000ms');
    });
  });

  await t('shouldRetry:false stops immediately (no retries on a 4xx)', async () => {
    await withStubbedTimers(async (waits) => {
      let calls = 0;
      const fn = async () => { calls += 1; throw Object.assign(new Error('404'), { status: 404 }); };
      await assert.rejects(
        withRetry(fn, { attempts: 5, shouldRetry: (e) => e.status !== 404, label: 'x' }),
        /failed after 1 attempt:/ // singular, and only one attempt made
      );
      assert.strictEqual(calls, 1, 'fn called exactly once');
      assert.strictEqual(waits.length, 0, 'no backoff waited');
    });
  });

  await t('retryable status (429) is retried under shouldRetry', async () => {
    await withStubbedTimers(async (waits) => {
      const fn = failingFn(1, () => Object.assign(new Error('429'), { status: 429 }));
      const out = await withRetry(fn, { attempts: 3, delayMs: 500, shouldRetry: (e) => e.status === 429, label: 'x' });
      assert.strictEqual(out, 'ok-after-2');
      assert.deepStrictEqual(waits, [500]);
    });
  });

  console.log(`\nretry.test.js: ${passed} tests passed`);
}

run();
