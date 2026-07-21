// Shared retry helper for flaky network fetchers (FIR-23 M4 hardening).
// Retries transient failures (network errors, timeouts, 5xx) with linear backoff.
// Does not retry on abort/4xx-style errors thrown deliberately by callers that
// already know the response is unusable (e.g. non-ok status from a bad URL).

async function withRetry(fn, { attempts = 3, delayMs = 1000, label = 'fetch' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.warn(`[retry] ${label} attempt ${i}/${attempts} failed: ${err.message} — retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr.message}`);
}

module.exports = { withRetry };
