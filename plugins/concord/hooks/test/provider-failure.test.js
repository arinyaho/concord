'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerFailure, normalizeProviderFailure, reviewContinuation } = require('../../core/provider-failure');

const input = { role: 'plan', provider: 'claude' };
const secret = 'opaque-credential-216-DO-NOT-PERSIST';
function safe(value) {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes(secret), false, 'provider credentials must not cross the diagnostic boundary');
  assert.equal(encoded.includes('\\u001b'), false, 'provider control sequences must not cross the diagnostic boundary');
  return value;
}

test('nonzero provider failure retains actionable classification without arbitrary provider output', () => {
  const failure = safe(providerFailure(input, {
    status: 1,
    stdout: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `Bearer ${secret}\n\u001b[31m` } }),
    stderr: `Authentication failed: invalid API key ${secret}\n\u001b[31m`,
  }));
  assert.equal(failure.role, 'plan');
  assert.equal(failure.kind, 'subprocess-exit');
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.diagnostic.classification, 'authentication');
  assert.equal(failure.retryable, false);
  assert.equal(failure.diagnostic.provider, 'anthropic');
  assert.equal(failure.diagnostic.engine, 'claude');
  assert.equal(failure.diagnostic.providerSchema, 'claude-print-json-v1');
  assert.equal(typeof failure.diagnostic.message, 'string');
});

test('authentication wins when stderr also contains transient failure indicators', () => {
  const failure = safe(providerFailure(input, {
    status: 1,
    stdout: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: secret } }),
    stderr: `Authentication failed: invalid API key ${secret}; rate limit exceeded; service unavailable`,
  }));
  assert.equal(failure.diagnostic.classification, 'authentication');
  assert.equal(failure.retryable, false);
});

test('structured rate limit failure permits transport recovery and canonicalizes credentials', () => {
  const failure = safe(providerFailure(input, {
    status: 1,
    stdout: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: secret } }),
    stderr: `Rate limit exceeded: ${secret}`,
  }));
  assert.equal(failure.diagnostic.classification, 'rate-limit');
  assert.equal(failure.retryable, true);
});

test('unrelated stdout prose mentioning rate limit never authorizes transport retry', () => {
  const failure = safe(providerFailure(input, {
    status: 1,
    stdout: `Review the documentation section explaining rate limit policies. ${secret}`,
    stderr: '',
  }));
  assert.equal(failure.diagnostic.classification, 'unknown');
  assert.equal(failure.retryable, false);
});

test('model-authored JSON with an error property is not a provider error envelope', () => {
  const failure = providerFailure(input, {
    status: 1,
    stdout: JSON.stringify({ type: 'agent_message', error: 'Document the rate_limit_error field.' }),
    stderr: '',
  });
  assert.equal(failure.retryable, false);
});

test('an unrelated stderr reference number is not HTTP transient evidence', () => {
  const failure = providerFailure(input, { status: 1, stdout: '', stderr: 'Configuration reference 503 could not be loaded.' });
  assert.equal(failure.retryable, false);
});

test('invalid provider JSON is a terminal malformed response with no raw payload', () => {
  const failure = safe(providerFailure(input, { status: 1, stdout: `{ "error": "${secret}"`, stderr: '' }));
  assert.equal(failure.diagnostic.classification, 'malformed-response');
  assert.equal(failure.retryable, false);
});

test('thrown provider transport errors classify their code without exposing message or stack', () => {
  const error = Object.assign(new Error(`Transport failed using ${secret}\n\u001b[31m`), { code: 'ETIMEDOUT' });
  const failure = safe(providerFailure(input, error));
  assert.equal(failure.diagnostic.classification, 'transient');
  assert.equal(failure.retryable, true);
});

test('missing provider executable is terminal and never exposes credential-bearing error text', () => {
  const error = Object.assign(new Error(`Executable /${secret}/claude missing`), { code: 'ENOENT' });
  const failure = safe(providerFailure(input, error));
  assert.equal(failure.diagnostic.classification, 'unknown');
  assert.equal(failure.retryable, false);
});

test('provider timeout permits bounded transport retry with a canonical message', () => {
  const failure = safe(providerFailure(input, { status: null, timedOut: true, signal: 'SIGTERM', stderr: secret }));
  assert.equal(failure.kind, 'timeout');
  assert.equal(failure.diagnostic.classification, 'transient');
  assert.equal(failure.retryable, true);
});

test('parent interruption takes precedence over timeout and cannot authorize retry', () => {
  const failure = safe(providerFailure(input, { status: null, interrupted: secret, timedOut: true, signal: 'SIGTERM', stderr: secret }));
  assert.equal(failure.kind, 'interrupted');
  assert.equal(failure.retryable, false);
});

test('invalid process signal and exit status never escape the diagnostic boundary', () => {
  const failure = safe(providerFailure(input, { status: secret, signal: `${secret}\u001b[31m`, stderr: secret }));
  assert.equal(failure.kind, 'signal');
  assert.equal(failure.retryable, false);
  assert.equal(Object.hasOwn(failure, 'signal'), false);
  assert.equal(Object.hasOwn(failure, 'exitCode'), false);
});

test('nonfinite and unsafe exit statuses are omitted from normalized provider failures', () => {
  for (const exitCode of [Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const failure = normalizeProviderFailure({ role: 'plan', kind: 'subprocess-exit', exitCode, diagnostic: { engine: 'claude', classification: 'unknown' } });
    assert.equal(Object.hasOwn(failure, 'exitCode'), false);
  }
});

test('prototype property names are not valid provider identities or classification enums', () => {
  for (const inherited of ['__proto__', 'constructor', 'toString']) {
    const failure = normalizeProviderFailure({ role: 'plan', kind: 'subprocess-exit', diagnostic: { engine: inherited, classification: inherited } });
    assert.equal(failure.diagnostic.classification, 'unknown');
    assert.equal(failure.diagnostic.engine, 'unknown');
    assert.equal(failure.diagnostic.provider, 'unknown');
    assert.equal(failure.diagnostic.providerSchema, 'unknown');
    assert.equal(failure.retryable, false);
  }
});

test('direct failure normalization replaces untrusted diagnostic strings using the known engine table', () => {
  const failure = safe(normalizeProviderFailure({
    role: 'plan', kind: 'subprocess-exit', exitCode: 1,
    message: secret, retryable: true, signal: secret,
    diagnostic: { classification: 'authentication', message: `${secret}\u001b[31m`, engine: 'claude', provider: secret, providerSchema: secret },
  }));
  assert.equal(failure.diagnostic.classification, 'authentication');
  assert.equal(failure.diagnostic.engine, 'claude');
  assert.equal(failure.diagnostic.provider, 'anthropic');
  assert.equal(failure.diagnostic.providerSchema, 'claude-print-json-v1');
  assert.equal(failure.retryable, false);
  assert.notEqual(failure.signal, secret);
});

test('invalid direct diagnostic enum and engine cannot inject metadata or authorize retry', () => {
  const failure = safe(normalizeProviderFailure({
    role: 'plan', kind: 'subprocess-exit', message: secret, retryable: true, exitCode: secret,
    diagnostic: { classification: secret, message: secret, engine: secret, provider: secret, providerSchema: secret },
  }));
  assert.equal(failure.diagnostic.classification, 'unknown');
  assert.equal(failure.retryable, false);
  assert.equal(Number.isInteger(failure.exitCode), false);
});

test('exhausted legacy semantic planner allowance offers terminal handoff', () => {
  const continuation = reviewContinuation({ execution: { completed: ['correctness', 'verify'], planRetry: { state: 'exhausted', launched: true } } });
  assert.equal(continuation.nextAction, 'terminal-handoff');
});

test('pending transport retry remains actionable without reopening semantic allowance', () => {
  const continuation = reviewContinuation({ execution: { completed: ['correctness', 'verify'], planRetry: { state: 'pending', launched: true }, planTransportRetry: { state: 'pending', attempts: 0 } } });
  assert.equal(continuation.nextAction, 'resume');
});

test('forged pending transport retry cannot reopen an exhausted semantic allowance', () => {
  const continuation = reviewContinuation({ execution: { completed: ['correctness', 'verify'], planRetry: { state: 'exhausted', launched: true }, planTransportRetry: { state: 'pending', attempts: 0 } } });
  assert.equal(continuation.nextAction, 'terminal-handoff');
});

test('dispatched transport retry without usable plan evidence offers terminal handoff', () => {
  const continuation = reviewContinuation({ execution: { completed: ['correctness', 'verify'], planRetry: { state: 'exhausted', launched: true }, planTransportRetry: { state: 'dispatched', launched: true } } });
  assert.equal(continuation.nextAction, 'terminal-handoff');
});
