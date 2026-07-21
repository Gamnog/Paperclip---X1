// Shared retry helper for flaky network fetchers (FIR-23 M4 hardening).
// Retries transient failures (network errors, timeouts, 5xx, rate-limit 429).
//
// Options (all optional; defaults preserve the original linear behaviour so
// existing callers are unaffected):
//   attempts   — total tries before giving up (default 3).
//   delayMs    — base wait between tries (default 1000).
//   factor     — backoff multiplier per retry; 1 = linear (default), 2 = exp.
//   maxDelayMs — cap on the computed backoff (default Infinity).
//   shouldRetry(err) — predicate to skip retrying a deliberate/permanent error
//                (e.g. a 4xx). Default: retry everything. When it returns false
//                the loop stops immediately instead of burning the remaining
//                attempts on a failure that won't change.
//   label      — log prefix.
//
// Server-directed cool-down: if a thrown error carries `err.retryAfterMs`
// (e.g. parsed from an HTTP 429 Retry-After header), the wait for that attempt
// is at least that long — we respect the server's back-pressure over our own
// computed backoff.
async function withRetry(
  fn,
  { attempts = 3, delayMs = 1000, factor = 1, maxDelayMs = Infinity, shouldRetry, label = 'fetch' } = {}
) {
  let lastErr;
  let made = 0;
  for (let i = 1; i <= attempts; i++) {
    made = i;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = typeof shouldRetry === 'function' ? shouldRetry(err) : true;
      if (i >= attempts || !retryable) break;
      const backoff = Math.min(delayMs * Math.pow(factor, i - 1), maxDelayMs);
      const wait = Math.max(backoff, Number(err.retryAfterMs) || 0);
      console.warn(`[retry] ${label} attempt ${i}/${attempts} failed: ${err.message} — retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new Error(`${label} failed after ${made} attempt${made === 1 ? '' : 's'}: ${lastErr.message}`);
}

module.exports = { withRetry };
