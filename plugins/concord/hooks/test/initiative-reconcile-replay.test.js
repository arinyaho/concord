'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const review = require('../../core/review');
const initiative = require('../../core/initiative-review-run');
const { tempDir } = require('./temp-dir');

const cli = path.resolve(__dirname, '../review-cli.js');

function fixture() {
  const repo = tempDir('initiative-reconcile-replay-repo-');
  const targetState = tempDir('initiative-reconcile-replay-target-');
  const initiativeState = tempDir('initiative-reconcile-replay-run-');
  const ref = 'feature/reconcile-replay';
  const key = 'reconcile-replay';
  const flags = ['--initiative-run-key', key, '--initiative-id', 'initiative-replay', '--initiative-state-dir', initiativeState, '--initiative-max-launches', '30', '--initiative-max-rounds', '8'];
  const env = { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: targetState };

  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(['commit', '-qam', 'change']);

  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args, ...flags], { cwd: repo, env, encoding: 'utf8' });
  const run = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, `${args.join(' ')} failed\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const fail = (...args) => {
    const result = invoke(...args);
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    return result;
  };
  const targetLedger = () => review.readLedger(targetState, review.targetSlug(ref));
  const writeTargetLedger = (ledger) => review.writeLedger(targetState, review.targetSlug(ref), ledger);
  const initiativeRun = () => initiative.openInitiativeRun({ stateDir: initiativeState, key, initiativeId: 'initiative-replay', repository: repo, maxLaunches: 30, maxRounds: 8 });

  function makeReconciliationRound({ record = true } = {}) {
    const started = run('round-start', ref, 'HEAD~1', '--no-broad');
    const current = targetLedger();
    assert.equal(started.head, current.target.head_sha);
    const round = current.round;
    for (const role of ['correctness', 'verify', 'plan']) run('reserve', ref, role);

    const finding = { id: 'correctness:identity', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'classification needs a human decision' };
    fs.writeFileSync(path.join(targetState, `round-${round}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [finding] }));
    run('artifact-normalize', ref, 'correctness');
    fs.writeFileSync(path.join(targetState, `round-${round}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
    run('artifact-normalize', ref, 'verify');
    fs.writeFileSync(path.join(targetState, `round-${round}-plan.json`), JSON.stringify({
      status: 'ok', protocolVersion: 2,
      groups: [{ groupId: 'identity-contract', findingIds: [finding.id], rootCause: 'The accepted identity policy is unsettled.', invariants: ['A human decision must define the identity behavior.'], changeClass: 'local', action: 'reconcile', reason: 'The approved contract does not state which identity wins.' }],
    }));
    run('artifact-normalize', ref, 'plan');
    const plan = run('plan-fixes', ref);
    assert.equal(plan.reconciliation.trigger, 'group-reconcile');
    const recorded = record ? run('record', ref) : null;
    if (recorded) assert.equal(recorded.decision.reconciliation, true);
    return { round, started, recorded, ledger: targetLedger() };
  }

  return { repo, targetState, initiativeState, ref, key, flags, env, run, fail, targetLedger, writeTargetLedger, initiativeRun, makeReconciliationRound };
}

test('real review-cli record replay recovers the resolved claim by occurrence and a fresh same-head round creates a distinct hold', () => {
  const f = fixture();
  const first = f.makeReconciliationRound();
  const firstRun = f.initiativeRun();
  const firstInitiativeLedger = JSON.parse(fs.readFileSync(firstRun.path, 'utf8'));
  const firstDisposition = firstInitiativeLedger.dispositions[0];
  const firstClaim = firstDisposition.packet.delivery.claim;

  assert.deepEqual(firstDisposition.occurrence, { attemptId: first.started.attemptId, round: first.round });
  assert.equal(firstClaim, `feature/reconcile-replay:1`);
  assert.match(firstDisposition.packet.handoff, new RegExp(`review-cli\\.js reconcile .*--claim '${firstClaim}'`));
  assert.match(first.recorded.handoff, new RegExp(`review-cli\\.js reconcile .*--claim '${firstClaim}'`));

  const reconcileArgs = ['reconcile', f.ref, '--claim', firstClaim, '--by', 'human reviewer', '--decision', 'Keep the recorded contract and restart the review.', '--contract', 'unchanged'];
  const resolved = f.run(...reconcileArgs);
  assert.equal(resolved.status, 'reconciled');

  // Simulate interruption after reconciliation persisted but before the target
  // ledger's convenience pointer was written. Replay must recover by the
  // durable (attemptId, round) occurrence and return the original claim.
  const targetAfterResolution = f.targetLedger();
  delete targetAfterResolution._lastInitiativeClaim;
  f.writeTargetLedger(targetAfterResolution);
  const replay = f.run('record', f.ref);
  assert.equal(replay.initiative.claim, firstClaim);
  assert.match(replay.handoff, new RegExp(`review-cli\\.js reconcile .*--claim '${firstClaim}'`));
  assert.equal(JSON.parse(fs.readFileSync(firstRun.path, 'utf8')).reconciliationDecisions.length, 1);

  const second = f.makeReconciliationRound();
  assert.equal(second.round, first.round + 1);
  assert.equal(second.started.head, first.started.head, 'the second round reviews the unchanged same head');
  assert.equal(typeof second.started.attemptId, 'string');
  const afterSecond = JSON.parse(fs.readFileSync(firstRun.path, 'utf8'));
  const secondDisposition = afterSecond.dispositions.at(-1);
  const secondClaim = secondDisposition.packet.delivery.claim;
  assert.notEqual(secondClaim, firstClaim);
  assert.deepEqual(secondDisposition.occurrence, { attemptId: second.started.attemptId, round: second.round });

  const stale = f.fail(...reconcileArgs);
  assert.match(stale.stderr, /matching pending reconciliation claim/);
  const afterStaleAttempt = JSON.parse(fs.readFileSync(firstRun.path, 'utf8'));
  assert.equal(afterStaleAttempt.reconciliationDecisions.length, 1);
  assert.ok(initiative.pendingReconciliations(afterStaleAttempt).some((entry) => entry.packet.delivery.claim === secondClaim));
});

test('real review-cli refuses a second same-head record after the initiative run is finalised', () => {
  const f = fixture();
  const first = f.makeReconciliationRound();
  const firstRun = f.initiativeRun();
  const firstClaim = JSON.parse(fs.readFileSync(firstRun.path, 'utf8')).dispositions[0].packet.delivery.claim;
  f.run('reconcile', f.ref, '--claim', firstClaim, '--by', 'human reviewer', '--decision', 'Keep the recorded contract and restart the review.', '--contract', 'unchanged');

  const second = f.makeReconciliationRound({ record: false });
  assert.equal(second.round, first.round + 1);
  assert.equal(second.started.head, first.started.head);
  const beforeFinalise = JSON.parse(fs.readFileSync(firstRun.path, 'utf8'));
  assert.equal(f.run('finalise').status, 'finalised');

  const refused = f.fail('record', f.ref);
  assert.match(refused.stderr, /keyed initiative run is not active/);
  const after = JSON.parse(fs.readFileSync(firstRun.path, 'utf8'));
  assert.equal(after.status, 'terminal');
  assert.deepEqual(after.dispositions, beforeFinalise.dispositions, 'the old same-head claim is not reused as a round-two result');
  assert.equal(f.targetLedger().phase, 'fixes', 'the refused record remains available for authorized recovery');
});

test('real review-cli never replays a resolved old claim when new same-head disposition recording fails', () => {
  const f = fixture();
  f.makeReconciliationRound();
  const initiativeRun = f.initiativeRun();
  const firstClaim = JSON.parse(fs.readFileSync(initiativeRun.path, 'utf8')).dispositions[0].packet.delivery.claim;
  f.run('reconcile', f.ref, '--claim', firstClaim, '--by', 'human reviewer', '--decision', 'Keep the recorded contract and restart the review.', '--contract', 'unchanged');
  const second = f.makeReconciliationRound({ record: false });

  // Interpose at the initiative store boundary to simulate a concurrent writer
  // winning the record lock after this target review is complete. The actual
  // review CLI and its post-record claim selection still run in the child.
  const preloadDir = tempDir('initiative-reconcile-replay-preload-');
  const preload = path.join(preloadDir, 'fail-record-disposition.js');
  const initiativeModule = require.resolve('../../core/initiative-review-run');
  fs.writeFileSync(preload, [
    `'use strict';`,
    `const initiative = require(${JSON.stringify(initiativeModule)});`,
    `const original = initiative.recordDisposition;`,
    `initiative.recordDisposition = (...args) => process.env.CONCORD_FAIL_RECORD_DISPOSITION === '1' ? false : original(...args);`,
    '',
  ].join('\n'));
  const result = spawnSync(process.execPath, ['--require', preload, cli, 'record', f.ref, ...f.flags], {
    cwd: f.repo,
    env: { ...f.env, CONCORD_FAIL_RECORD_DISPOSITION: '1' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, `record unexpectedly reused the prior claim: ${result.stdout}`);
  assert.match(result.stderr, /contended|original initiative claim is missing or ambiguous/);
  assert.equal(f.targetLedger().phase, 'fixes', 'a refused round-two record remains available for recovery');
  const after = JSON.parse(fs.readFileSync(initiativeRun.path, 'utf8'));
  assert.equal(after.dispositions.length, 1);
  assert.equal(after.reconciliationDecisions.length, 1);
  assert.ok(!initiative.pendingReconciliations(after).length);
  assert.equal(second.started.head, f.targetLedger().target.head_sha);
});
