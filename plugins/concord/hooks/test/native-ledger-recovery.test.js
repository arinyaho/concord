'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../../core/review');
const { runPath } = require('../../core/initiative-review-run');
const plugins = path.resolve(__dirname, '../../..');
const providers = { claude: path.join(plugins, 'concord/hooks/review-cli.js'), copilot: path.join(plugins, 'concord-copilot/bin/review-cli.js') };
function setup(t, provider, mode = 'base', keyed = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ledger-recovery-'));
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
  return { root, stateDir, call, targetFile: review.ledgerPath(stateDir, review.targetSlug('feat/x')), initiativeFile: runPath(initiativeDir, 'recovery-run') };
}
function recoveryGuidance(message) {
  assert.match(message, /reconcil/i);
  assert.match(message, /separate target review state directory/i);
  assert.match(message, /retain|preserv/i);
}
for (const provider of Object.keys(providers)) {
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
