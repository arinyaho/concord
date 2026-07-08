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

test('loadDodConfig: corrupt JSON degrades to the default rather than throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'review.config.json'), '{not json');
  const cfg = dodExec.loadDodConfig(dir);
  assert.deepStrictEqual(cfg.dod, dodExec.DEFAULT_DOD_COMMANDS);
});

test('loadDodConfig: an empty or non-array "dod" degrades to the default', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: [] }));
  assert.deepStrictEqual(dodExec.loadDodConfig(dir).dod, dodExec.DEFAULT_DOD_COMMANDS);
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: 'node --test' }));
  assert.deepStrictEqual(dodExec.loadDodConfig(dir).dod, dodExec.DEFAULT_DOD_COMMANDS);
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
