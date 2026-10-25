'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const dodExec = require('../../core/dod-exec');
const { tempDir } = require('./temp-dir');

function tmpDir() {
  return tempDir('dod-exec-');
}

// ---- loadDodConfig ----

// An absent config DEFERS the gate instead of blocking the run: the review
// still converges and the handoff says DEFERRED. The false-clean footgun this
// guards against is a silent DEFAULT gate (`node --test` on a repo with no node
// tests exits 0 having run nothing), not the deferral.
test('loadDodConfig: missing review.config.json defers the gate (no throw, no silent default)', () => {
  const dir = tmpDir(); // guaranteed empty -- no review.config.json written
  const cfg = dodExec.loadDodConfig(dir);
  assert.strictEqual(cfg.deferred, true);
  assert.strictEqual(cfg.deferredBy, 'no-config');
  assert.strictEqual(cfg.dod, undefined); // never a default command list
});

test('loadDodConfig: an absent config via injected readFileFn (ENOENT) defers, does not throw', () => {
  const readFileFn = () => {
    const e = new Error('ENOENT: no such file or directory');
    e.code = 'ENOENT';
    throw e;
  };
  const cfg = dodExec.loadDodConfig('/repo', readFileFn);
  assert.deepStrictEqual(cfg, { deferred: true, deferredBy: 'no-config' });
});

test('loadDodConfig: reads a configured "dod" command list from the repo root', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'review.config.json'), JSON.stringify({ dod: ['npm run lint', 'npm test'] }));
  const cfg = dodExec.loadDodConfig(dir);
  assert.deepStrictEqual(cfg.dod, ['npm run lint', 'npm test']);
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

test('a DoD command does not inherit the driver\'s CONCORD_CODEX_BIN override', () => {
  const previous = process.env.CONCORD_CODEX_BIN;
  process.env.CONCORD_CODEX_BIN = '/driver/codex';
  try {
    const r = dodExec.defaultExecFn(`node -e "process.exit(process.env.CONCORD_CODEX_BIN ? 3 : 0)"`, process.cwd());
    assert.strictEqual(r.status, 0);
    const named = dodExec.defaultExecFn(`CONCORD_CODEX_BIN=/named node -e "process.exit(process.env.CONCORD_CODEX_BIN === '/named' ? 0 : 3)"`, process.cwd());
    assert.strictEqual(named.status, 0);
  } finally {
    if (previous === undefined) delete process.env.CONCORD_CODEX_BIN; else process.env.CONCORD_CODEX_BIN = previous;
  }
});

test('commandExecutables removes a backslash-newline continuation before reading words, as the shell does', () => {
  assert.deepStrictEqual(dodExec.commandExecutables(['FOO=1 \\\n  go test']), ['go']);
  assert.ok(!dodExec.commandExecutables(['true \\\n#c; fmt']).includes('fmt'));
});

test('review preflight is an optional no-op when review.config.json is absent', () => {
  const repoRoot = tmpDir();
  let called = false;
  assert.deepStrictEqual(dodExec.loadReviewPreflight(repoRoot), []);
  assert.deepStrictEqual(dodExec.runReviewPreflight(repoRoot, { execFn: () => { called = true; return { status: 0 }; } }), { commands: [], passed: true });
  assert.equal(called, false);
});

test('review preflight leaves configs without a preflight property to their existing DoD validation path', () => {
  const repoRoot = tmpDir();
  for (const raw of ['null', '[]', '{"dod":null}']) {
    fs.writeFileSync(path.join(repoRoot, 'review.config.json'), raw);
    assert.deepStrictEqual(dodExec.loadReviewPreflight(repoRoot), [], raw);
  }
});

test('review preflight validates the declaration independently of the DoD field', () => {
  const repoRoot = tmpDir();
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ dod: null, preflight: ['node -e "process.exit(0)"', 'git --version'] }));
  assert.deepStrictEqual(dodExec.loadReviewPreflight(repoRoot), ['node -e "process.exit(0)"', 'git --version']);
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ dod: null, preflight: [] }));
  assert.deepStrictEqual(dodExec.loadReviewPreflight(repoRoot), []);
});

test('review preflight rejects malformed arrays and blank command strings', () => {
  const repoRoot = tmpDir();
  for (const preflight of [null, 'node --version', [''], ['  '], ['node --version', 3]]) {
    fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ preflight }));
    assert.throws(() => dodExec.loadReviewPreflight(repoRoot), /driver environment.*preflight/i, JSON.stringify(preflight));
  }
});

test('review preflight fails closed for malformed or unreadable raw config', () => {
  const repoRoot = tmpDir();
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), '{ invalid');
  assert.throws(() => dodExec.loadReviewPreflight(repoRoot), /driver environment preflight.*malformed/i);
  assert.throws(() => dodExec.loadReviewPreflight(repoRoot, () => { const error = new Error('EACCES'); error.code = 'EACCES'; throw error; }), /driver environment preflight could not read/i);
});

test('review preflight runs commands sequentially from the repository root', () => {
  const repoRoot = tmpDir();
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ preflight: ['first check', 'second check'] }));
  const calls = [];
  const result = dodExec.runReviewPreflight(repoRoot, { execFn: (command, cwd) => { calls.push([command, cwd]); return { status: 0 }; } });
  assert.deepStrictEqual(calls, [['first check', repoRoot], ['second check', repoRoot]]);
  assert.deepStrictEqual(result, { commands: ['first check', 'second check'], passed: true });
});

test('review preflight stops at a failed command and bounds its diagnostic', () => {
  const repoRoot = tmpDir(); const command = 'node -e "require(\'./missing-preflight-module\')"';
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ preflight: [command, 'must not run'] }));
  const calls = [];
  assert.throws(() => dodExec.runReviewPreflight(repoRoot, { execFn: (cmd, cwd) => { calls.push([cmd, cwd]); return { status: 1, stdout: 'diagnostic '.repeat(1000), stderr: '' }; } }), (error) => {
    assert.match(error.message, /driver environment preflight failed/i);
    assert.ok(error.message.includes(command), 'the exact failed command must be named');
    const diagnostic = error.message.slice(error.message.indexOf('\n') + 1);
    assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 4 * 1024, 'diagnostic must be at most 4 KiB');
    assert.doesNotMatch(error.message, /sandbox/i);
    return true;
  });
  assert.deepStrictEqual(calls, [[command, repoRoot]]);
});

test('review preflight treats spawn errors and timeout results as failures', () => {
  const repoRoot = tmpDir(); const command = 'slow check';
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ preflight: [command] }));
  for (const result of [
    { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    { status: 0, error: new Error('spawn error') },
  ]) {
    assert.throws(() => dodExec.runReviewPreflight(repoRoot, { execFn: () => result }), /driver environment preflight failed/i);
  }
});

test('review preflight real commands use the bounded timeout and do not inherit the driver executable override', () => {
  assert.equal(dodExec.PREFLIGHT_TIMEOUT_MS, 10_000);
  assert.equal(dodExec.PREFLIGHT_MAX_BUFFER, 64 * 1024);
  const repoRoot = tmpDir(); const previous = process.env.CONCORD_CODEX_BIN;
  process.env.CONCORD_CODEX_BIN = '/driver/codex';
  try {
    fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ preflight: [`node -e "process.exit(process.env.CONCORD_CODEX_BIN ? 7 : 0)"`] }));
    assert.deepStrictEqual(dodExec.runReviewPreflight(repoRoot), { commands: [`node -e "process.exit(process.env.CONCORD_CODEX_BIN ? 7 : 0)"`], passed: true });
  } finally {
    if (previous === undefined) delete process.env.CONCORD_CODEX_BIN; else process.env.CONCORD_CODEX_BIN = previous;
  }
});

test('review preflight forcibly stops a command that ignores SIGTERM before the configured timeout', { skip: process.platform === 'win32' }, () => {
  const childProcess = require('node:child_process');
  const originalSpawnSync = childProcess.spawnSync;
  const repoRoot = tmpDir();
  const started = Date.now();
  let result;
  childProcess.spawnSync = (command, options) => originalSpawnSync(command, { ...options, timeout: 100 });
  try {
    result = dodExec.defaultPreflightExec(`exec node -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 2000)"`, repoRoot);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.ok(Date.now() - started < 1500, `SIGTERM-resistant child ran for ${Date.now() - started}ms`);
});
