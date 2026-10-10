'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { normalizeArtifact } = require('../../core/artifact-contract');
const { foldTelemetry } = require('../../core/review-telemetry');
const { runPath, openInitiativeRun, recordDisposition } = require('../../core/initiative-review-run');
const { fileTarget } = require('../../core/target');

// The runner owns all sequencing. Its subprocess seam makes this a no-network
// integration test while exercising the real artifact contract at the boundary.
const { runReviewUntilGreen, reviewerPrompt, codexExec, providerExec, resolveCodexExecutable, resolveDefaultBase } = require('../../core/codex-review-runner');
const { reviewerPrompt: packagedReviewerPrompt } = require('../../../concord-codex/engine/codex-review-runner');
const { tempDir } = require('./temp-dir');

function temp() { return tempDir('codex-runner-'); }
function v2Plan(fixes, groups) {
  const fixGroups = (groups || fixes.map((finding) => ({ findingIds: [finding.id], rootCause: finding.summary, invariants: ['fixed behavior'], changeClass: 'local', action: 'fix', findings: [finding] })))
    .map((group) => ({ groupId: group.groupId || group.findingIds[0], ...group }));
  return { protocolVersion: 2, planId: 'test-plan', transactionScope: 'group', fixes, fixGroups };
}

test('initiative terminal recording lock contention fails closed', async () => {
  const stateDir = temp();
  const key = 'terminal-lock';
  const ledgerPath = runPath(stateDir, key);
  await assert.rejects(
    runReviewUntilGreen({
      ref: 'feature/x', repoRoot: '/repo', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
      runCli: ([verb]) => {
        if (verb === 'round-start') {
          fs.mkdirSync(`${ledgerPath}.lock`);
          return { decision: { converged: true }, stateDir };
        }
      },
    }),
    /initiative target terminal recording was contended/,
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).reconciliation, null);
  fs.rmdirSync(`${ledgerPath}.lock`);
});

test('initiative explicit finalise lock contention fails closed', async () => {
  const stateDir = temp();
  const key = 'finalise-lock';
  const ledgerPath = runPath(stateDir, key);
  openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  fs.mkdirSync(`${ledgerPath}.lock`);
  await assert.rejects(
    runReviewUntilGreen({
      initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true,
    }),
    /initiative run finalisation was contended/,
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).status, 'active');
  fs.rmdirSync(`${ledgerPath}.lock`);
});

test('initiative finalisation returns only the safe aggregate', async () => {
  const stateDir = temp();
  const result = await runReviewUntilGreen({
    initiativeRunKey: 'final-summary', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true,
  });
  assert.deepStrictEqual(result, { decision: { finalised: true }, initiative: { targetIds: [], counts: { targets: 0, launches: 0, rounds: 0, findings: {}, checks: 0, telemetry: 0 } } });
});

test('initiative finalisation renders the completion report and index', async () => {
  const stateDir = temp();
  await runReviewUntilGreen({ initiativeRunKey: 'final-report', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true });
  const runId = require('node:crypto').createHash('sha256').update('final-report').digest('hex');
  const dir = path.dirname(fs.realpathSync(runPath(stateDir, 'final-report')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `initiative-report-${runId}`, 'report.json'), 'utf8')).runId, runId);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'initiative-reports.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('matching initiative finalisation replays the same safe aggregate', async () => {
  const stateDir = temp();
  const options = { initiativeRunKey: 'final-replay', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true };
  const first = await runReviewUntilGreen(options);
  const bytes = fs.readFileSync(runPath(stateDir, 'final-replay'));
  assert.deepStrictEqual(await runReviewUntilGreen(options), first);
  assert.deepStrictEqual(fs.readFileSync(runPath(stateDir, 'final-replay')), bytes);
});

test('terminal file targets retain their content identity and preflight without a new round', async () => {
  const stateDir = temp();
  let starts = 0;
  const options = {
    ref: 'file:note.md', repoRoot: '/repo', initiativeRunKey: 'file-terminal', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
    targetIdentity: () => 'content-sha',
    runCli: ([verb]) => {
      if (verb === 'round-start') {
        starts++;
        return { decision: 'terminal', status: 'converged', ref: 'file:note.md', head: 'content-sha', stateDir, dodPassed: true, dodDeferred: true };
      }
    },
  };
  await runReviewUntilGreen(options);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(runPath(stateDir, 'file-terminal'), 'utf8')).targets, [{ ref: 'file:note.md', head_sha: 'content-sha' }]);
  starts = 0;
  const replay = await runReviewUntilGreen({ ...options, targetIdentity: () => 'content-sha', runCli: () => { starts++; throw new Error('round-start must not run'); } });
  assert.strictEqual(starts, 0);
  assert.deepStrictEqual(replay.initiative.counts.targets, 1);
});

test('a changed target head opens a new target and reaches round-start', async () => {
  const stateDir = temp();
  const key = 'changed-terminal';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, targets: [{ ref: 'file:note.md', head_sha: 'old-bytes' }], dispositions: [{ target: 'file:note.md', reason: 'clean', kind: 'terminal', revision: { ref: 'file:note.md', head_sha: 'old-bytes' } }] }));
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'new-bytes', runCli: () => { throw new Error('round-start reached'); } }),
    /round-start reached/,
  );
});

test('a legacy terminal file target without head_sha does not match and reaches round-start', async () => {
  const stateDir = temp();
  const key = 'legacy-file-terminal';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, targets: [{ ref: 'file:note.md' }], dispositions: [{ target: 'file:note.md', reason: 'clean', kind: 'terminal', revision: { ref: 'file:note.md' } }] }));
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'new-bytes', runCli: () => { throw new Error('round-start reached'); } }),
    /round-start reached/,
  );
});

test('a different base with the same head is a new target', async () => {
  const stateDir = temp();
  const key = 'same-head-different-base';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', base: 'main', head_sha: 'same-head' } }] }));
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', base: 'release', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'same-head', runCli: () => { throw new Error('round-start reached'); } }), /round-start reached/);
});

test('resuming a terminal git target binds the review ledger base before identity and round-start', async () => {
  const stateDir = temp();
  const key = 'resume-terminal-base';
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', base: headCommit, head_sha: 'same-head' } }] }));
  let identityBase;
  const result = await runReviewUntilGreen({ ref: 'feature/x', resume: true, initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: (_ref, base) => { identityBase = base; return 'same-head'; }, runCli: ([verb]) => { if (verb === 'show') return { target: { base: 'HEAD' } }; throw new Error('round-start must not run'); } });
  assert.strictEqual(identityBase, 'HEAD');
  assert.strictEqual(result.decision, 'terminal');
});

test('terminal git target replay rejects a dirty worktree before returning its cached result', async () => {
  const repoRoot = temp();
  const stateDir = temp();
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'note.md'), 'clean\n');
  execFileSync('git', ['add', 'note.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const options = { ref: 'feature/x', base: 'HEAD', repoRoot, initiativeRunKey: 'dirty-terminal', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1 };
  await runReviewUntilGreen({ ...options, runCli: ([verb]) => verb === 'round-start' ? { decision: 'terminal', status: 'converged', base: 'HEAD', head, stateDir } : undefined });
  fs.writeFileSync(path.join(repoRoot, 'note.md'), 'dirty\n');
  await assert.rejects(
    runReviewUntilGreen({ ...options, runCli: () => { throw new Error('round-start must not run'); } }),
    /working tree is dirty; commit or stash before review-until-green/,
  );
});

test('resuming a git target with no base in the review ledger fails closed before identity and round-start', async () => {
  const stateDir = temp();
  const key = 'resume-no-base';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', base: 'main', head_sha: 'same-head' } }] }));
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', resume: true, initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => { throw new Error('identity must not run'); }, runCli: ([verb]) => { if (verb === 'show') return {}; throw new Error('round-start must not run'); } }), /no recorded base/);
});

test('resuming a git target with no base in the review ledger and no disposition reaches round-start', async () => {
  const stateDir = temp();
  const key = 'resume-no-base-no-disposition';
  openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', resume: true, initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'head', runCli: ([verb]) => { if (verb === 'show') return {}; throw new Error('round-start reached'); } }), /round-start reached/);
});

test('resume does not replay a terminal on the same head with another base', async () => {
  const stateDir = temp();
  const key = 'resume-same-head-other-base';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', base: 'main', head_sha: 'same-head' } }] }));
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', resume: true, initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'same-head', runCli: ([verb]) => { if (verb === 'show') return { target: { base: 'release' } }; throw new Error('round-start reached'); } }), /round-start reached/);
});

test('non-Git in-root state supports file and finalise runs', async () => {
  const repoRoot = temp();
  const stateDir = path.join(repoRoot, '.state');
  fs.writeFileSync(path.join(repoRoot, 'note.md'), 'note');
  await runReviewUntilGreen({ ref: 'file:note.md', repoRoot, initiativeRunKey: 'file-non-git', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'file-head', runCli: ([verb]) => verb === 'round-start' ? { decision: 'terminal', status: 'converged', ref: 'file:note.md', head: 'file-head', stateDir } : undefined });
  const finalised = await runReviewUntilGreen({ repoRoot, initiativeRunKey: 'finalise-non-git', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true });
  assert.deepStrictEqual(finalised.decision, { finalised: true });
});

test('initiative state inside a repository must be ignored before its ledger is created', async () => {
  const repoRoot = temp();
  const stateDir = path.join(repoRoot, '.concord-state');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  await assert.rejects(
    runReviewUntilGreen({ initiativeRunKey: 'inside-repo', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true, repoRoot }),
    /must be ignored/,
  );
  assert.strictEqual(fs.existsSync(stateDir), false);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.concord-state/\n');
  const result = await runReviewUntilGreen({ initiativeRunKey: 'inside-repo', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true, repoRoot });
  assert.deepStrictEqual(result.decision, { finalised: true });
});

test('initiative ignore validation checks the hashed ledger, not a hidden probe', async () => {
  const repoRoot = temp();
  const stateDir = path.join(repoRoot, 'state');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.*\n');
  await assert.rejects(
    runReviewUntilGreen({ initiativeRunKey: 'probe-only', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true, repoRoot }),
    /must be ignored/,
  );
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'state/\n');
  await runReviewUntilGreen({ initiativeRunKey: 'probe-only', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, initiativeFinalise: true, repoRoot });
});

test('initiative terminal evidence uses record reconciliation and post-fix DoD checks', async () => {
  const stateDir = temp();
  await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo', initiativeRunKey: 'final-packet', initiativeStateDir: stateDir, initiativeMaxLaunches: 2, initiativeMaxRounds: 1,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', ref: 'feature/x', base: 'main', head: 'reviewed-head', attemptId: 'attempt-1', round: 1, stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] }
          : { decision: { continue: false, intentReview: true }, reconciliation: { finding: 'intent:missing', stage: 'record', avoidedLaunches: 2, findings: { intent: 1 } }, checks: [{ name: 'definition-of-done', status: 'passed' }] },
    spawn: async () => ({ status: 0 }),
  });
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'final-packet'), 'utf8'));
  assert.deepStrictEqual(ledger.targets, [{ ref: 'feature/x', base: 'main', head_sha: 'reviewed-head' }]);
  assert.deepStrictEqual(ledger.checks, [{ name: 'definition-of-done', status: 'passed' }]);
  assert.deepStrictEqual(ledger.reconciliation.hint.firstMaterialFinding, 'intent:missing');
});

test('initiative terminal string decisions are recorded', async () => {
  const stateDir = temp();
  await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo', initiativeRunKey: 'terminal-string', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
    runCli: ([verb]) => verb === 'round-start' ? { decision: 'terminal', status: 'parked', base: 'main', head: 'head', stateDir, dodPassed: false, dodDeferred: false } : undefined,
  });
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'terminal-string'), 'utf8'));
  assert.deepStrictEqual(ledger.reconciliation.terminals, [{ target: 'feature/x', reason: 'parked', revision: { ref: 'feature/x', base: 'main', head_sha: 'head' } }]);
  assert.deepStrictEqual(ledger.targets, [{ ref: 'feature/x', base: 'main', head_sha: 'head' }]);
});

test('initiative runner records escaped results and thrown errors as durable dispositions', async () => {
  const stateDir = temp();
  const escaped = { ref: 'feature/escape', repoRoot: '/repo', initiativeRunKey: 'escaped', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1 };
  await runReviewUntilGreen({ ...escaped, runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'escape', base: 'main', head: 'head', stateDir } : undefined });
  const escapedLedger = JSON.parse(fs.readFileSync(runPath(stateDir, 'escaped'), 'utf8'));
  assert.deepStrictEqual(escapedLedger.dispositions[0].packet.outcome, { kind: 'escape', reason: 'escape' });
  assert.strictEqual(escapedLedger.dispositions[0].packet.delivery.consumed, false);

  const failed = { ref: 'feature/error', repoRoot: '/repo', initiativeRunKey: 'errored', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1 };
  let error;
  await assert.rejects(runReviewUntilGreen({ ...failed, runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false } : verb === 'artifact-normalize' ? { status: 'ok' } : undefined, spawn: async () => { throw new Error('subprocess failed'); } }), (caught) => { error = caught; return /Provider execution failed without a recognized diagnostic/.test(caught.message); });
  assert.strictEqual(error.continuationPacket.delivery.consumed, false);
  const errorDisposition = JSON.parse(fs.readFileSync(runPath(stateDir, 'errored'), 'utf8')).dispositions[0];
  assert.deepStrictEqual(errorDisposition.packet.exit, { code: null, signal: null });
  assert.deepStrictEqual(errorDisposition.packet.telemetry, { complete: false });
  assert.strictEqual(errorDisposition.packet.nextAction, 'terminal-handoff');
});

test('initiative terminal recording contended by an already-recorded matching disposition returns its packet instead of throwing', async () => {
  const stateDir = temp();
  const key = 'terminal-race';
  const run = { path: runPath(stateDir, key) }; // ledger is opened by runReviewUntilGreen itself before round-start runs below
  const result = await runReviewUntilGreen({
    ref: 'feature/race', repoRoot: '/repo', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
    runCli: ([verb]) => {
      if (verb === 'round-start') {
        // Simulate a concurrent runReviewUntilGreen invocation that converges on the
        // identical target+revision and wins the recordDisposition race before this
        // run's own withTelemetry call attempts to record the same terminal outcome.
        recordDisposition(run, {
          target: 'feature/race',
          revision: { ref: 'feature/race', base: 'main', head_sha: 'race-head' },
          result: { decision: 'terminal', status: 'clean' },
          packet: { trigger: 'terminal', nextAction: 'replay' },
        });
        return { decision: 'terminal', status: 'clean', base: 'main', head: 'race-head', stateDir };
      }
    },
  });
  assert.strictEqual(result.decision, 'terminal');
  assert.ok(result.continuationPacket);
  assert.deepStrictEqual(result.continuationPacket.outcome, { kind: 'terminal', reason: 'clean' });
});

test('initiative runner preserves the acquired revision when round-start fails early', async () => {
  const stateDir = temp();
  const repoRoot = temp();
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/early-error', repoRoot, initiativeRunKey: 'early-error', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'immutable-head', runCli: () => { throw new Error('round-start failed'); } }),
    /round-start failed/,
  );
  const disposition = JSON.parse(fs.readFileSync(runPath(stateDir, 'early-error'), 'utf8')).dispositions[0];
  assert.deepStrictEqual(disposition.revision, { ref: 'feature/early-error', head_sha: 'immutable-head' });
  assert.strictEqual(disposition.kind, 'error');
});

test('initiative runner records an unsupported provider before work starts', async () => {
  const stateDir = temp();
  const repoRoot = temp();
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/provider-error', base: 'main', repoRoot, reviewer: 'unsupported', initiativeRunKey: 'provider-error', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'immutable-head' }),
    /unsupported provider/,
  );
  const disposition = JSON.parse(fs.readFileSync(runPath(stateDir, 'provider-error'), 'utf8')).dispositions[0];
  assert.deepStrictEqual(disposition.revision, { ref: 'feature/provider-error', base: 'main', head_sha: 'immutable-head' });
  assert.strictEqual(disposition.kind, 'error');
});

test('initiative runner records a default-base resolution failure with its immutable revision', async () => {
  const stateDir = temp();
  const repoRoot = temp();
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/base-error', repoRoot, initiativeRunKey: 'base-error', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'immutable-head' }),
    /cannot determine a remote default base/,
  );
  const disposition = JSON.parse(fs.readFileSync(runPath(stateDir, 'base-error'), 'utf8')).dispositions[0];
  assert.deepStrictEqual(disposition.revision, { ref: 'feature/base-error', head_sha: 'immutable-head' });
  assert.strictEqual(disposition.kind, 'error');
});

test('initiative runner leaves its terminal delivery claim unconsumed until the launcher acknowledges output', async () => {
  const stateDir = temp();
  const result = await runReviewUntilGreen({ ref: 'feature/deliver', base: 'main', repoRoot: '/repo', initiativeRunKey: 'deliver', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, runCli: ([verb]) => verb === 'round-start' ? { decision: 'terminal', status: 'clean', base: 'main', head: 'head', stateDir } : undefined });
  assert.strictEqual(result.continuationPacket.delivery.consumed, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(runPath(stateDir, 'deliver'), 'utf8')).dispositions[0].packet.delivery.consumed, false);
  const replay = await runReviewUntilGreen({ ref: 'feature/deliver', base: 'main', repoRoot: '/repo', initiativeRunKey: 'deliver', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'head', runCli: () => { throw new Error('round-start must not run'); } });
  assert.strictEqual(replay.continuationPacket.delivery.claim, result.continuationPacket.delivery.claim);
  assert.strictEqual(replay.continuationPacket.outcome.reason, 'clean');
});

test('initiative runner replays an unconsumed duplicate escape handoff', async () => {
  const stateDir = temp();
  const options = { ref: 'feature/escape-replay', base: 'main', repoRoot: '/repo', initiativeRunKey: 'escape-replay', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
    runCli: ([verb]) => verb === 'round-start' ? { decision: 'escape', base: 'main', head: 'head', stateDir } : undefined };
  const first = await runReviewUntilGreen(options);
  const replay = await runReviewUntilGreen({ ...options, targetIdentity: () => 'head', runCli: () => { throw new Error('round-start must not run'); } });
  assert.strictEqual(replay.decision, 'escape');
  assert.strictEqual(replay.continuationPacket.delivery.claim, first.continuationPacket.delivery.claim);
  assert.deepStrictEqual(replay.continuationPacket.outcome, { kind: 'escape', reason: 'escape' });
});

test('initiative runner starts a new round after a consumed escape disposition at the same revision', async () => {
  const stateDir = temp();
  const options = { ref: 'feature/escape-consumed', base: 'main', repoRoot: '/repo', initiativeRunKey: 'escape-consumed', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
    runCli: ([verb]) => verb === 'round-start' ? { decision: 'escape', base: 'main', head: 'head', stateDir } : undefined };
  await runReviewUntilGreen(options);
  const ledgerPath = runPath(stateDir, 'escape-consumed');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const firstClaim = ledger.dispositions[0].packet.delivery.claim;
  ledger.dispositions[0].packet.delivery.consumed = true;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  let roundStarted = false;
  const retry = await runReviewUntilGreen({ ...options, targetIdentity: () => 'head', runCli: ([verb]) => { if (verb === 'round-start') { roundStarted = true; return { decision: 'escape', base: 'main', head: 'head', stateDir }; } return undefined; } });
  assert.strictEqual(roundStarted, true);
  assert.strictEqual(retry.decision, 'escape');
  // The second escape is a NEW occurrence, not a replay of the first
  // (consumed) one: it must get its own ledger entry and its own,
  // not-yet-consumed delivery claim -- otherwise it's silently dropped.
  const afterRetry = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.strictEqual(afterRetry.dispositions.length, 2);
  assert.notStrictEqual(retry.continuationPacket.delivery.claim, firstClaim);
  assert.strictEqual(retry.continuationPacket.delivery.consumed, false);
});

test('a non-material gate-pending record result produces a working, resumable escape packet', async () => {
  // Unlike the literal string decision:'escape' above, this drives the
  // runner through record's object-shaped gatePending decision (with no
  // reconciliation, i.e. no material finding) -- the real production path
  // normalizeDisposition now classifies as 'escape'. This is the exact
  // end-to-end path the prior unit-level tests (normalizeDisposition,
  // recordDisposition, terminalTarget called directly) never exercised,
  // which is why withTelemetry's stale `escaped` computation went unnoticed.
  const stateDir = temp();
  const options = { ref: 'feature/gate-pending', base: 'main', repoRoot: '/repo', initiativeRunKey: 'gate-pending-e2e', initiativeStateDir: stateDir, initiativeMaxLaunches: 8, initiativeMaxRounds: 4,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] }
          : { decision: { continue: false, gatePending: true } },
    spawn: async () => ({ status: 0 }) };
  const result = await runReviewUntilGreen(options);
  assert.ok(result.continuationPacket, 'gate-pending must produce a continuationPacket, not throw');
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'gate-pending-e2e'), 'utf8'));
  assert.strictEqual(ledger.dispositions.length, 1);
  assert.strictEqual(ledger.dispositions[0].kind, 'escape');
  assert.strictEqual(ledger.dispositions[0].reason, 'gate-pending');
  assert.strictEqual(ledger.dispositions[0].packet.nextAction, 'resume');
  // Consume it, then confirm a retry at the same revision actually reaches
  // round-start again instead of replaying the stale packet forever.
  ledger.dispositions[0].packet.delivery.consumed = true;
  fs.writeFileSync(runPath(stateDir, 'gate-pending-e2e'), JSON.stringify(ledger));
  let roundStarted = false;
  await runReviewUntilGreen({ ...options, targetIdentity: () => 'head', runCli: ([verb]) => {
      if (verb === 'reserve') return { status: 'granted' }; if (verb === 'round-start') roundStarted = true; return options.runCli([verb]); } });
  assert.strictEqual(roundStarted, true);
});

test('a final DoD failure produces a working, resumable escape packet', async () => {
  const stateDir = temp();
  const options = { ref: 'feature/dod-failed', base: 'main', repoRoot: '/repo', initiativeRunKey: 'dod-failed-e2e', initiativeStateDir: stateDir, initiativeMaxLaunches: 8, initiativeMaxRounds: 4,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] }
          : { decision: { continue: false, dodFailed: true } },
    spawn: async () => ({ status: 0 }) };
  const result = await runReviewUntilGreen(options);
  assert.deepStrictEqual(result.continuationPacket.outcome, { kind: 'escape', reason: 'dod-failed' });
  assert.strictEqual(result.continuationPacket.nextAction, 'resume');
});

test('a consumed gate-pending retry does not double-count the prior round\'s telemetry', async () => {
  const stateDir = temp();
  const options = { ref: 'feature/gp-telemetry', base: 'main', repoRoot: '/repo', initiativeRunKey: 'gp-telemetry', initiativeStateDir: stateDir, initiativeMaxLaunches: 8, initiativeMaxRounds: 4,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] }
          : { decision: { continue: false, gatePending: true } },
    spawn: async () => ({ status: 0 }) };
  await runReviewUntilGreen(options);
  const ledgerPath = runPath(stateDir, 'gp-telemetry');
  let ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const firstRoundCount = ledger.telemetry.length;
  assert.ok(firstRoundCount > 0);
  ledger.dispositions[0].packet.delivery.consumed = true;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  await runReviewUntilGreen({ ...options, targetIdentity: () => 'head' });
  ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  // The local telemetry cache must be cleared once an escape/gate-pending
  // recording is captured durably in the ledger, or the second round
  // reloads the first round's invocations and records them again on top
  // of its own -- the second recording must add only its OWN entries.
  assert.strictEqual(ledger.telemetry.length, firstRoundCount * 2);
});

test('initiative provider errors retain completed DoD and a separate claim for each actual launch', async () => {
  const stateDir = temp();
  const options = { ref: 'feature/error-retry', base: 'main', repoRoot: '/repo', initiativeRunKey: 'error-retry', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 2,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false } : verb === 'artifact-normalize' ? { status: 'ok' } : undefined,
    spawn: async () => { throw new Error('subprocess failed'); } };
  let first;
  await assert.rejects(runReviewUntilGreen(options), (error) => { first = error; return /Provider execution failed without a recognized diagnostic/.test(error.message); });
  assert.deepStrictEqual(first.continuationPacket.dod, { status: 'passed' });
  assert.match(first.continuationPacket.error.message, /Provider execution failed without a recognized diagnostic/);
  assert.strictEqual(first.continuationPacket.nextAction, 'terminal-handoff');
  let second;
  await assert.rejects(runReviewUntilGreen(options), (error) => { second = error; return /Provider execution failed without a recognized diagnostic/.test(error.message); });
  assert.notStrictEqual(second.continuationPacket.delivery.claim, first.continuationPacket.delivery.claim);
  assert.strictEqual(JSON.parse(fs.readFileSync(runPath(stateDir, 'error-retry'), 'utf8')).dispositions.length, 2);
});

test('initiative provider retry preserves consumed history and returns a new delivery claim', async () => {
  const stateDir = temp();
  const options = { ref: 'feature/error-consumed', base: 'main', repoRoot: '/repo', initiativeRunKey: 'error-consumed', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 2,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false } : verb === 'artifact-normalize' ? { status: 'ok' } : undefined,
    spawn: async () => { throw new Error('subprocess failed'); } };
  let first;
  await assert.rejects(runReviewUntilGreen(options), (error) => { first = error; return /Provider execution failed without a recognized diagnostic/.test(error.message); });
  const ledgerPath = runPath(stateDir, 'error-consumed');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.dispositions[0].packet.delivery.consumed = true;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  await assert.rejects(runReviewUntilGreen(options), (error) => error.continuationPacket.delivery.claim !== first.continuationPacket.delivery.claim && error.continuationPacket.delivery.consumed === false);
  const after = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.deepStrictEqual(after.dispositions[0], ledger.dispositions[0]);
  assert.strictEqual(after.dispositions.length, 2);
});

test('initiative generic harness replay deduplicates the same Error and reads back its consumed claim', async () => {
  const stateDir = temp();
  const sameError = new Error('harness normalization failed');
  let launches = 0;
  let recordedFailure;
  const options = { ref: 'feature/harness-error-retry', base: 'main', repoRoot: '/repo', initiativeRunKey: 'harness-error-retry', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 2,
    runCli: ([verb, , failureJson]) => {
      if (verb === 'reserve') return { status: 'granted' };
      if (verb === 'round-start') return { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') throw sameError;
      if (verb === 'round-failure') { recordedFailure = JSON.parse(failureJson); return { status: 'recorded' }; }
      if (verb === 'show') return { round: 1, execution: { failure: recordedFailure } };
    },
    spawn: async () => { launches++; return { status: 0 }; } };
  let first;
  await assert.rejects(runReviewUntilGreen(options), (error) => { first = error; return error === sameError; });
  const file = runPath(stateDir, 'harness-error-retry');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.dispositions[0].packet.delivery.consumed = true;
  fs.writeFileSync(file, JSON.stringify(stored));
  const priorPacket = first.continuationPacket;
  await assert.rejects(runReviewUntilGreen(options), (error) => error === sameError && error.continuationPacket.delivery.claim === priorPacket.delivery.claim && error.continuationPacket.delivery.consumed === true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after.dispositions, stored.dispositions);
  assert.strictEqual(launches, 2, 'generic harness dedup must not hide actual provider activity');
});

test('initiative records a distinct second failure at an unchanged revision instead of masking it as a duplicate', async () => {
  const stateDir = temp();
  let call = 0;
  const options = { ref: 'feature/error-distinct', base: 'main', repoRoot: '/repo', initiativeRunKey: 'error-distinct', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 2,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false } : verb === 'artifact-normalize' ? { status: 'ok' } : undefined,
    spawn: async () => { call++; throw Object.assign(new Error('opaque provider detail'), { code: call === 1 ? 'ETIMEDOUT' : 'ENOENT' }); } };
  let first;
  await assert.rejects(runReviewUntilGreen(options), (error) => { first = error; return /Provider execution failed temporarily/.test(error.message); });
  let second;
  await assert.rejects(runReviewUntilGreen(options), (error) => { second = error; return /Provider execution failed without a recognized diagnostic/.test(error.message); });
  assert.notStrictEqual(second.continuationPacket.delivery.claim, first.continuationPacket.delivery.claim);
  assert.match(second.continuationPacket.error.message, /Provider execution failed without a recognized diagnostic/);
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'error-distinct'), 'utf8'));
  assert.strictEqual(ledger.dispositions.length, 2);
});

test('separate A B A provider failures each retrieve their own occurrence packet', async () => {
  const stateDir = temp();
  let call = 0;
  const options = { ref: 'feature/error-abab', base: 'main', repoRoot: '/repo', initiativeRunKey: 'error-abab', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 2,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false } : verb === 'artifact-normalize' ? { status: 'ok' } : undefined,
    // The third launch repeats A's canonical diagnostic, but is a distinct
    // actual provider invocation with its own audit and delivery occurrence.
    spawn: async () => { call++; throw Object.assign(new Error('opaque provider detail'), { code: call === 2 ? 'ENOENT' : 'ETIMEDOUT' }); } };
  let first;
  await assert.rejects(runReviewUntilGreen(options), (error) => { first = error; return /Provider execution failed temporarily/.test(error.message); });
  let second;
  await assert.rejects(runReviewUntilGreen(options), (error) => { second = error; return /Provider execution failed without a recognized diagnostic/.test(error.message); });
  const third = await runReviewUntilGreen(options).catch((error) => error);
  assert.match(third.message, /Provider execution failed temporarily/);
  assert.notStrictEqual(third.continuationPacket.delivery.claim, first.continuationPacket.delivery.claim);
  assert.notStrictEqual(third.continuationPacket.delivery.claim, second.continuationPacket.delivery.claim);
  assert.match(third.continuationPacket.error.message, /Provider execution failed temporarily/);
  assert.strictEqual(call, 3);
  assert.strictEqual(JSON.parse(fs.readFileSync(runPath(stateDir, 'error-abab'), 'utf8')).dispositions.length, 3);
});

test('initiative accepts a runner-owned fixer revision on the next round', async () => {
  const stateDir = temp();
  let round = 0;
  await runReviewUntilGreen({
    ref: 'feature/fixed', base: 'main', repoRoot: '/repo', initiativeRunKey: 'fixed-revision', initiativeStateDir: stateDir, initiativeMaxLaunches: 8, initiativeMaxRounds: 2,
    runCli: ([verb]) => {
      if (verb === 'reserve') return { status: 'granted' };
      if (verb === 'round-start') return { decision: 'work', round: ++round, base: 'main', head: round === 1 ? 'before' : 'after', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') return { status: 'ok' };
      if (verb === 'plan-fixes') return v2Plan(round === 1 ? [{ id: 'correctness:bug', file: 'a.txt', span: 'bad', summary: 'fix it' }] : []);
      if (verb === 'commit-fix') return { committed: true, sha: 'after' };
      if (verb === 'record') return round === 1 ? { decision: { continue: true } } : { decision: { continue: false, converged: true } };
    },
    spawn: async () => ({ status: 0 }),
  });
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'fixed-revision'), 'utf8'));
  assert.deepStrictEqual(ledger.dispositions[0].revision, { ref: 'feature/fixed', base: 'main', head_sha: 'after' });
});

test('initiative rejects a revision that differs from the committed fixer revision', async () => {
  const stateDir = temp();
  let round = 0;
  await assert.rejects(runReviewUntilGreen({
    ref: 'feature/fixed-drift', base: 'main', repoRoot: '/repo', initiativeRunKey: 'fixed-drift', initiativeStateDir: stateDir, initiativeMaxLaunches: 8, initiativeMaxRounds: 2,
    runCli: ([verb]) => {
      if (verb === 'reserve') return { status: 'granted' };
      if (verb === 'round-start') return { decision: 'work', round: ++round, base: 'main', head: round === 1 ? 'before' : 'other', stateDir, targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') return { status: 'ok' };
      if (verb === 'plan-fixes') return v2Plan([{ id: 'correctness:bug', file: 'a.txt', span: 'bad', summary: 'fix it' }]);
      if (verb === 'commit-fix') return { committed: true, sha: 'after' };
      if (verb === 'record') return { decision: { continue: true } };
    },
    spawn: async () => ({ status: 0 }),
  }), /initiative target revision changed before round-start/);
});

test('initiative accepts a file identity produced by its fixer', async () => {
  const stateDir = temp();
  const repoRoot = temp();
  const note = path.join(repoRoot, 'note.md');
  fs.writeFileSync(note, 'before\n');
  const identity = () => fs.readFileSync(note, 'utf8');
  let round = 0;
  await runReviewUntilGreen({
    ref: 'file:note.md', repoRoot, initiativeRunKey: 'file-fixed', initiativeStateDir: stateDir, initiativeMaxLaunches: 8, initiativeMaxRounds: 2, targetIdentity: identity,
    runCli: ([verb]) => {
      if (verb === 'reserve') return { status: 'granted' };
      if (verb === 'round-start') return { decision: 'work', round: ++round, head: identity(), stateDir, targetType: 'file', dodPassed: true, dodDeferred: true, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') return { status: 'ok' };
      if (verb === 'plan-fixes') return v2Plan(round === 1 ? [{ id: 'docreview:fix', file: 'note.md', span: 'before', summary: 'fix it' }] : []);
      if (verb === 'record') return round === 1 ? { decision: { continue: true } } : { decision: { continue: false, converged: true } };
    },
    spawn: async ({ role }) => { if (role === 'fix') fs.writeFileSync(note, 'after\n'); return { status: 0 }; },
  });
});

test('reconciliation terminates the target and retains its restored base and avoided fixes', async () => {
  const stateDir = temp();
  await runReviewUntilGreen({
    ref: 'feature/x', resume: true, repoRoot: '/repo', initiativeRunKey: 'reconcile', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 1,
    runCli: ([verb]) => {
      if (verb === 'reserve') return { status: 'granted' };
      if (verb === 'show') return { target: { base: 'main' } };
      if (verb === 'round-start') return { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') return { status: 'ok' };
      if (verb === 'plan-fixes') return { ...v2Plan([]), avoidedLaunches: 2, reconciliation: { finding: 'intent:missing', findings: { intent: 1 } } };
      if (verb === 'record') return { decision: { continue: false, intentReview: true }, reconciliation: { finding: 'intent:missing', stage: 'record', avoidedLaunches: 2, findings: { intent: 1 } } };
    },
    spawn: async () => ({ status: 0 }),
  });
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'reconcile'), 'utf8'));
  assert.deepStrictEqual(ledger.targets, [{ ref: 'feature/x', base: 'main', head_sha: 'head' }]);
  assert.deepStrictEqual(ledger.reconciliation.hint.avoidedLaunches, 2);
  assert.deepStrictEqual(ledger.checks, [{ name: 'definition-of-done', status: 'failed' }]);
});

test('parked and abandoned target outcomes take precedence over reconciliation metadata', async () => {
  const stateDir = temp();
  for (const outcome of ['parked', 'abandoned']) {
    await runReviewUntilGreen({
      ref: 'feature/x', repoRoot: '/repo', initiativeRunKey: `${outcome}-over-reconcile`, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1,
      runCli: ([verb]) => verb === 'round-start' ? { decision: { [outcome]: true }, head: 'head', reconciliation: { finding: 'intent:missing' }, stateDir } : undefined,
    });
    const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, `${outcome}-over-reconcile`), 'utf8'));
    assert.deepStrictEqual(ledger.reconciliation.terminals, [{ target: 'feature/x', reason: outcome, revision: { ref: 'feature/x', head_sha: 'head' } }]);
  }
});

test('initiative terminal records object decision reason and deferred DoD accurately', async () => {
  const stateDir = temp();
  await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo', initiativeRunKey: 'deferred-terminal', initiativeStateDir: stateDir, initiativeMaxLaunches: 2, initiativeMaxRounds: 1,
    runCli: ([verb]) => verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: true, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] }
          : { decision: { continue: false, converged: true } },
    spawn: async () => ({ status: 0 }),
  });
  const ledger = JSON.parse(fs.readFileSync(runPath(stateDir, 'deferred-terminal'), 'utf8'));
  assert.deepStrictEqual(ledger.reconciliation.terminals, [{ target: 'feature/x', reason: 'clean', revision: { ref: 'feature/x', base: 'main', head_sha: 'head' } }]);
  assert.deepStrictEqual(ledger.checks, [{ name: 'definition-of-done', status: 'deferred' }]);
});

test('Codex resolver falls back to the macOS app after a broken PATH command', () => {
  const calls = [];
  const resolved = resolveCodexExecutable('/repo', {
    platform: 'darwin', env: { PATH: '/broken' },
    probe: (command) => {
      calls.push(command);
      return command === 'codex' ? { error: { code: 'ENOENT' } } : { status: 0, stdout: 'codex-cli 0.154.0\n' };
    },
  });
  assert.deepStrictEqual(calls, ['codex', '/Applications/ChatGPT.app/Contents/Resources/codex']);
  assert.strictEqual(resolved.command, '/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.strictEqual(resolved.version, 'codex-cli 0.154.0');
});

test('Codex resolver treats an explicit override as authoritative', () => {
  assert.throws(() => resolveCodexExecutable('/repo', {
    platform: 'darwin', env: { CONCORD_CODEX_BIN: '/broken/codex' },
    probe: () => ({ error: { code: 'ENOENT' } }),
  }), /no usable Codex executable/);
});

test('codex-review-runner.js has no hardcoded copy of the panel lens list -- it must import report.js\'s PANEL_LENSES', () => {
  // Guards the third-copy bug: this module used to hardcode the five lens
  // names alongside report.js's PANEL_LENSES (review-cli.js's own copy), so
  // adding a sixth lens would silently spawn it in one path and skip it in
  // the other. A source grep for a literal 5-element lens array catches a
  // regression even if some future refactor stops calling it "lenses".
  const src = fs.readFileSync(require.resolve('../../core/codex-review-runner.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/report['"]\)/.test(src),
    'codex-review-runner.js must require ./report to get PANEL_LENSES',
  );
  assert.ok(
    !/\[\s*['"]ac-coverage['"]\s*,\s*['"]design-conformance['"]\s*,\s*['"]cross-context['"]\s*,\s*['"]silent-gap['"]\s*,\s*['"]threat-model['"]\s*\]/.test(src),
    'codex-review-runner.js must not hardcode the panel lens list -- import report.js\'s PANEL_LENSES instead',
  );
});

test('codexExec starts subprocesses asynchronously so panel work can overlap', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const started = path.join(binDir, 'started');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse { const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(started)}, '1'); const wait = setInterval(() => { if (fs.readFileSync(${JSON.stringify(started)}, 'utf8').length === 2) { clearInterval(wait); process.exit(0); } }, 10); }\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const first = codexExec({ role: 'panel', prompt: 'first', repoRoot: binDir, stateDir: binDir, timeoutMs: 15000, codexExecutable: { command: codex, version: 'codex-cli 0.154.0' } });
    const second = codexExec({ role: 'panel', prompt: 'second', repoRoot: binDir, stateDir: binDir, timeoutMs: 15000, codexExecutable: { command: codex, version: 'codex-cli 0.154.0' } });
    assert.strictEqual(typeof first?.then, 'function');
    const results = await Promise.all([first, second]);
    assert.deepStrictEqual(results.map((result) => result.status), [0, 0]);
    assert.strictEqual(fs.readFileSync(started, 'utf8'), '11');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec probes the CLI version once for concurrent calls', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const probes = path.join(binDir, 'probes');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) { require('node:fs').appendFileSync(${JSON.stringify(probes)}, '1'); process.stdout.write('codex-cli 0.154.0\\n'); }\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await Promise.all([
      codexExec({ role: 'correctness', prompt: 'first', repoRoot: binDir, stateDir: binDir }),
      codexExec({ role: 'verify', prompt: 'second', repoRoot: binDir, stateDir: binDir }),
    ]);
    assert.strictEqual(fs.readFileSync(probes, 'utf8'), '1');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec parses documented turn.completed usage without retaining agent output', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse { require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'discard me' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3 } }) + '\\n'); }\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await codexExec({
      role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir,
      requestedModel: 'gpt-5.1-codex', reasoningEffort: 'high', serviceTier: 'priority',
    });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepStrictEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-5.1-codex']);
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(args.includes('service_tier="priority"'));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.role, 'correctness');
    assert.strictEqual(result.engine, 'codex');
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.providerSchema, 'codex-exec-json-v1');
    assert.strictEqual(result.requestedModel, 'gpt-5.1-codex');
    assert.strictEqual(result.reasoningEffort, 'high');
    assert.strictEqual(result.serviceTier, 'priority');
    assert.strictEqual(result.resolvedModel, 'unavailable');
    assert.match(result.invocationId, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
    assert.strictEqual(result.usagePartial, false);
    assert.deepStrictEqual(result.usage, {
      inputTokens: 95,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      reasoningOutputTokens: 3,
      outputTokens: 4,
      totalTokens: 127,
    });
    assert.deepStrictEqual(result.providerUsage, {
      input_tokens: 120,
      cached_input_tokens: 20,
      cache_write_input_tokens: 5,
      output_tokens: 7,
      reasoning_output_tokens: 3,
    });
  } finally {
    process.env.PATH = previousPath;
  }
});

for (const [provider, executable, expectedArgs] of [
  ['claude', 'claude', ['-p', '--model', 'review-model']],
  ['copilot', 'copilot', ['-p', '--model', 'review-model', '--allow-all-tools', '--allow-all-paths', '--no-ask-user']],
]) test(`providerExec invokes ${provider} non-interactively with the requested model`, async () => {
  const binDir = temp();
  const executablePath = path.join(binDir, executable);
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(executablePath, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(executablePath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await providerExec({
      provider, role: 'correctness', prompt: 'review', repoRoot: binDir,
      stateDir: binDir, requestedModel: 'review-model',
    });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    for (const expected of expectedArgs) assert.ok(args.includes(expected), `${provider} arguments omitted ${expected}`);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.engine, provider);
    assert.strictEqual(result.requestedModel, 'review-model');
    assert.strictEqual(result.usagePartial, true);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('providerExec keeps the Claude prompt separate from the variadic --add-dir option', async () => {
  const binDir = temp();
  const claude = path.join(binDir, 'claude');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(claude, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await providerExec({
      provider: 'claude', role: 'correctness', prompt: 'Reply exactly OK.', repoRoot: binDir,
      stateDir: binDir, requestedModel: 'opus',
    });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [
      '-p', '--model', 'opus', '--output-format', 'json', '--no-session-persistence',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      `--add-dir=${binDir}`, 'Reply exactly OK.',
    ]);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec elapsed time excludes the synchronous version probe', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900); process.stdout.write('codex-cli 0.154.0\\n'); }\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const begin = Date.now();
    const result = await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    const total = Date.now() - begin;
    // The probe blocks 900 ms before the review starts. Whatever elapsedMs
    // leaves out of the call's own wall time must cover it, so spawn delay
    // under load moves both sides equally.
    assert.ok(total - result.elapsedMs >= 850, `review elapsed time included version probe: ${result.elapsedMs}ms of ${total}ms`);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec rejects extra usage fields from the pinned schema', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3, total_tokens: 127 } }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    assert.strictEqual(result.usagePartial, true);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec marks a successful subprocess with no usage event as partial', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await codexExec({ role: 'verify', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.usagePartial, true);
    assert.deepStrictEqual(result.usage, {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec exposes signal and timeout termination separately', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse if (process.argv.includes('signal')) process.kill(process.pid, 'SIGTERM');\nelse setTimeout(() => {}, 1000);\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const signal = await codexExec({ role: 'correctness', prompt: 'signal', repoRoot: binDir, stateDir: binDir });
    assert.deepStrictEqual({ status: signal.status, signal: signal.signal, timedOut: signal.timedOut }, { status: null, signal: 'SIGTERM', timedOut: false });
    const timeout = await codexExec({ role: 'correctness', prompt: 'wait', repoRoot: binDir, stateDir: binDir, timeoutMs: 20 });
    assert.deepStrictEqual({ status: timeout.status, signal: timeout.signal, timedOut: timeout.timedOut }, { status: null, signal: 'SIGTERM', timedOut: true });
    const controller = new AbortController();
    const interrupted = codexExec({ role: 'correctness', prompt: 'wait', repoRoot: binDir, stateDir: binDir, abortSignal: controller.signal });
    setTimeout(() => controller.abort('SIGINT'), 20);
    assert.strictEqual((await interrupted).interrupted, 'SIGINT');
  } finally {
    process.env.PATH = previousPath;
  }
});

for (const [name, body] of [
  ['malformed JSONL', `'not json\\n'`],
  ['unknown event', `JSON.stringify({ type: 'future.event' }) + '\\n'`],
  ['unknown item', `JSON.stringify({ type: 'item.completed', item: { type: 'future_item' } }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n'`],
  ['duplicate completion', `JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n'`],
  ['all-zero default usage', `JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }) + '\\n'`],
  ['collaboration evidence', `JSON.stringify({ type: 'item.completed', item: { type: 'collaboration_tool_call' } }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n'`],
]) test(`codexExec marks ${name} partial`, async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse process.stdout.write(${body});\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    assert.strictEqual((await codexExec({ role: 'verify', prompt: 'review', repoRoot: binDir, stateDir: binDir })).usagePartial, true);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec marks a CLI version mismatch partial', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.155.0\\n');\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await codexExec({ role: 'verify', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    assert.strictEqual(result.cliVersion, 'codex-cli 0.155.0');
    assert.strictEqual(result.usagePartial, true);
    assert.strictEqual(result.usageStatus, 'unsupported-cli-version');
  } finally {
    process.env.PATH = previousPath;
  }
});

function harness({ targetType = 'git', rounds = 1, malformed = false, retry = false, retryForever = false, correctnessArtifact, gateApplied = false, dodDeferred = false, failingRole, promptDrivenFix = false, retryArtifact, retryArtifacts, stateDir = temp(), slotIdentity = {} } = {}) {
  const calls = []; let round = 0; let retried = false;
  const cli = (args) => {
    calls.push(['cli', ...args]);
    const [verb, ref, role] = args;
    if (verb === 'round-start') {
      round++;
      const pending = retryArtifacts || (retryArtifact ? { [retryArtifact.role]: retryArtifact.prompt } : {});
      const repairs = Object.fromEntries(Object.keys(pending).map((role) => {
        const snapshotPath = path.join(stateDir, `round-${round}-${role}.original`);
        const packetPath = path.join(stateDir, `round-${round}-${role}.packet.json`);
        const candidatePath = path.join(stateDir, `round-${round}-${role}.candidate.json`);
        fs.writeFileSync(snapshotPath, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
        fs.writeFileSync(packetPath, JSON.stringify({ role }));
        return [role, { snapshotPath, packetPath, candidatePath, originalHash: 'test', error: 'invalid representation', state: 'prepared' }];
      }));
      return { decision: 'work', round, stateDir, targetType, dodPassed: true, dodDeferred, intentApplied: false, gateApplied, retryArtifact, retryArtifacts, repairArtifacts: repairs };
    }
    if (verb === 'artifact-normalize') {
      if (correctnessArtifact && role === 'correctness') {
        const artifact = path.join(stateDir, `round-${round}-correctness.json`);
        try {
          const canonical = normalizeArtifact(role, fs.readFileSync(artifact, 'utf8'));
          fs.writeFileSync(artifact, JSON.stringify(canonical) + '\n');
          return { status: 'ok' };
        } catch (error) { throw new Error(`harness-failure: ${error.message}`); }
      }
      if (malformed && role === 'correctness') throw new Error('harness-failure: correctness artifact is not JSON');
      if (retry && role === 'correctness' && (!retried || retryForever)) {
        retried = true;
        const snapshotPath = path.join(stateDir, `round-${round}-correctness.original`);
        const packetPath = path.join(stateDir, `round-${round}-correctness.packet.json`);
        const candidatePath = path.join(stateDir, `round-${round}-correctness.candidate.json`);
        fs.writeFileSync(snapshotPath, fs.readFileSync(path.join(stateDir, `round-${round}-correctness.json`)));
        fs.writeFileSync(packetPath, JSON.stringify({ role: 'correctness' }));
        return { status: 'repair', repair: { snapshotPath, packetPath, candidatePath, originalHash: 'test', error: 'invalid representation', state: 'prepared' } };
      }
      return { status: 'ok' };
    }
    if (verb === 'artifact-repair-dispatch') return { state: 'dispatched', snapshotPath: path.join(stateDir, `round-${round}-${role}.original`), packetPath: path.join(stateDir, `round-${round}-${role}.packet.json`), candidatePath: path.join(stateDir, `round-${round}-${role}.candidate.json`), originalHash: 'test' };
    if (verb === 'artifact-repair-candidate') return { state: 'candidate-ready', snapshotPath: path.join(stateDir, `round-${round}-${role}.original`), packetPath: path.join(stateDir, `round-${round}-${role}.packet.json`), candidatePath: path.join(stateDir, `round-${round}-${role}.candidate.json`), originalHash: 'test', candidateHash: 'test' };
    if (verb === 'telemetry-slot') {
      const artifactPath = role;
      return { engine: 'codex', provider: 'openai', artifactPath, attempt: calls.filter((call) => call[0] === 'cli' && call[1] === 'telemetry-slot' && call[3] === artifactPath).length, role: path.basename(artifactPath).includes('-fix-') ? 'fix' : path.basename(artifactPath).match(/^round-\d+-(.+)\.json$/)?.[1], round, ...slotIdentity };
    }
    if (verb === 'plan-fixes') {
      const fixes = round === 1 ? [{ id: 'correctness:bug', file: 'a.txt', span: 'bad', summary: 'fix it' }] : [];
      return { protocolVersion: 2, planId: `plan-${round}`, transactionScope: 'group', fixes, fixGroups: fixes.map((finding) => ({ groupId: finding.id, findingIds: [finding.id], rootCause: finding.summary, invariants: ['fixed behavior'], changeClass: 'local', action: 'fix', findings: [finding] })) };
    }
    if (verb === 'commit-fix') {
      if (promptDrivenFix && !fs.existsSync(path.join(stateDir, `round-${round}-fix-${String(role).replace(/:/g, '_')}.json`))) throw new Error('commit-fix did not receive its declared artifact');
      return { committed: true, sha: 'abc' };
    }
    if (verb === 'record') return round < rounds ? { decision: { continue: true }, handoff: 'continue' } : { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb} ${ref}`);
  };
  const spawn = ({ role, prompt, provider, repoRoot }) => {
    calls.push(['spawn', role, prompt, provider]);
    if (role === failingRole) return { status: 1 };
    const n = round;
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, `round-${n}-correctness.json`), correctnessArtifact || JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
    if (role === 'artifact-repair') {
      const target = prompt.match(/candidate\.json/) && path.join(repoRoot, 'candidate.json');
      if (!target) throw new Error('repair prompt did not name candidate');
      fs.copyFileSync(path.join(repoRoot, 'original.json'), target);
    }
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'plan') fs.writeFileSync(path.join(stateDir, `round-${n}-plan.json`), JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [] }));
    if (role === 'gate') fs.writeFileSync(path.join(stateDir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
    if (role === 'gate-verify') fs.writeFileSync(path.join(stateDir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'fix') {
      const target = promptDrivenFix ? prompt.match(/write ONLY to (.+\.json): either/)?.[1] : path.join(stateDir, `round-${n}-fix-correctness_bug.json`);
      if (!target) throw new Error('fix prompt did not name an artifact path');
      fs.writeFileSync(target, JSON.stringify({ status: 'ok', edited: true, groupId: 'correctness:bug', files: ['a.txt'] }));
    }
    if (role === 'certify') fs.writeFileSync(path.join(stateDir, `round-${n}-certify-correctness_bug.json`), JSON.stringify({ status: 'ok' }));
    return { status: 0 };
  };
  return { stateDir, calls, cli, spawn };
}

test('runner records an artifact-less reviewer exit as a retryable harness failure', async () => {
  const h = harness();
  let failure;
  const cli = (args) => {
    if (args[0] === 'artifact-normalize' && args[2] === 'correctness') {
      throw new Error('harness-failure: missing gate artifact correctness for round 1');
    }
    if (args[0] === 'round-failure') {
      failure = JSON.parse(args[2]);
      return { status: 'recorded' };
    }
    return h.cli(args);
  };
  const spawn = ({ role, prompt }) => {
    if (role === 'correctness') return { status: 0 }; // Process exited but never wrote its artifact.
    return h.spawn({ role, prompt });
  };

  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn }),
    /missing gate artifact correctness/,
  );
  assert.deepStrictEqual(failure, {
    role: 'correctness',
    kind: 'artifact-write-failure',
    message: 'missing gate artifact correctness for round 1',
  });
});

test('runner removes signal handlers after both a terminal result and a failure', async () => {
  const before = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, process.listenerCount(signal)]));
  const success = harness();
  await runReviewUntilGreen({ ref: 'feature/signals-success', repoRoot: '/repo', runCli: success.cli, spawn: success.spawn, handleSignals: true });
  const failure = harness({ failingRole: 'correctness' });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/signals-failure', repoRoot: '/repo', runCli: failure.cli, spawn: failure.spawn, handleSignals: true }));
  assert.deepStrictEqual(Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, process.listenerCount(signal)])), before);
});

test('runner persists an interruption delivered between orchestration steps', async () => {
  const failures = [];
  const cli = (args) => {
    if (args[0] === 'round-start') {
      process.emit('SIGINT');
      return { decision: 'work', round: 1, stateDir: temp(), targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    }
    if (args[0] === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (args[0] === 'round-failure') { failures.push(JSON.parse(args[2])); return { status: 'recorded' }; }
    throw new Error(`unexpected CLI ${args[0]}`);
  };
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/orchestration-signal', repoRoot: '/repo', runCli: cli, spawn: () => ({ status: 0 }), handleSignals: true }), /interrupted by SIGINT/);
  assert.deepStrictEqual(failures, [{ role: 'runner', kind: 'interrupted', message: 'review runner interrupted by SIGINT', signal: 'SIGINT' }]);
});

test('resume launches only the artifact role still pending after an interruption', async () => {
  const stateDir = temp();
  const calls = [];
  let attempt = 0;
  const cli = (args) => {
    const [verb, , role] = args;
    if (verb === 'round-start') {
      attempt++;
      return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false,
        completedArtifacts: attempt === 1 ? [] : ['correctness'] };
    }
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: role, attempt: 1 };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'round-failure') return { status: 'recorded', retryable: true };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    calls.push(`${attempt}:${role}`);
    if (attempt === 1 && role === 'verify') throw Object.assign(new Error('opaque interrupted detail'), { reviewFailure: { role, kind: 'interrupted' } });
    return { status: 0 };
  };

  await assert.rejects(runReviewUntilGreen({ ref: 'feature/resume', repoRoot: '/repo', runCli: cli, spawn }), /interrupted/);
  await runReviewUntilGreen({ ref: 'feature/resume', resume: true, repoRoot: '/repo', runCli: cli, spawn });
  assert.deepStrictEqual(calls, ['1:correctness', '1:verify', '2:verify', '2:plan']);
});

test('a failing parallel reviewer does not let the parent return before its sibling exits', async () => {
  const stateDir = temp();
  let siblingFinished = false;
  const cli = (args) => {
    if (args[0] === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: true, intentApplied: true, gateApplied: false };
    if (args[0] === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (args[0] === 'round-failure') return { status: 'recorded' };
    if (args[0] === 'artifact-normalize') return { status: 'ok' };
    throw new Error(`unexpected CLI ${args[0]}`);
  };
  const spawn = async ({ role }) => {
    if (role === 'intent') {
      await new Promise((resolve) => setTimeout(resolve, 30));
      siblingFinished = true;
      return { status: 0 };
    }
    if (role === 'correctness') throw new Error('correctness failed');
    return { status: 0 };
  };

  await assert.rejects(runReviewUntilGreen({ ref: 'feature/wait', repoRoot: '/repo', runCli: cli, spawn }), /correctness provider execution failed/);
  assert.strictEqual(siblingFinished, true);
});

test('a failing pooled broad finder waits for its paired finder before returning', async () => {
  const stateDir = temp();
  let gateFinished = false;
  const cli = (args) => {
    if (args[0] === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: true, gateMode: 'pair' };
    if (args[0] === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (args[0] === 'round-failure') return { status: 'recorded' };
    if (args[0] === 'artifact-normalize') return { status: 'ok' };
    throw new Error(`unexpected CLI ${args[0]}`);
  };
  const spawn = async ({ role }) => {
    if (role === 'correctness') throw new Error('correctness failed');
    if (role === 'gate') {
      await new Promise((resolve) => setTimeout(resolve, 30));
      gateFinished = true;
    }
    return { status: 0 };
  };

  await assert.rejects(runReviewUntilGreen({ ref: 'feature/pooled-wait', repoRoot: '/repo', runCli: cli, spawn }), /correctness provider execution failed/);
  assert.strictEqual(gateFinished, true);
});

test('a prior group cannot skip a later group without its own certification', async () => {
  const stateDir = temp();
  const fixSpawns = [];
  const commits = [];
  const fixes = [
    { id: 'correctness:a', file: 'a.txt', span: 'bad a', summary: 'fix both' },
    { id: 'correctness:b', file: 'b.txt', span: 'bad b', summary: 'same root cause' },
  ];
  const cli = (args) => {
    if (args[0] === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false };
    if (args[0] === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (args[0] === 'artifact-normalize') return { status: 'ok' };
    if (args[0] === 'plan-fixes') return v2Plan(fixes);
    if (args[0] === 'commit-fix') {
      commits.push(args[2]);
      return { committed: true, sha: 'fixed', resolvedFindingIds: ['correctness:b'] };
    }
    if (args[0] === 'record') return { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${args[0]}`);
  };
  const spawn = async ({ role, prompt }) => {
    if (role === 'fix') fixSpawns.push(prompt);
    return { status: 0 };
  };

  await runReviewUntilGreen({ ref: 'feature/grouped', repoRoot: '/repo', runCli: cli, spawn });
  assert.strictEqual(fixSpawns.length, 2);
  assert.deepStrictEqual(commits, ['correctness:a', 'correctness:b']);
});

test('runner launches one fixer for one root-cause group', async () => {
  const stateDir = temp();
  const fixes = [
    { id: 'correctness:a', file: 'a.txt', span: 'bad a', summary: 'first symptom' },
    { id: 'correctness:b', file: 'b.txt', span: 'bad b', summary: 'second symptom' },
  ];
  const fixGroups = [{
    findingIds: fixes.map((finding) => finding.id), rootCause: 'shared protocol defect',
    invariants: ['one owner decides the result'], changeClass: 'structural', action: 'fix', findings: fixes,
  }];
  const fixPrompts = [];
  const cli = (args) => {
    if (args[0] === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false };
    if (args[0] === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (args[0] === 'artifact-normalize') return { status: 'ok' };
    if (args[0] === 'plan-fixes') return v2Plan(fixes, fixGroups);
    if (args[0] === 'commit-fix') return { committed: true, sha: 'fixed', resolvedFindingIds: ['correctness:b'] };
    if (args[0] === 'record') return { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${args[0]}`);
  };
  const spawn = async ({ role, prompt }) => { if (role === 'fix') fixPrompts.push(prompt); return { status: 0 }; };

  await runReviewUntilGreen({ ref: 'feature/root-group', repoRoot: '/repo', runCli: cli, spawn });
  assert.strictEqual(fixPrompts.length, 1);
  assert.match(fixPrompts[0], /shared protocol defect/);
  assert.match(fixPrompts[0], /correctness:b/);
});

test('runner automatically executes a clean round in correctness then verify order and returns terminal handoff', async () => {
  const h = harness();
  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(out.handoff, 'LGTM');
  assert.deepStrictEqual(h.calls.map((c) => c[0] === 'spawn' ? c.slice(0, 2) : c.slice(0, 2)), [
    ['cli', 'round-start'], ['cli', 'telemetry-slot'], ['spawn', 'correctness'], ['cli', 'artifact-normalize'], ['cli', 'telemetry-slot'], ['spawn', 'verify'], ['cli', 'artifact-normalize'], ['cli', 'telemetry-slot'], ['spawn', 'plan'], ['cli', 'artifact-normalize'], ['cli', 'plan-fixes'], ['cli', 'telemetry-slot'], ['spawn', 'fix'], ['cli', 'telemetry-slot'], ['spawn', 'certify'], ['cli', 'commit-fix'], ['cli', 'record'],
  ]);
  assert.ok(h.calls.filter((call) => call[0] === 'cli' && call[1] === 'telemetry-slot').every((call) => call.slice(-2).join(' ') === '--engine codex'));
  assert.strictEqual(fs.existsSync(path.join(h.stateDir, 'telemetry-feature-x.json')), false);
});

test('runner records slots when the review state directory contains whitespace', async () => {
  const stateDir = path.join(temp(), 'state dir');
  fs.mkdirSync(stateDir);
  const h = harness({ stateDir });

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });

  assert.strictEqual(h.calls.filter((call) => call[0] === 'cli' && call[1] === 'telemetry-slot').length, 5);
});

test('runner fails before spawning when telemetry slot allocation fails', async () => {
  const h = harness();
  const cli = (args) => {
    if (args[0] === 'telemetry-slot') throw new Error('slot allocation failed');
    return h.cli(args);
  };

  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn: h.spawn }), /slot allocation failed/);
  assert.strictEqual(h.calls.some((call) => call[0] === 'spawn'), false);
});

test('runner keeps invocation role and round when slot metadata disagrees', async () => {
  const h = harness({ slotIdentity: { role: 'artifact-derived-role', round: 99 } });

  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });

  assert.deepStrictEqual(out.telemetry.invocations.map(({ role, round }) => ({ role, round })), [
    { role: 'correctness', round: 1 },
    { role: 'verify', round: 1 },
    { role: 'plan', round: 1 },
    { role: 'fix', round: 1 },
    { role: 'certify', round: 1 },
  ]);
});

test('runner reports aggregate and per-role subprocess telemetry', async () => {
  const h = harness();
  const usageByRole = {
    correctness: { inputTokens: 100, cacheWriteInputTokens: 0, cachedInputTokens: 10, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 111 },
    verify: { inputTokens: 200, cacheWriteInputTokens: 0, cachedInputTokens: 20, reasoningOutputTokens: 0, outputTokens: 2, totalTokens: 222 },
    plan: { inputTokens: 50, cacheWriteInputTokens: 0, cachedInputTokens: 5, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 56 },
    fix: { inputTokens: 300, cacheWriteInputTokens: 0, cachedInputTokens: 30, reasoningOutputTokens: 0, outputTokens: 3, totalTokens: 333 },
    certify: { inputTokens: 70, cacheWriteInputTokens: 0, cachedInputTokens: 7, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 78 },
  };
  const spawn = async (input) => ({
    ...await h.spawn(input),
    engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: `invocation-${input.role}`,
    elapsedMs: input.role === 'correctness' ? 10 : input.role === 'verify' ? 20 : 30,
    usage: usageByRole[input.role],
    usagePartial: false,
  });

  const out = await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn,
    reviewerModel: 'gpt-5.1-codex', fixerModel: 'gpt-5.1-codex',
    reasoningEffort: 'high', serviceTier: 'priority',
  });

  assert.deepStrictEqual(out.telemetry, {
    total: {
      calls: 5,
      partialCalls: 0,
      inputTokens: 720,
      cacheWriteInputTokens: 0,
      cachedInputTokens: 72,
      reasoningOutputTokens: 0,
      outputTokens: 8,
      totalTokens: 800,
      elapsedMs: 120,
    },
    byRole: {
      correctness: { calls: 1, partialCalls: 0, ...usageByRole.correctness, elapsedMs: 10 },
      verify: { calls: 1, partialCalls: 0, ...usageByRole.verify, elapsedMs: 20 },
      plan: { calls: 1, partialCalls: 0, ...usageByRole.plan, elapsedMs: 30 },
      fix: { calls: 1, partialCalls: 0, ...usageByRole.fix, elapsedMs: 30 },
      certify: { calls: 1, partialCalls: 0, ...usageByRole.certify, elapsedMs: 30 },
    },
    invocations: [
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-correctness', role: 'correctness', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, operation: 'substantive-review', ...usageByRole.correctness, elapsedMs: 10, artifactPath: path.join(h.stateDir, 'round-1-correctness.json'), attempt: 1 },
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-verify', role: 'verify', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, operation: 'substantive-review', ...usageByRole.verify, elapsedMs: 20, artifactPath: path.join(h.stateDir, 'round-1-verify.json'), attempt: 1 },
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-plan', role: 'plan', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, operation: 'substantive-review', ...usageByRole.plan, elapsedMs: 30, artifactPath: path.join(h.stateDir, 'round-1-plan.json'), attempt: 1 },
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-fix', role: 'fix', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, operation: 'substantive-review', ...usageByRole.fix, elapsedMs: 30, artifactPath: path.join(h.stateDir, 'round-1-fix-correctness_bug.json'), attempt: 1 },
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-certify', role: 'certify', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, operation: 'substantive-review', ...usageByRole.certify, elapsedMs: 30, artifactPath: path.join(h.stateDir, 'round-1-certify-correctness_bug.json'), attempt: 1 },
    ],
  });
  assert.strictEqual(out.handoff, 'LGTM');
});

test('resumed runner preserves telemetry from the previous process', async () => {
  const h = harness();
  const telemetryPath = path.join(h.stateDir, 'telemetry-feature-x.json');
  fs.writeFileSync(telemetryPath, JSON.stringify({
    total: { calls: 1, partialCalls: 0, inputTokens: 10, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20 },
    byRole: {
      correctness: { calls: 1, partialCalls: 0, inputTokens: 10, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20 },
    },
    invocations: [
      { role: 'correctness', round: 4, model: null, reasoningEffort: null, status: 0, usagePartial: false, inputTokens: 10, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20 },
    ],
  }) + '\n');

  const out = await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });

  assert.deepStrictEqual(out.telemetry.total, {
    calls: 6, partialCalls: 5, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20,
  });
  assert.deepStrictEqual(out.telemetry.invocations.map(({ role, round }) => ({ role, round })), [
    { role: 'correctness', round: 4 },
    { role: 'correctness', round: 1 },
    { role: 'verify', round: 1 },
    { role: 'plan', round: 1 },
    { role: 'fix', round: 1 },
    { role: 'certify', round: 1 },
  ]);
  assert.strictEqual(fs.existsSync(telemetryPath), false);
});

test('resumed runner preserves a corrupt telemetry file as malformed evidence', async () => {
  const stateDir = temp();
  const telemetryPath = path.join(stateDir, 'telemetry-feature-x.json');
  fs.writeFileSync(telemetryPath, 'not json');

  const out = await runReviewUntilGreen({
    ref: 'feature/x', resume: true, repoRoot: '/repo',
    runCli: () => ({ decision: 'terminal', stateDir, handoff: 'LGTM' }),
    spawn: () => { throw new Error('terminal resume must not spawn'); },
  });

  assert.deepStrictEqual(out.telemetry.invocations.map(({ status, invocationId, artifactPath }) => ({ status, invocationId, artifactPath })), [
    { status: 'malformed', invocationId: null, artifactPath: telemetryPath },
  ]);
  assert.strictEqual(out.telemetry.total.malformedCalls, 1);
  fs.writeFileSync(telemetryPath, JSON.stringify(out.telemetry));
  const folded = foldTelemetry(stateDir, { target: { ref: 'feature/x' } }, 'feature-x').telemetry;
  assert.strictEqual(folded.malformedCalls, 1);
  assert.strictEqual(folded.calls, 0);
});

test('runner persists unknown Codex token components as null', async () => {
  const h = harness();
  let invocation = 0;
  const spawn = async (input) => ({
    ...await h.spawn(input), engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1',
    invocationId: `invocation-${++invocation}`, usagePartial: true,
  });
  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn });
  const fields = ['inputTokens', 'cacheWriteInputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'outputTokens', 'totalTokens'];
  assert.deepStrictEqual(out.telemetry.invocations.map((entry) => fields.map((field) => entry[field])), [
    fields.map(() => null), fields.map(() => null), fields.map(() => null), fields.map(() => null), fields.map(() => null),
  ]);

  const telemetryPath = path.join(h.stateDir, 'telemetry-feature-x.json');
  fs.writeFileSync(telemetryPath, JSON.stringify(out.telemetry));
  const folded = foldTelemetry(h.stateDir, {
    target: { ref: 'feature/x' },
    telemetrySlots: out.telemetry.invocations.map(({ artifactPath, attempt, role, round }) => ({ engine: 'codex', provider: 'openai', artifactPath, attempt, role, round })),
  }, 'feature-x').telemetry;
  assert.strictEqual(folded.totalTokens, null);
  assert.strictEqual(folded.partialCalls, 5);
});

test('runner removes persisted telemetry when the review is abandoned', async () => {
  const h = harness();
  const cli = (args) => args[0] === 'record'
    ? { decision: { continue: false, abandoned: true }, handoff: 'abandoned' }
    : h.cli(args);

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn: h.spawn });

  assert.strictEqual(fs.existsSync(path.join(h.stateDir, 'telemetry-feature-x.json')), false);
});

test('runner preserves a rejected Codex probe as a failed invocation', async () => {
  const h = harness();
  const cli = (args) => args[0] === 'telemetry-slot' ? null : h.cli(args);
  const previousPath = process.env.PATH;
  process.env.PATH = temp();
  try {
    await assert.rejects(
      runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli }),
      /correctness provider execution failed; Provider execution failed without a recognized diagnostic/,
    );
  } finally {
    process.env.PATH = previousPath;
  }

  const telemetryPath = path.join(h.stateDir, 'telemetry-feature-x.json');
  const telemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
  assert.strictEqual(telemetry.invocations[0].status, 'failed');
  assert.match(telemetry.invocations[0].invocationId, /^[0-9a-f-]{36}$/);
  const folded = foldTelemetry(h.stateDir, { target: { ref: 'feature/x' } }, 'feature-x').telemetry;
  assert.deepStrictEqual({ calls: folded.calls, partialCalls: folded.partialCalls, status: folded.entries[0].status }, {
    calls: 1, partialCalls: 1, status: 'failed',
  });
});

test('runner stamps Codex identity on a custom spawn rejection without telemetry', async () => {
  const h = harness();
  const cli = (args) => args[0] === 'telemetry-slot' ? null : h.cli(args);

  await assert.rejects(
    runReviewUntilGreen({
      ref: 'feature/x',
      repoRoot: '/repo',
      runCli: cli,
      spawn: async () => { throw new Error('spawn failed'); },
    }),
    /correctness provider execution failed; Provider execution failed without a recognized diagnostic/,
  );

  const telemetryPath = path.join(h.stateDir, 'telemetry-feature-x.json');
  const telemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
  assert.deepStrictEqual(
    { status: telemetry.invocations[0].status, engine: telemetry.invocations[0].engine, provider: telemetry.invocations[0].provider },
    { status: 'failed', engine: 'codex', provider: 'openai' },
  );
  assert.match(telemetry.invocations[0].invocationId, /^[0-9a-f-]{36}$/);
  const folded = foldTelemetry(h.stateDir, { target: { ref: 'feature/x' } }, 'feature-x').telemetry;
  assert.deepStrictEqual({ calls: folded.calls, partialCalls: folded.partialCalls, status: folded.entries[0].status }, {
    calls: 1, partialCalls: 1, status: 'failed',
  });
});

test('terminal runner returns persisted telemetry even when the caller omits resume', async () => {
  const stateDir = temp();
  const persisted = {
    total: { calls: 1, partialCalls: 0, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20 },
    byRole: {
      correctness: { calls: 1, partialCalls: 0, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20 },
    },
    invocations: [
      { role: 'correctness', round: 4, model: null, reasoningEffort: null, status: 0, usagePartial: false, inputTokens: 10, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20 },
    ],
  };
  fs.writeFileSync(path.join(stateDir, 'telemetry-feature-x.json'), `${JSON.stringify(persisted)}\n`);

  const out = await runReviewUntilGreen({
    ref: 'feature/x',
    repoRoot: '/repo',
    runCli: () => ({ decision: 'terminal', stateDir, handoff: 'LGTM' }),
    spawn: () => { throw new Error('terminal resume must not spawn'); },
  });

  assert.deepStrictEqual(out.telemetry, persisted);
  assert.strictEqual(out.handoff, 'LGTM');
});

test('terminal runner without a telemetry file ignores historical ledger slots', async () => {
  const stateDir = temp();
  fs.writeFileSync(path.join(stateDir, 'review-feature-x.json'), JSON.stringify({
    target: { ref: 'feature/x' },
    telemetrySlots: [
      { engine: 'codex', provider: 'openai', artifactPath: '/old/one.json', attempt: 1, role: 'correctness', round: 1 },
      { engine: 'codex', provider: 'openai', artifactPath: '/old/two.json', attempt: 1, role: 'verify', round: 1 },
    ],
  }));

  const out = await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo',
    runCli: () => ({ decision: 'terminal', stateDir, handoff: 'LGTM' }),
    spawn: () => { throw new Error('terminal invocation must not spawn'); },
  });

  assert.deepStrictEqual(out.telemetry.total, {
    calls: 0, partialCalls: 0, inputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0,
    reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0,
  });
  assert.strictEqual(out.handoff, 'LGTM');
});

test('no-op runner does not leave an empty telemetry file for the next invocation', async () => {
  const stateDir = temp();

  const out = await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo',
    runCli: () => ({ decision: 'no-op', stateDir }),
    spawn: () => { throw new Error('no-op invocation must not spawn'); },
  });

  assert.strictEqual(out.telemetry.total.calls, 0);
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'telemetry-feature-x.json')), false);
});

test('no-op runner preserves telemetry from an interrupted round', async () => {
  const stateDir = temp();
  const telemetryPath = path.join(stateDir, 'telemetry-feature-x.json');
  const persisted = {
    total: { calls: 1, partialCalls: 1, inputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 1 },
    byRole: {},
    invocations: [{ engine: 'codex', provider: 'openai', invocationId: 'failed-1', role: 'correctness', round: 1, status: 'failed', usagePartial: true }],
  };
  fs.writeFileSync(telemetryPath, JSON.stringify(persisted));

  const out = await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo',
    runCli: () => ({ decision: 'no-op', stateDir }),
    spawn: () => { throw new Error('no-op invocation must not spawn'); },
  });

  assert.strictEqual(out.telemetry.invocations[0].invocationId, 'failed-1');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(telemetryPath, 'utf8')), persisted);
});

test('runner preserves telemetry when record stops for a re-runnable decision', async () => {
  const h = harness();
  const cli = (args) => args[0] === 'record'
    ? { decision: { continue: false, intentReview: true }, handoff: 'resolve intent' }
    : h.cli(args);

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn: h.spawn });

  assert.strictEqual(fs.existsSync(path.join(h.stateDir, 'telemetry-feature-x.json')), true);
});

test('runner leaves the CLI-authored usage line as the only handoff usage summary', async () => {
  const h = harness();
  const cli = (args) => args[0] === 'record'
    ? { decision: { continue: false, converged: true }, handoff: 'LGTM\nreview usage: 42 tokens across 3 call(s), 0 partial' }
    : h.cli(args);

  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn: h.spawn });

  assert.strictEqual(out.handoff, 'LGTM\nreview usage: 42 tokens across 3 call(s), 0 partial');
});

test('runner returns the CLI-folded telemetry as the authoritative aggregate', async () => {
  const h = harness();
  const folded = { engine: 'codex', calls: 3, partialCalls: 0, missingCalls: 1, entries: [] };
  const cli = (args) => {
    const result = h.cli(args);
    return args[0] === 'record' ? { ...result, telemetry: folded } : result;
  };

  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn: h.spawn });

  assert.strictEqual(out.telemetry, folded);
});

test('resumed runner reconciles only slots evidenced by its telemetry file', async () => {
  const stateDir = temp();
  const currentArtifact = path.join(stateDir, 'round-4-correctness.json');
  fs.writeFileSync(path.join(stateDir, 'review-feature-x.json'), JSON.stringify({
    target: { ref: 'feature/x' },
    telemetrySlots: [
      { engine: 'codex', provider: 'openai', artifactPath: '/prior/round-1-correctness.json', attempt: 1, role: 'correctness', round: 1 },
      { engine: 'codex', provider: 'openai', artifactPath: currentArtifact, attempt: 1, role: 'correctness', round: 4 },
    ],
  }));
  fs.writeFileSync(path.join(stateDir, 'telemetry-feature-x.json'), JSON.stringify({
    total: { calls: 1, partialCalls: 0, inputTokens: 1, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 2, elapsedMs: 1 },
    byRole: {},
    invocations: [{
      engine: 'codex', provider: 'openai', role: 'correctness', round: 4,
      artifactPath: currentArtifact, attempt: 1, invocationId: 'current', status: 0,
      usagePartial: false, inputTokens: 1, cacheWriteInputTokens: 0, cachedInputTokens: 0,
      reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 2, elapsedMs: 1,
    }],
  }));

  const out = await runReviewUntilGreen({
    ref: 'feature/x', resume: true, repoRoot: '/repo',
    runCli: () => ({ decision: 'terminal', stateDir, handoff: 'LGTM' }),
    spawn: () => { throw new Error('terminal resume must not spawn'); },
  });

  assert.deepStrictEqual(out.telemetry.invocations.map(({ invocationId, artifactPath }) => ({ invocationId, artifactPath })), [
    { invocationId: 'current', artifactPath: currentArtifact },
  ]);
  assert.strictEqual(out.telemetry.total.partialCalls, 0);
});

test('runner leaves missing-slot synthesis to the CLI fold', async () => {
  const h = harness();
  const ledgerPath = path.join(h.stateDir, 'review-feature-x.json');
  const slots = [{ engine: 'codex', provider: 'openai', artifactPath: '/missing.json', attempt: 1, role: 'correctness', round: 1 }];
  const writeSlots = () => fs.writeFileSync(ledgerPath, JSON.stringify({ target: { ref: 'feature/x' }, telemetrySlots: slots }));
  writeSlots();
  const cli = (args) => {
    const result = h.cli(args);
    if (args[0] === 'telemetry-slot') {
      slots.push(result);
      writeSlots();
    }
    return result;
  };

  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn: h.spawn });

  assert.strictEqual(out.telemetry.invocations.some((invocation) => invocation.artifactPath === '/missing.json'), false);
  assert.deepStrictEqual({ calls: out.telemetry.total.calls, partialCalls: out.telemetry.total.partialCalls, missingCalls: out.telemetry.total.missingCalls }, {
    calls: 5, partialCalls: 5, missingCalls: undefined,
  });
});

test('terminal runner does not invent a missing call from an otherwise empty persisted file', async () => {
  const stateDir = temp();
  const artifactPath = path.join(stateDir, 'round-4-correctness.json');
  fs.writeFileSync(path.join(stateDir, 'review-feature-x.json'), JSON.stringify({
    target: { ref: 'feature/x' },
    telemetrySlots: [{ engine: 'codex', provider: 'openai', artifactPath, attempt: 1, role: 'correctness', round: 4 }],
  }));
  fs.writeFileSync(path.join(stateDir, 'telemetry-feature-x.json'), JSON.stringify({
    total: { calls: 0, partialCalls: 0, inputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    byRole: {}, invocations: [],
  }));

  const out = await runReviewUntilGreen({
    ref: 'feature/x', resume: true, repoRoot: '/repo',
    runCli: () => ({ decision: 'terminal', stateDir, handoff: 'LGTM' }),
    spawn: () => { throw new Error('terminal resume must not spawn'); },
  });

  assert.strictEqual(out.telemetry.total.calls, 0);
  assert.strictEqual(out.telemetry.total.partialCalls, 0);
  assert.deepStrictEqual(out.telemetry.invocations, []);
});

test('fix and certify prompts bind the complete root-cause group', () => {
  const finding = { id: 'correctness:bug', file: 'src/parser.js', span: 'lines 41-43', summary: 'repair it' };
  const group = { groupId: 'parser-contract', findingIds: ['correctness:bug', 'correctness:mirror'], rootCause: 'shared parser contract', invariants: ['one parse result'], changeClass: 'local', action: 'fix', findings: [
    { id: 'correctness:bug', file: 'src/parser.js', span: 'lines 41-43', summary: 'repair it' },
    { id: 'correctness:mirror', file: 'src/mirror.js', span: 'line 8', summary: 'same root cause' },
  ] };
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, finding, fixGroup: group, plannedFindings: group.findings });
  assert.match(prompt, /\/state\/round-7-fix-parser-contract\.json/);
  assert.match(prompt, /src\/parser\.js/);
  assert.match(prompt, /EVERY file/i);
  assert.match(prompt, /"edited":false/);
  assert.match(prompt, /correctness:mirror/);
  const certify = reviewerPrompt('certify', { stateDir: '/state', round: 7, finding, fixGroup: group });
  assert.match(certify, /resolvedFindingIds/);
  assert.match(certify, /one parse result/);
  assert.match(certify, /fileHashes/);
});

test('verify stays independent and plan performs design-grounded structural grouping', () => {
  const verify = reviewerPrompt('verify', { stateDir: '/state', round: 7, targetType: 'git' });
  assert.doesNotMatch(verify, /round-7-history\.json/);
  assert.match(verify, /independent/);
  const plan = reviewerPrompt('plan', { stateDir: '/state', round: 7, targetType: 'git', slug: 'feat-x', intentHash: 'abc' });
  assert.match(plan, /round-7-history\.json/);
  assert.match(plan, /identity\|ownership\|retry-accounting/);
  assert.match(plan, /designEvidence/);

  const finding = { id: 'correctness:a', file: 'a.js', span: 'bad a', summary: 'first symptom' };
  const group = {
    groupId: 'shared', findingIds: ['correctness:a', 'correctness:b'], rootCause: 'shared protocol defect',
    invariants: ['one owner decides the result'], changeClass: 'structural', action: 'fix',
    findings: [finding, { id: 'correctness:b', file: 'b.js', span: 'bad b', summary: 'second symptom' }],
  };
  const fix = reviewerPrompt('fix', { stateDir: '/state', round: 7, finding, fixGroup: group, plannedFindings: group.findings });
  assert.match(fix, /shared protocol defect/);
  assert.match(fix, /one owner decides the result/);
  assert.match(fix, /entire authorized group/i);
});

test('file-target fix prompt still uses an explicitly classified group', () => {
  const finding = { id: 'docreview:bug', file: 'note.md', span: 'bad', summary: 'fix it' };
  const group = { groupId: 'docreview:bug', findingIds: ['docreview:bug'], rootCause: 'unsupported claim', invariants: ['claim is supported'], changeClass: 'local', action: 'fix', findings: [finding] };
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, targetType: 'file', finding, fixGroup: group });
  assert.match(prompt, /groupId":"docreview:bug/);
  assert.match(prompt, /"files":\["<every edited path>"\]/);
});

test('correctness prompt requires every changed file in examined', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: true });
  assert.match(prompt, /every changed file.*examined/i);
});

test('correctness prompt never claims the DoD passed when the gate was deferred', () => {
  // round-start reports dodPassed:true under a deferral too, so a prompt built
  // from dodPassed alone would tell the reviewer "DoD already passed; do not
  // rerun tests" on a run where nothing was ever executed -- removing the last
  // real check precisely when there is no gate behind it.
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: true, dodDeferred: true });
  assert.ok(!/do not rerun tests/i.test(prompt), 'a deferred gate must not be reported as an already-passed one');
  assert.match(prompt, /no executable.*gate.*ran this run/i);
  assert.match(prompt, /single run of the repo's own already-configured build\/test command/i);
});

test('correctness prompt reserves a pending DoD for the final clean boundary', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: false, dodDeferred: false, dodPending: true });
  assert.match(prompt, /run once after review convergence/i);
  assert.match(prompt, /do not run the build or test suite/i);
  assert.doesNotMatch(prompt, /DoD already failed/i);
});

test('runner passes --no-dod to round-start and threads the deferral into the correctness prompt', async () => {
  const h = harness({ dodDeferred: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn, noDod: true, resolveDefaultBase: () => 'upstream/main' });
  assert.deepStrictEqual(h.calls[0], ['cli', 'round-start', 'feature/x', 'upstream/main', '--no-dod', '--reviewer', 'codex', '--fixer', 'codex']);
  const correctness = h.calls.find((c) => c[0] === 'spawn' && c[1] === 'correctness');
  assert.ok(!/do not rerun tests/i.test(correctness[2]), 'the deferral must reach the reviewer prompt');
});

test('runner omits --no-dod by default -- the opt-out is never added on the runner\'s own initiative', async () => {
  const h = harness();
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn, resolveDefaultBase: () => 'upstream/main' });
  assert.deepStrictEqual(h.calls[0], ['cli', 'round-start', 'feature/x', 'upstream/main', '--reviewer', 'codex', '--fixer', 'codex']);
});

test('file-target correctness prompt requires contract-complete docreview findings', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'file', dodPassed: true });
  assert.match(prompt, /EVERY reviewed target.*examined/i);
  assert.match(prompt, /docreview:<stable-slug>/);
  assert.match(prompt, /"examined"/);
  assert.match(prompt, /"findings"/);
  // The artifact contract rejects a finding with no file, so a prompt that asks
  // only for an id and an examined list fails the round before verification.
  assert.match(prompt, /"file":"<path>"/);
  assert.match(prompt, /"span":"<exact offending text>"/);
  assert.match(prompt, /"summary":"<one sentence>"/);
});

test('git-target correctness prompt states the finding shape too -- a finding with no file is fatal, not retried', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true });
  assert.match(prompt, /"file":"<path>"/);
  assert.match(prompt, /"span":"<exact offending text>"/);
  assert.match(prompt, /"summary":"<one sentence>"/);
});

test('verify prompt asks for the distrust-green findings channel the CLI actually reads', () => {
  const prompt = reviewerPrompt('verify', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true });
  // plan-fixes/commit-fix/record all merge verify's `findings` into the candidate
  // set; a prompt that says "write ONLY {status,rejected}" loses them silently.
  assert.match(prompt, /"findings":\[\]/);
  assert.match(prompt, /catch a bug the first pass missed/);
});

test('correctness and verify prompts exclude the intent artifact -- the state dir is on --add-dir', () => {
  for (const role of ['correctness', 'verify']) {
    const prompt = reviewerPrompt(role, { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
    // Without this the reviewer can read intent-<slug>.md and raise a design
    // objection under a correctness: id, which the loop then AUTO-FIXES --
    // the opposite of intent's report-only-to-a-human contract.
    assert.match(prompt, /Ignore (?:any|every) intent-\*\.md/);
  }
});

test('gate prompt states the three-segment id shape -- a two-segment id defaults the class silently', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
  assert.match(prompt, /gate:<class>:<slug>/);
});

test('fix prompt forbids declaring state artifacts or paths outside the repository', () => {
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, finding: { id: 'correctness:bug', file: 'src/parser.js', span: 'lines 41-43', summary: 'repair it' } });
  assert.match(prompt, /repository-relative/i);
  assert.match(prompt, /must not include.*artifact/i);
  assert.match(prompt, /outside.*repository/i);
});

test('fresh runner resolves a remote default base once, while resume preserves the ledger base by omitting it', async () => {
  const fresh = harness();
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: fresh.cli, spawn: fresh.spawn, resolveDefaultBase: () => 'upstream/main' });
  assert.deepStrictEqual(fresh.calls[0], ['cli', 'round-start', 'feature/x', 'upstream/main', '--reviewer', 'codex', '--fixer', 'codex']);

  const resumed = harness();
  await runReviewUntilGreen({ ref: 'feature/x', base: 'must-not-override-ledger-base', resume: true, repoRoot: '/repo', runCli: resumed.cli, spawn: resumed.spawn, resolveDefaultBase: () => { throw new Error('must not resolve resume base'); } });
  // No --reviewer/--fixer passed on resume: round-start must fall back to
  // ledger.reviewRouting rather than receiving a materialized 'codex' default.
  assert.deepStrictEqual(resumed.calls[0], ['cli', 'round-start', 'feature/x']);
});

test('resuming a run started with non-default routing does not resend the codex default and does not throw', async () => {
  // round-start rejects an explicit --reviewer/--fixer that conflicts with the
  // ledger's persisted routing. A resume call that never received routing
  // options used to still materialize the 'codex' default and resend it,
  // throwing on resume even though the caller asked for nothing -- defeating
  // routing persistence. This exercises the runner's resume path end-to-end,
  // not review-cli.js directly, since that is exactly the gap the bug hid in.
  const h = harness();
  // First round-start call: report the routing this run was actually started
  // with (claude/copilot), as review-cli's ledger would restore it.
  h.cli = ((original) => (args) => {
    const result = original(args);
    if (args[0] === 'round-start') result.reviewRouting = { reviewer: 'claude', fixer: 'copilot' };
    return result;
  })(h.cli);
  await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.deepStrictEqual(h.calls[0], ['cli', 'round-start', 'feature/x']);
  const correctness = h.calls.find((c) => c[0] === 'spawn' && c[1] === 'correctness');
  assert.ok(correctness, 'resume must still dispatch the review round rather than throwing');
  // The restored ledger routing (claude/copilot), not the 'codex' default,
  // must be what actually gets dispatched.
  assert.strictEqual(correctness[3], 'claude');
  const fix = h.calls.find((c) => c[0] === 'spawn' && c[1] === 'fix');
  assert.strictEqual(fix[3], 'copilot');
});

test('resuming a run started with a pinned model restores it instead of dropping to the provider default', async () => {
  // round-start's ledger restores reviewer/fixer provider on resume, but the
  // runner used to keep reading options.reviewerModel/fixerModel directly for
  // launch() -- unset on a bare `resume` call -- silently dropping a model
  // that was pinned when the run started. This exercises the resume path
  // end-to-end so the dropped field cannot hide behind review-cli.js's own tests.
  const h = harness();
  h.cli = ((original) => (args) => {
    const result = original(args);
    if (args[0] === 'round-start') {
      result.reviewRouting = { reviewer: 'claude', reviewerModel: 'claude-opus-4-1', fixer: 'copilot', fixerModel: 'gpt-5.2' };
    }
    return result;
  })(h.cli);
  const requestedModels = [];
  const spawn = (input) => {
    requestedModels.push([input.role, input.requestedModel]);
    return h.spawn(input);
  };
  await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn });
  const correctness = requestedModels.find(([role]) => role === 'correctness');
  const fix = requestedModels.find(([role]) => role === 'fix');
  assert.strictEqual(correctness[1], 'claude-opus-4-1');
  assert.strictEqual(fix[1], 'gpt-5.2');
});

test('default base resolution uses an available remote HEAD without assuming origin', () => {
  const calls = [];
  const base = resolveDefaultBase('/repo', (bin, args) => {
    calls.push([bin, ...args]);
    return 'refs/remotes/upstream/main\nrefs/remotes/origin/HEAD\n';
  });
  assert.strictEqual(base, 'upstream/main');
  assert.deepStrictEqual(calls, [['git', 'for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD']]);
});

test('default base resolution fails clearly when no remote default is advertised', () => {
  assert.throws(
    () => resolveDefaultBase('/repo', () => ''),
    /cannot determine a remote default base; pass an explicit base/,
  );
});

test('fix subprocess writes the prompt-declared artifact consumed by commit-fix', async () => {
  const h = harness({ promptDrivenFix: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.ok(h.calls.some((call) => call[0] === 'cli' && call[1] === 'commit-fix'));
});

test('runner fails closed when a required reviewer subprocess is terminated by a signal', async () => {
  const h = harness();
  let failure;
  const cli = (args) => {
    if (args[0] === 'round-failure') { failure = JSON.parse(args[2]); return { status: 'recorded' }; }
    return h.cli(args);
  };
  const spawn = (input) => input.role === 'correctness' ? { status: null, signal: 'SIGTERM' } : h.spawn(input);
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn }),
    /harness-failure: correctness subprocess ended from SIGTERM/,
  );
  assert.deepStrictEqual(failure, { role: 'correctness', kind: 'signal', message: 'correctness subprocess ended from SIGTERM; Provider execution failed without a recognized diagnostic.', signal: 'SIGTERM', retryable: false, diagnostic: { classification: 'unknown', message: 'Provider execution failed without a recognized diagnostic.', engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1' } });
  assert.strictEqual(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'verify'), false);
});

test('gate-verify subprocess failure is retryable instead of being folded as a clean verdict', async () => {
  const h = harness({ gateApplied: true, failingRole: 'gate-verify' });
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }),
    /gate-verify subprocess exited 1/,
  );
  assert.ok(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'gate-verify'));
});

test('base broad pools both finder artifacts before launching both verifiers', async () => {
  const stateDir = temp();
  const pending = new Map();
  const calls = [];
  const cli = (args) => {
    const [verb, , role] = args;
    if (verb === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: true, intentApplied: true, gateApplied: true, priorIntentIds: ['intent:retry-count'] };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: role, attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return { decision: { continue: false }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb} ${role}`);
  };
  const spawn = ({ role, prompt }) => {
    calls.push(role);
    // round-start's priorIntentIds must actually reach the intent prompt.
    if (role === 'intent') assert.match(prompt, /\["intent:retry-count"\]/);
    return new Promise((resolve) => pending.set(role, resolve));
  };
  const complete = (role) => {
    const artifact = path.join(stateDir, `round-1-${role}.json`);
    if (role === 'correctness') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'intent' || role === 'gate') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', findings: [] }));
    if (role === 'gate-verify') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
    if (role === 'plan') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [] }));
    pending.get(role)({ status: 0 });
  };

  const running = runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  await new Promise(setImmediate);
  assert.deepStrictEqual(new Set(calls), new Set(['correctness', 'intent', 'gate']));
  complete('correctness');
  complete('intent');
  complete('gate');
  await new Promise(setImmediate);
  assert.deepStrictEqual(new Set(calls), new Set(['correctness', 'intent', 'gate', 'verify', 'gate-verify']));
  complete('verify');
  complete('gate-verify');
  await new Promise(setImmediate);
  assert.deepStrictEqual(new Set(calls), new Set(['correctness', 'intent', 'gate', 'verify', 'gate-verify', 'plan']));
  complete('plan');
  await running;
});

test('intent and gate prompts preserve their full role contracts', () => {
  const base = { stateDir: '/state', round: 2, slug: 'feature-x' };
  const intent = reviewerPrompt('intent', base);
  const gate = reviewerPrompt('gate', base);
  const verify = reviewerPrompt('gate-verify', base);
  assert.match(intent, /exact changed line/i);
  assert.match(intent, /verbatim requirement/i);
  assert.match(intent, /intent:/);
  assert.match(reviewerPrompt('intent', { ...base, priorIntentIds: ['intent:scope-not-a-key-listing'] }), /REUSE that id verbatim/i);
  assert.match(reviewerPrompt('intent', { ...base, priorIntentIds: ['intent:scope-not-a-key-listing'] }), /\["intent:scope-not-a-key-listing"\]/);
  assert.match(gate, /cross-context.*silent-gap.*ac-coverage.*design-conformance/i);
  assert.match(gate, /Read\/Grep.*repository/i);
  assert.match(gate, /intent-feature-x\.md/);
  assert.match(gate, /requirement/);
  assert.match(verify, /Reject false positives/i);
  assert.match(verify, /new.*gate:/i);
  assert.match(verify, /rejected/);
  assert.match(verify, /correctness candidates only as context/i);
  assert.match(verify, /disposition only gate:\*/i);
  assert.match(verify, /Do not copy, accept, or reject correctness:\*/i);
  assert.match(verify, /belongs to the correctness verifier/i);
  assert.match(reviewerPrompt('verify', { ...base, gateApplied: true }), /round-2-gate\.json/);
  assert.match(reviewerPrompt('gate-verify', { ...base, gateApplied: true }), /round-2-correctness\.json/);
});

test('panel lens prompts identify the reviewed diff and require the intent source', async () => {
  const stateDir = temp();
  const prompts = [];
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role, prompt }) => {
    prompts.push({ role, prompt });
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings: [] }));
    }
    return { status: 0 };
  };

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });

  const lensPrompts = prompts.filter(({ role }) => role.startsWith('gate-panel-') && role !== 'gate-panel-verify');
  assert.strictEqual(lensPrompts.length, 5);
  for (const { prompt } of lensPrompts) {
    assert.match(prompt, /round-4-diff\.txt/);
    assert.match(prompt, /MUST read.*intent-feature-x\.md/i);
  }
});

test('panel lens and adversarial-vote prompts carry the blocked-tool clause', async () => {
  const stateDir = temp();
  const prompts = [];
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role, prompt }) => {
    prompts.push({ role, prompt });
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      // One lens must emit a candidate so the adversarial vote prompts exist.
      const findings = lens === 'ac-coverage' ? [{ id: 'gate:ac-coverage:gap', file: 'a.js', span: 'x', summary: 's' }] : [];
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    }
    return { status: 0 };
  };

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });

  // Same clause reviewerPrompt appends: a reviewer that loses a tool must say so.
  const clause = /do NOT substitute a weaker method.*"status":"ok","blocked"/;
  const panelPrompts = prompts.filter(({ role }) => role.startsWith('gate-panel-'));
  assert.strictEqual(panelPrompts.length, 8); // 5 lenses + 3 votes
  for (const { role, prompt } of panelPrompts) assert.match(prompt, clause, `${role} prompt is missing the blocked clause`);

  // The reviewerPrompt half of the same guard: every review-class role carries
  // the clause, including the ones this run spawned for real.
  const spawnedReviewers = prompts.filter(({ role }) => role === 'correctness' || role === 'verify');
  assert.strictEqual(spawnedReviewers.length, 2);
  for (const { role, prompt } of spawnedReviewers) assert.match(prompt, clause, `${role} prompt is missing the blocked clause`);
  const base = { stateDir: '/state', round: 2, targetType: 'git', dodPassed: true, slug: 'feature-x' };
  for (const role of ['correctness', 'verify', 'intent', 'gate', 'gate-verify']) {
    assert.match(reviewerPrompt(role, base), clause, `${role} prompt is missing the blocked clause`);
  }
  // `fix` is not a review-class prompt: it edits code rather than emitting a
  // verdict, so it deliberately does not get the clause.
  assert.doesNotMatch(reviewerPrompt('fix', { ...base, finding: { id: 'correctness:bug', file: 'a.js', span: 'x', summary: 's' } }), clause);
});

test('an adversarial vote that declares blocked fails the round instead of counting as a refutation', async () => {
  const stateDir = temp();
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      const findings = lens === 'ac-coverage' ? [{ id: 'gate:ac-coverage:gap', file: 'a.js', span: 'x', summary: 's' }] : [];
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    }
    if (role === 'gate-panel-verify') {
      // Every voter obeys the blocked clause: none of them actually attempted
      // the refutation, so the finding must not be silently rejected.
      for (const vote of [0, 1, 2]) {
        fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-vote-gate_ac-coverage_gap-${vote}.json`),
          JSON.stringify({ status: 'ok', blocked: ['grep: denied by sandbox'] }));
      }
    }
    return { status: 0 };
  };

  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn }),
    /harness-failure: gate-panel vote .* could not run: grep: denied by sandbox/,
  );
});

test('a failed panel lens is treated as zero findings while the remaining lenses continue', async () => {
  const stateDir = temp();
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'gate-panel-ac-coverage') return { status: 1 };
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings: [] }));
    }
    return { status: 0 };
  };

  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });

  assert.strictEqual(out.handoff, 'LGTM');
});

test('an interrupted panel lens waits for every launched sibling before the runner rejects', async () => {
  const stateDir = temp();
  const pending = [];
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'gate-panel-ac-coverage') {
      const error = new Error('interrupted panel lens');
      error.reviewFailure = { role, kind: 'interrupted', message: 'interrupted panel lens' };
      return Promise.reject(error);
    }
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') return new Promise((resolve) => pending.push(resolve));
    return { status: 0 };
  };
  let settled = false;
  const running = runReviewUntilGreen({ ref: 'feature/panel-interrupt', repoRoot: '/repo', runCli: cli, spawn }).then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; },
  );
  for (let i = 0; i < 10 && pending.length < 4; i++) await new Promise(setImmediate);
  assert.strictEqual(pending.length, 4);
  await new Promise(setImmediate);
  assert.strictEqual(settled, false, 'the interrupted lens must wait for sibling cleanup');
  for (const resolve of pending) resolve({ status: 0 });
  assert.match((await running).message, /gate-panel-ac-coverage subprocess interrupted/);
});

test('an interrupted adversarial vote waits for every sibling before the runner rejects', async () => {
  const stateDir = temp();
  const pending = [];
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role, prompt }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      const findings = lens === 'ac-coverage' ? [{ id: 'gate:ac-coverage:gap', file: 'a.js', span: 'x', summary: 's' }] : [];
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    }
    if (role === 'gate-panel-verify') {
      if (/-0\.json/.test(prompt)) {
        const error = new Error('interrupted adversarial vote');
        error.reviewFailure = { role, kind: 'interrupted', message: error.message };
        return Promise.reject(error);
      }
      return new Promise((resolve) => pending.push(resolve));
    }
    return { status: 0 };
  };
  let settled = false;
  const running = runReviewUntilGreen({ ref: 'feature/vote-interrupt', repoRoot: '/repo', runCli: cli, spawn }).then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; },
  );
  for (let i = 0; i < 10 && pending.length < 2; i++) await new Promise(setImmediate);
  assert.strictEqual(pending.length, 2);
  await new Promise(setImmediate);
  assert.strictEqual(settled, false, 'the interrupted vote must wait for sibling cleanup');
  for (const resolve of pending) resolve({ status: 0 });
  assert.match((await running).message, /gate-panel-verify subprocess interrupted/);
});

test('panel lenses and each finding\'s adversarial votes fan out concurrently', async () => {
  const stateDir = temp();
  const pendingLenses = [];
  const pendingVotes = [];
  let recorded = 0;
  let activeSlots = 0; let maxActiveSlots = 0;
  const cli = async (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') {
      activeSlots++; maxActiveSlots = Math.max(maxActiveSlots, activeSlots);
      await new Promise(setImmediate);
      activeSlots--;
      return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    }
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      return new Promise((resolve) => pendingLenses.push({ role, resolve }));
    }
    if (role === 'gate-panel-verify') return new Promise((resolve) => pendingVotes.push(resolve));
    return { status: 0 };
  };

  const running = runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  for (let i = 0; i < 10 && pendingLenses.length < 5; i++) await new Promise(setImmediate);
  assert.strictEqual(pendingLenses.length, 5);
  for (const { role, resolve } of pendingLenses) {
    const lens = role.slice('gate-panel-'.length);
    const findings = lens === 'ac-coverage' ? [{ id: 'gate:ac-coverage:gap' }] : [];
    fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    resolve({ status: 0 });
  }
  for (let i = 0; i < 10 && pendingVotes.length < 3; i++) await new Promise(setImmediate);
  assert.strictEqual(pendingVotes.length, 3);
  for (const resolve of pendingVotes) {
    fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-vote-gate_ac-coverage_gap-${pendingVotes.indexOf(resolve)}.json`), JSON.stringify({ status: 'ok', survives: false }));
    resolve({ status: 0 });
  }
  await running;
  assert.strictEqual(maxActiveSlots, 1);
});

test('panel candidates with unsafe IDs never reach an interpolated verdict path', async () => {
  const stateDir = temp();
  const escaped = path.join(path.dirname(stateDir), 'escaped.json');
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: args[2], attempt: 1 };
    if (verb === 'plan-fixes') return { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      const findings = lens === 'ac-coverage' ? [{ id: '../../escaped', file: 'a.txt', summary: 'unsafe' }] : [];
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    }
    if (role === 'gate-panel-verify') throw new Error('unsafe candidate must not be verified');
    return { status: 0 };
  };

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  assert.strictEqual(fs.existsSync(escaped), false);
});

test('runner canonicalizes a findings artifact without changing its finding and continues to verify', async () => {
  const finding = { id: 'correctness:kept', file: 'a.txt', summary: 'keep this exact finding', span: 'bad' };
  const h = harness({ correctnessArtifact: JSON.stringify({ status: 'findings', examined: ['a.txt'], findings: [finding], ignored: true }) });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const artifact = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'round-1-correctness.json'), 'utf8'));
  assert.deepStrictEqual(artifact, { status: 'ok', examined: ['a.txt'], findings: [finding] });
  assert.ok(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'verify'));
});

for (const [label, raw] of [
  ['malformed JSON', '{not json'],
  ['semantically missing finding summary', JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:missing', file: 'a.txt' }] })],
]) {
  test(`runner fail-closes ${label} before verify at the artifact contract boundary`, async () => {
    const h = harness({ correctnessArtifact: raw });
    await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /harness-failure/);
    assert.strictEqual(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'verify'), false);
  });
}

test('real review-cli keeps the correctness-to-verify mtime guard active', () => {
  const repo = tempDir('runner-mtime-repo-');
  const stateDir = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'runner@test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'runner'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-am', 'change'], { cwd: repo });
  const cli = path.join(__dirname, '..', 'review-cli.js');
  const env = { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir };
  const started = JSON.parse(execFileSync('node', [cli, 'round-start', 'feature/x', 'HEAD~1'], { cwd: repo, env, encoding: 'utf8' }));
  const correctness = path.join(stateDir, `round-${started.round}-correctness.json`);
  const verify = path.join(stateDir, `round-${started.round}-verify.json`);
  fs.writeFileSync(correctness, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }) + '\n');
  fs.writeFileSync(verify, JSON.stringify({ status: 'ok', rejected: [] }) + '\n');
  const now = Date.now() / 1000;
  fs.utimesSync(correctness, now, now);
  fs.utimesSync(verify, now - 5, now - 5);
  assert.throws(() => execFileSync('node', [cli, 'plan-fixes', 'feature/x'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }), /predates round/);
});

test('runner dispatches one artifact repair after a normalization failure', async () => {
  const h = harness({ retry: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'correctness').length, 1);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'artifact-repair').length, 1);
});

test('normalization retry is an isolated artifact-repair operation, never a second reviewer launch', async () => {
  const h = harness({ retry: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const launches = h.calls.filter((call) => call[0] === 'spawn' && call[1] === 'correctness');
  assert.strictEqual(launches.length, 1, 'a substantive reviewer may launch only once');
  const repair = h.calls.find((call) => call[0] === 'spawn' && call[1] === 'artifact-repair');
  assert.ok(repair, 'retry must launch artifact-repair');
  assert.doesNotMatch(repair[2], /Review the diff|REWRITE ARTIFACT/, 'repair receives no substantive reviewer context');
});

test('artifact repair prompt names the staged packet, immutable snapshot, and candidate paths', async () => {
  const h = harness({ retry: true });
  let repairRoot;
  const spawn = (input) => { if (input.role === 'artifact-repair') repairRoot = input.repoRoot; return h.spawn(input); };
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn });
  const repair = h.calls.find((call) => call[0] === 'spawn' && call[1] === 'artifact-repair');
  for (const name of ['packet.json', 'original.json', 'candidate.json']) {
    assert.ok(repair[2].includes(JSON.stringify(path.join(repairRoot, name))), `repair prompt omitted the staged ${name} path`);
  }
});

test('runner resumes an artifact repair from its retained snapshot', async () => {
  const h = harness({ retryArtifact: { role: 'correctness', prompt: 'RESUME ARTIFACT RETRY' } });
  await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(h.calls.filter((call) => call[0] === 'spawn' && call[1] === 'correctness').length, 0);
  assert.strictEqual(h.calls.filter((call) => call[0] === 'spawn' && call[1] === 'artifact-repair').length, 1);
});

test('runner resumes every persisted artifact repair', async () => {
  const h = harness({ gateApplied: true, retryArtifacts: { correctness: 'RESUME CORRECTNESS RETRY', gate: 'RESUME GATE RETRY' } });
  await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(h.calls.filter((call) => call[0] === 'spawn' && call[1] === 'artifact-repair').length, 2);
});

test('runner fail-closes a malformed reviewer artifact before verify', async () => {
  const h = harness({ malformed: true });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /harness-failure/);
  assert.strictEqual(h.calls.some((c) => c[0] === 'spawn' && c[1] === 'verify'), false);
});

test('runner fails closed when the retry artifact is still invalid', async () => {
  const h = harness({ retry: true, retryForever: true });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /artifact repair exhausted/);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'artifact-repair').length, 1);
});

test('runner loops through record continuation and file targets never commit', async () => {
  const h = harness({ rounds: 2, targetType: 'file' });
  await runReviewUntilGreen({ ref: 'file:note.md', repoRoot: '/repo', targetIdentity: () => 'file-head', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(h.calls.filter((c) => c[1] === 'round-start').length, 2);
  assert.strictEqual(h.calls.some((c) => c[1] === 'commit-fix'), false);
});

test('runner routes review and fix roles to independent providers and models', async () => {
  const h = harness({ promptDrivenFix: true });
  const routed = [];
  await runReviewUntilGreen({
    ref: 'feature/x', repoRoot: '/repo', runCli: h.cli,
    reviewer: 'claude', reviewerModel: 'claude-opus-4-1',
    fixer: 'copilot', fixerModel: 'gpt-5.2',
    spawn: async (input) => {
      routed.push({ role: input.role, provider: input.provider, model: input.requestedModel });
      return h.spawn(input);
    },
  });
  assert.ok(routed.some(({ role, provider, model }) => role === 'correctness' && provider === 'claude' && model === 'claude-opus-4-1'));
  assert.ok(routed.some(({ role, provider, model }) => role === 'fix' && provider === 'copilot' && model === 'gpt-5.2'));
  assert.ok(routed.filter(({ role }) => role !== 'fix').every(({ provider }) => provider === 'claude'));
});

test('Codex review-and-fix launcher and compatibility alias --help exit without invoking the runner', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const binDir = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async (options) => {
        fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
        return { handoff: 'unexpected' };
      } };
      return load.apply(this, arguments);
    };
  `);
  for (const name of ['review-and-fix.js', 'review-until-green.js']) {
    const output = execFileSync('node', ['--require', preload, path.join(binDir, name), '--help'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
    assert.match(output, /^Usage: review-and-fix/m);
    assert.match(output, /resume <ref>/);
  }
  assert.strictEqual(fs.existsSync(capture), false);
});

test('Codex launcher prints a blocked or reconciliation-required result and exits non-zero, and exits zero for a handoff', () => {
  const dir = temp();
  const preload = path.join(dir, 'result-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => JSON.parse(process.env.RESULT) };
      return load.apply(this, arguments);
    };
  `);
  const launch = (result) => spawnSync('node', ['--require', preload, bin, 'feature/x'], { env: { ...process.env, RESULT: JSON.stringify(result) }, encoding: 'utf8' });
  for (const result of [{ decision: 'blocked', reason: 'budget-exhausted' }, { decision: 'reconciliation-required', reason: 'reconciliation-required' }]) {
    const outcome = launch(result);
    assert.strictEqual(outcome.status, 1);
    assert.deepStrictEqual(JSON.parse(outcome.stdout), result);
  }
  const handoff = launch({ handoff: 'ok' });
  assert.strictEqual(handoff.status, 0);
  assert.strictEqual(handoff.stdout, 'ok\n');
});

test('Codex launcher recognizes documented broad-review phrases without consuming them as target arguments', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') {
        return { runReviewUntilGreen: async (options) => {
          fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
          return { handoff: 'ok' };
        } };
      }
      return load.apply(this, arguments);
    };
  `);
  for (const args of [['feature/x', 'broad', 'review'], ['feature/x', '게이트']]) {
    fs.rmSync(capture, { force: true });
    execFileSync('node', ['--require', preload, bin, ...args], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
    const options = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.strictEqual(options.ref, 'feature/x');
    assert.strictEqual(options.base, undefined);
    assert.strictEqual(options.broad, true);
  }
});

test('Codex launcher forwards independent reviewer and fixer routing without consuming it as target arguments', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async (options) => {
        fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
        return { handoff: 'ok' };
      } };
      return load.apply(this, arguments);
    };
  `);
  execFileSync('node', ['--require', preload, bin, 'feature/x', '--no-dod', '--reviewer', 'claude', '--reviewer-model', 'claude-opus-4-1', '--fixer', 'copilot', '--fixer-model', 'gpt-5.2', '--reasoning-effort', 'high', '--service-tier', 'priority'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  const options = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.strictEqual(options.ref, 'feature/x');
  assert.strictEqual(options.base, undefined); // the flag must not be mistaken for base
  assert.strictEqual(options.noDod, true);
  assert.strictEqual(options.reviewer, 'claude');
  assert.strictEqual(options.reviewerModel, 'claude-opus-4-1');
  assert.strictEqual(options.fixer, 'copilot');
  assert.strictEqual(options.fixerModel, 'gpt-5.2');
  assert.strictEqual(options.reasoningEffort, 'high');
  assert.strictEqual(options.serviceTier, 'priority');

  fs.rmSync(capture, { force: true });
  execFileSync('node', ['--require', preload, bin, 'feature/x'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).noDod, false);
});

test('Codex launcher marks resume so the runner preserves the ledger base', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async (options) => {
        fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
        return { handoff: 'ok' };
      } };
      return load.apply(this, arguments);
    };
  `);
  execFileSync('node', ['--require', preload, bin, 'resume', 'feature/x'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  const options = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.strictEqual(options.resume, true);
  assert.strictEqual(options.base, undefined);
});

test('Codex launcher finalises without resolving a git target', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs'); const Module = require('node:module'); const load = Module._load;
    Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async (options) => { fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options)); return { handoff: 'ok' }; } }; return load.apply(this, arguments); };
  `);
  execFileSync('node', ['--require', preload, bin, '--initiative-finalise', '--initiative-run-key', 'key', '--initiative-state-dir', dir, '--initiative-max-launches', '1', '--initiative-max-rounds', '1'], { cwd: dir, env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).ref, undefined);
});

test('Codex launcher emits then acknowledges an unconsumed continuation packet', () => {
  const dir = temp();
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  const preload = path.join(dir, 'runner.js');
  const capture = path.join(dir, 'ack');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const Module = require('node:module'); const load = Module._load; Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => ({ decision: 'terminal', initiative: {}, handoff: 'legacy', continuationPacket: { delivery: { consumed: false, claim: 'one' } } }), acknowledgeContinuationPacket: async (_options, claim) => fs.writeFileSync(process.env.CAPTURE, claim) }; return load.apply(this, arguments); };`);
  assert.strictEqual(execFileSync('node', ['--require', preload, bin, 'feature/x'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' }), '{"delivery":{"consumed":false,"claim":"one"}}\n');
  assert.strictEqual(fs.readFileSync(capture, 'utf8'), 'one');
  fs.writeFileSync(preload, `const Module = require('node:module'); const load = Module._load; Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => ({ decision: 'terminal', initiative: {}, handoff: 'legacy' }) }; return load.apply(this, arguments); };`);
  assert.strictEqual(execFileSync('node', ['--require', preload, bin, 'feature/x'], { encoding: 'utf8' }), '');
});

test('Codex launcher emits then acknowledges an error continuation packet before nonzero exit', () => {
  const dir = temp();
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  const preload = path.join(dir, 'runner.js');
  const capture = path.join(dir, 'ack');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const Module = require('node:module'); const load = Module._load; Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => { const error = new Error('legacy'); error.continuationPacket = { delivery: { consumed: false, claim: 'error' } }; throw error; }, acknowledgeContinuationPacket: async (_options, claim) => fs.writeFileSync(process.env.CAPTURE, claim) }; return load.apply(this, arguments); };`);
  assert.throws(() => execFileSync('node', ['--require', preload, bin, 'feature/x'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error) => error.status === 1 && error.stderr === '{"delivery":{"consumed":false,"claim":"error"}}\n');
  assert.strictEqual(fs.readFileSync(capture, 'utf8'), 'error');
});

function cleanRepo() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  return repo;
}

test('reviewOnly stops after verification, reports the verified findings, and never plans, fixes, or records', async () => {
  const h = harness({ gateApplied: true });
  const verified = [{ id: 'correctness:bug', category: 'correctness', file: 'a.txt', line: 1, span: 'bad', summary: 'fix it', requirement: '' }];
  const cli = (args) => (args[0] === 'findings' ? (h.calls.push(['cli', ...args]), { findings: verified }) : h.cli(args));
  const result = await runReviewUntilGreen({ ref: 'feature/ro', base: 'main', repoRoot: cleanRepo(), runCli: cli, spawn: h.spawn, reviewOnly: true, broad: true, reviewer: 'claude' });
  assert.deepStrictEqual(result, { decision: 'review-only', round: 1, findings: verified });
  const spawned = h.calls.filter((c) => c[0] === 'spawn').map((c) => c[1]).sort();
  assert.deepStrictEqual(spawned, ['correctness', 'gate', 'gate-verify', 'verify']);
  assert.ok(h.calls.filter((c) => c[0] === 'spawn').every((c) => c[3] === 'claude'));
  const verbs = h.calls.filter((c) => c[0] === 'cli').map((c) => c[1]);
  for (const verb of ['plan-fixes', 'commit-fix', 'record']) assert.ok(!verbs.includes(verb), `${verb} must not run in review-only mode`);
  const start = h.calls.find((c) => c[0] === 'cli' && c[1] === 'round-start');
  assert.ok(start.includes('--no-dod'), 'a review that never edits has no definition of done to run');
});

test('Codex review-and-fix launcher passes --review-only to the runner and prints its findings as JSON', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-and-fix.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async (options) => {
        fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
        return { decision: 'review-only', round: 1, findings: [] };
      }, acknowledgeContinuationPacket: () => true };
      return load.apply(this, arguments);
    };
  `);
  const output = execFileSync('node', ['--require', preload, bin, 'feature/x', 'main', '--review-only', '--no-broad', '--reviewer', 'claude', '--intent-file', '/abs/pr.md'], { cwd: dir, env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  const options = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.strictEqual(options.reviewOnly, true);
  assert.strictEqual(options.intentFile, '/abs/pr.md');
  assert.strictEqual(options.ref, 'feature/x');
  assert.strictEqual(options.base, 'main');
  assert.deepStrictEqual(JSON.parse(output), { decision: 'review-only', round: 1, findings: [] });
});

test('runner passes intentFile to round-start as --intent-file', async () => {
  const h = harness();
  await runReviewUntilGreen({ ref: 'feature/intent', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn, intentFile: '/abs/pr.md' });
  const start = h.calls.find((c) => c[0] === 'cli' && c[1] === 'round-start');
  const at = start.indexOf('--intent-file');
  assert.ok(at > 0 && start[at + 1] === '/abs/pr.md', `round-start args: ${start.join(' ')}`);
});

test('providerExec keeps project settings out of a Claude reviewer on an untrusted checkout', async () => {
  const binDir = temp();
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await providerExec({ provider: 'claude', role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, untrustedCheckout: true });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.strictEqual(args[args.indexOf('--setting-sources') + 1], 'user');
    await providerExec({ provider: 'claude', role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    assert.ok(!JSON.parse(fs.readFileSync(capture, 'utf8')).includes('--setting-sources'), 'a trusted checkout keeps its project settings');
  } finally {
    process.env.PATH = previousPath;
  }
});

for (const provider of ['codex', 'claude']) test(`an untrusted ${provider} reviewer cannot leave a same-group child running after its CLI exits`, async () => {
  if (process.platform === 'win32') return;
  const binDir = temp(); const marker = path.join(binDir, 'late-marker');
  const executable = path.join(binDir, provider);
  const delayed = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 450)`;
  fs.writeFileSync(executable, `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(delayed)}], { stdio: 'ignore' }).unref();\nconsole.log(${JSON.stringify(provider === 'codex' ? '{"type":"turn.completed","usage":{}}' : '{}')});\n`);
  fs.chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  try {
    if (provider === 'codex') await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, untrustedCheckout: true, codexExecutable: { command: executable, version: 'codex-cli 0.154.0' } });
    else await providerExec({ provider, role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, untrustedCheckout: true });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.strictEqual(fs.existsSync(marker), false, 'a reviewer descendant must not write after the top-level CLI exits');
    if (provider === 'codex') await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, codexExecutable: { command: executable, version: 'codex-cli 0.154.0' } });
    else await providerExec({ provider, role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.strictEqual(fs.existsSync(marker), true, 'trusted launches retain their prior process lifecycle');
  } finally { process.env.PATH = oldPath; }
});

test('reviewOnly treats the checkout as untrusted: no repository intent command and no project agent config', async () => {
  const h = harness();
  const inputs = [];
  const cli = (args) => (args[0] === 'findings' ? { findings: [] } : h.cli(args));
  const spawn = (input) => { inputs.push(input); return h.spawn(input); };
  await runReviewUntilGreen({ ref: 'feature/untrusted', base: 'main', repoRoot: cleanRepo(), runCli: cli, spawn, reviewOnly: true, noBroad: true, reviewer: 'claude' });
  const start = h.calls.find((c) => c[0] === 'cli' && c[1] === 'round-start');
  assert.ok(start.includes('--no-intent-command'), `round-start args: ${start.join(' ')}`);
  assert.ok(inputs.length && inputs.every((input) => input.untrustedCheckout === true));
});

test('reviewOnly keeps its round out of the persistent review ledger', async () => {
  const dir = temp();
  const fakeCli = path.join(dir, 'fake-cli.js');
  const capture = path.join(dir, 'state-dirs.txt');
  fs.writeFileSync(fakeCli, `require('node:fs').appendFileSync(${JSON.stringify(capture)}, (process.env.REVIEW_STATE_DIR || '') + '\\n'); process.stdout.write(JSON.stringify({ decision: 'no-op', message: 'nothing', stateDir: process.env.REVIEW_STATE_DIR }));\n`);
  const previous = process.env.REVIEW_STATE_DIR;
  process.env.REVIEW_STATE_DIR = path.join(dir, 'persistent');
  try {
    await runReviewUntilGreen({ ref: 'feature/isolated', base: 'main', repoRoot: dir, cliPath: fakeCli, reviewOnly: true, reviewer: 'claude', spawn: () => ({ status: 0 }) });
  } finally {
    if (previous === undefined) delete process.env.REVIEW_STATE_DIR; else process.env.REVIEW_STATE_DIR = previous;
  }
  const seen = fs.readFileSync(capture, 'utf8').trim().split('\n');
  assert.ok(seen.length >= 1);
  for (const stateDir of seen) {
    assert.notStrictEqual(stateDir, path.join(dir, 'persistent'));
    assert.ok(stateDir.startsWith(fs.realpathSync(os.tmpdir())) || stateDir.startsWith(os.tmpdir()), stateDir);
  }
  assert.strictEqual(new Set(seen).size, 1, 'one isolated directory for the whole run');
  assert.ok(!fs.existsSync(seen[0]), 'the isolated state is removed when the run ends');
});

for (const reviewer of ['copilot']) test(`reviewOnly refuses the ${reviewer} reviewer, which cannot be kept from an untrusted checkout's configuration`, async () => {
  const h = harness();
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/untrusted-reviewer', base: 'main', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn, reviewOnly: true, reviewer }),
    /reviewOnly supports the claude and codex reviewers/,
  );
  assert.deepStrictEqual(h.calls, [], 'nothing starts before the refusal');
});

test('reviewOnly fails when a reviewer left the checkout modified, instead of reporting on a tree that is not the commit', async () => {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  const h = harness({ gateApplied: false });
  let reported = false;
  const cli = (args) => (args[0] === 'findings' ? (reported = true, { findings: [] }) : h.cli(args));
  const spawn = (input) => {
    if (input.role === 'correctness') fs.writeFileSync(path.join(repo, 'a.txt'), 'edited by the reviewer\n');
    return h.spawn(input);
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/dirty', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude' }),
    /reviewer left the checkout modified/,
  );
  assert.strictEqual(reported, false, 'no findings are reported from a modified tree');
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`reviewOnly rejects a reviewer edit hidden from git status by ${flag}`, async () => {
  const repo = cleanRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'file'], { cwd: repo });
  const h = harness({ gateApplied: false });
  let reported = false;
  const cli = (args) => (args[0] === 'findings' ? (reported = true, { findings: [] }) : h.cli(args));
  const spawn = (input) => {
    if (input.role === 'correctness') {
      execFileSync('git', ['update-index', flag, 'a.txt'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hidden reviewer edit\n');
    }
    return h.spawn(input);
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/hidden-edit', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /reviewer left the checkout modified/,
  );
  assert.strictEqual(reported, false, 'no findings are reported from a modified tree');
});

test('reviewOnly rejects a finder edit before a verifier can restore the checkout', async () => {
  const repo = cleanRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'file'], { cwd: repo });
  const h = harness({ gateApplied: false }); let verifierRan = false;
  const cli = (args) => args[0] === 'findings' ? { findings: [] } : h.cli(args);
  const spawn = (input) => {
    if (input.role === 'correctness') fs.writeFileSync(path.join(repo, 'a.txt'), 'reviewer edit\n');
    if (input.role === 'verify') { verifierRan = true; fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n'); }
    return h.spawn(input);
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/transient-edit', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /reviewer left the checkout modified/,
  );
  assert.strictEqual(verifierRan, false, 'the next reviewer must not run on a tree altered by a prior reviewer');
});

for (const reviewer of ['claude', 'codex']) test(`reviewOnly rejects a file target changed by its ${reviewer} reviewer before reporting findings`, async () => {
  const repo = temp();
  fs.writeFileSync(path.join(repo, 'note.md'), 'original\n');
  const head = fileTarget({ files: ['note.md'] }, repo).identity;
  const h = harness({ targetType: 'file' });
  let reported = false;
  const cli = (args) => {
    if (args[0] === 'findings') return (reported = true, { findings: [] });
    const result = h.cli(args);
    return args[0] === 'round-start' ? { ...result, head } : result;
  };
  const spawn = (input) => {
    if (input.role === 'correctness') fs.writeFileSync(path.join(repo, 'note.md'), 'reviewer edit\n');
    return h.spawn(input);
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer, noBroad: true }),
    /reviewer modified the file target/,
  );
  assert.strictEqual(reported, false, 'findings must not describe stale file content');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'note.md'), 'utf8'), 'reviewer edit\n');
});

test('reviewOnly reports findings for an unchanged file target', async () => {
  const repo = temp();
  fs.writeFileSync(path.join(repo, 'note.md'), 'original\n');
  const head = fileTarget({ files: ['note.md'] }, repo).identity;
  const h = harness({ targetType: 'file' });
  const cli = (args) => {
    if (args[0] === 'findings') return { findings: [] };
    const result = h.cli(args);
    return args[0] === 'round-start' ? { ...result, head } : result;
  };
  const result = await runReviewUntilGreen({ ref: 'file:note.md', repoRoot: repo, runCli: cli, spawn: h.spawn, reviewOnly: true, reviewer: 'claude', noBroad: true });
  assert.deepStrictEqual(result, { decision: 'review-only', round: 1, findings: [] });
});

test('reviewOnly rejects a file target replaced by an identical external symlink', async () => {
  const repo = temp(); const external = path.join(temp(), 'note.md');
  fs.writeFileSync(path.join(repo, 'note.md'), 'original\n');
  fs.writeFileSync(external, 'original\n');
  const head = fileTarget({ files: ['note.md'] }, repo).identity;
  const h = harness({ targetType: 'file' });
  let reported = false;
  const cli = (args) => {
    if (args[0] === 'findings') return (reported = true, { findings: [] });
    const result = h.cli(args);
    return args[0] === 'round-start' ? { ...result, head } : result;
  };
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'correctness') {
      fs.unlinkSync(path.join(repo, 'note.md'));
      fs.symlinkSync(external, path.join(repo, 'note.md'));
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /unsafe or oversized file target/,
  );
  assert.strictEqual(reported, false);
});

test('reviewOnly rejects a file target enlarged beyond its aggregate identity limit', async () => {
  const repo = temp(); fs.writeFileSync(path.join(repo, 'note.md'), 'original\n');
  const head = fileTarget({ files: ['note.md'] }, repo).identity;
  const h = harness({ targetType: 'file' });
  let reported = false;
  const cli = (args) => {
    if (args[0] === 'findings') return (reported = true, { findings: [] });
    const result = h.cli(args);
    return args[0] === 'round-start' ? { ...result, head } : result;
  };
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'correctness') {
      const fd = fs.openSync(path.join(repo, 'note.md'), 'w');
      try { fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /unsafe or oversized file target/,
  );
  assert.strictEqual(reported, false);
});

test('reviewOnly runs broad workers one at a time while accepting trusted ledger updates', async () => {
  const repo = cleanRepo();
  const stateDir = temp();
  const h = harness({ stateDir, gateApplied: true });
  const ledger = require('../../core/review').ledgerPath(stateDir, require('../../core/review').targetSlug('feature/serial'));
  let revision = 0; let active = 0; let maximum = 0;
  const roles = [];
  const cli = (args) => {
    if (args[0] === 'findings') return { findings: [] };
    const result = h.cli(args);
    if (args[0] === 'round-start') fs.writeFileSync(ledger, JSON.stringify({ revision: revision++ }));
    if (args[0] === 'telemetry-slot' || args[0] === 'artifact-normalize') fs.writeFileSync(ledger, JSON.stringify({ revision: revision++ }));
    return result;
  };
  const spawn = async (input) => {
    roles.push(input.role);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return h.spawn(input);
  };
  const result = await runReviewUntilGreen({ ref: 'feature/serial', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'codex', broad: true });
  assert.deepStrictEqual(result.findings, []);
  assert.deepStrictEqual(roles, ['correctness', 'gate', 'verify', 'gate-verify']);
  assert.strictEqual(maximum, 1);
  assert.ok(revision > 4, 'trusted CLI calls updated the ledger between workers');
});

test('normal review keeps its parallel broad worker pool', async () => {
  const h = harness({ gateApplied: true });
  let active = 0; let maximum = 0;
  const spawn = async (input) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return h.spawn(input);
  };
  await runReviewUntilGreen({ ref: 'feature/parallel', base: 'main', repoRoot: cleanRepo(), runCli: h.cli, spawn, reviewer: 'claude', noDod: true });
  assert.ok(maximum > 1, 'normal broad reviewers still overlap');
});

test('reviewOnly preserves its artifact guard during an isolated artifact repair', async () => {
  const repo = cleanRepo();
  const stateDir = temp();
  const h = harness({ stateDir, retry: true });
  const ledger = require('../../core/review').ledgerPath(stateDir, require('../../core/review').targetSlug('feature/repair'));
  const descriptor = path.join(stateDir, 'round-1-correctness.repair.json');
  let revision = 0;
  const cli = (args) => {
    if (args[0] === 'findings') return { findings: [] };
    const result = h.cli(args);
    if (['round-start', 'telemetry-slot', 'artifact-normalize'].includes(args[0])) {
      fs.writeFileSync(ledger, JSON.stringify({ revision: revision++ }));
    }
    if (args[0] === 'artifact-normalize' && result.status === 'repair') fs.writeFileSync(descriptor, JSON.stringify(result.repair));
    if (args[0] === 'artifact-repair-dispatch' || args[0] === 'artifact-repair-candidate') fs.writeFileSync(descriptor, JSON.stringify(result));
    return result;
  };
  const result = await runReviewUntilGreen({ ref: 'feature/repair', base: 'main', repoRoot: repo, runCli: cli, spawn: h.spawn, reviewOnly: true, reviewer: 'codex', noBroad: true });
  assert.deepStrictEqual(result.findings, []);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'artifact-repair').length, 1);
});

test('reviewOnly rejects a repair worker that rewrites the trusted source snapshot and descriptor', async () => {
  const repo = cleanRepo();
  const stateDir = temp();
  const h = harness({ stateDir, retry: true });
  const stem = path.join(stateDir, 'round-1-correctness');
  const descriptor = `${stem}.repair.json`;
  let reported = false;
  const cli = (args) => {
    if (args[0] === 'findings') return (reported = true, { findings: [] });
    const result = h.cli(args);
    if (args[0] === 'artifact-normalize' && result.status === 'repair') fs.writeFileSync(descriptor, JSON.stringify(result.repair));
    if (args[0] === 'artifact-repair-dispatch' || args[0] === 'artifact-repair-candidate') fs.writeFileSync(descriptor, JSON.stringify(result));
    return result;
  };
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'artifact-repair') {
      fs.writeFileSync(`${stem}.original`, '{"status":"ok","examined":[],"findings":[]}');
      fs.writeFileSync(descriptor, JSON.stringify({ ...JSON.parse(fs.readFileSync(descriptor, 'utf8')), originalHash: 'forged' }));
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/repair-tamper', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'codex', noBroad: true }),
    /protected review artifact changed/,
  );
  assert.strictEqual(reported, false);
});

for (const [name, target, action] of [
  ['rewrites the normalized correctness artifact', 'round-1-correctness.json', 'rewrite'],
  ['deletes the normalized correctness artifact', 'round-1-correctness.json', 'delete'],
  ['rewrites the round diff', 'round-1-diff.txt', 'rewrite'],
  ['rewrites the changed-path manifest', 'round-1-changes.json', 'rewrite'],
  ['rewrites the round history', 'round-1-history.json', 'rewrite'],
  ['rewrites the intent', 'intent-file.md', 'rewrite'],
  ['rewrites the ledger', 'ledger', 'rewrite'],
]) test(`reviewOnly rejects a verifier that ${name} before findings`, async () => {
  const repo = cleanRepo();
  const stateDir = temp();
  const h = harness({ stateDir });
  let reported = false;
  const cli = (args) => {
    if (args[0] === 'findings') return (reported = true, { findings: [] });
    const result = h.cli(args);
    if (args[0] === 'round-start') {
      fs.writeFileSync(path.join(stateDir, 'round-1-diff.txt'), 'original diff\n');
      fs.writeFileSync(path.join(stateDir, 'round-1-changes.json'), '{"paths":[]}\n');
      fs.writeFileSync(path.join(stateDir, 'round-1-history.json'), '{}\n');
      fs.writeFileSync(path.join(stateDir, `intent-${require('../../core/review').targetSlug('feature/tamper')}.md`), 'original intent\n');
      fs.writeFileSync(require('../../core/review').ledgerPath(stateDir, require('../../core/review').targetSlug('feature/tamper')), '{}\n');
    }
    return result;
  };
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'verify') {
      const pathToChange = target === 'ledger'
        ? require('../../core/review').ledgerPath(stateDir, require('../../core/review').targetSlug('feature/tamper'))
        : path.join(stateDir, target === 'intent-file.md' ? `intent-${require('../../core/review').targetSlug('feature/tamper')}.md` : target);
      if (action === 'delete') fs.unlinkSync(pathToChange);
      else fs.writeFileSync(pathToChange, 'tampered\n');
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/tamper', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /protected review artifact changed/,
  );
  assert.strictEqual(reported, false);
  assert.strictEqual(h.calls.some((call) => call[0] === 'cli' && call[1] === 'round-failure'), false,
    'a disposable review must not read poisoned ledger evidence during failure recording');
});

test('reviewOnly rejects a finder that forges a later verifier artifact', async () => {
  const repo = cleanRepo();
  const h = harness();
  let reported = false;
  const cli = (args) => args[0] === 'findings' ? (reported = true, { findings: [] }) : h.cli(args);
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'correctness') fs.writeFileSync(path.join(h.stateDir, 'round-1-verify.json'), '{"status":"ok","rejected":[]}');
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/forged', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /protected review artifact changed: round-1-verify.json/,
  );
  assert.strictEqual(reported, false);
});

test('reviewOnly rejects a protected artifact replaced by an identical external symlink', async () => {
  const repo = cleanRepo(); const stateDir = temp(); const h = harness({ stateDir });
  const external = path.join(temp(), 'copy.json');
  let reported = false;
  const cli = (args) => {
    if (args[0] === 'findings') return (reported = true, { findings: [] });
    const result = h.cli(args);
    if (args[0] === 'round-start') fs.writeFileSync(path.join(stateDir, 'round-1-changes.json'), '{"paths":[]}\n');
    return result;
  };
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'correctness') {
      const protectedPath = path.join(stateDir, 'round-1-changes.json');
      fs.copyFileSync(protectedPath, external);
      fs.unlinkSync(protectedPath);
      fs.symlinkSync(external, protectedPath);
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/symlink-hash', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /protected review artifact.*round-1-changes\.json/,
  );
  assert.strictEqual(reported, false);
});

test('reviewOnly rejects an oversized protected artifact before launching workers', async () => {
  const repo = cleanRepo(); const stateDir = temp(); const h = harness({ stateDir });
  let launched = false;
  const cli = (args) => {
    if (args[0] === 'findings') return { findings: [] };
    const result = h.cli(args);
    if (args[0] === 'round-start') {
      const fd = fs.openSync(path.join(stateDir, 'round-1-changes.json'), 'w');
      try { fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/oversized-hash', base: 'main', repoRoot: repo, runCli: cli, spawn: (input) => (launched = true, h.spawn(input)), reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /protected review artifact.*round-1-changes\.json/,
  );
  assert.strictEqual(launched, false);
});

test('bounded review hash accepts missing future output and refuses a FIFO without hanging', { skip: process.platform === 'win32' }, () => {
  const directory = temp();
  const root = require('../../core/bounded-artifact').captureArtifactRoot(directory);
  const { hashArtifact } = require('../../core/bounded-artifact');
  assert.strictEqual(hashArtifact(path.join(directory, 'future.json'), root, { allowMissing: true }), null);
  fs.writeFileSync(path.join(directory, 'ordinary.json'), '{}\n');
  assert.match(hashArtifact(path.join(directory, 'ordinary.json'), root), /^[0-9a-f]{64}$/);
  const pipe = path.join(directory, 'pipe.json');
  assert.strictEqual(spawnSync('mkfifo', [pipe]).status, 0);
  const child = spawnSync(process.execPath, ['-e',
    'const h=require(process.argv[1]);try{h.hashArtifact(process.argv[2],h.captureArtifactRoot(process.argv[3]));process.exit(2)}catch(e){if(/unsafe or oversized/.test(e.message))process.exit(0);process.exit(3)}',
    require.resolve('../../core/bounded-artifact'), pipe, directory], { timeout: 3000 });
  assert.strictEqual(child.status, 0, `FIFO hash stalled or failed unsafely: ${child.error || child.stderr}`);
});

test('bounded review hash rejects a same-path inode replacement during its read', () => {
  const directory = temp(); const file = path.join(directory, 'artifact.json');
  fs.writeFileSync(file, 'original\n');
  const script = [
    'const fs=require("node:fs"),path=require("node:path"),h=require(process.argv[1]),file=process.argv[2];',
    'const read=fs.readSync;let swapped=false;',
    'fs.readSync=function(...args){const n=read.apply(this,args);if(!swapped){swapped=true;fs.unlinkSync(file);fs.writeFileSync(file,"replaced\\n")}return n};',
    'try{h.hashArtifact(file,h.captureArtifactRoot(path.dirname(file)));process.exit(2)}catch(e){process.exit(/unsafe or oversized/.test(e.message)?0:3)}',
  ].join('');
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../../core/bounded-artifact'), file], { timeout: 3000 });
  assert.strictEqual(child.status, 0, `replacement was not rejected: ${child.error || child.stderr}`);
});

test('reviewOnly refuses a symlinked producer output before trusted normalization', async () => {
  const repo = cleanRepo(); const stateDir = temp(); const h = harness({ stateDir });
  const external = path.join(temp(), 'artifact.json');
  let normalized = false;
  const cli = (args) => {
    if (args[0] === 'findings') return { findings: [] };
    if (args[0] === 'artifact-normalize') normalized = true;
    return h.cli(args);
  };
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'correctness') {
      const output = path.join(stateDir, 'round-1-correctness.json');
      fs.copyFileSync(output, external);
      fs.unlinkSync(output);
      fs.symlinkSync(external, output);
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/producer-output', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /protected review artifact changed: round-1-correctness\.json/,
  );
  assert.strictEqual(normalized, false);
});

test('reviewOnly telemetry publication refuses a worker-planted temporary symlink', async () => {
  const repo = cleanRepo(); const stateDir = temp(); const h = harness({ stateDir });
  const ref = 'feature/telemetry-temp'; const external = path.join(temp(), 'sentinel.txt');
  fs.writeFileSync(external, 'untouched\n');
  const cli = (args) => args[0] === 'findings' ? { findings: [] } : h.cli(args);
  const spawn = (input) => {
    const result = h.spawn(input);
    if (input.role === 'correctness') {
      const slug = require('../../core/review').targetSlug(ref);
      fs.symlinkSync(external, path.join(stateDir, `telemetry-${slug}.json.${process.pid}.tmp`));
    }
    return result;
  };
  await assert.rejects(
    runReviewUntilGreen({ ref, base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /EEXIST/,
  );
  assert.strictEqual(fs.readFileSync(external, 'utf8'), 'untouched\n');
});

test('reviewOnly refuses resume, which has no ledger to recover the base from', async () => {
  const h = harness();
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/resume', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn, reviewOnly: true, reviewer: 'claude', resume: true }),
    /reviewOnly cannot resume/,
  );
  assert.deepStrictEqual(h.calls, []);
});

test('codexExec keeps AGENTS.md and project rules out of a Codex reviewer on an untrusted checkout', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(codex, 0o755);
  await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, untrustedCheckout: true, codexExecutable: { command: codex, version: 'codex-cli 0.154.0' } });
  const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.ok(args.includes('project_doc_max_bytes=0'), `args: ${args.join(' ')}`);
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--strict-config'));
  assert.ok(!args.includes('--sandbox'));
});

test('codexExec keeps its normal sandbox and strips inherited credentials from untrusted reviews', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'capture.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nconst keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SAFE_VALUE']; require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(keys.map(key => [key, process.env[key] || null])) }));\n`);
  fs.chmodSync(codex, 0o755);
  const input = { role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir,
    codexExecutable: { command: codex, version: 'codex-cli 0.154.0' }, env: { ...process.env, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', SAFE_VALUE: 'kept' } };
  await codexExec({ ...input, untrustedCheckout: true });
  const untrusted = JSON.parse(fs.readFileSync(capture, 'utf8'));
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.strictEqual(untrusted.env[key], null, key);
  assert.strictEqual(untrusted.env.SAFE_VALUE, 'kept');
  await codexExec(input);
  const normal = JSON.parse(fs.readFileSync(capture, 'utf8'));
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.strictEqual(normal.env[key], 'secret', key);
  assert.strictEqual(normal.env.SAFE_VALUE, 'kept');
  assert.deepStrictEqual(normal.args.slice(0, 7), ['exec', '--cd', binDir, '--sandbox', 'workspace-write', '--add-dir', binDir]);
  assert.ok(!normal.args.includes('--strict-config'));
});

test('reviewOnly runs a Codex reviewer from its own CODEX_HOME, which marks the checkout untrusted before Codex can trust it', async () => {
  const sourceHome = temp();
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-test"}');
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), '[mcp_servers.user]\ncommand = "user-tool"\n');
  const repo = cleanRepo();
  const h = harness();
  const seen = [];
  const cli = (args) => (args[0] === 'findings' ? { findings: [] } : h.cli(args));
  const spawn = (input) => {
    const home = input.env && input.env.CODEX_HOME;
    seen.push({ role: input.role, untrusted: input.untrustedCheckout, home,
      config: home && fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
      auth: home && fs.readFileSync(path.join(home, 'auth.json'), 'utf8') });
    return h.spawn(input);
  };
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = sourceHome;
  try {
    await runReviewUntilGreen({ ref: 'feature/codex', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'codex', noBroad: true });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
  assert.ok(seen.length);
  for (const launch of seen) {
    assert.strictEqual(launch.untrusted, true);
    assert.ok(launch.home && launch.home !== sourceHome, `${launch.role} ran from its own CODEX_HOME`);
    assert.ok(launch.config.includes(`[projects.${JSON.stringify(fs.realpathSync(repo))}]\ntrust_level = "untrusted"`), launch.config);
    assert.ok(launch.config.includes('default_permissions = "concord-review"'), launch.config);
    assert.ok(launch.config.includes('approval_policy = "never"'), launch.config);
    assert.ok(launch.config.includes('[shell_environment_policy]\ninherit = "core"'), launch.config);
    assert.ok(launch.config.includes('ignore_default_excludes = false'), launch.config);
    assert.ok(launch.config.includes('[permissions.concord-review]\nextends = ":workspace"'), launch.config);
    assert.ok(launch.config.includes(`[permissions.concord-review.filesystem]\n${JSON.stringify(path.join(sourceHome, 'auth.json'))} = "deny"`), launch.config);
    assert.ok(launch.config.includes(`${JSON.stringify(path.join(launch.home, 'auth.json'))} = "deny"`), launch.config);
    assert.ok(launch.config.includes('[permissions.concord-review.network]\nenabled = false'), launch.config);
    assert.ok(!launch.config.includes('mcp_servers'), 'the account\'s own Codex configuration stays out');
    assert.strictEqual(launch.auth, '{"OPENAI_API_KEY":"sk-test"}');
  }
  assert.ok(!fs.existsSync(seen[0].home), 'the review-only CODEX_HOME is removed when the run ends');
});

test('reviewOnly fails when a reviewer moved HEAD, even with a clean worktree', async () => {
  const repo = cleanRepo();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const h = harness();
  const cli = (args) => {
    if (args[0] === 'findings') return { findings: [] };
    const out = h.cli(args);
    return args[0] === 'round-start' ? { ...out, head } : out;
  };
  const spawn = (input) => {
    if (input.role === 'correctness') execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'moved'], { cwd: repo });
    return h.spawn(input);
  };
  await assert.rejects(
    runReviewUntilGreen({ ref: 'feature/moved', base: 'main', repoRoot: repo, runCli: cli, spawn, reviewOnly: true, reviewer: 'claude', noBroad: true }),
    /reviewer moved HEAD/,
  );
});

test('a reviewer subprocess does not inherit the driver\'s CONCORD_CODEX_BIN override', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'env.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ bin: process.env.CONCORD_CODEX_BIN || null }));\n`);
  fs.chmodSync(codex, 0o755);
  await codexExec({ role: 'verify', prompt: 'p', repoRoot: binDir, stateDir: binDir, env: { ...process.env, CONCORD_CODEX_BIN: codex } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { bin: null });
});

test('the verify prompt lists the examined paths and the certify prompt lists the declared fix files', async () => {
  const examined = ['src/examined-one.js', 'docs/examined-two.md'];
  const h = harness({ correctnessArtifact: JSON.stringify({ status: 'ok', examined, findings: [] }) });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const promptFor = (role) => h.calls.find((call) => call[0] === 'spawn' && call[1] === role)?.[2];
  for (const file of examined) assert.ok(promptFor('verify').includes(`"${file}"`), `verify prompt does not list ${file}`);
  assert.ok(promptFor('certify').includes('["a.txt"]'), 'certify prompt does not list the declared fix files');
});

for (const targetType of ['git', 'file']) {
  test(`codex runner: a ${targetType} group whose fixer reports no edit launches no certifier and no commit`, async () => {
    const h = harness({ targetType });
    const spawn = async (options) => {
      const result = await h.spawn(options);
      if (options.role === 'fix') fs.writeFileSync(path.join(h.stateDir, 'round-1-fix-correctness_bug.json'), JSON.stringify({ status: 'ok', edited: false }));
      return result;
    };
    const repoRoot = temp();
    fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'bad\n');
    await runReviewUntilGreen({ ref: targetType === 'file' ? 'file:a.txt' : 'feature/x', repoRoot, runCli: h.cli, spawn });
    assert.ok(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'fix'));
    assert.strictEqual(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'certify'), false);
    assert.strictEqual(h.calls.some((call) => call[0] === 'cli' && call[1] === 'commit-fix'), false);
    assert.ok(h.calls.some((call) => call[0] === 'cli' && call[1] === 'record'));
    assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'a.txt'), 'utf8'), 'bad\n');
  });
}

test('codex runner: a round transaction with a no-edit member launches no certifier and no commit', async () => {
  const h = harness();
  const cli = (args) => {
    if (args[0] !== 'plan-fixes') return h.cli(args);
    h.calls.push(['cli', ...args]);
    const fixGroups = ['a', 'b'].map((groupId) => {
      const finding = { id: `correctness:${groupId}`, file: 'a.txt', span: 'bad', summary: `fix ${groupId}` };
      return { groupId, findingIds: [finding.id], rootCause: finding.summary, invariants: ['shared invariant'], changeClass: 'structural', action: 'fix', findings: [finding] };
    });
    return { protocolVersion: 2, planId: 'plan-1', transactionScope: 'round', fixes: fixGroups.flatMap((group) => group.findings), fixGroups };
  };
  const spawn = async (options) => {
    if (options.role !== 'fix') return h.spawn(options);
    h.calls.push(['spawn', options.role, options.prompt, options.provider]);
    const target = options.prompt.match(/write ONLY to (.+\.json): either/)?.[1];
    if (!target) throw new Error('fix prompt did not name an artifact path');
    const groupId = path.basename(target).match(/^round-1-fix-(.+)\.json$/)[1];
    if (groupId === 'a') fs.writeFileSync(path.join(options.repoRoot, 'a.txt'), 'fixed by a\n');
    fs.writeFileSync(target, JSON.stringify(groupId === 'a' ? { status: 'ok', edited: true, groupId: 'a', files: ['a.txt'] } : { status: 'ok', edited: false }));
    return { status: 0 };
  };
  const repoRoot = temp();
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'bad\n');
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot, runCli: cli, spawn });
  const fixTargets = h.calls.filter((call) => call[0] === 'spawn' && call[1] === 'fix').map((call) => path.basename(call[2].match(/write ONLY to (.+\.json): either/)[1]));
  assert.deepStrictEqual(fixTargets, ['round-1-fix-a.json', 'round-1-fix-b.json']);
  assert.strictEqual(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'certify'), false);
  assert.strictEqual(h.calls.some((call) => call[0] === 'cli' && call[1] === 'commit-fix'), false);
  assert.ok(h.calls.some((call) => call[0] === 'cli' && call[1] === 'record'));
  // The runner leaves A's uncommitted edit for record to park; parking itself is the CLI's decision.
  assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'a.txt'), 'utf8'), 'fixed by a\n');
});
