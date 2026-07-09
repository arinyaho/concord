'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dodExec = require('../lib/dod-exec');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dod-exec-'));
}

// ---- loadDodConfig ----

test('loadDodConfig: missing review.config.json falls back to the default command list', () => {
  const dir = tmpDir();
  const cfg = dodExec.loadDodConfig(dir);
  assert.deepStrictEqual(cfg.dod, dodExec.DEFAULT_DOD_COMMANDS);
});

test('loadDodConfig: reads a configured "dod" command list from the repo root', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: ['npm run lint', 'npm test'] }));
  const cfg = dodExec.loadDodConfig(dir);
  assert.deepStrictEqual(cfg.dod, ['npm run lint', 'npm test']);
});

test('loadDodConfig: absent config (ENOENT via injected readFileFn) falls back to the default, does not throw', () => {
  const readFileFn = () => {
    const e = new Error('ENOENT: no such file or directory');
    e.code = 'ENOENT';
    throw e;
  };
  const cfg = dodExec.loadDodConfig('/repo', readFileFn);
  assert.deepStrictEqual(cfg.dod, dodExec.DEFAULT_DOD_COMMANDS);
});

test('loadDodConfig: present-but-corrupt config (bad JSON) throws harness-failure, does NOT degrade to default', () => {
  const readFileFn = () => '{ not json';
  assert.throws(() => dodExec.loadDodConfig('/repo', readFileFn), /harness-failure/);
});

test('loadDodConfig: present config with a non-usable "dod" shape throws harness-failure', () => {
  const readFileFn = () => JSON.stringify({ dod: [] });
  assert.throws(() => dodExec.loadDodConfig('/repo', readFileFn), /harness-failure/);
});

test('loadDodConfig: an unreadable-for-another-reason file (non-ENOENT error) throws harness-failure', () => {
  const readFileFn = () => {
    const e = new Error('EACCES: permission denied');
    e.code = 'EACCES';
    throw e;
  };
  assert.throws(() => dodExec.loadDodConfig('/repo', readFileFn), /harness-failure/);
});

test('loadDodConfig: an empty or non-array "dod" is a malformed present config -- throws harness-failure, does not degrade', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: [] }));
  assert.throws(() => dodExec.loadDodConfig(dir), /harness-failure/);
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: 'node --test' }));
  assert.throws(() => dodExec.loadDodConfig(dir), /harness-failure/);
});

// ---- runDodExec ----

function fakeExecFn(script) {
  // script: cmd -> { status, stdout, stderr }
  return (cmd) => script[cmd] || { status: 1, stdout: '', stderr: `no fake registered for "${cmd}"` };
}

test('runDodExec: all commands passing -> passed:true, one result per command', () => {
  const execFn = fakeExecFn({
    'npm run lint': { status: 0, stdout: 'lint ok\n', stderr: '' },
    'npm test': { status: 0, stdout: 'tests ok\n', stderr: '' },
  });
  const out = dodExec.runDodExec({ cwd: '/repo', commands: ['npm run lint', 'npm test'], execFn });
  assert.strictEqual(out.passed, true);
  assert.strictEqual(out.results.length, 2);
  assert.ok(out.results.every((r) => r.passed));
});

test('runDodExec: fail-fast -- stops at the first failing command, does not run the rest', () => {
  let ranSecond = false;
  const execFn = (cmd) => {
    if (cmd === 'npm test') ranSecond = true;
    if (cmd === 'npm run lint') return { status: 1, stdout: '', stderr: 'lint error\n' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = dodExec.runDodExec({ cwd: '/repo', commands: ['npm run lint', 'npm test'], execFn });
  assert.strictEqual(out.passed, false);
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(ranSecond, false);
});

test('runDodExec: a failing command records its exit code and combined stdout+stderr', () => {
  const execFn = fakeExecFn({ 'node --test': { status: 1, stdout: 'ran 3 tests\n', stderr: '# fail 1\n' } });
  const out = dodExec.runDodExec({ cwd: '/repo', commands: ['node --test'], execFn });
  assert.strictEqual(out.results[0].exitCode, 1);
  assert.match(out.results[0].output, /ran 3 tests/);
  assert.match(out.results[0].output, /# fail 1/);
});

test('runDodExec: empty command list passes trivially', () => {
  const out = dodExec.runDodExec({ cwd: '/repo', commands: [], execFn: fakeExecFn({}) });
  assert.strictEqual(out.passed, true);
  assert.deepStrictEqual(out.results, []);
});
