'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../../core/review');
const { runPath } = require('../../core/initiative-review-run');
const { tempDir } = require('./temp-dir');
const plugins = path.resolve(__dirname, '../../..');
const providers = { claude: path.join(plugins, 'concord/hooks/review-cli.js'), copilot: path.join(plugins, 'concord-copilot/bin/review-cli.js') };
function setup(t, provider, mode = 'base', keyed = true) {
  const root = tempDir('native-ledger-recovery-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const stateDir = path.join(root, 'target'); const initiativeDir = path.join(root, 'initiative');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '-A'); git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  const options = ['--initiative-run-key', 'recovery-run', '--initiative-state-dir', initiativeDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5', '--initiative-mode', mode];
  const call = (args, withKey = keyed) => spawnSync(process.execPath, [providers[provider], ...args, ...(withKey ? options : [])], { cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir }, encoding: 'utf8' });
  const ok = args => { const r = call(args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  ok(['round-start', 'feat/x', 'HEAD~1', ...(mode === 'base' ? ['--no-broad'] : [])]);
  if (keyed) assert.equal(ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
  return { root, repo, stateDir, initiativeDir, options, call, targetFile: review.ledgerPath(stateDir, review.targetSlug('feat/x')), initiativeFile: runPath(initiativeDir, 'recovery-run') };
}
function recoveryGuidance(message) {
  assert.match(message, /reconcil/i);
  assert.match(message, /separate target review state directory/i);
  assert.match(message, /retain|preserv/i);
}
for (const provider of Object.keys(providers)) {
  test(`${provider}: first charged reserve retains binding when killed before its target reservation write`, t => {
    const s = setup(t, provider, 'base', false);
    const hook = path.join(s.root, 'interrupt-charge.cjs');
    fs.writeFileSync(hook, `
const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = function(from, to, ...args) {
  const result = rename.call(this, from, to, ...args);
  if (String(to) === process.env.INTERRUPT_RUN && JSON.parse(fs.readFileSync(to)).launches.length) process.kill(process.pid, 'SIGKILL');
  return result;
};
`);
    const killed = spawnSync(process.execPath, ['--require', hook, providers[provider], 'reserve', 'feat/x', 'correctness', ...s.options], {
      cwd: s.repo, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: s.repo, REVIEW_STATE_DIR: s.stateDir, INTERRUPT_RUN: s.initiativeFile },
    });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const charged = fs.readFileSync(s.initiativeFile, 'utf8');
    assert.equal(JSON.parse(charged).launches.length, 1);
    fs.rmSync(`${s.targetFile}.lock`, { recursive: true, force: true });
    const bound = fs.readFileSync(s.targetFile, 'utf8');
    assert.equal(JSON.parse(bound).initiative_binding?.key, 'recovery-run');
    for (const args of [['reserve', 'feat/x', 'verify'], ['reset', 'feat/x']]) {
      const denied = s.call(args, false);
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /initiative.*flags/i);
    }
    for (const [flag, value, message] of [
      ['--initiative-run-key', 'foreign-run', /different initiative binding/],
      ['--initiative-state-dir', path.join(s.root, 'foreign-state'), /different initiative binding/],
      ['--initiative-max-launches', '999', /immutable configured budgets/],
    ]) {
      const options = [...s.options];
      options[options.indexOf(flag) + 1] = value;
      const foreign = spawnSync(process.execPath, [providers[provider], 'reserve', 'feat/x', 'verify', ...options], {
        cwd: s.repo, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: s.repo, REVIEW_STATE_DIR: s.stateDir },
      });
      assert.notEqual(foreign.status, 0);
      assert.match(foreign.stderr, message);
    }
    assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), charged);
    const shown = s.call(['show', 'feat/x'], false);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), bound, 'show mutated target state');
    const resumed = s.call(['reserve', 'feat/x', 'verify'], true);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, 'granted');
    assert.equal(JSON.parse(fs.readFileSync(s.initiativeFile)).launches.length, 2);
  });
  test(`${provider}: a denied first reserve leaves standalone identity unchanged`, t => {
    const s = setup(t, provider, 'base', false);
    const before = fs.readFileSync(s.targetFile, 'utf8');
    const result = s.call(['reserve', 'feat/x', 'fix', '--count', '21'], true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'denied');
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), before);
    const lock = `${s.initiativeFile}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
    const contended = s.call(['reserve', 'feat/x', 'correctness'], true);
    fs.rmSync(lock, { recursive: true, force: true });
    assert.equal(contended.status, 0, contended.stderr);
    assert.equal(JSON.parse(contended.stdout).status, 'denied');
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), before);
    const invalid = s.call(['reserve', 'feat/x', 'invalid'], true);
    assert.notEqual(invalid.status, 0);
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), before);
    assert.equal(s.call(['reset', 'feat/x'], false).status, 0);
  });
  test(`${provider}: a failed first charge leaves standalone identity unchanged`, t => {
    const s = setup(t, provider, 'base', false);
    const before = fs.readFileSync(s.targetFile, 'utf8');
    const hook = path.join(s.root, 'fail-charge.cjs');
    fs.writeFileSync(hook, `
const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = function(from, to, ...args) {
  if (String(to) === process.env.FAIL_RUN && JSON.parse(fs.readFileSync(from)).launches.length) throw new Error('injected charge publication failure');
  return rename.call(this, from, to, ...args);
};
`);
    const failed = spawnSync(process.execPath, ['--require', hook, providers[provider], 'reserve', 'feat/x', 'correctness', ...s.options], {
      cwd: s.repo, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: s.repo, REVIEW_STATE_DIR: s.stateDir, FAIL_RUN: s.initiativeFile },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /injected charge publication failure/);
    assert.equal(JSON.parse(fs.readFileSync(s.initiativeFile)).launches.length, 0);
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), before);
    assert.equal(s.call(['reset', 'feat/x'], false).status, 0);
  });
  for (const verb of ['reset', 'rerun']) for (const keyed of [false, true]) {
    test(`${provider}: ${keyed ? 'keyed' : 'unkeyed'} ${verb} preserves corrupt bound bytes and charged budget`, t => {
      const s = setup(t, provider);
      const valid = fs.readFileSync(s.targetFile, 'utf8');
      assert.ok(JSON.parse(valid).initiative_binding);
      const corrupt = valid.slice(0, -17); fs.writeFileSync(s.targetFile, corrupt);
      const artifact = path.join(s.stateDir, 'round-1-correctness.json');
      fs.writeFileSync(artifact, 'Retained review evidence.');
      const before = fs.readFileSync(s.initiativeFile, 'utf8');
      const result = s.call([verb, 'feat/x'], keyed);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unreadable review ledger/);
      assert.match(result.stderr, /restore|reconcil/i);
      assert.match(result.stderr, /binding/i);
      assert.equal(fs.readFileSync(s.targetFile, 'utf8'), corrupt);
      assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
      assert.equal(fs.readFileSync(artifact, 'utf8'), 'Retained review evidence.');
    });
  }
  test(`${provider}: readable standalone reset still removes its ledger`, t => {
    const s = setup(t, provider, 'base', false);
    assert.equal(JSON.parse(fs.readFileSync(s.targetFile)).initiative_binding, undefined);
    const result = s.call(['reset', 'feat/x'], false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(s.targetFile), false);
  });
  test(`${provider}: post-launch escalation requires reconciled separate state and preserves old records`, t => {
    const s = setup(t, provider, 'lite');
    const targetBefore = fs.readFileSync(s.targetFile, 'utf8');
    const before = fs.readFileSync(s.initiativeFile, 'utf8');
    const result = s.call(['escalate', 'public-api']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /after the first launch/);
    recoveryGuidance(result.stderr);
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), targetBefore);
    assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
  });
  test(`${provider}: legacy initiative recovery preserves old records and requires separate reconciled state`, t => {
    const s = setup(t, provider);
    const legacy = { ...JSON.parse(fs.readFileSync(s.initiativeFile)), version: 4 };
    fs.writeFileSync(s.initiativeFile, JSON.stringify(legacy));
    const targetBefore = fs.readFileSync(s.targetFile, 'utf8');
    const before = fs.readFileSync(s.initiativeFile, 'utf8');
    const result = s.call(['reserve', 'feat/x', 'verify']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schemaVersion must be 5/);
    recoveryGuidance(result.stderr);
    assert.equal(fs.readFileSync(s.targetFile, 'utf8'), targetBefore);
    assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
  });
  test(`${provider}: unreadable resume report requires restored binding before mutation`, () => {
    const engine = provider === 'claude' ? review : require('../../../concord-copilot/engine/review');
    const report = engine.renderReviewReport([{ unreadable: 'review-feat-x.json' }]);
    assert.match(report, /restore|reconcil/i);
    assert.match(report, /binding/i);
    assert.doesNotMatch(report, /reset <ref>/);
  });
}
