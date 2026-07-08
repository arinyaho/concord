'use strict';

// Pure helpers for the headless `claude -p` gate call: timeout/retry policy.
// Kept out of review-engine.js (which does the real spawning) so the policy is
// unit-testable without launching a process.
//
// Why this exists: the gate call was hard-capped at a 90s timeout "matching the
// spike's alarm cap" -- a value tuned to a tiny toy diff. A real PR diff review
// (large prompt + `--add-dir` on a big repo + non-streaming JSON output) runs
// well past 90s, so the very first call died with ETIMEDOUT and the run aborted
// as a harness-failure. The timeout is now a deliberately high ceiling (not a
// value tuned to one diff), env-overridable, and a spawn timeout is retried
// once before aborting.

// `Number` (not `parseInt`): parseInt truncates '1e6' to 1 and '300.9' to 300,
// so a user writing REVIEW_CLAUDE_TIMEOUT_MS=1e6 (a natural way to type a big
// number of ms) would get a 1ms timeout -- reintroducing the very failure this
// fixes. `Number('1e6')` is 1000000; '', 'abc', '300abc' become 0/NaN and fall
// through to the default.
function resolveTimeoutMs(envValue, defaultMs) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

function resolveRetries(envValue, defaultRetries) {
  const n = Number(envValue);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultRetries;
}

// The mutating fix gate must NOT be retried. A fix call killed mid-edit leaves
// partial edits on disk; re-running the same prompt would apply them a second
// time on the now-dirty tree, past the engine's once-per-round double-fix guard.
// Read-only gates (review/verify) are safe to retry.
function retriesForMode(mode, retries) {
  return mode === 'fix' ? 0 : retries;
}

// A spawn timeout surfaces as an error whose `code` is 'ETIMEDOUT' (and whose
// message contains it). Only these are worth retrying -- an auth/tool error
// should fail fast rather than consume a retry attempt.
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

module.exports = { resolveTimeoutMs, resolveRetries, retriesForMode, isTimeoutError, callWithRetry };
