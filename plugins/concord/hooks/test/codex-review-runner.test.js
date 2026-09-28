'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeArtifact } = require('../../core/artifact-contract');
const { foldTelemetry } = require('../../core/review-telemetry');
const { runPath, openInitiativeRun } = require('../../core/initiative-review-run');

// The runner owns all sequencing. Its subprocess seam makes this a no-network
// integration test while exercising the real artifact contract at the boundary.
const { runReviewUntilGreen, reviewerPrompt, codexExec, providerExec, resolveCodexExecutable, resolveDefaultBase } = require('../../core/codex-review-runner');
const { reviewerPrompt: packagedReviewerPrompt } = require('../../../concord-codex/engine/codex-review-runner');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-')); }

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

test('changed terminal target identity fails before round-start', async () => {
  const stateDir = temp();
  const key = 'changed-terminal';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, targets: [{ ref: 'file:note.md', head_sha: 'old-bytes' }], dispositions: [{ target: 'file:note.md', reason: 'clean', kind: 'terminal', revision: { ref: 'file:note.md', head_sha: 'old-bytes' } }] }));
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'new-bytes', runCli: () => { throw new Error('round-start must not run'); } }),
    /revision changed/,
  );
});

test('terminal target preflight does not replay against a historical matching target', async () => {
  const stateDir = temp();
  const key = 'multi-revision-terminal';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, targets: [{ ref: 'file:note.md', head_sha: 'old-bytes' }, { ref: 'file:note.md', head_sha: 'current-bytes' }], dispositions: [{ target: 'file:note.md', reason: 'clean', kind: 'terminal', revision: { ref: 'file:note.md', head_sha: 'old-bytes' } }] }));
  await assert.rejects(runReviewUntilGreen({ ref: 'file:note.md', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'current-bytes', runCli: () => { throw new Error('round-start must not run'); } }), /revision changed/);
});

test('legacy terminal file targets without head_sha fail closed before a round', async () => {
  const stateDir = temp();
  const key = 'legacy-file-terminal';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, targets: [{ ref: 'file:note.md' }], dispositions: [{ target: 'file:note.md', reason: 'clean', kind: 'terminal', revision: { ref: 'file:note.md' } }] }));
  await assert.rejects(
    runReviewUntilGreen({ ref: 'file:note.md', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'new-bytes', runCli: () => { throw new Error('round-start must not run'); } }),
    /no stored revision/,
  );
});

test('terminal replay requires the recorded base even when head matches', async () => {
  const stateDir = temp();
  const key = 'same-head-different-base';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', base: 'main', head_sha: 'same-head' } }] }));
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', base: 'release', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => 'same-head', runCli: () => { throw new Error('round-start must not run'); } }), /revision changed/);
});

test('resuming a terminal git target binds its recorded base before identity and round-start', async () => {
  const stateDir = temp();
  const key = 'resume-terminal-base';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', base: 'main', head_sha: 'same-head' } }] }));
  let identityBase;
  const result = await runReviewUntilGreen({ ref: 'feature/x', resume: true, initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: (_ref, base) => { identityBase = base; return 'same-head'; }, runCli: () => { throw new Error('round-start must not run'); } });
  assert.strictEqual(identityBase, 'main');
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

test('terminal git targets without a recorded base fail closed before identity and round-start', async () => {
  const stateDir = temp();
  const key = 'legacy-git-terminal';
  const run = openInitiativeRun({ stateDir, key, repository: process.cwd(), maxLaunches: 1, maxRounds: 1 });
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  fs.writeFileSync(run.path, JSON.stringify({ ...ledger, dispositions: [{ target: 'feature/x', reason: 'clean', kind: 'terminal', revision: { ref: 'feature/x', head_sha: 'same-head' } }] }));
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', resume: true, initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, targetIdentity: () => { throw new Error('identity must not run'); }, runCli: () => { throw new Error('round-start must not run'); } }), /no stored base/);
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
    runCli: ([verb]) => verb === 'round-start' ? { decision: 'work', ref: 'feature/x', base: 'main', head: 'reviewed-head', attemptId: 'attempt-1', round: 1, stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { fixes: [] }
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
  await runReviewUntilGreen({ ...escaped, runCli: ([verb]) => verb === 'round-start' ? { decision: 'escape', base: 'main', head: 'head', stateDir } : undefined });
  const escapedLedger = JSON.parse(fs.readFileSync(runPath(stateDir, 'escaped'), 'utf8'));
  assert.deepStrictEqual(escapedLedger.dispositions[0], { target: 'feature/escape', revision: { ref: 'feature/escape', base: 'main', head_sha: 'head' }, kind: 'escape', reason: 'escape', sequence: 1, packet: { trigger: 'escape', exit: { code: 0, signal: null }, dod: { status: 'not-run' }, telemetry: { complete: true }, nextAction: 'resume', ledger: { version: 3, status: 'active' }, budget: { maxLaunches: 1, maxRounds: 1, launches: 0, rounds: 0 }, delivery: { claim: 'feature/escape:1', continuation: 'resume', consumed: true } } });

  const failed = { ref: 'feature/error', repoRoot: '/repo', initiativeRunKey: 'errored', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1 };
  let error;
  await assert.rejects(runReviewUntilGreen({ ...failed, runCli: ([verb]) => verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false } : verb === 'artifact-normalize' ? { status: 'ok' } : undefined, spawn: async () => { throw new Error('subprocess failed'); } }), (caught) => { error = caught; return /subprocess failed/.test(caught.message); });
  assert.strictEqual(error.continuationPacket.delivery.consumed, true);
  const errorDisposition = JSON.parse(fs.readFileSync(runPath(stateDir, 'errored'), 'utf8')).dispositions[0];
  assert.deepStrictEqual(errorDisposition.packet.exit, { code: null, signal: null });
  assert.deepStrictEqual(errorDisposition.packet.telemetry, { complete: false });
  assert.strictEqual(errorDisposition.packet.nextAction, 'resume');
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

test('initiative runner consumes its terminal delivery claim before returning the continuation packet', async () => {
  const stateDir = temp();
  const result = await runReviewUntilGreen({ ref: 'feature/deliver', base: 'main', repoRoot: '/repo', initiativeRunKey: 'deliver', initiativeStateDir: stateDir, initiativeMaxLaunches: 1, initiativeMaxRounds: 1, runCli: ([verb]) => verb === 'round-start' ? { decision: 'terminal', status: 'clean', base: 'main', head: 'head', stateDir } : undefined });
  assert.strictEqual(result.continuationPacket.delivery.consumed, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(runPath(stateDir, 'deliver'), 'utf8')).dispositions[0].packet.delivery.consumed, true);
});

test('reconciliation terminates the target and retains its restored base and avoided fixes', async () => {
  const stateDir = temp();
  await runReviewUntilGreen({
    ref: 'feature/x', resume: true, repoRoot: '/repo', initiativeRunKey: 'reconcile', initiativeStateDir: stateDir, initiativeMaxLaunches: 4, initiativeMaxRounds: 1,
    runCli: ([verb]) => {
      if (verb === 'round-start') return { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: false, dodDeferred: false, intentApplied: false, gateApplied: false };
      if (verb === 'artifact-normalize') return { status: 'ok' };
      if (verb === 'plan-fixes') return { fixes: [], avoidedLaunches: 2, reconciliation: { finding: 'intent:missing', findings: { intent: 1 } } };
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
    runCli: ([verb]) => verb === 'round-start' ? { decision: 'work', round: 1, base: 'main', head: 'head', stateDir, targetType: 'git', dodPassed: true, dodDeferred: true, intentApplied: false, gateApplied: false }
      : verb === 'artifact-normalize' ? { status: 'ok' }
        : verb === 'plan-fixes' ? { fixes: [] }
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
    const first = codexExec({ role: 'panel', prompt: 'first', repoRoot: binDir, stateDir: binDir, timeoutMs: 1000 });
    const second = codexExec({ role: 'panel', prompt: 'second', repoRoot: binDir, stateDir: binDir, timeoutMs: 1000 });
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
  ['claude', 'claude', ['-p', '--model', 'review-model', '--add-dir']],
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

test('codexExec elapsed time excludes the synchronous version probe', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900); process.stdout.write('codex-cli 0.154.0\\n'); }\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    assert.ok(result.elapsedMs < 800, `review elapsed time included version probe: ${result.elapsedMs}ms`);
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
      return { decision: 'work', round, stateDir, targetType, dodPassed: true, dodDeferred, intentApplied: false, gateApplied, retryArtifact, retryArtifacts };
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
      if (retry && role === 'correctness' && (!retried || retryForever)) { retried = true; return { status: 'retry', prompt: 'REWRITE ARTIFACT' }; }
      return { status: 'ok' };
    }
    if (verb === 'telemetry-slot') {
      const artifactPath = role;
      return { engine: 'codex', provider: 'openai', artifactPath, attempt: calls.filter((call) => call[0] === 'cli' && call[1] === 'telemetry-slot' && call[3] === artifactPath).length, role: path.basename(artifactPath).includes('-fix-') ? 'fix' : path.basename(artifactPath).match(/^round-\d+-(.+)\.json$/)?.[1], round, ...slotIdentity };
    }
    if (verb === 'plan-fixes') return { fixes: round === 1 ? [{ id: 'correctness:bug', file: 'a.txt', span: 'bad', summary: 'fix it' }] : [] };
    if (verb === 'commit-fix') {
      if (promptDrivenFix && !fs.existsSync(path.join(stateDir, `round-${round}-fix-${String(role).replace(/:/g, '_')}.json`))) throw new Error('commit-fix did not receive its declared artifact');
      return { committed: true, sha: 'abc' };
    }
    if (verb === 'record') return round < rounds ? { decision: { continue: true }, handoff: 'continue' } : { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb} ${ref}`);
  };
  const spawn = ({ role, prompt, provider }) => {
    calls.push(['spawn', role, prompt, provider]);
    if (role === failingRole) return { status: 1 };
    const n = round;
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, `round-${n}-correctness.json`), correctnessArtifact || JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'gate') fs.writeFileSync(path.join(stateDir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
    if (role === 'fix') {
      const target = promptDrivenFix ? prompt.match(/write ONLY to (.+\.json): either/)?.[1] : path.join(stateDir, `round-${n}-fix-correctness_bug.json`);
      if (!target) throw new Error('fix prompt did not name an artifact path');
      fs.writeFileSync(target, JSON.stringify({ status: 'ok', edited: true, files: ['a.txt'] }));
    }
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
    if (verb === 'plan-fixes') return { fixes: [] };
    if (verb === 'record') return { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    calls.push(`${attempt}:${role}`);
    if (attempt === 1 && role === 'verify') throw new Error('interrupted');
    return { status: 0 };
  };

  await assert.rejects(runReviewUntilGreen({ ref: 'feature/resume', repoRoot: '/repo', runCli: cli, spawn }), /interrupted/);
  await runReviewUntilGreen({ ref: 'feature/resume', resume: true, repoRoot: '/repo', runCli: cli, spawn });
  assert.deepStrictEqual(calls, ['1:correctness', '1:verify', '2:verify']);
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

  await assert.rejects(runReviewUntilGreen({ ref: 'feature/wait', repoRoot: '/repo', runCli: cli, spawn }), /correctness failed/);
  assert.strictEqual(siblingFinished, true);
});

test('runner automatically executes a clean round in correctness then verify order and returns terminal handoff', async () => {
  const h = harness();
  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(out.handoff, 'LGTM');
  assert.deepStrictEqual(h.calls.map((c) => c[0] === 'spawn' ? c.slice(0, 2) : c.slice(0, 2)), [
    ['cli', 'round-start'], ['cli', 'telemetry-slot'], ['spawn', 'correctness'], ['cli', 'artifact-normalize'], ['cli', 'telemetry-slot'], ['spawn', 'verify'], ['cli', 'artifact-normalize'], ['cli', 'plan-fixes'], ['cli', 'telemetry-slot'], ['spawn', 'fix'], ['cli', 'commit-fix'], ['cli', 'record'],
  ]);
  assert.ok(h.calls.filter((call) => call[0] === 'cli' && call[1] === 'telemetry-slot').every((call) => call.slice(-2).join(' ') === '--engine codex'));
  assert.strictEqual(fs.existsSync(path.join(h.stateDir, 'telemetry-feature-x.json')), false);
});

test('runner records slots when the review state directory contains whitespace', async () => {
  const stateDir = path.join(temp(), 'state dir');
  fs.mkdirSync(stateDir);
  const h = harness({ stateDir });

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });

  assert.strictEqual(h.calls.filter((call) => call[0] === 'cli' && call[1] === 'telemetry-slot').length, 3);
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
    { role: 'fix', round: 1 },
  ]);
});

test('runner reports aggregate and per-role subprocess telemetry', async () => {
  const h = harness();
  const usageByRole = {
    correctness: { inputTokens: 100, cacheWriteInputTokens: 0, cachedInputTokens: 10, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 111 },
    verify: { inputTokens: 200, cacheWriteInputTokens: 0, cachedInputTokens: 20, reasoningOutputTokens: 0, outputTokens: 2, totalTokens: 222 },
    fix: { inputTokens: 300, cacheWriteInputTokens: 0, cachedInputTokens: 30, reasoningOutputTokens: 0, outputTokens: 3, totalTokens: 333 },
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
      calls: 3,
      partialCalls: 0,
      inputTokens: 600,
      cacheWriteInputTokens: 0,
      cachedInputTokens: 60,
      reasoningOutputTokens: 0,
      outputTokens: 6,
      totalTokens: 666,
      elapsedMs: 60,
    },
    byRole: {
      correctness: { calls: 1, partialCalls: 0, ...usageByRole.correctness, elapsedMs: 10 },
      verify: { calls: 1, partialCalls: 0, ...usageByRole.verify, elapsedMs: 20 },
      fix: { calls: 1, partialCalls: 0, ...usageByRole.fix, elapsedMs: 30 },
    },
    invocations: [
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-correctness', role: 'correctness', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, ...usageByRole.correctness, elapsedMs: 10, artifactPath: path.join(h.stateDir, 'round-1-correctness.json'), attempt: 1 },
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-verify', role: 'verify', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, ...usageByRole.verify, elapsedMs: 20, artifactPath: path.join(h.stateDir, 'round-1-verify.json'), attempt: 1 },
      { engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', invocationId: 'invocation-fix', role: 'fix', round: 1, model: 'gpt-5.1-codex', resolvedModel: null, reasoningEffort: 'high', serviceTier: 'priority', status: 0, usagePartial: false, ...usageByRole.fix, elapsedMs: 30, artifactPath: path.join(h.stateDir, 'round-1-fix-correctness_bug.json'), attempt: 1 },
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
    calls: 4, partialCalls: 3, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 1, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 16, elapsedMs: 20,
  });
  assert.deepStrictEqual(out.telemetry.invocations.map(({ role, round }) => ({ role, round })), [
    { role: 'correctness', round: 4 },
    { role: 'correctness', round: 1 },
    { role: 'verify', round: 1 },
    { role: 'fix', round: 1 },
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
    fields.map(() => null), fields.map(() => null), fields.map(() => null),
  ]);

  const telemetryPath = path.join(h.stateDir, 'telemetry-feature-x.json');
  fs.writeFileSync(telemetryPath, JSON.stringify(out.telemetry));
  const folded = foldTelemetry(h.stateDir, {
    target: { ref: 'feature/x' },
    telemetrySlots: out.telemetry.invocations.map(({ artifactPath, attempt, role, round }) => ({ engine: 'codex', provider: 'openai', artifactPath, attempt, role, round })),
  }, 'feature-x').telemetry;
  assert.strictEqual(folded.totalTokens, null);
  assert.strictEqual(folded.partialCalls, 3);
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
      /no usable Codex executable/,
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
    /spawn failed/,
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
    calls: 3, partialCalls: 3, missingCalls: undefined,
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

test('fix prompt requires an explicit, span-absent claim for a distinct planned mirror finding', () => {
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, finding: { id: 'correctness:bug', file: 'src/parser.js', span: 'lines 41-43', summary: 'repair it' }, plannedFindingIds: ['correctness:bug', 'correctness:mirror'] });
  assert.match(prompt, /\/state\/round-7-fix-correctness_bug\.json/);
  assert.match(prompt, /src\/parser\.js/);
  assert.match(prompt, /lines 41-43/);
  assert.match(prompt, /EVERY file/i);
  assert.match(prompt, /"edited":false/);
  assert.match(prompt, /"resolvedFindingIds"/);
  assert.match(prompt, /distinct planned mirror finding/i);
  assert.match(prompt, /exact span must be absent/i);
  assert.match(prompt, /correctness:mirror/);
  assert.doesNotMatch(prompt, /other planned fixes: \["correctness:bug"/);
  assert.match(prompt, /"files":\["<every edited path>"\],"resolvedFindingIds":\["<distinct planned mirror finding id>"\]\}/);
});

test('file-target fix prompt omits git-only mirror claims', () => {
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, targetType: 'file', finding: { id: 'correctness:bug', file: 'note.md', span: 'bad', summary: 'fix it' }, plannedFindingIds: ['correctness:bug', 'correctness:mirror'] });
  assert.doesNotMatch(prompt, /resolvedFindingIds|mirror finding|correctness:mirror/);
  assert.match(prompt, /\{"status":"ok","edited":true,"files":\["<every edited path>"\]\}\./);
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

test('correctness prompt keeps the real pass and real failure wordings when the gate actually ran', () => {
  const passed = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: true, dodDeferred: false });
  assert.match(passed, /DoD already passed; do not rerun tests\./);
  const failed = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: false, dodDeferred: false });
  assert.match(failed, /DoD already failed; do not root-cause it\./);
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
    assert.match(prompt, /Ignore any intent-\*\.md file/);
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
  assert.deepStrictEqual(failure, { role: 'correctness', kind: 'signal', message: 'correctness subprocess ended from SIGTERM', signal: 'SIGTERM' });
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

test('intent and gate review chains fan out alongside the correctness-to-verify chain', async () => {
  const stateDir = temp();
  const pending = new Map();
  const calls = [];
  const cli = (args) => {
    const [verb, , role] = args;
    if (verb === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: true, intentApplied: true, gateApplied: true, priorIntentIds: ['intent:retry-count'] };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'telemetry-slot') return { engine: 'codex', provider: 'openai', artifactPath: role, attempt: 1 };
    if (verb === 'plan-fixes') return { fixes: [] };
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
    pending.get(role)({ status: 0 });
  };

  const running = runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  await new Promise(setImmediate);
  assert.deepStrictEqual(calls, ['correctness', 'intent', 'gate']);
  complete('correctness');
  complete('intent');
  complete('gate');
  await new Promise(setImmediate);
  assert.deepStrictEqual(calls, ['correctness', 'intent', 'gate', 'verify', 'gate-verify']);
  complete('verify');
  complete('gate-verify');
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
  assert.match((await running).message, /interrupted panel lens/);
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
  assert.match((await running).message, /interrupted adversarial vote/);
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
    if (verb === 'plan-fixes') return { fixes: [] };
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mtime-repo-'));
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

test('runner appends retry prompt and retries precisely once', async () => {
  const h = harness({ retry: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const correctness = h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'correctness');
  assert.strictEqual(correctness.length, 2);
  assert.match(correctness[1][2], /REWRITE ARTIFACT/);
});

test('runner resumes an artifact retry with its persisted prompt', async () => {
  const h = harness({ retryArtifact: { role: 'correctness', prompt: 'RESUME ARTIFACT RETRY' } });
  await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const correctness = h.calls.filter((call) => call[0] === 'spawn' && call[1] === 'correctness');
  assert.strictEqual(correctness.length, 1);
  assert.match(correctness[0][2], /RESUME ARTIFACT RETRY/);
});

test('runner resumes every persisted artifact retry prompt', async () => {
  const h = harness({ gateApplied: true, retryArtifacts: { correctness: 'RESUME CORRECTNESS RETRY', gate: 'RESUME GATE RETRY' } });
  await runReviewUntilGreen({ ref: 'feature/x', resume: true, repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const correctness = h.calls.find((call) => call[0] === 'spawn' && call[1] === 'correctness');
  const gate = h.calls.find((call) => call[0] === 'spawn' && call[1] === 'gate');
  assert.match(correctness[2], /RESUME CORRECTNESS RETRY/);
  assert.match(gate[2], /RESUME GATE RETRY/);
});

test('runner fail-closes a malformed reviewer artifact before verify', async () => {
  const h = harness({ malformed: true });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /harness-failure/);
  assert.strictEqual(h.calls.some((c) => c[0] === 'spawn' && c[1] === 'verify'), false);
});

test('runner fails closed when the retry artifact is still invalid', async () => {
  const h = harness({ retry: true, retryForever: true });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /retry exhausted/);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'correctness').length, 2);
});

test('runner loops through record continuation and file targets never commit', async () => {
  const h = harness({ rounds: 2, targetType: 'file' });
  await runReviewUntilGreen({ ref: 'file:note.md', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
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

test('Codex launcher --help exits without invoking the runner', () => {
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
        return { handoff: 'unexpected' };
      } };
      return load.apply(this, arguments);
    };
  `);
  const output = execFileSync('node', ['--require', preload, bin, '--help'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  assert.match(output, /^Usage: review-until-green/m);
  assert.match(output, /resume <ref>/);
  assert.strictEqual(fs.existsSync(capture), false);
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

test('Codex launcher emits only a consumed continuation packet and never duplicates it', () => {
  const dir = temp();
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  const preload = path.join(dir, 'runner.js');
  fs.writeFileSync(preload, `const Module = require('node:module'); const load = Module._load; Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => ({ decision: 'terminal', initiative: {}, handoff: 'legacy', continuationPacket: { delivery: { consumed: true, claim: 'one' } } }) }; return load.apply(this, arguments); };`);
  assert.strictEqual(execFileSync('node', ['--require', preload, bin, 'feature/x'], { encoding: 'utf8' }), '{"delivery":{"consumed":true,"claim":"one"}}\n');
  fs.writeFileSync(preload, `const Module = require('node:module'); const load = Module._load; Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => ({ decision: 'terminal', initiative: {}, handoff: 'legacy' }) }; return load.apply(this, arguments); };`);
  assert.strictEqual(execFileSync('node', ['--require', preload, bin, 'feature/x'], { encoding: 'utf8' }), '');
});

test('Codex launcher emits a consumed error continuation packet before nonzero exit', () => {
  const dir = temp();
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  const preload = path.join(dir, 'runner.js');
  fs.writeFileSync(preload, `const Module = require('node:module'); const load = Module._load; Module._load = function(request, parent, isMain) { if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async () => { const error = new Error('legacy'); error.continuationPacket = { delivery: { consumed: true, claim: 'error' } }; throw error; } }; return load.apply(this, arguments); };`);
  assert.throws(() => execFileSync('node', ['--require', preload, bin, 'feature/x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error) => error.status === 1 && error.stderr === '{"delivery":{"consumed":true,"claim":"error"}}\n');
});
