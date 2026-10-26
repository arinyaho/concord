'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtimes = [
  require('../../core/initiative-review-run'),
  require('../../../concord-codex/engine/initiative-review-run'),
  require('../../../concord-copilot/engine/initiative-review-run'),
];
const { tempDir } = require('./temp-dir');

function open(runtime, key) {
  return runtime.openInitiativeRun({ stateDir: tempDir('initiative-reconcile-'), key, repository: '/repo', maxLaunches: 12, maxRounds: 6 });
}

function revision(ref, head = `${ref}-head`) {
  return { ref, base: 'main', head_sha: head };
}

function ledger(run) {
  return JSON.parse(fs.readFileSync(run.path, 'utf8'));
}

for (const [runtimeName, runtime] of [['native', runtimes[0]], ['Codex', runtimes[1]], ['Copilot', runtimes[2]]]) {
  test(`${runtimeName}: initiative plans validate and are immutable after launch`, () => {
    const run = open(runtime, `plan-${runtimeName}`);
    const plan = { version: 1, targets: [{ ref: 'A', dependsOn: [] }, { ref: 'B', dependsOn: ['A'] }] };
    assert.equal(runtime.setInitiativePlan(run, plan), true);
    assert.equal(runtime.setInitiativePlan(run, plan), true, 'the same plan is idempotent');
    const storedPlan = ledger(run).dependencyPlan;
    assert.deepEqual({ version: storedPlan.version, targets: storedPlan.targets }, plan);
    assert.match(storedPlan.sha256, /^[a-f0-9]{64}$/);

    const invalidPlans = [
      { version: 1, targets: [{ ref: 'A' }] },
      { version: 1, targets: [{ ref: '' , dependsOn: [] }] },
      { version: 1, targets: [{ ref: 'A', dependsOn: [] }, { ref: 'A', dependsOn: [] }] },
      { version: 1, targets: [{ ref: 'A', dependsOn: ['missing'] }] },
      { version: 1, targets: [{ ref: 'A', dependsOn: ['A'] }] },
      { version: 1, targets: [{ ref: 'A', dependsOn: [] }, { ref: 'B', dependsOn: ['A', 'A'] }] },
      { version: 1, targets: [{ ref: 'A', dependsOn: ['B'] }, { ref: 'B', dependsOn: ['A'] }] },
    ];
    for (const bad of invalidPlans) {
      const before = fs.readFileSync(run.path, 'utf8');
      assert.throws(() => runtime.setInitiativePlan(run, bad));
      assert.equal(fs.readFileSync(run.path, 'utf8'), before, 'invalid plan refusal leaves ledger bytes unchanged');
    }

    assert.equal(runtime.reserveLaunch(run, { role: 'correctness', target: 'A', attemptId: 'a', round: 1 }), true);
    assert.equal(runtime.setInitiativePlan(run, plan), true, 're-registering the identical plan after launch is safe');
    const beforeChangedPlan = fs.readFileSync(run.path, 'utf8');
    assert.throws(() => runtime.setInitiativePlan(run, { version: 1, targets: [{ ref: 'A', dependsOn: [] }] }));
    assert.equal(fs.readFileSync(run.path, 'utf8'), beforeChangedPlan);
  });

  test(`${runtimeName}: a reconciliation hold blocks its target and dependents while independent work remains reservable`, () => {
    const run = open(runtime, `holds-${runtimeName}`);
    const plan = { version: 1, targets: [
      { ref: 'A', dependsOn: [] }, { ref: 'B', dependsOn: ['A'] },
      { ref: 'C', dependsOn: ['B'] }, { ref: 'D', dependsOn: [] },
    ] };
    runtime.setInitiativePlan(run, plan);
    for (const ref of ['A', 'B']) assert.equal(runtime.reserveLaunch(run, { role: 'correctness', target: ref, revision: { ref, base: 'main' }, attemptId: `${ref}-old`, round: 1 }), true);

    const held = revision('A');
    assert.equal(runtime.recordDisposition(run, {
      target: 'A', revision: held, occurrence: { attemptId: 'a1', round: 1 },
      result: { decision: { gatePending: true }, reconciliation: { finding: 'gate:A' } },
    }), true);
    assert.equal(runtime.recordDisposition(run, {
      target: 'B', revision: revision('B'), occurrence: { attemptId: 'b1', round: 1 },
      result: { decision: { gatePending: true }, reconciliation: { finding: 'gate:B' } },
    }), true);
    const ledgerBeforeReconcile = ledger(run);
    const launchCount = ledgerBeforeReconcile.launches.length;
    const roundsBeforeIndependentLaunch = ledgerBeforeReconcile.rounds.length;
    const claim = ledgerBeforeReconcile.dispositions.find((entry) => entry.target === 'A').packet.delivery.claim;

    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'A', revision: held, attemptId: 'a2', round: 1 }), 'reconciliation-required');
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'B', revision: revision('B'), attemptId: 'b2', round: 1 }), 'reconciliation-required');
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'C', revision: revision('C'), attemptId: 'c1', round: 1 }), 'reconciliation-required');
    assert.notEqual(runtime.denialReason(run, { role: 'correctness', target: 'unknown', revision: revision('unknown'), attemptId: 'u1', round: 1 }), null);
    assert.equal(runtime.reserveLaunch(run, { role: 'correctness', target: 'D', revision: { ref: 'D', base: 'main' }, attemptId: 'd1', round: 1 }), true);
    assert.equal(ledger(run).launches.length, launchCount + 1);
    const roundsBeforeReconcile = ledger(run).rounds.length;
    assert.equal(roundsBeforeReconcile, roundsBeforeIndependentLaunch + 1);

    assert.equal(runtime.reconcileInitiativeRun(run, { target: 'A', claim, by: 'reviewer', decision: 'resume after confirming gate evidence', contract: 'unchanged' }), true);
    const after = ledger(run);
    assert.equal(after.reconciliationDecisions.length, 1);
    assert.equal(after.launches.length, launchCount + 1, 'reconciliation does not refund or consume launch budget');
    assert.equal(after.rounds.length, roundsBeforeReconcile, 'reconciliation does not reset round history or usage');
    assert.notEqual(runtime.denialReason(run, { role: 'correctness', target: 'A', revision: held, attemptId: 'a2', round: 1 }), 'reconciliation-required');
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'B', revision: revision('B'), attemptId: 'b2', round: 1 }), 'reconciliation-required', 'resolving A leaves B’s separate hold pending');
    assert.equal(ledger(run).reconciliationDecisions.length, 1);
  });

  test(`${runtimeName}: reconciliation decisions reject stale claims and changed or incomplete contracts without writes`, () => {
    const run = open(runtime, `reject-${runtimeName}`);
    runtime.setInitiativePlan(run, { version: 1, targets: [{ ref: 'A', dependsOn: [] }] });
    runtime.recordDisposition(run, { target: 'A', revision: revision('A'), occurrence: { attemptId: 'a1', round: 1 }, result: { reconciliation: { finding: 'gate:A' } } });
    const claim = ledger(run).dispositions.at(-1).packet.delivery.claim;
    const attempts = [
      { target: 'A', claim: 'stale', by: 'reviewer', decision: 'resume', contract: 'unchanged' },
      { target: 'wrong', claim, by: 'reviewer', decision: 'resume', contract: 'unchanged' },
      { target: 'A', claim, by: '', decision: 'resume', contract: 'unchanged' },
      { target: 'A', claim, by: 'reviewer', decision: '', contract: 'unchanged' },
      { target: 'A', claim, by: 'reviewer', decision: 'resume', contract: 'changed' },
    ];
    for (const input of attempts) {
      const before = fs.readFileSync(run.path, 'utf8');
      assert.throws(() => runtime.reconcileInitiativeRun(run, input));
      assert.equal(fs.readFileSync(run.path, 'utf8'), before);
    }
    assert.equal(runtime.reconcileInitiativeRun(run, { target: 'A', claim, by: 'reviewer', decision: 'resume', contract: 'unchanged' }), true);
    const after = fs.readFileSync(run.path, 'utf8');
    assert.throws(() => runtime.reconcileInitiativeRun(run, { target: 'A', claim, by: 'reviewer', decision: 'second decision', contract: 'unchanged' }));
    assert.equal(fs.readFileSync(run.path, 'utf8'), after, 'a resolved claim cannot be reconciled twice');
  });

  test(`${runtimeName}: claims resolve by occurrence, preserving distinct later holds at the same revision`, () => {
    const run = open(runtime, `occurrences-${runtimeName}`);
    runtime.setInitiativePlan(run, { version: 1, targets: [{ ref: 'A', dependsOn: [] }] });
    const revisionA = revision('A');
    const firstOccurrence = { attemptId: 'a1', round: 1 };
    runtime.recordDisposition(run, { target: 'A', revision: revisionA, occurrence: firstOccurrence, result: { reconciliation: { finding: 'gate:first' } } });
    const firstClaim = ledger(run).dispositions.at(-1).packet.delivery.claim;
    runtime.reconcileInitiativeRun(run, { target: 'A', claim: firstClaim, by: 'reviewer', decision: 'resolved first gate', contract: 'unchanged' });
    assert.equal(runtime.terminalTarget(run, 'A', revisionA), false, 'a resolved reconciliation finding is no longer terminal for this pair');

    runtime.recordDisposition(run, { target: 'A', revision: revisionA, occurrence: firstOccurrence, result: { reconciliation: { finding: 'gate:first' } } });
    assert.equal(ledger(run).reconciliationDecisions.length, 1, 're-recording the resolved occurrence cannot recreate its hold');
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'A', revision: revisionA, attemptId: 'a2', round: 1 }), null);

    runtime.recordDisposition(run, { target: 'A', revision: revisionA, occurrence: { attemptId: 'a2', round: 2 }, result: { reconciliation: { finding: 'gate:second' } } });
    const secondClaim = ledger(run).dispositions.at(-1).packet.delivery.claim;
    assert.notEqual(secondClaim, firstClaim);
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'A', revision: revisionA, attemptId: 'a3', round: 2 }), 'reconciliation-required');
    assert.throws(() => runtime.reconcileInitiativeRun(run, { target: 'A', claim: firstClaim, by: 'reviewer', decision: 'try to release newer hold', contract: 'unchanged' }));
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'A', revision: revisionA, attemptId: 'a3', round: 2 }), 'reconciliation-required');
  });

  test(`${runtimeName}: legacy runs preserve global holds and allow human reconciliation without occurrence reopening`, () => {
    const run = open(runtime, `legacy-${runtimeName}`);
    runtime.recordDisposition(run, { target: 'A', revision: revision('A'), result: { reconciliation: { finding: 'gate:A' } } });
    const claim = ledger(run).dispositions.at(-1).packet.delivery.claim;
    assert.notEqual(runtime.denialReason(run, { role: 'correctness', target: 'B', revision: revision('B'), attemptId: 'b1', round: 1 }), null);
    assert.equal(runtime.reconcileInitiativeRun(run, { target: 'A', claim, by: 'reviewer', decision: 'resume', contract: 'unchanged' }), true);
    assert.equal(runtime.denialReason(run, { role: 'correctness', target: 'B', revision: revision('B'), attemptId: 'b1', round: 1 }), null);
    assert.equal(runtime.recordDisposition(run, { target: 'A', revision: revision('A'), result: { reconciliation: { finding: 'gate:A' } } }), false, 'the old occurrence-less claim cannot be recreated for this pair');
    assert.equal(runtime.recordDisposition(run, { target: 'clean', revision: revision('clean'), result: { decision: { converged: true } } }), true);
    assert.equal(runtime.terminalTarget(run, 'clean', revision('clean')).kind, 'terminal', 'ordinary clean terminal dispositions still block replay');
  });

  test(`${runtimeName}: public summary and completion reports do not expose target revisions or reconciliation text`, () => {
    const stateDir = tempDir('initiative-reconcile-privacy-');
    const run = runtime.openInitiativeRun({ stateDir, key: `privacy-${runtimeName}`, repository: '/repo', maxLaunches: 4, maxRounds: 2 });
    const target = 'private-target-ref';
    const base = 'private-base-name';
    const head = 'private-head-sha';
    runtime.recordDisposition(run, {
      target, revision: { ref: target, base, head_sha: head }, occurrence: { attemptId: 'private-attempt', round: 1 },
      result: { reconciliation: { finding: 'private reconciliation detail' } },
    });
    const summary = runtime.publicInitiativeSummary(run);
    assert.doesNotMatch(JSON.stringify(summary), /private-target-ref|private-base-name|private-head-sha|private reconciliation detail/);
    assert.equal(runtime.finaliseInitiativeRun(run), true);
    const id = crypto.createHash('sha256').update(`privacy-${runtimeName}`).digest('hex');
    const reportDir = path.join(stateDir, `initiative-report-${id}`);
    const reportJson = fs.readFileSync(path.join(reportDir, 'report.json'), 'utf8');
    const reportMarkdown = fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8');
    const reportIndex = fs.readFileSync(path.join(stateDir, 'initiative-reports.jsonl'), 'utf8');
    for (const serialized of [reportJson, reportMarkdown, reportIndex]) {
      assert.doesNotMatch(serialized, /private-target-ref|private-base-name|private-head-sha|private reconciliation detail|private-attempt/);
    }
  });
}
