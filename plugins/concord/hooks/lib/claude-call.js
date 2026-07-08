'use strict';

// Pure helpers for the headless `claude -p` gate call: timeout/retry policy.
// Kept out of review-engine.js (which does the real spawning) so the policy is
// unit-testable without launching a process.
//
// Why this exists: the gate call was hard-capped at a 90s timeout "matching the
// spike's alarm cap" -- a value tuned to a tiny toy diff. A real PR diff review
// (large prompt + `--add-dir` on a big repo + non-streaming JSON output) runs
// well past 90s, so the very first call died with ETIMEDOUT and the run aborted
// as a harness-failure. The timeout is now a generous safety net (not a tuned
// cap), env-overridable, and a spawn timeout is retried once before aborting.

function resolveTimeoutMs(envValue, defaultMs) {
  const n = Number.parseInt(envValue, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

function resolveRetries(envValue, defaultRetries) {
  const n = Number.parseInt(envValue, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultRetries;
}

// A spawn timeout surfaces as an error whose `code` is 'ETIMEDOUT' (and whose
// message contains it). Only these are worth retrying -- an auth/tool error
// should fail fast, not burn a retry.
function isTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'ETIMEDOUT') return true;
  return typeof err.message === 'string' && err.message.includes('ETIMEDOUT');
}

// Call `fn(attempt)` once, retrying up to `retries` more times while
// `shouldRetry(err)` is true. Returns fn's value; throws the last error when
// retries are exhausted or the error is not retryable (fail fast).
function callWithRetry(fn, { retries = 0, shouldRetry = () => false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt < retries && shouldRetry(e)) continue;
      throw e;
    }
  }
  throw lastErr; // defensive; unreachable
}

module.exports = { resolveTimeoutMs, resolveRetries, isTimeoutError, callWithRetry };
