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

// UPDATED (was: "falls back to the default command list") -- old behavior was
// ENOENT -> return { dod: DEFAULT_DOD_COMMANDS }. Fix makes ENOENT fail-closed
// (throws harness-failure). Test now asserts the correct post-fix behavior.
test('loadDodConfig: missing review.config.json throws harness-failure (no silent fallback)', () => {
  const dir = tmpDir(); // guaranteed empty -- no review.config.json written
  assert.throws(
    () => dodExec.loadDodConfig(dir),
    (err) => {
      assert.match(err.message, /harness-failure/);
      assert.match(err.message, /review\.config\.json/);
      return true;
    },
  );
});

test('loadDodConfig: reads a configured "dod" command list from the repo root', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: ['npm run lint', 'npm test'] }));
  const cfg = dodExec.loadDodConfig(dir);
  assert.deepStrictEqual(cfg.dod, ['npm run lint', 'npm test']);
});

// UPDATED (was: "absent config (ENOENT via injected readFileFn) falls back to
// the default, does not throw") -- old behavior returned DEFAULT_DOD_COMMANDS
// on ENOENT. Fix makes ENOENT fail-closed: throws harness-failure so concord
// never passes a DoD gate it never actually ran (false-clean footgun).
test('loadDodConfig throws harness-failure when review.config.json is absent (no silent default gate)', () => {
  const readFileFn = () => {
    const e = new Error('ENOENT: no such file or directory');
    e.code = 'ENOENT';
    throw e;
  };
  assert.throws(
    () => dodExec.loadDodConfig('/repo', readFileFn),
    (err) => {
      assert.match(err.message, /harness-failure/);
      assert.match(err.message, /review\.config\.json/);
      return true;
    },
  );
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

// ---- loadDodConfig: dod:null opt-out (deferred gate) ----

test('loadDodConfig returns { deferred: true } for an explicit "dod": null (opt-out, not a gate)', () => {
  // `{"dod":null}` is the honest no-gate declaration. Distinct from ABSENT config
  // (harness-failure) and from a command list. The review gates still run; the
  // executable DoD is skipped and labeled deferred, never faked to a false clean.
  const readFileFn = () => '{"dod":null}';
  const result = dodExec.loadDodConfig('/repo', readFileFn);
  assert.deepStrictEqual(result, { deferred: true });
});

test('loadDodConfig guard: a dod array still returns { dod: [...] } (null opt-out does not change the normal path)', () => {
  const readFileFn = () => JSON.stringify({ dod: ['node --test'] });
  const result = dodExec.loadDodConfig('/repo', readFileFn);
  assert.deepStrictEqual(result.dod, ['node --test']);
  assert.ok(!result.deferred, 'array path must not set deferred');
});

test('loadDodConfig guard: {} (dod absent/undefined, not null) still throws harness-failure (a typo must not be silently deferred)', () => {
  const readFileFn = () => JSON.stringify({});
  assert.throws(() => dodExec.loadDodConfig('/repo', readFileFn), /harness-failure/);
});
