'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const review = require('../../core/review');
const { normalizeArtifact } = require('../../core/artifact-contract');
const cli = require('../review-cli');

const eligible = (id) => ({ id, file: 'a.txt', summary: 's', releaseBlocking: [], rationale: 'outcome and checks stay correct' });

function decide(gateOpen) {
  return review.decideTermination({
    dodPassed: true, openFindingsCount: 0, fixedCount: 0, noProgress: false, budgetSpent: 1, maxRounds: 5,
    ...review.splitGateOpen(gateOpen),
  });
}

test('all open gate findings follow-up eligible -> converged with exact followUps', () => {
  const d = decide([eligible('gate:silent-gap:a'), eligible('gate:cross-context:b')]);
  assert.strictEqual(d.converged, true);
  assert.deepStrictEqual(d.followUps, ['gate:silent-gap:a', 'gate:cross-context:b']);
  assert.match(d.reason, /2 non-blocking GATE follow-up candidate/);
});

test('a releaseBlocking finding keeps gate-pending', () => {
  const d = decide([eligible('gate:silent-gap:a'), { ...eligible('gate:threat-model:b'), releaseBlocking: ['security'] }]);
  assert.strictEqual(d.gatePending, true);
  assert.strictEqual(d.converged, false);
});

test('missing fields or empty rationale keep gate-pending', () => {
  assert.strictEqual(decide([{ id: 'gate:silent-gap:a', file: 'a.txt', summary: 's' }]).gatePending, true);
  assert.strictEqual(decide([{ ...eligible('gate:silent-gap:a'), rationale: '  ' }]).gatePending, true);
});

test('a verifier blocking override flips an eligible finding to gate-pending', () => {
  assert.strictEqual(decide([{ ...eligible('gate:silent-gap:a'), blockingReason: 'breaks AC 2' }]).gatePending, true);
});

test('handoff lists follow-up candidates and says clean is not the delivery disposition', () => {
  const text = cli.renderHandoff({ ledger: { ...review.emptyLedger({ ref: 'feat/x' }), status: 'clean', gate_open: [eligible('gate:silent-gap:a')] } });
  assert.match(text, /Follow-up candidates \(not fixed; roll over as root-cause tickets, then record the PR's delivery disposition\):/);
  assert.match(text, /\[gate:silent-gap:a\] a\.txt: s/);
  assert.match(text, /rationale: outcome and checks stay correct/);
  assert.match(text, /not the PR delivery disposition/);
});

test('gate-verify blocking entries are validated by the artifact contract', () => {
  const base = { status: 'ok', rejected: [], findings: [] };
  assert.deepStrictEqual(normalizeArtifact('gate-verify', JSON.stringify({ ...base, blocking: [{ id: 'gate:silent-gap:a', reason: ' breaks AC ' }] })).blocking, [{ id: 'gate:silent-gap:a', reason: 'breaks AC' }]);
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ ...base, blocking: [{ id: 'correctness:a', reason: 'x' }] })), /invalid id/);
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ ...base, blocking: [{ id: 'gate:silent-gap:a', reason: ' ' }] })), /no "reason"/);
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ ...base, blocking: 'gate:x' })), /must be an array/);
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ ...base, rejected: [{ id: 'gate:silent-gap:a', reason: 'not real' }], blocking: [{ id: 'gate:silent-gap:a', reason: 'breaks AC' }] })), /both rejected and blocking/);
});
