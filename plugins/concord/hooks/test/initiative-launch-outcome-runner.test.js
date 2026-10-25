'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { launchAccounting, runPath } = require('../../core/initiative-review-run');
const review = require('../../core/review');
const { tempDir } = require('./temp-dir');

const tmp = () => tempDir('launch-outcome-runner-');
const cliPath = path.resolve(__dirname, '../../hooks/review-cli.js');

function fixture(maxLaunches = 1) {
  const repoRoot = tmp(), stateDir = tmp(), initiativeStateDir = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'before\n');
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'after\n'); git('commit', '-aqm', 'change');
  const calls = [], workers = [];
  const options = {
    ref: 'feature/test', base, repoRoot, initiativeStateDir, initiativeRunKey: 'integration',
    initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: 10, noBroad: true, cliPath, sessionHandoff: 'off',
    runCli: (args) => {
      calls.push(args);
      const output = execFileSync(process.execPath, [cliPath, ...args], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repoRoot, REVIEW_STATE_DIR: stateDir },
      });
      return JSON.parse(output);
    },
  };
  const spawn = async ({ role, prompt }) => {
    workers.push(role);
    const destination = /Write ONLY .*? to ([^\n]+?\.json)/.exec(prompt)?.[1];
    assert.ok(destination, `no artifact destination for ${role}`);
    const artifact = role === 'correctness' ? { status: 'ok', examined: ['a.txt'], findings: [] }
      : role === 'plan' ? { status: 'ok', protocolVersion: 2, groups: [] }
        : { status: 'ok', examined: ['a.txt'], findings: [] };
    fs.writeFileSync(destination, JSON.stringify(artifact));
    return { status: 0, launchOutcome: { lifecycle: 'unknown', reason: 'none', failed: false } };
  };
  const ledger = () => JSON.parse(fs.readFileSync(runPath(initiativeStateDir, 'integration'), 'utf8'));
  return { options, calls, workers, spawn, ledger };
}

test('real runner and CLI refund a proven pre-turn failure and permit explicit same-key retry', async () => {
  const f = fixture(1);
  let first = true;
  const spawn = async (input) => {
    if (first) {
      first = false;
      f.workers.push(input.role);
      return { status: 1, launchOutcome: { lifecycle: 'not-started', reason: 'unsupported-model', failed: true } };
    }
    return f.spawn(input);
  };
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn }));
  let counts = launchAccounting(f.ledger());
  assert.deepStrictEqual({ attempted: counts.attempted, charged: counts.charged, refunded: counts.refunded }, { attempted: 1, charged: 0, refunded: 1 });

  await runReviewUntilGreen({ ...f.options, resume: true, spawn });
  counts = launchAccounting(f.ledger());
  assert.deepStrictEqual({ attempted: counts.attempted, charged: counts.charged, refunded: counts.refunded }, { attempted: 2, charged: 1, refunded: 1 });
  assert.deepStrictEqual(f.workers, ['correctness', 'correctness']);
});

test('three real refunded failures stop at the cap before a fourth provider launch', async () => {
  const f = fixture(5);
  let providers = 0;
  const spawn = async ({ role }) => {
    providers++;
    f.workers.push(role);
    return { status: 1, launchOutcome: { lifecycle: 'not-started', reason: 'unsupported-model', failed: true } };
  };
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn }));
  await assert.rejects(runReviewUntilGreen({ ...f.options, resume: true, spawn }));
  const result = await runReviewUntilGreen({ ...f.options, resume: true, spawn });
  assert.equal(result.decision, 'environment-failure-limit');
  assert.equal(result.nextAction, 'terminal-handoff');
  assert.equal(result.retryable, false);
  assert.equal(providers, 3);
  const ledger = f.ledger();
  const counts = launchAccounting(ledger);
  assert.deepStrictEqual({ attempted: counts.attempted, charged: counts.charged, refunded: counts.refunded }, { attempted: 3, charged: 0, refunded: 3 });
  assert.equal(ledger.launches.length, 3);
  assert.equal(ledger.rounds.length, 1);
  assert.equal(ledger.launchRefunds.limitReached, true);
  const denied = f.options.runCli(['reserve', f.options.ref, 'correctness', '--count', '1', '--initiative-run-key', f.options.initiativeRunKey, '--initiative-id', f.options.initiativeRunKey, '--initiative-state-dir', f.options.initiativeStateDir, '--initiative-max-launches', String(f.options.initiativeMaxLaunches), '--initiative-max-rounds', String(f.options.initiativeMaxRounds)]);
  assert.deepStrictEqual({ status: denied.status, reason: denied.reason }, { status: 'denied', reason: 'environment-failure-limit' });
});


test('outcome persistence failure outranks a sibling intent provider failure', async () => {
  const f = fixture(20);
  const intentFile = path.join(tmp(), 'intent.md');
  fs.writeFileSync(intentFile, '# Review intent\n');
  f.options.intentFile = intentFile;
  const originalCli = f.options.runCli;
  f.options.runCli = (args) => {
    if (args[0] === 'launch-outcome') {
      const receipt = JSON.parse(args[2]);
      const target = review.readLedger(f.stateDir, review.targetSlug(f.options.ref));
      const launch = target.initiative_reservations.find((item) => item.reservationIds.includes(receipt.reservationId));
      if (launch.role === 'correctness') throw new Error('injected accounting persistence failure');
    }
    return originalCli(args);
  };
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn: async ({ role }) => ({
    status: 1, launchOutcome: { lifecycle: 'unknown', reason: 'unknown', failed: true },
  }) }), /launch outcome could not be persisted/);
});



test('accounting persistence failure outranks a terminal blocked gate sibling', async () => {
  const f = fixture(20);
  delete f.options.noBroad;
  f.options.initiativeMode = 'lite';
  const originalCli = f.options.runCli;
  f.options.runCli = (args) => {
    if (args[0] === 'launch-outcome') {
      const receipt = JSON.parse(args[2]);
      const target = review.readLedger(f.stateDir, review.targetSlug(f.options.ref));
      const launch = target.initiative_reservations.find((item) => item.reservationIds.includes(receipt.reservationId));
      if (launch.role === 'correctness') throw new Error('injected correctness accounting failure');
    }
    return originalCli(args);
  };
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn: async ({ role, prompt }) => {
    if (role === 'gate') {
      const destination = /Write ONLY .*? to ([^\n]+?\.json)/.exec(prompt)?.[1];
      assert.ok(destination, 'gate prompt must name its artifact');
      fs.writeFileSync(destination, JSON.stringify({ status: 'blocked', blocked: ['required gate method unavailable'] }));
    }
    return { status: 0, launchOutcome: { lifecycle: 'unknown', reason: 'none', failed: false } };
  } }), /launch outcome could not be persisted/);
});

test('environment failure limit outranks a parallel resumable provider failure', async () => {
  const f = fixture(20);
  delete f.options.noBroad;
  f.options.initiativeMode = 'lite';
  const originalCli = f.options.runCli;
  f.options.runCli = (args) => {
    if (args[0] === 'reserve' && args[2] === 'gate-review') return { status: 'denied', reason: 'environment-failure-limit' };
    return originalCli(args);
  };
  const launched = [];
  const result = await runReviewUntilGreen({ ...f.options, spawn: async ({ role }) => {
    launched.push(role);
    return { status: 1 };
  } });
  assert.equal(result.decision, 'environment-failure-limit');
  assert.deepStrictEqual(launched, ['correctness']);
});

test('panel lens outcome persistence failure is not swallowed by lenient lens collection', async () => {
  const f = fixture(20);
  const originalCli = f.options.runCli;
  const lensIds = new Set();
  let firstRecord = true;
  f.options.runCli = (args) => {
    if (args[0] === 'reserve' && args[2] === 'lens') {
      const ids = Array.from({ length: Number(args[4]) }, (_, index) => `${'a'.repeat(32)}:${index}`);
      ids.forEach((id) => lensIds.add(id));
      return { status: 'granted', reservationIds: ids };
    }
    if (args[0] === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (args[0] === 'telemetry-slot' && !firstRecord) return { engine: 'codex' };
    if (args[0] === 'gate-panel-round-record') return { status: 'done' };
    if (args[0] === 'record') {
      const recorded = originalCli(args);
      if (firstRecord) { firstRecord = false; return { ...recorded, decision: { panelPending: true } }; }
      return recorded;
    }
    if (args[0] === 'launch-outcome' && lensIds.has(JSON.parse(args[2]).reservationId)) throw new Error('injected lens accounting persistence failure');
    return originalCli(args);
  };
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn: f.spawn }), /launch outcome could not be persisted/);
});

test('real runner and CLI charge a failed launch whose lifecycle evidence is missing', async () => {
  const f = fixture(1);
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn: async () => ({ status: 1 }) }));
  const counts = launchAccounting(f.ledger());
  assert.deepStrictEqual({ attempted: counts.attempted, charged: counts.charged, refunded: counts.refunded }, { attempted: 1, charged: 1, refunded: 0 });
});
