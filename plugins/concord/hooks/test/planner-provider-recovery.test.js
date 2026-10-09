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
const { runPath, consumeDispositionDelivery } = require('../../core/initiative-review-run');

const ref = 'feature/plan-resume';
const ids = ['correctness:first', 'correctness:second'];
function fixture({ maxLaunches = 12, incompleteReplacement = false, acceptedInitially = false, repairInitialPlan = false, replacementError = null, cliCopy = 'core', broadIntent = false, keyed = true, replacementResult = null, transportResult = null, initialPlanFailure = null, fixResult = null } = {}) {
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
  const runner = cliCopy === 'core' ? runReviewUntilGreen : require(`../../../concord-${cliCopy}/engine/codex-review-runner`).runReviewUntilGreen;
  const spawn = (input) => {
    launches.push(input.role);
    if (initialPlanFailure && input.role === 'plan') return typeof initialPlanFailure === 'function' ? initialPlanFailure(input) : initialPlanFailure;
    if (input.role === 'artifact-repair') {
      const artifact = JSON.parse(fs.readFileSync(path.join(input.repoRoot, 'original.json'), 'utf8'));
      artifact.status = 'ok';
      if (artifact.groups) artifact.groups = artifact.groups.filter((group) => group.findingIds.some((id) => id.startsWith('correctness:')));
      fs.writeFileSync(path.join(input.repoRoot, 'candidate.json'), JSON.stringify(artifact));
      return { status: 0 };
    }
    if (transportResult && input.role === 'plan' && launches.filter((role) => role === 'plan').length === 3) return transportResult;
    if (replacementResult && input.role === 'plan' && launches.filter((role) => role === 'plan').length === 2) return typeof replacementResult === 'function' ? replacementResult(input) : replacementResult;
    if (input.role === 'fix') return fixResult ? (typeof fixResult === 'function' ? fixResult(input) : fixResult) : { status: 1 }; // Halt after the real CLI authorizes the exact group; never edit the fixture.
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
  const options = { reviewer: 'claude', ref, base, repoRoot: repo, runCli, spawn, noBroad: !broadIntent, broad: broadIntent, ...(broadIntent ? { intentFile } : {}), sessionHandoff: 'off', ...(keyed ? { initiativeRunKey: 'same-run', initiativeStateDir: initiativeDir, initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: 1 } : {}) };
  const ledger = () => readLedger(stateDir, targetSlug(ref));
  const initiative = () => JSON.parse(fs.readFileSync(runPath(initiativeDir, 'same-run'), 'utf8'));
  const resume = () => runner({ ...options, resume: true });
  return { root, stateDir, broadIntent, launches, calls, plans, options, ledger, initiative, resume, runCli, run: () => runner(options) };
}
async function initialIncomplete(h) {
  await assert.rejects(h.run(), /classification is incomplete.*correctness:first.*correctness:second/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan']);
  assert.equal(h.calls.find((args) => args[0] === 'artifact-normalize' && args[2] === 'plan') !== undefined, true);
  assert.equal(h.initiative().launches.length, 3);
  assert.equal(h.ledger().round, 1);
}
function sealed(h) {
  return Object.fromEntries((h.broadIntent ? ['correctness', 'verify', 'intent', 'gate', 'gate-verify'] : ['correctness', 'verify']).map((role) => [role, { hash: h.ledger().execution.artifactHashes[role], bytes: fs.readFileSync(path.join(h.stateDir, `round-1-${role}.json`), 'utf8') }]));
}

for (const cliCopy of ['core', 'codex']) {
  for (const role of ['initial-plan', 'fix']) {
    for (const mode of ['nonzero', 'thrown']) {
      test(`${cliCopy}: separately reserved ${role} ${mode} failures retain distinct claims despite provider invocationId collision`, async (t) => {
        const suppliedId = 'provider-controlled-identical-invocation';
        const failed = mode === 'nonzero' ? { status: 1, invocationId: suppliedId } : () => { throw Object.assign(new Error('opaque failure'), { invocationId: suppliedId, telemetry: { invocationId: suppliedId } }); };
        const h = fixture({ cliCopy, acceptedInitially: true, ...(role === 'initial-plan' ? { initialPlanFailure: failed } : { fixResult: failed }) });
        t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
        let first;
        await assert.rejects(h.run(), (error) => { first = error; return true; });
        const before = sealed(h);
        const count = role === 'initial-plan' ? 3 : 4;
        assert.equal(h.initiative().launches.length, count);
        assert.equal(consumeDispositionDelivery({ path: runPath(path.join(h.root, 'initiative'), 'same-run') }, first.continuationPacket.delivery.claim), true);
        const history = h.initiative().dispositions;
        let second;
        await assert.rejects(h.resume(), (error) => { second = error; return true; });
        assert.equal(second.message, first.message);
        assert.notEqual(second.continuationPacket.delivery.claim, first.continuationPacket.delivery.claim);
        const current = h.initiative();
        assert.equal(current.dispositions.length, history.length + 1);
        assert.deepEqual(current.dispositions.slice(0, history.length), history);
        assert.equal(current.dispositions.at(-1).packet.budget.launches, count + 1);
        assert.equal(current.dispositions.at(-1).packet.delivery.consumed, false);
        assert.equal(current.launches.length, count + 1);
        assert.equal(current.rounds.length, 1);
        assert.deepEqual(sealed(h), before);
        assert.deepEqual(h.launches, role === 'initial-plan' ? ['correctness', 'verify', 'plan', 'plan'] : ['correctness', 'verify', 'plan', 'fix', 'fix']);
        assert.equal(JSON.stringify(second.continuationPacket).includes(suppliedId), false, 'provider invocation metadata cannot enter failure continuation identity');
      });
    }
  }
}

for (const [cliCopy, corruption] of ['core', 'codex', 'copilot'].flatMap((copy) =>
  ['changed', 'deleted', 'repair', 'manifest', 'reviewer'].map((kind) => [copy, kind]))) {
  test(`${cliCopy}: ${corruption} accepted transport plan refuses resume durably without launching`, async (t) => {
    const h = fixture({ cliCopy, replacementResult: { status: 1, stderr: 'rate_limit_error' } });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await initialIncomplete(h);
    await assert.rejects(h.resume(), /plan/);
    await assert.rejects(h.resume(), /fix/);
    assert.equal(h.ledger().execution.planRetry.state, 'accepted');
    assert.ok(h.ledger().execution.completed.includes('plan'));
    const history = h.initiative().launches;
    const planFile = path.join(h.stateDir, 'round-1-plan.json');
    if (corruption === 'changed') fs.appendFileSync(planFile, '\n');
    else if (corruption === 'deleted') fs.unlinkSync(planFile);
    else if (corruption === 'repair') fs.writeFileSync(path.join(h.stateDir, 'round-1-plan.repair.json'), '{}');
    else if (corruption === 'manifest') fs.appendFileSync(path.join(h.stateDir, 'round-1-changes.json'), '\n');
    else fs.appendFileSync(path.join(h.stateDir, 'round-1-correctness.json'), '\n');
    const before = sealed(h);
    let error;
    await assert.rejects(h.resume(), (value) => { error = value; return true; });
    assert.match(error.message, /reconcile the existing evidence/);
    assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
    const ledger = h.ledger();
    assert.equal(ledger.execution.planRetry.state, 'exhausted');
    assert.equal(ledger.execution.planTransportRetry.state, 'exhausted');
    assert.equal(ledger.execution.failure.nextAction, 'terminal-handoff');
    assert.equal(ledger.execution.failure.kind, 'evidence-failure');
    assert.equal(ledger.execution.normalizedPlan, null);
    assert.equal(ledger.execution.planRepairPending, false);
    assert.equal(ledger.execution.completed.includes('plan'), false);
    const report = require('../../core/review').renderReviewReport([{ ledger }]);
    assert.match(report, /terminal handoff/);
    assert.doesNotMatch(report, /\/review-and-fix resume/);
    assert.deepEqual(sealed(h), before);
    assert.deepEqual(h.initiative().launches, history);
    assert.equal(ledger.round, 1);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'plan', 'fix']);
    await assert.rejects(h.resume());
    assert.equal(h.ledger().execution.planRetry.state, 'exhausted');
    assert.equal(h.ledger().execution.planTransportRetry.state, 'exhausted');
    assert.deepEqual(h.initiative().launches, history);
    assert.equal(h.launches.length, 6);
  });
}

test('nonzero replacement retains safe provider diagnostics and agrees with terminal continuation', async (t) => {
  const secret = 'credential-never-persist-216';
  const h = fixture({ replacementResult: { status: 1, provider: 'anthropic', engine: 'claude', providerSchema: 'claude-print-json-v1', stdout: '', stderr: `authentication_error: invalid API key Authorization: Bearer ${secret}` } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  let failureError;
  await assert.rejects(h.resume(), (error) => { failureError = error; return /plan.*(?:exit|failed)/.test(error.message); });
  const failure = h.ledger().execution.failure;
  assert.equal(failure.role, 'plan');
  assert.equal(failure.exitCode, 1);
  assert.ok(failure.diagnostic, 'nonzero replacement must retain a safe provider diagnostic');
  assert.equal(failure.diagnostic.classification, 'authentication');
  assert.equal(failure.diagnostic.provider, 'anthropic');
  assert.equal(failure.diagnostic.engine, 'claude');
  assert.equal(failure.diagnostic.providerSchema, 'claude-print-json-v1');
  assert.match(failure.diagnostic.message, /authentication/i);
  assert.equal(failure.retryable, false);
  assert.equal(failure.nextAction, 'terminal-handoff');
  assert.equal(failureError.continuationPacket.nextAction, failure.nextAction);
  assert.equal(h.ledger().execution.planRetry.state, 'exhausted');
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 4);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.equal(JSON.stringify(h.ledger()).includes(secret), false);
  assert.equal(JSON.stringify(h.initiative()).includes(secret), false);
  assert.equal(JSON.stringify(failureError.continuationPacket).includes(secret), false);
  assert.equal(failureError.message.includes(secret), false);
});

for (const cliCopy of ['core', 'codex']) {
  test(`${cliCopy}: retryable replacement resumes only plan under the same initiative and sealed evidence`, async (t) => {
    const h = fixture({ cliCopy, replacementResult: { status: 1, stderr: 'rate_limit_error: Too many requests' } });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await initialIncomplete(h);
    const before = sealed(h);
    let failureError;
    await assert.rejects(h.resume(), (error) => { failureError = error; return /plan/.test(error.message); });
    assert.equal(h.ledger().execution.failure.diagnostic.classification, 'rate-limit');
    assert.equal(h.ledger().execution.failure.nextAction, 'resume');
    assert.equal(failureError.continuationPacket.nextAction, 'resume');
    assert.equal(h.ledger().execution.planRetry.launched, true);
    assert.equal(h.ledger().execution.planTransportRetry.state, 'pending');
    await assert.rejects(h.resume(), /fix.*(?:exit|failed)/);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'plan', 'fix']);
    assert.deepEqual(sealed(h), before);
    assert.equal(h.ledger().round, 1);
    assert.equal(h.initiative().launches.length, 6);
    assert.equal(h.initiative().rounds.length, 1);
    assert.equal(h.initiative().launches.filter((launch) => launch.role === 'plan').length, 3);
    assert.equal(h.ledger().execution.planTransportRetry.attempts, 1);
    assert.deepEqual(h.plans[0].fixGroups[0].findingIds, ids);
  });
}

for (const [classification, stderr] of [
  ['unknown', 'opaque failure credential-never-persist-216'],
  ['malformed-response', 'invalid JSON provider response credential-never-persist-216'],
  ['authentication', 'rate_limit_error followed by authentication_error invalid API key credential-never-persist-216'],
]) {
  test(`${classification} replacement terminal handoff never launches a blind resume`, async (t) => {
    const h = fixture({ replacementResult: { status: 1, stderr } });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await initialIncomplete(h);
    const before = sealed(h);
    let error;
    await assert.rejects(h.resume(), (value) => { error = value; return true; });
    assert.equal(h.ledger().execution.failure.diagnostic.classification, classification);
    assert.equal(h.ledger().execution.failure.nextAction, 'terminal-handoff');
    assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
    await assert.rejects(h.resume(), /(?:exhausted|terminal|failed|incomplete)/);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
    assert.deepEqual(sealed(h), before);
    assert.equal(h.initiative().launches.length, 4);
    for (const bytes of persistedBytes(h)) assert.equal(bytes.includes('credential-never-persist-216'), false);
    assert.equal(error.message.includes('credential-never-persist-216'), false);
  });
}

test('transport retry failure exhausts recovery and leaves no resume instruction', async (t) => {
  const h = fixture({ replacementResult: { status: 1, stderr: '503 service unavailable' }, transportResult: { status: 1, stderr: 'rate_limit_error' } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  await assert.rejects(h.resume(), /plan/);
  let error;
  await assert.rejects(h.resume(), (value) => { error = value; return true; });
  assert.equal(h.ledger().execution.planTransportRetry.state, 'exhausted');
  assert.equal(h.ledger().execution.planTransportRetry.attempts, 1);
  assert.equal(h.ledger().execution.failure.nextAction, 'terminal-handoff');
  assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
  await assert.rejects(h.resume(), /(?:exhausted|terminal|failed|incomplete)/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'plan']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 5);
});

for (const cliCopy of ['core', 'codex']) {
  test(`${cliCopy}: identical canonical transport failures append a new terminal disposition without rewriting delivered history`, async (t) => {
    const failure = { status: 1, stderr: 'rate_limit_error' };
    const h = fixture({ cliCopy, replacementResult: failure, transportResult: failure });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await initialIncomplete(h);
    const before = sealed(h);
    let replacementError;
    await assert.rejects(h.resume(), (error) => { replacementError = error; return true; });
    assert.equal(replacementError.continuationPacket.nextAction, 'resume');
    assert.equal(consumeDispositionDelivery({ path: runPath(path.join(h.root, 'initiative'), 'same-run') }, replacementError.continuationPacket.delivery.claim), true);
    const history = h.initiative().dispositions;
    const original = history.at(-1);
    assert.equal(original.packet.delivery.consumed, true);
    let transportError;
    await assert.rejects(h.resume(), (error) => { transportError = error; return true; });
    assert.equal(transportError.message, replacementError.message, 'both executions have the same canonical diagnostic');
    assert.equal(h.ledger().execution.failure.nextAction, 'terminal-handoff');
    assert.equal(transportError.continuationPacket.nextAction, 'terminal-handoff');
    const dispositions = h.initiative().dispositions;
    assert.equal(dispositions.length, history.length + 1);
    assert.deepEqual(dispositions.slice(0, history.length), history, 'prior outcomes, delivery claims and budget snapshots are immutable');
    const terminal = dispositions.at(-1);
    assert.notEqual(terminal.packet.delivery.claim, original.packet.delivery.claim);
    assert.equal(terminal.packet.delivery.consumed, false);
    assert.equal(original.packet.budget.launches, 4);
    assert.equal(terminal.packet.budget.launches, 5);
    assert.deepEqual(sealed(h), before);
    assert.equal(h.ledger().round, 1);
    await assert.rejects(h.resume());
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'plan']);
    assert.equal(h.initiative().launches.length, 5);
  });
}

for (const [cliCopy, corruption] of [['core', 'changed'], ['codex', 'deleted']]) {
  test(`${cliCopy}: ${corruption} normalized transport plan persists terminal refusal before any process`, async (t) => {
    const h = fixture({ cliCopy, replacementResult: { status: 1, stderr: 'rate_limit_error' } });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await initialIncomplete(h);
    const before = sealed(h);
    await assert.rejects(h.resume());
    const originalCli = h.options.runCli;
    h.options.runCli = (args) => {
      if (args[0] === 'plan-fixes') throw new Error('test interruption after successful transport plan normalization');
      return originalCli(args);
    };
    await assert.rejects(h.resume(), /test interruption after successful transport plan normalization/);
    assert.ok(h.ledger().execution.normalizedPlan);
    assert.equal(h.ledger().execution.planTransportRetry.attempts, 1);
    h.options.runCli = originalCli;
    const planFile = path.join(h.stateDir, 'round-1-plan.json');
    if (corruption === 'changed') fs.appendFileSync(planFile, '\n');
    else fs.unlinkSync(planFile);
    let error;
    await assert.rejects(h.resume(), (value) => { error = value; return true; });
    assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
    const ledger = h.ledger();
    assert.equal(ledger.execution.planTransportRetry.state, 'exhausted', 'durable recovery authority must be exhausted when usable plan evidence is lost');
    assert.equal(ledger.execution.planRetry.state, 'exhausted');
    assert.equal(ledger.execution.failure.nextAction, 'terminal-handoff');
    const report = require('../../core/review').renderReviewReport([{ ledger }]);
    assert.match(report, /terminal handoff/);
    assert.doesNotMatch(report, /\/review-and-fix resume/);
    assert.deepEqual(sealed(h), before);
    assert.equal(ledger.round, 1);
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'plan']);
    assert.equal(h.initiative().launches.length, 5);
    await assert.rejects(h.resume());
    assert.equal(h.launches.length, 5);
    assert.equal(h.initiative().launches.length, 5);
  });
}

test('successful invalid transport recovery does not reopen semantic replacement allowance', async (t) => {
  const h = fixture({ incompleteReplacement: true, replacementResult: { status: 1, stderr: 'rate_limit_error' } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  await assert.rejects(h.resume(), /plan/);
  await assert.rejects(h.resume(), /classification is incomplete/);
  assert.equal(h.ledger().execution.planRetry.state, 'exhausted');
  await assert.rejects(h.resume(), /(?:exhausted|incomplete)/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan', 'plan']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 5);
});

test('denied transport reservation launches nothing and preserves sealed reviewers', async (t) => {
  const h = fixture({ maxLaunches: 4, replacementResult: { status: 1, stderr: 'rate_limit_error' } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  await assert.rejects(h.resume(), /plan/);
  const result = await h.resume();
  assert.equal(result.decision, 'blocked');
  assert.equal(result.reason, 'budget-exhausted');
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 4);
  assert.equal(h.ledger().execution.planTransportRetry.attempts, 0);
});

function persistedBytes(h) {
  const bytes = [];
  for (const dir of [h.stateDir, path.join(h.root, 'initiative')]) {
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) bytes.push(fs.readFileSync(file, 'utf8'));
      }
    };
    visit(dir);
  }
  return bytes;
}

test('thrown provider error credentials never reach persisted artifacts or terminal output', async (t) => {
  const secret = 'thrown-credential-never-persist-216';
  const h = fixture({ replacementResult: () => { throw new Error(`authentication_error Authorization: Bearer ${secret}`); } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  let error;
  await assert.rejects(h.resume(), (value) => { error = value; return true; });
  assert.equal(h.ledger().execution.failure.diagnostic.classification, 'authentication');
  assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
  assert.deepEqual(sealed(h), before);
  assert.equal(h.initiative().launches.length, 4);
  assert.equal(error.message.includes(secret), false);
  assert.equal(JSON.stringify(error.continuationPacket).includes(secret), false);
  for (const bytes of persistedBytes(h)) assert.equal(bytes.includes(secret), false);
});

test('pending transport recovery refuses tampered sealed reviewer evidence before launch', async (t) => {
  const h = fixture({ replacementResult: { status: 1, stderr: 'rate_limit_error' } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  await assert.rejects(h.resume(), /plan/);
  fs.appendFileSync(path.join(h.stateDir, 'round-1-correctness.json'), '\n');
  let error;
  await assert.rejects(h.resume(), (value) => { error = value; return /(?:hash|sealed|artifact|changed)/.test(value.message); });
  assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
  assert.equal(h.ledger().execution.failure.nextAction, 'terminal-handoff');
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.equal(h.initiative().launches.length, 4);
});

test('interrupted transport dispatch without a plan artifact never authorizes another launch', async (t) => {
  const h = fixture({ replacementResult: { status: 1, stderr: 'rate_limit_error' } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  const before = sealed(h);
  await assert.rejects(h.resume(), /plan/);
  const originalCli = h.options.runCli;
  h.options.runCli = (args) => {
    const result = originalCli(args);
    if (args[0] === 'plan-dispatch') throw new Error('test interrupted after durable transport dispatch');
    return result;
  };
  let error;
  await assert.rejects(h.resume(), (value) => { error = value; return true; });
  assert.equal(h.ledger().execution.planTransportRetry.attempts, 1);
  assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
  h.options.runCli = originalCli;
  await assert.rejects(h.resume(), /(?:exhausted|terminal|failed|incomplete|dispatch)/);
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
  assert.deepEqual(sealed(h), before);
  // The transport reservation precedes durable dispatch, so its consumed slot
  // remains visible even though the parent was interrupted before spawn.
  assert.equal(h.initiative().launches.length, 5);
});

test('legacy exhausted replacement failure without diagnostics reports terminal handoff', async (t) => {
  const h = fixture({ replacementResult: { status: 1, stderr: 'unknown old provider failure' } });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await initialIncomplete(h);
  await assert.rejects(h.resume(), /plan/);
  const stored = h.ledger();
  delete stored.execution.failure.diagnostic;
  delete stored.execution.failure.retryable;
  delete stored.execution.failure.nextAction;
  delete stored.execution.planTransportRetry;
  fs.writeFileSync(ledgerPath(h.stateDir, targetSlug(ref)), JSON.stringify(stored));
  const report = require('../../core/review').renderReviewReport([{ ledger: h.ledger() }]);
  assert.match(report, /terminal handoff/);
  assert.doesNotMatch(report, /\/review-and-fix resume/);
  let error;
  await assert.rejects(h.resume(), (value) => { error = value; return true; });
  assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
  assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
});

for (const mode of ['persistence', 'readback']) {
  test(`failed provider failure ${mode} cannot advertise actionable resume`, async (t) => {
    const h = fixture({ replacementResult: { status: 1, stderr: 'rate_limit_error' } });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    await initialIncomplete(h);
    const before = sealed(h);
    const originalCli = h.options.runCli;
    let recordedFailure = false;
    h.options.runCli = (args) => {
      if (args[0] === 'round-failure') {
        if (mode === 'persistence') throw new Error('test failure persistence refused');
        recordedFailure = true;
      }
      if (args[0] === 'show' && recordedFailure) throw new Error('test failure readback refused');
      return originalCli(args);
    };
    let error;
    await assert.rejects(h.resume(), (value) => { error = value; return true; });
    assert.match(error.message, /failure recording or readback failed/);
    assert.equal(error.continuationPacket.nextAction, 'terminal-handoff');
    assert.deepEqual(h.launches, ['correctness', 'verify', 'plan', 'plan']);
    assert.deepEqual(sealed(h), before);
    assert.equal(h.initiative().launches.length, 4);
  });
}

