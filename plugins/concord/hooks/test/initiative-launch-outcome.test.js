'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./temp-dir');

for (const [engine, initiative] of [
  ['core', require('../../core/initiative-review-run')],
  ['codex', require('../../../concord-codex/engine/initiative-review-run')],
  ['copilot', require('../../../concord-copilot/engine/initiative-review-run')],
]) {
const test = (name, fn) => nodeTest(`${engine}: ${name}`, fn);

function fixture(maxLaunches = 1) {
  const run = initiative.openInitiativeRun({ repository: '/repo', stateDir: tempDir('launch-outcome-'), key: 'refunds', maxLaunches, maxRounds: 2 });
  const revision = { ref: 'feature/x', base: 'base', head_sha: 'head' };
  let sequence = 0;
  const reserve = () => {
    const reservationId = `${String(++sequence).padStart(32, '0')}:0`;
    const launch = { role: 'correctness', target: 'feature/x', attemptId: 'attempt', round: 1, revision, reservationIds: [reservationId] };
    return { granted: initiative.reserveLaunch(run, launch), reservationId, launch };
  };
  const receipt = (reservation, overrides = {}) => ({
    reservationId: reservation.reservationId, role: 'correctness', target: 'feature/x', attemptId: 'attempt', round: 1, revision,
    invocationId: reservation.reservationId.split(':')[0].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'), provider: 'codex', lifecycle: 'not-started', reason: 'spawn-enoent', failed: true, ...overrides,
  });
  return { run, reserve, receipt, read: () => JSON.parse(fs.readFileSync(run.path, 'utf8')) };
}

test('proven pre-turn failures refund a matched reservation without deleting launch or round history', () => {
  const f = fixture(), reservation = f.reserve();
  assert.equal(reservation.granted, true);
  assert.equal(f.read().launches[0].reservationId, reservation.reservationId);
  assert.equal(initiative.recordLaunchOutcome(f.run, f.receipt(reservation)).refunded, true);
  assert.deepEqual(initiative.launchAccounting(f.read()), { attempted: 1, charged: 0, refunded: 1, environmentFailures: 1, started: 0 });
  assert.equal(f.read().launches.length, 1);
  assert.equal(f.read().rounds.length, 1);
  assert.equal(f.reserve().granted, true, 'the refunded budget is available to an explicit retry');
});

test('duplicate outcome receipts are idempotent and cannot refund a second time', () => {
  const f = fixture(), reservation = f.reserve(), receipt = f.receipt(reservation);
  initiative.recordLaunchOutcome(f.run, receipt);
  const before = fs.readFileSync(f.run.path, 'utf8');
  assert.equal(initiative.recordLaunchOutcome(f.run, receipt).status, 'duplicate');
  assert.equal(fs.readFileSync(f.run.path, 'utf8'), before);
  assert.throws(() => initiative.recordLaunchOutcome(f.run, { ...receipt, reason: 'spawn-eacces' }), /already|different|conflict/i);
});

test('unknown or started failures remain charged even when an environment reason is present', () => {
  for (const [lifecycle, reason] of [['unknown', 'unknown'], ['unknown', 'unsupported-model'], ['started', 'unsupported-model']]) {
    const f = fixture(), reservation = f.reserve();
    assert.equal(initiative.recordLaunchOutcome(f.run, f.receipt(reservation, { lifecycle, reason })).refunded, false);
    assert.equal(initiative.launchAccounting(f.read()).charged, 1);
    assert.equal(f.reserve().granted, false);
  }
});

test('receipt identity must match the reserved role, target, attempt, round and exact revision', () => {
  const f = fixture(), reservation = f.reserve();
  for (const override of [
    { reservationId: `${'f'.repeat(32)}:0` }, { role: 'gate' }, { target: 'other' }, { attemptId: 'other' }, { round: 2 },
    { revision: { ref: 'feature/x', base: 'base', head_sha: 'other-head' } },
  ]) assert.throws(() => initiative.recordLaunchOutcome(f.run, f.receipt(reservation, override)), /reservation|identity|match/i);
  assert.equal(f.read().launchOutcomes, undefined);
  assert.equal(initiative.launchAccounting(f.read()).charged, 1);
});

test('three consecutive refunds latch a bounded stop and parallel success cannot clear it', () => {
  const f = fixture(2), inFlight = f.reserve();
  let last;
  for (let i = 0; i < 3; i++) {
    last = f.reserve();
    assert.equal(last.granted, true);
    assert.equal(initiative.recordLaunchOutcome(f.run, f.receipt(last)).refunded, true);
  }
  initiative.recordLaunchOutcome(f.run, f.receipt(inFlight, { lifecycle: 'started', reason: 'none', failed: false }));
  assert.equal(f.reserve().granted, false);
  assert.equal(initiative.denialReason(f.run, last.launch), 'environment-failure-limit');
  assert.equal(initiative.launchAccounting(f.read()).refunded, 3);
  assert.equal(initiative.pairRefusal(f.run, 'unrelated-target', { ref: 'unrelated-target', head_sha: 'other' }), 'environment-failure-limit');
  assert.equal(f.read().rounds.length, 1, 'refunds do not change round accounting');
});

test('a proven started turn resets the refund streak before the stop is latched', () => {
  const f = fixture(5);
  for (let i = 0; i < 2; i++) { const r = f.reserve(); initiative.recordLaunchOutcome(f.run, f.receipt(r)); }
  const progress = f.reserve();
  initiative.recordLaunchOutcome(f.run, f.receipt(progress, { lifecycle: 'started', reason: 'none', failed: false }));
  for (let i = 0; i < 2; i++) { const r = f.reserve(); initiative.recordLaunchOutcome(f.run, f.receipt(r)); }
  assert.equal(f.reserve().granted, true);
});

test('legacy launches without reservation identities stay fully charged', () => {
  const f = fixture();
  assert.equal(initiative.reserveLaunch(f.run, { role: 'correctness', round: 1 }), true);
  assert.deepEqual(initiative.launchAccounting(f.read()), { attempted: 1, charged: 1, refunded: 0, environmentFailures: 0, started: 0 });
  assert.throws(() => initiative.recordLaunchOutcome(f.run, f.receipt({ reservationId: `${'0'.repeat(32)}:0` })), /reservation|identity|match/i);
});


test('one provider invocation cannot refund multiple reservation slots', () => {
  const f = fixture(2), first = f.reserve(), second = f.reserve();
  const original = f.receipt(first);
  initiative.recordLaunchOutcome(f.run, original);
  assert.throws(() => initiative.recordLaunchOutcome(f.run, f.receipt(second, { invocationId: original.invocationId })), /invocation|already|different/i);
  assert.equal(initiative.launchAccounting(f.read()).refunded, 1);
});

test('a terminal run cannot accept a new late refund', () => {
  const f = fixture(), reservation = f.reserve();
  const ledger = f.read();
  fs.writeFileSync(f.run.path, JSON.stringify({ ...ledger, status: 'terminal' }));
  assert.throws(() => initiative.recordLaunchOutcome(f.run, f.receipt(reservation)), /terminal|active/i);
  assert.equal(initiative.launchAccounting(f.read()).charged, 1);
});


test('delivery budgets and public summaries show charged, attempted and refunded counts separately', () => {
  const f = fixture(), reservation = f.reserve();
  initiative.recordLaunchOutcome(f.run, f.receipt(reservation));
  const counts = initiative.publicInitiativeSummary(f.run).counts;
  assert.equal(counts.launches, 0);
  assert.equal(counts.attemptedLaunches, 1);
  assert.equal(counts.refundedLaunches, 1);
  assert.equal(counts.environmentFailures, 1);
  assert.equal(initiative.recordDisposition(f.run, { target: 'feature/x', revision: reservation.launch.revision, result: new Error('provider environment unavailable') }), true);
  const packet = f.read().dispositions[0].packet;
  assert.equal(packet.budget.launches, 0);
  assert.equal(packet.budget.attemptedLaunches, 1);
  assert.equal(packet.budget.refundedLaunches, 1);
  assert.equal(packet.budget.environmentFailures, 1);
});

test('resolver refusal is a classified pre-turn failure and closed targets reject late refunds', () => {
  const f = fixture(), reservation = f.reserve();
  assert.equal(initiative.recordLaunchOutcome(f.run, f.receipt(reservation, { reason: 'unusable-executable' })).refunded, true);
  const other = fixture(), inFlight = other.reserve();
  initiative.recordDisposition(other.run, { target: 'feature/x', revision: inFlight.launch.revision, result: { decision: { converged: true } } });
  assert.throws(() => initiative.recordLaunchOutcome(other.run, other.receipt(inFlight)), /terminal|closed|completed/i);
});

test('completion reports separate charged budget from attempted provider launches', () => {
  const f = fixture(), reservation = f.reserve();
  initiative.recordLaunchOutcome(f.run, f.receipt(reservation));
  assert.equal(initiative.finaliseInitiativeRun(f.run), true);
  const directory = path.join(path.dirname(f.run.path), path.basename(f.run.path, '.json').replace('initiative-review-', 'initiative-report-'));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  assert.equal(report.counts.launches, 1, 'historical role totals still count attempts');
  assert.equal(report.counts.chargedLaunches, 0);
  assert.equal(report.counts.refundedLaunches, 1);
  assert.equal(report.counts.environmentFailures, 1);
  assert.match(fs.readFileSync(path.join(directory, 'report.md'), 'utf8'), /Charged launches: 0/);
  assert.equal(JSON.stringify(report).includes(reservation.reservationId), false);
});
}
