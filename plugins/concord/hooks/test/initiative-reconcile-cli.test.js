'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const I = require('../../core/initiative-review-run');
const { tempDir } = require('./temp-dir');
const cli = path.resolve(__dirname, '../review-cli.js');
function fixture() {
  const repo = tempDir('reconcile-cli-repo-'), state = path.join(repo, 'initiative');
  const flags = ['--initiative-run-key', 'run', '--initiative-id', 'initiative', '--initiative-state-dir', state, '--initiative-max-launches', '20', '--initiative-max-rounds', '10'];
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args, ...flags], { cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: path.join(repo, 'target-state') }, encoding: 'utf8' });
  const json = (...args) => { const out = invoke(...args); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); };
  const open = () => I.openInitiativeRun({ stateDir: state, key: 'run', initiativeId: 'initiative', repository: repo, maxLaunches: 20, maxRounds: 10 });
  const hold = (run, target = 'A') => {
    assert.ok(I.recordDisposition(run, { target, revision: { ref: target, base: 'main', head_sha: 'h' }, result: { decision: { gatePending: true }, reconciliation: { finding: 'gate:contract' } }, occurrence: { attemptId: 'attempt', round: 1 } }));
    return JSON.parse(fs.readFileSync(run.path)).dispositions.at(-1).packet.delivery.claim;
  };
  return { repo, state, invoke, json, open, hold };
}
test('initiative-plan registers private dependency evidence without creating a target ledger', () => {
  const h = fixture(), source = path.join(h.repo, 'plan.json');
  fs.writeFileSync(source, JSON.stringify({ version: 1, targets: [{ ref: 'A', dependsOn: [] }, { ref: 'B', dependsOn: [] }, { ref: 'C', dependsOn: ['A'] }] }));
  assert.equal(h.json('initiative-plan', source).status, 'registered');
  const run = h.open(); h.hold(run);
  assert.equal(I.pairRefusal(run, 'B', { ref: 'B', base: 'main', head_sha: 'b' }), null);
  assert.equal(I.pairRefusal(run, 'C', { ref: 'C', base: 'main', head_sha: 'c' }), 'reconciliation-required');
  assert.equal(fs.existsSync(path.join(h.repo, 'target-state')), false);
});
test('malformed plan and reconcile inputs do not create a run', () => {
  for (const args of [['initiative-plan', 'relative.json'], ['reconcile', 'A', '--by', 'human'], ['reconcile', 'A', '--claim', 'A:1', '--by', 'human', '--decision', 'resume', '--contract', 'changed']]) {
    const h = fixture(), out = h.invoke(...args);
    assert.notEqual(out.status, 0);
    assert.equal(fs.existsSync(h.state), false, out.stderr);
  }
});
test('reconcile records an exact attributed decision and never opens an absent run', () => {
  const h = fixture();
  const options = ['--claim', 'A:1', '--by', 'human', '--decision', 'Keep the approved contract and resume A.', '--contract', 'unchanged'];
  assert.notEqual(h.invoke('reconcile', 'A', ...options).status, 0);
  assert.equal(fs.existsSync(h.state), false);
  const run = h.open(), claim = h.hold(run), before = JSON.parse(fs.readFileSync(run.path));
  assert.equal(claim, 'A:1');
  assert.equal(h.json('reconcile', 'A', ...options).status, 'reconciled');
  const after = JSON.parse(fs.readFileSync(run.path));
  assert.deepEqual(after.launches, before.launches); assert.deepEqual(after.rounds, before.rounds); assert.deepEqual(after.budget, before.budget);
  assert.equal(after.reconciliationDecisions[0].by, 'human');
  assert.equal(after.reconciliationDecisions[0].decision, options[5]);
  assert.notEqual(h.invoke('reconcile', 'A', ...options).status, 0);
});
