'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { artifactDestinationFromPrompt } = require('../../core/review-artifact');
const { readLedger, targetSlug, ledgerPath } = require('../../core/review');
const { runPath } = require('../../core/initiative-review-run');

const ref = 'feature/plan-resume';
const ids = ['correctness:first', 'correctness:second'];
function fixture({ maxLaunches = 12, incompleteReplacement = false, acceptedInitially = false, repairInitialPlan = false, replacementError = null, cliCopy = 'core', broadIntent = false, keyed = true, failReplacement = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-resume-'));
  const repo = path.join(root, 'repo');
  const stateDir = path.join(root, 'review');
  const initiativeDir = path.join(root, 'initiative');
  for (const dir of [repo, stateDir, initiativeDir]) fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').toString().trim();
  git('checkout', '-qb', ref);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('commit', '-qam', 'change');
  const intentFile = path.join(root, 'intent.md');
  if (broadIntent) fs.writeFileSync(intentFile, 'REQ: Both local defects are corrected.\n');
  const launches = [];
  const calls = [];
  const plans = [];
  const cliPath = path.resolve(__dirname, cliCopy === 'core' ? '../review-cli.js' : `../../../concord-${cliCopy}/bin/review-cli.js`);
  const runCli = (args) => {
    calls.push(args);
    try {
      const value = JSON.parse(execFileSync(process.execPath, [cliPath, ...args], {
        cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir }, encoding: 'utf8', stdio: 'pipe',
      }));
      if (args[0] === 'plan-fixes') plans.push(value);
      return value;
    } catch (error) { throw new Error(String(error.stderr || error.message).trim()); }
  };
  const spawn = (input) => {
    launches.push(input.role);
    if (input.role === 'artifact-repair') {
      const artifact = JSON.parse(fs.readFileSync(path.join(input.repoRoot, 'original.json'), 'utf8'));
      artifact.status = 'ok';
      if (artifact.groups) artifact.groups = artifact.groups.filter((group) => group.findingIds.some((id) => id.startsWith('correctness:')));
      fs.writeFileSync(path.join(input.repoRoot, 'candidate.json'), JSON.stringify(artifact));
      return { status: 0 };
    }
    if (failReplacement && input.role === 'plan' && launches.filter((role) => role === 'plan').length === 2) return { status: 1 };
    if (input.role === 'fix') return { status: 1 }; // Halt after the real CLI authorizes the exact group; never edit the fixture.
    const destination = artifactDestinationFromPrompt(input.prompt, input.stateDir);
    let artifact;
    if (input.role === 'correctness') artifact = { status: 'ok', examined: ['a.txt'], findings: ids.map((id) => ({ id, gate: 'correctness', file: 'a.txt', span: 'two', summary: id })) };
    else if (input.role === 'verify') artifact = { status: 'ok', rejected: [], findings: [] };
    else if (input.role === 'intent' || input.role === 'gate') artifact = { status: 'ok', findings: [] };
    else if (input.role === 'gate-verify') artifact = { status: 'ok', rejected: [], findings: [] };
    else if (input.role === 'plan') {
      const complete = acceptedInitially || (!incompleteReplacement && launches.filter((role) => role === 'plan').length > 1);
      artifact = { status: repairInitialPlan && launches.filter((role) => role === 'plan').length === 1 ? 'OK' : 'ok', protocolVersion: 2, groups: complete ? [{ groupId: 'shared', findingIds: ids, rootCause: 'shared local defect', invariants: ['both findings fixed'], changeClass: 'local', structuralEffects: [], action: 'fix' }] : [] };
      if (launches.filter((role) => role === 'plan').length > 1) {
        if (replacementError === 'status') artifact.status = 'OK';
        // Status case makes this mixed-namespace plan eligible under the existing repair contract.
        if (replacementError === 'namespace') artifact.status = 'OK';
        if (replacementError === 'namespace') artifact.groups.push({ groupId: 'foreign', findingIds: ['gate:cross-context:foreign'], rootCause: 'foreign defect', invariants: ['foreign'], changeClass: 'local', structuralEffects: [], action: 'fix' });
      }
    } else throw new Error(`unexpected provider role ${input.role}`);
    fs.writeFileSync(destination, JSON.stringify(artifact));
    return { status: 0 };
  };
  const options = { ref, base, repoRoot: repo, runCli, spawn, noBroad: !broadIntent, broad: broadIntent, ...(broadIntent ? { intentFile } : {}), sessionHandoff: 'off', ...(keyed ? { initiativeRunKey: 'same-run', initiativeStateDir: initiativeDir, initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: 1 } : {}) };
  const ledger = () => readLedger(stateDir, targetSlug(ref));
  const initiative = () => JSON.parse(fs.readFileSync(runPath(initiativeDir, 'same-run'), 'utf8'));
  const resume = () => runReviewUntilGreen({ ...options, resume: true });
  return { root, stateDir, broadIntent, launches, calls, plans, options, ledger, initiative, resume, runCli };
}
async function initialIncomplete(h) {
  await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  assert.equal(h.calls.find((args) => args[0] === 'artifact-normalize' && args[2] === 'plan') !== undefined, true);
  assert.equal(h.initiative().launches.length, 3);
  assert.equal(h.ledger().round, 1);
}
function sealed(h) {
  return Object.fromEntries((h.broadIntent ? ['correctness', 'verify', 'intent', 'gate', 'gate-verify'] : ['correctness', 'verify']).map((role) => [role, { hash: h.ledger().execution.artifactHashes[role], bytes: fs.readFileSync(path.join(h.stateDir, `round-1-${role}.json`), 'utf8') }]));
}

test('incomplete v2 plan resume reserves only a new planner, preserves sealed evidence and exact findings', async (t) => {
  const h = fixture(); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'fix']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.ledger().round, 1);
  assert.deepEqual(h.plans[0].fixes.map((finding) => finding.id), ids);
  assert.deepEqual(h.plans[0].fixGroups[0].findingIds, ids);
  assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 2);
  assert.equal(h.initiative().rounds.length, 1);
  const telemetry = JSON.parse(fs.readFileSync(path.join(h.stateDir, `telemetry-${targetSlug(ref)}.json`), 'utf8'));
  assert.equal(telemetry.invocations.filter((invocation) => invocation.role === 'plan').length, 2);
});

test('a second incomplete plan is bounded and later resumes launch nothing', async (t) => {
  const h = fixture({ incompleteReplacement: true }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  await assert.rejects(h.resume(), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  await assert.rejects(h.resume(), /(?:exhausted|incomplete).*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.equal(h.initiative().launches.length, 4);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.ledger().round, 1);
});

test('denied replacement planner reservation launches nothing and records the actual budget block', async (t) => {
  const h = fixture({ maxLaunches: 3 }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  const result = await h.resume();
  assert.equal(result.decision, 'blocked');
  assert.equal(result.reason, 'budget-exhausted');
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 3);
  assert.equal(h.ledger().initiative_blocked.role, 'plan');
  assert.equal(h.ledger().initiative_blocked.key, 'same-run');
});

test('a plan accepted by plan-fixes resumes without relaunching its planner', async (t) => {
  const h = fixture({ acceptedInitially: true }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(runReviewUntilGreen(h.options), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  const before = sealed(h);
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'fix', 'fix']);
  assert.deepEqual(sealed(h), before);
  assert.deepEqual(h.plans.map((plan) => plan.fixGroups[0].findingIds), [ids, ids]);
  assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 1);
});


test('interruption after normalization reuses the pending plan without a new planner launch', async (t) => {
  const h = fixture({ acceptedInitially: true }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const runCli = (args) => {
    if (args[0] === 'plan-fixes') throw new Error('test interruption before semantic acceptance');
    return h.runCli(args);
  };
  await assert.rejects(runReviewUntilGreen({ ...h.options, runCli }), /test interruption/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  assert.equal(h.ledger().execution.completed.includes('plan'), false);
  assert.equal(h.ledger().execution.normalizedPlan, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(h.stateDir, 'round-1-plan.json'))).digest('hex'));
  const before = sealed(h);
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'fix']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 1);
});

test('semantic rejection after schema repair requests a fresh planner rather than replaying its repair candidate', async (t) => {
  const h = fixture({ repairInitialPlan: true }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'artifact-repair']);
  const before = sealed(h);
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'artifact-repair', 'plan', 'fix']);
  assert.deepEqual(sealed(h), before);
  assert.deepEqual(h.plans[0].fixGroups[0].findingIds, ids);
  assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 3);
});

test('native CLI refuses to normalize replacement plan evidence without a fresh keyed reservation', async (t) => {
  const h = fixture(); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const started = h.runCli(h.calls.find((args) => args[0] === 'round-start'));
  assert.equal(started.round, 1);
  const initiativeFlags = h.calls.find((args) => args[0] === 'artifact-normalize' && args[2] === 'plan').slice(3);
  assert.throws(() => h.runCli(['artifact-normalize', ref, 'plan', ...initiativeFlags]), /reserv|launch/i);
  assert.equal(h.initiative().launches.length, 3);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
});


test('planner recovery preserves sealed intent and both broad gate roles in the same round', async (t) => {
  const h = fixture({ broadIntent: true }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual([...h.launches].sort(), ['intent', 'correctness', 'verify', 'gate', 'gate-verify', 'plan'].sort());
  const before = sealed(h);
  const initial = [...h.launches];
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, [...initial, 'plan', 'fix']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.ledger().round, 1);
  assert.equal(h.initiative().rounds.length, 1);
  assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 2);
});

test('pre-upgrade completed incomplete plan is rejected by the guard then migrated to planner recovery', async (t) => {
  const h = fixture(); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  // The old semantic guard did not supersede the normalized plan's reservation.
  const runCli = (args) => {
    if (args[0] === 'plan-fixes') throw new Error('test legacy classification failure');
    return h.runCli(args);
  };
  await assert.rejects(runReviewUntilGreen({ ...h.options, runCli }), /test legacy classification failure/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  const before = sealed(h);
  // Seed the persisted 0.9.0-beta.4 representation, rather than repairing evidence.
  const stored = h.ledger();
  stored.execution.completed = [...new Set([...stored.execution.completed, 'plan'])];
  stored.execution.artifactHashes.plan = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(h.stateDir, 'round-1-plan.json'))).digest('hex');
  delete stored.execution.normalizedPlan;
  delete stored.execution.planRetry;
  delete stored.execution.retryArtifacts?.plan;
  delete stored.execution.repairArtifacts?.plan;
  stored.execution.failure = null;
  fs.writeFileSync(ledgerPath(h.stateDir, targetSlug(ref)), JSON.stringify(stored));
  await assert.rejects(h.resume(), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'fix']);
  assert.deepEqual(sealed(h), before);
  assert.deepEqual(h.plans[0].fixGroups[0].findingIds, ids);
});


test('standalone planner recovery is bounded without an initiative launch budget', async (t) => {
  const h = fixture({ keyed: false, incompleteReplacement: true }); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  const before = sealed(h);
  await assert.rejects(h.resume(), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  await assert.rejects(h.resume(), /(?:exhausted|incomplete).*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.ledger().round, 1);
  assert.equal(h.calls.some((args) => args[0] === 'reserve'), false);
});

test('rereading a rejected plan remains idempotent and does not finalise its keyed run as unreserved evidence', async (t) => {
  const h = fixture(); t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  const initialRun = h.initiative();
  const initialExecution = h.ledger().execution;
  const initialLaunchState = h.ledger().initiative_launched;
  const initialReservations = h.ledger().initiative_reservations;
  const planArgs = h.calls.find((args) => args[0] === 'plan-fixes');
  assert.throws(() => h.runCli(planArgs), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.equal(h.initiative().status, 'active');
  assert.deepEqual(h.initiative().launches, initialRun.launches);
  assert.deepEqual(h.ledger().execution, initialExecution);
  assert.deepEqual(h.ledger().initiative_launched, initialLaunchState);
  assert.deepEqual(h.ledger().initiative_reservations, initialReservations);
  assert.deepEqual(sealed(h), before);
  await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'fix']);
  assert.deepEqual(h.plans[0].fixGroups[0].findingIds, ids);
});

for (const cliCopy of ['core', 'codex', 'copilot']) for (const replacementError of ['status', 'namespace']) {
  test(`${cliCopy}: semantic replacement retains its own ${replacementError === 'namespace' ? 'status-and-namespace' : replacementError} repair allowance`, async (t) => {
    const h = fixture({ cliCopy, replacementError, repairInitialPlan: replacementError === 'namespace' });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete/);
    const before = sealed(h);
    for (const suffix of ['repair.json', 'original', 'packet.json', 'candidate.json', 'retry']) {
      assert.equal(fs.existsSync(path.join(h.stateDir, `round-1-plan.${suffix}`)), false, `stale ${suffix}`);
    }
    await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', ...(replacementError === 'namespace' ? ['artifact-repair'] : []), 'plan', 'artifact-repair', 'fix']);
    assert.deepEqual(sealed(h), before);
    assert.deepEqual(h.plans[0].fixGroups[0].findingIds, ids);
    assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, replacementError === 'namespace' ? 4 : 3);
  });
}

test('replacement repair survives interruption without consuming a second semantic retry', async (t) => {
  const h = fixture({ replacementError: 'status', incompleteReplacement: true });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  // Simulate process loss at the CLI boundary, without recording a failed launch.
  h.runCli(h.calls.find((args) => args[0] === 'round-start'));
  h.runCli(h.calls.find((args) => args[0] === 'reserve' && args[2] === 'plan'));
  fs.writeFileSync(path.join(h.stateDir, 'round-1-plan.json'), JSON.stringify({ status: 'OK', protocolVersion: 2, groups: [] }));
  const repair = h.runCli(h.calls.find((args) => args[0] === 'artifact-normalize' && args[2] === 'plan'));
  assert.equal(repair.status, 'repair');
  const snapshot = fs.readFileSync(path.join(h.stateDir, 'round-1-plan.original'), 'utf8');
  await assert.rejects(h.resume(), /planner retry exhausted/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'artifact-repair']);
  assert.equal(JSON.parse(snapshot).status, 'OK');
  assert.deepEqual(sealed(h), before);
  await assert.rejects(h.resume(), /planner retry exhausted/);
  assert.equal(h.ledger().execution.planRetry.state, 'exhausted');
});

test('replacement repair requires a separate budgeted reservation', async (t) => {
  const h = fixture({ replacementError: 'status', maxLaunches: 4 });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  const result = await h.resume();
  assert.equal(result.reason, 'budget-exhausted');
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 4);
});


test('preparing replacement repair preserves unrelated retry accounting and semantic exhaustion state', async (t) => {
  const h = fixture({ keyed: false });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete/);
  const stored = h.ledger();
  stored.execution.retryArtifacts.verify = 'unrelated correction';
  stored.execution.repairArtifacts = { verify: { state: 'prepared' } };
  fs.writeFileSync(ledgerPath(h.stateDir, targetSlug(ref)), JSON.stringify(stored));
  fs.writeFileSync(path.join(h.stateDir, 'round-1-plan.json'), JSON.stringify({ status: 'OK', protocolVersion: 2, groups: [] }));
  const result = h.runCli(['artifact-normalize', ref, 'plan']);
  assert.equal(result.status, 'repair');
  assert.equal(h.ledger().execution.retryArtifacts.verify, 'unrelated correction');
  assert.deepEqual(h.ledger().execution.repairArtifacts.verify, { state: 'prepared' });
  assert.equal(h.ledger().execution.planRetry.state, 'pending');
  assert.equal(h.ledger().execution.planRetry.rejectedHash, stored.execution.planRetry.rejectedHash);
  assert.throws(() => h.runCli(['artifact-normalize', ref, 'plan']), /requires a separate candidate/);
  fs.writeFileSync(result.repair.candidatePath, JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [], injected: true }));
  assert.throws(() => h.runCli(['artifact-normalize', ref, 'plan', '--candidate', result.repair.candidatePath]), /does not preserve/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'round-1-plan.json'))).status, 'OK');
});


async function interruptPendingPlan(h) {
  const runCli = (args) => {
    if (args[0] === 'plan-fixes') throw new Error('test interruption before semantic acceptance');
    return h.runCli(args);
  };
  await assert.rejects(runReviewUntilGreen({ ...h.options, runCli }), /test interruption/);
}

for (const keyed of [true, false]) {
  test(`failed replacement subprocess consumes the one semantic planner launch (keyed=${keyed})`, async (t) => {
    const h = fixture({ keyed, failReplacement: true });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await assert.rejects(runReviewUntilGreen(h.options), /classification is incomplete/);
    const before = sealed(h);
    await assert.rejects(h.resume(), /plan.*(?:exit|failed)|(?:exit|failed).*plan/);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
    await assert.rejects(h.resume(), /(?:exhausted|incomplete|failed)/);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
    assert.deepEqual(sealed(h), before);
    assert.equal(h.ledger().round, 1);
    if (keyed) assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 2);
  });
}

for (const invalidation of ['missing', 'hash-invalid', 'missing-after-repair']) {
  test(`pending normalized planner reruns after ${invalidation} intent detector evidence`, async (t) => {
    const h = fixture({ acceptedInitially: true, broadIntent: true, repairInitialPlan: invalidation === 'missing-after-repair' });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await interruptPendingPlan(h);
    const initialRoles = [...h.launches];
    const before = sealed(h);
    delete before.intent;
    const intentPath = path.join(h.stateDir, 'round-1-intent.json');
    if (invalidation.startsWith('missing')) fs.unlinkSync(intentPath);
    else fs.appendFileSync(intentPath, '\n');
    await assert.rejects(h.resume(), /fix.*(?:exit|failed)|(?:exit|failed).*fix/);
    assert.deepEqual(h.launches, [...initialRoles, 'intent', 'plan', 'fix']);
    const after = sealed(h);
    delete after.intent;
    assert.deepEqual(after, before);
    assert.equal(h.ledger().round, 1);
    assert.equal(h.initiative().rounds.length, 1);
    assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, invalidation === 'missing-after-repair' ? 3 : 2);
    assert.equal(h.initiative().launches.filter((launch) => launch.role === 'intent').length, 2);
  });
}

for (const legacy of [false, true]) {
  test(`plan-fixes rejects changed ${legacy ? 'legacy completed' : 'pending normalized'} bytes without resealing`, async (t) => {
    const h = fixture({ acceptedInitially: true });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await interruptPendingPlan(h);
    if (legacy) {
      const stored = h.ledger();
      stored.execution.completed = [...stored.execution.completed, 'plan'];
      delete stored.execution.normalizedPlan;
      fs.writeFileSync(ledgerPath(h.stateDir, targetSlug(ref)), JSON.stringify(stored));
    }
    const originalHash = h.ledger().execution.artifactHashes.plan;
    const originalLaunches = h.initiative().launches;
    fs.appendFileSync(path.join(h.stateDir, 'round-1-plan.json'), '\n');
    const flags = h.calls.find((args) => args[0] === 'artifact-normalize' && args[2] === 'plan').slice(3);
    assert.throws(() => h.runCli(['plan-fixes', ref, ...flags]), /hash|changed|sealed|normalized/i);
    assert.equal(h.ledger().execution.artifactHashes.plan, originalHash);
    assert.deepEqual(h.initiative().launches, originalLaunches);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
    assert.equal(h.plans.length, 0);
  });
}
