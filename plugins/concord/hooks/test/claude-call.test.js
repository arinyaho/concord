'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveTimeoutMs, resolveRetries, isTimeoutError, callWithRetry } = require('../lib/claude-call');

test('resolveTimeoutMs: valid positive env int wins', () => {
  assert.strictEqual(resolveTimeoutMs('120000', 600000), 120000);
});

test('resolveTimeoutMs: missing/empty/non-numeric/zero/negative falls back to default', () => {
  assert.strictEqual(resolveTimeoutMs(undefined, 600000), 600000);
  assert.strictEqual(resolveTimeoutMs('', 600000), 600000);
  assert.strictEqual(resolveTimeoutMs('abc', 600000), 600000);
  assert.strictEqual(resolveTimeoutMs('0', 600000), 600000);
  assert.strictEqual(resolveTimeoutMs('-5', 600000), 600000);
});

test('resolveRetries: valid non-negative env int wins, including 0', () => {
  assert.strictEqual(resolveRetries('2', 1), 2);
  assert.strictEqual(resolveRetries('0', 1), 0);
});

test('resolveRetries: missing/non-numeric/negative falls back to default', () => {
  assert.strictEqual(resolveRetries(undefined, 1), 1);
  assert.strictEqual(resolveRetries('nope', 1), 1);
  assert.strictEqual(resolveRetries('-1', 1), 1);
});

test('isTimeoutError: matches ETIMEDOUT by code or message, nothing else', () => {
  assert.strictEqual(isTimeoutError({ code: 'ETIMEDOUT' }), true);
  assert.strictEqual(isTimeoutError(new Error('spawnSync claude ETIMEDOUT')), true);
  assert.strictEqual(isTimeoutError(new Error('auth required')), false);
  assert.strictEqual(isTimeoutError({ code: 'ENOENT' }), false);
  assert.strictEqual(isTimeoutError(null), false);
});

test('callWithRetry: returns value on first success (no extra calls)', () => {
  let calls = 0;
  const out = callWithRetry(() => { calls++; return 'ok'; }, { retries: 1, shouldRetry: () => true });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(calls, 1);
});

test('callWithRetry: retries a retryable failure then succeeds', () => {
  let calls = 0;
  const out = callWithRetry(() => {
    calls++;
    if (calls === 1) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
    return 'recovered';
  }, { retries: 1, shouldRetry: isTimeoutError });
  assert.strictEqual(out, 'recovered');
  assert.strictEqual(calls, 2);
});

test('callWithRetry: non-retryable error fails fast (no retry)', () => {
  let calls = 0;
  assert.throws(() => callWithRetry(() => {
    calls++;
    throw new Error('auth required');
  }, { retries: 3, shouldRetry: isTimeoutError }), /auth required/);
  assert.strictEqual(calls, 1);
});

test('callWithRetry: throws the last error after exhausting retries', () => {
  let calls = 0;
  assert.throws(() => callWithRetry(() => {
    calls++;
    const e = new Error(`ETIMEDOUT #${calls}`); e.code = 'ETIMEDOUT'; throw e;
  }, { retries: 2, shouldRetry: isTimeoutError }), /ETIMEDOUT #3/);
  assert.strictEqual(calls, 3); // 1 initial + 2 retries
});
