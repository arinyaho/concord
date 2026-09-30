'use strict';
// Target identity under one initiative run key is the revision pair (ref, base, head).
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openInitiativeRun, reserveLaunch, recordDisposition, publicInitiativeSummary, terminalTarget, denialReason } = require('../../core/initiative-review-run');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'revision-pair-'));
const open = (options) => openInitiativeRun({ repository: '/repo', ...options });
const rev = (head_sha, base = 'main') => ({ ref: 'feature/x', base, head_sha });
const terminal = (run, revision, result = { decision: { converged: true } }) => recordDisposition(run, { target: 'feature/x', revision, result });
const read = (run) => JSON.parse(fs.readFileSync(run.path, 'utf8'));
const launchAt = (revision, attemptId = 'a') => ({ role: 'correctness', target: 'feature/x', revision, round: 1, attemptId });

test('AC1: a terminal target is reviewed again on a new head, charged to the same budget', () => {
  const run = open({ stateDir: temp(), key: 'ac1', maxLaunches: 4, maxRounds: 3 });
  assert.ok(reserveLaunch(run, launchAt(rev('h1'), 'a1')));
  assert.ok(terminal(run, rev('h1')));
  assert.ok(reserveLaunch(run, launchAt(rev('h2'), 'a2')));
  assert.ok(terminal(run, rev('h2')));
  const ledger = read(run);
  assert.deepStrictEqual(ledger.dispositions.map((d) => d.revision.head_sha), ['h1', 'h2']);
  assert.strictEqual(ledger.launches.length, 2);
  assert.strictEqual(ledger.rounds.length, 2);
  assert.strictEqual(new Set(publicInitiativeSummary(run).targetIds).size, 2);
});

test('AC1: a new base with the same head is a new revision pair', () => {
  const run = open({ stateDir: temp(), key: 'ac1-base', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1', 'main')));
  assert.ok(reserveLaunch(run, launchAt(rev('h1', 'release'))));
});

test('AC2: an already-terminal revision pair is still refused', () => {
  const run = open({ stateDir: temp(), key: 'ac2', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1')));
  assert.strictEqual(reserveLaunch(run, launchAt(rev('h1'))), false);
  assert.strictEqual(denialReason(run, launchAt(rev('h1'))), 'target-terminal');
  assert.strictEqual(terminal(run, rev('h1')), false);
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h1')).kind, 'terminal');
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h2')), false);
});

test('AC3: after reconciliation-required a new revision pair is refused and launches nothing', () => {
  const run = open({ stateDir: temp(), key: 'ac3', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1'), { status: 'reconciliation-required' }));
  assert.strictEqual(reserveLaunch(run, launchAt(rev('h2'))), false);
  assert.strictEqual(denialReason(run, launchAt(rev('h2'))), 'reconciliation-required');
  assert.strictEqual(read(run).launches.length, 0);
  assert.strictEqual(read(run).targets.length, 1);
});

test('AC4: an exhausted budget is reported as budget-exhausted for a new revision', () => {
  const run = open({ stateDir: temp(), key: 'ac4', maxLaunches: 1, maxRounds: 3 });
  assert.ok(reserveLaunch(run, launchAt(rev('h1'), 'a')));
  assert.ok(terminal(run, rev('h1')));
  assert.strictEqual(reserveLaunch(run, launchAt(rev('h2'), 'b')), false);
  assert.strictEqual(denialReason(run, launchAt(rev('h2'), 'b')), 'budget-exhausted');
});

test('AC5: two checkouts sharing key and state directory share revision-pair records', () => {
  const stateDir = temp();
  const first = open({ stateDir, key: 'ac5', maxLaunches: 4, maxRounds: 3 });
  const second = open({ stateDir, key: 'ac5', maxLaunches: 4, maxRounds: 3 });
  assert.strictEqual(first.path, second.path);
  assert.ok(terminal(first, rev('h1')));
  assert.strictEqual(reserveLaunch(second, launchAt(rev('h1'))), false);
  assert.ok(reserveLaunch(second, launchAt(rev('h2'))));
  assert.strictEqual(read(first).launches.length, 1);
});

test('AC6: aggregate output for revision pairs carries hashed identifiers and counts only', () => {
  const run = open({ stateDir: temp(), key: 'ac6', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('secret-h1', 'secret-base')));
  assert.ok(terminal(run, rev('secret-h2', 'secret-base')));
  const summary = publicInitiativeSummary(run);
  assert.strictEqual(summary.targetIds.length, 2);
  assert.ok(summary.targetIds.every((id) => /^[0-9a-f]{64}$/.test(id)));
  assert.doesNotMatch(JSON.stringify(summary), /secret|feature\/x/);
  assert.strictEqual(summary.targetIds[0], crypto.createHash('sha256').update(JSON.stringify(rev('secret-h1', 'secret-base'))).digest('hex'));
});

const work = { decision: 'work', round: 1, base: 'main', head: 'h2', stateDir: temp(), targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false };
async function runnerAt(key, stateDir, maxLaunches) {
  const spawned = [];
  const calls = [];
  const result = await runReviewUntilGreen({ ref: 'feature/x', base: 'main', repoRoot: '/repo', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: 3, targetIdentity: () => 'h2',
    runCli: ([verb]) => { calls.push(verb); return verb === 'round-start' ? work : verb === 'artifact-normalize' ? { status: 'ok' } : verb === 'plan-fixes' ? { fixes: [] } : verb === 'record' ? { decision: { continue: false, converged: true } } : {}; },
    spawn: async (input) => { spawned.push(input.role); return { status: 0 }; } });
  return { result, spawned, calls };
}

test('AC3 runner: a new revision after reconciliation-required is blocked and spawns nothing', async () => {
  const stateDir = temp();
  const run = open({ stateDir, key: 'r-ac3', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1'), { status: 'reconciliation-required' }));
  const { result, spawned } = await runnerAt('r-ac3', stateDir, 4);
  assert.strictEqual(result.decision, 'reconciliation-required');
  assert.deepStrictEqual(spawned, []);
  assert.strictEqual(read(run).launches.length, 0);
  assert.ok(!read(run).dispositions.some((d) => d.kind === 'error'));
});

test('AC4 runner: budget exhaustion on a new revision is blocked, not an error disposition', async () => {
  const stateDir = temp();
  const run = open({ stateDir, key: 'r-ac4', maxLaunches: 1, maxRounds: 3 });
  assert.ok(reserveLaunch(run, launchAt(rev('h1'), 'a')));
  assert.ok(terminal(run, rev('h1')));
  const { result, spawned } = await runnerAt('r-ac4', stateDir, 1);
  assert.strictEqual(result.decision, 'blocked');
  assert.strictEqual(result.reason, 'budget-exhausted');
  assert.deepStrictEqual(spawned, []);
  assert.ok(!read(run).dispositions.some((d) => d.kind === 'error'));
});

test('AC1 runner: a terminal ref opens a new target on a new head instead of throwing', async () => {
  const stateDir = temp();
  const run = open({ stateDir, key: 'r-ac1', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1')));
  const { calls } = await runnerAt('r-ac1', stateDir, 4);
  assert.ok(calls.includes('round-start'));
  assert.deepStrictEqual(read(run).dispositions.map((d) => [d.kind, d.revision.head_sha]), [['terminal', 'h1'], ['terminal', 'h2']]);
});

test('terminalTarget matches the exact pair: the same head on another base is a different pair', () => {
  const run = open({ stateDir: temp(), key: 'same-head', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1', 'main')));
  assert.ok(terminal(run, rev('h1', 'release')));
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h1', 'release')).revision.base, 'release');
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h1', 'main')).revision.base, 'main');
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h1', 'other')), false);
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h2', 'main')), false);
});

test('terminalTarget skips a headless or baseless legacy candidate instead of throwing', () => {
  const run = open({ stateDir: temp(), key: 'legacy', maxLaunches: 4, maxRounds: 3 });
  assert.ok(terminal(run, rev('h1', 'main')));
  const ledger = read(run);
  ledger.dispositions.unshift({ ...ledger.dispositions[0], revision: { ref: 'feature/x' } }, { ...ledger.dispositions[0], revision: { ref: 'feature/x', head_sha: 'h9' } });
  fs.writeFileSync(run.path, JSON.stringify(ledger));
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h1', 'main')).revision.head_sha, 'h1');
  assert.strictEqual(terminalTarget(run, 'feature/x', rev('h2', 'main')), false);
});
