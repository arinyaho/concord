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

function setup(t, provider, keyed = true) {
  const root = tempDir('native-record-claim-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const stateDir = path.join(root, 'target');
  const initiativeDir = path.join(root, 'initiative');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '-A'); git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  const options = ['--initiative-run-key', 'claim-run', '--initiative-state-dir', initiativeDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'];
  const call = args => spawnSync(process.execPath, [providers[provider], ...args, ...(keyed ? options : [])], {
    cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir }, encoding: 'utf8',
  });
  const ok = args => { const r = call(args); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return JSON.parse(r.stdout); };
  const targetFile = review.ledgerPath(stateDir, review.targetSlug('feat/x'));
  const initiativeFile = runPath(initiativeDir, 'claim-run');
  const target = () => JSON.parse(fs.readFileSync(targetFile));
  const initiative = () => JSON.parse(fs.readFileSync(initiativeFile));
  const start = ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad']);
  if (keyed) for (const role of ['correctness', 'verify']) assert.equal(ok(['reserve', 'feat/x', role]).status, 'granted');
  fs.writeFileSync(path.join(stateDir, `round-${start.round}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(stateDir, `round-${start.round}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  ok(['plan-fixes', 'feat/x']);
  const first = ok(['record', 'feat/x']);
  assert.equal(first.decision.converged, true);
  return { repo, git, first, call, ok, targetFile, initiativeFile, target, initiative };
}

for (const provider of Object.keys(providers)) {
  test(`${provider}: terminal record replay returns the same native initiative claim once`, t => {
    const s = setup(t, provider);
    const before = fs.readFileSync(s.initiativeFile, 'utf8');
    const claim = s.first.initiative.claim;
    assert.equal(claim, s.initiative().dispositions[0].packet.delivery.claim);
    assert.equal(s.target()._lastInitiativeClaim, claim);
    fs.writeFileSync(path.join(s.repo, 'a.txt'), 'three\n'); s.git('commit', '-aqm', 'later head');
    const replay = s.ok(['record', 'feat/x']);
    assert.deepEqual(replay.initiative, { claim });
    assert.equal(s.initiative().dispositions.length, 1);
    assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
  });
  test(`${provider}: legacy done record recovers its original native claim after the head moves`, t => {
    const s = setup(t, provider);
    const ledger = s.target(); delete ledger._lastInitiativeClaim;
    fs.writeFileSync(s.targetFile, JSON.stringify(ledger));
    fs.writeFileSync(path.join(s.repo, 'a.txt'), 'three\n'); s.git('commit', '-aqm', 'later head');
    const before = fs.readFileSync(s.initiativeFile, 'utf8');
    assert.deepEqual(s.ok(['record', 'feat/x']).initiative, s.first.initiative);
    assert.equal(s.initiative().dispositions.length, 1);
    assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
  });
  test(`${provider}: terminal record replay rejects a claim absent from the native run`, t => {
    const s = setup(t, provider);
    fs.writeFileSync(s.targetFile, JSON.stringify({ ...s.target(), _lastInitiativeClaim: 'caller-invented-claim' }));
    const before = fs.readFileSync(s.initiativeFile, 'utf8');
    const result = s.call(['record', 'feat/x']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /record:.*initiative.*claim/i);
    assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
  });
  test(`${provider}: standalone terminal record replay has no initiative claim`, t => {
    const s = setup(t, provider, false);
    assert.equal(s.first.initiative, undefined);
    assert.equal(s.ok(['record', 'feat/x']).initiative, undefined);
    assert.equal(fs.existsSync(s.initiativeFile), false);
  });
  for (const decision of [{ continue: true }, { continue: false, panelPending: true }]) {
    test(`${provider}: record replay for ${decision.continue ? 'continuing' : 'pending panel'} omits terminal initiative claim`, t => {
      const s = setup(t, provider);
      fs.writeFileSync(s.targetFile, JSON.stringify({ ...s.target(), status: 'converging', _lastDecision: decision }));
      const before = fs.readFileSync(s.initiativeFile, 'utf8');
      const replay = s.ok(['record', 'feat/x']);
      assert.deepEqual(replay.decision, decision);
      assert.equal(replay.initiative, undefined);
      assert.equal(fs.readFileSync(s.initiativeFile, 'utf8'), before);
    });
  }
}
