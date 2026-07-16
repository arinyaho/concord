'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadIntentConfig, fetchIntent } = require('../../core/intent');

// readFileFn stub: maps the config path to a string, or throws ENOENT.
function reader(contentByPath) {
  return (p) => {
    if (Object.prototype.hasOwnProperty.call(contentByPath, p)) return contentByPath[p];
    const e = new Error('no such file');
    e.code = 'ENOENT';
    throw e;
  };
}
const CFG = require('path').join('/repo', 'review.config.json');

test('loadIntentConfig: absent file -> null (benign opt-out)', () => {
  assert.strictEqual(loadIntentConfig('/repo', reader({})), null);
});

test('loadIntentConfig: file present but no intent key -> null', () => {
  assert.strictEqual(loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ dod: ['x'] }) })), null);
});

test('loadIntentConfig: valid intent -> { command }', () => {
  const r = loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ intent: { command: 'cat spec.md' } }) }));
  assert.deepStrictEqual(r, { command: 'cat spec.md' });
});

test('loadIntentConfig: malformed JSON -> harness-failure', () => {
  assert.throws(() => loadIntentConfig('/repo', reader({ [CFG]: '{not json' })), /harness-failure/);
});

test('loadIntentConfig: intent without a string command -> harness-failure', () => {
  assert.throws(() => loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ intent: {} }) })), /harness-failure/);
  assert.throws(() => loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ intent: { command: '   ' } }) })), /harness-failure/);
});

// execFn stub: records the env it was handed, returns a scripted result.
function fakeExec(result, sink) {
  return (cmd, cwd, env) => {
    if (sink) { sink.cmd = cmd; sink.env = env; }
    return result;
  };
}

test('fetchIntent: passes ref/base via env, NOT interpolated into the command', () => {
  const sink = {};
  const r = fetchIntent({
    command: 'echo hi',
    cwd: '/repo',
    ref: 'feat/x; rm -rf ~',
    base: 'main',
    execFn: fakeExec({ status: 0, stdout: 'the requirement text' }, sink),
  });
  assert.strictEqual(sink.cmd, 'echo hi'); // command string untouched
  assert.strictEqual(sink.env.REVIEW_REF, 'feat/x; rm -rf ~'); // inert as an env value
  assert.strictEqual(sink.env.REVIEW_BASE, 'main');
  assert.strictEqual(r.text, 'the requirement text');
  assert.strictEqual(typeof r.sha, 'string');
  assert.strictEqual(r.bytes, Buffer.byteLength('the requirement text', 'utf8'));
});

test('fetchIntent: absent base -> empty-string env', () => {
  const sink = {};
  fetchIntent({ command: 'x', cwd: '/repo', ref: 'r', base: undefined, execFn: fakeExec({ status: 0, stdout: 'y' }, sink) });
  assert.strictEqual(sink.env.REVIEW_BASE, '');
});

test('fetchIntent: non-zero exit -> harness-failure', () => {
  assert.throws(() => fetchIntent({ command: 'x', cwd: '/r', ref: 'r', execFn: fakeExec({ status: 3, stdout: '' }) }), /harness-failure/);
});

test('fetchIntent: empty / whitespace-only output -> harness-failure', () => {
  assert.throws(() => fetchIntent({ command: 'x', cwd: '/r', ref: 'r', execFn: fakeExec({ status: 0, stdout: '  \n ' }) }), /harness-failure/);
});

test('fetchIntent: oversize output -> harness-failure', () => {
  const big = 'a'.repeat(256 * 1024 + 1);
  assert.throws(() => fetchIntent({ command: 'x', cwd: '/r', ref: 'r', execFn: fakeExec({ status: 0, stdout: big }) }), /harness-failure/);
});
