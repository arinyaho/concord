'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const gate = require('../../core/gate');

function reader(map) {
  return (p) => {
    const key = Object.keys(map).find((k) => p.endsWith(k));
    if (key === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return map[key];
  };
}

test('loadGateConfig: absent config file -> null (benign)', () => {
  assert.strictEqual(gate.loadGateConfig('/repo', reader({})), null);
});

test('loadGateConfig: config without a gate key -> null', () => {
  assert.strictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"dod":["node --test"]}' })), null);
});

test('loadGateConfig: "gate": null -> null (explicit opt-out)', () => {
  assert.strictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":null}' })), null);
});

test('loadGateConfig: "gate": {} -> enabled, panel defaults to false', () => {
  assert.deepStrictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{}}' })), { enabled: true, panel: false });
});

test('loadGateConfig: "gate": {"panel": true} -> panel enabled', () => {
  assert.deepStrictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{"panel":true}}' })), { enabled: true, panel: true });
});

test('loadGateConfig: "gate": {"panel": "yes"} (not a boolean) -> harness-failure', () => {
  assert.throws(() => gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{"panel":"yes"}}' })), /harness-failure/);
});

test('loadGateConfig: "gate": true (not an object) -> harness-failure', () => {
  assert.throws(() => gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":true}' })), /harness-failure/);
});

test('loadGateConfig: malformed JSON -> harness-failure', () => {
  assert.throws(() => gate.loadGateConfig('/repo', reader({ 'review.config.json': '{bad' })), /harness-failure/);
});

test('foldGateFindings: drops verify-rejected and dismissed, keeps unchanged-file findings', () => {
  const gateFindings = [
    { id: 'gate:silent-gap:sibling-reopen', file: 'src/unchanged_sibling.js', span: 'spawn(opts)', summary: 'sibling reopens the gate', requirement: 'must not reopen a resolved sibling' },
    { id: 'gate:ac-coverage:missing-validate', file: 'src/verify.js', span: '', summary: 'design requires a target-exists check', requirement: 'verify must check the target exists' },
    { id: 'gate:cross-context:ac-b-partial', file: 'src/promote.js', span: '', summary: 'AC-B only partial', requirement: 'AC-B: automated end-to-end' },
  ];
  const out = gate.foldGateFindings({
    gateFindings,
    verifyRejectedIds: ['gate:cross-context:ac-b-partial'],   // a false positive
    dismissedIds: ['gate:ac-coverage:missing-validate'],      // human-accepted/deferred
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'gate:silent-gap:sibling-reopen');
  assert.strictEqual(out[0].class, 'silent-gap'); // non-default class, actually derived (not a hardcoded default)
  assert.strictEqual(out[0].evidence, 'spawn(opts)'); // evidence maps from the finding's span
  assert.strictEqual(out[0].requirement, 'must not reopen a resolved sibling'); // requirement passes through
  assert.strictEqual(out[0].summary, 'sibling reopens the gate'); // summary passes through
  assert.strictEqual(out[0].file, 'src/unchanged_sibling.js'); // NOT filtered though it is an unchanged file
});

test('foldGateFindings: class derives from the id segment, defaults to cross-context', () => {
  const out = gate.foldGateFindings({
    gateFindings: [{ id: 'gate:only-two-segments', file: 'a.js', span: '', summary: 's', requirement: '' }],
    verifyRejectedIds: [],
    dismissedIds: [],
  });
  assert.strictEqual(out[0].class, 'cross-context');
});

// --- carryForwardGateFindings (cross-round persistence, spec decision 4) ---
//
// A round where the gate subagent nondeterministically fails to re-report a
// real finding must not erase it from ledger.gate_open. The retire rule is
// deliberately narrow: a prior finding is dropped ONLY when it is plausibly
// resolved -- dismissed, rejected by this round's gate-verify, or its file
// was touched by the diff since base (a fix plausibly addressed it). An
// untouched file's silence is untrusted (the gate is nondeterministic), so
// those findings carry forward.

test('carryForwardGateFindings: a prior finding on an UNCHANGED file survives a silent round', () => {
  const priorGateOpen = [{ id: 'gate:cross-context:g', file: 'unchanged.txt', evidence: '', requirement: '', summary: 's' }];
  const out = gate.carryForwardGateFindings({
    priorGateOpen,
    thisRoundIds: [],
    verifyRejectedIds: [],
    dismissedIds: [],
    changedFiles: ['a.txt'], // g's file not among this round's changed files
  });
  assert.deepStrictEqual(out, priorGateOpen);
});

test('carryForwardGateFindings: a prior finding whose file WAS changed this round is dropped (a fix plausibly addressed it)', () => {
  const out = gate.carryForwardGateFindings({
    priorGateOpen: [{ id: 'gate:cross-context:g', file: 'a.txt', evidence: '', requirement: '', summary: 's' }],
    thisRoundIds: [],
    verifyRejectedIds: [],
    dismissedIds: [],
    changedFiles: ['a.txt'],
  });
  assert.deepStrictEqual(out, []);
});

test('carryForwardGateFindings: a prior finding already present in thisRound is not double-carried', () => {
  const out = gate.carryForwardGateFindings({
    priorGateOpen: [{ id: 'gate:cross-context:g', file: 'unchanged.txt', evidence: '', requirement: '', summary: 's' }],
    thisRoundIds: ['gate:cross-context:g'], // re-reported this round -- thisRound already carries it
    verifyRejectedIds: [],
    dismissedIds: [],
    changedFiles: [],
  });
  assert.deepStrictEqual(out, []);
});

test('carryForwardGateFindings: a dismissed prior finding is dropped even on an unchanged file', () => {
  const out = gate.carryForwardGateFindings({
    priorGateOpen: [{ id: 'gate:cross-context:g', file: 'unchanged.txt', evidence: '', requirement: '', summary: 's' }],
    thisRoundIds: [],
    verifyRejectedIds: [],
    dismissedIds: ['gate:cross-context:g'],
    changedFiles: [],
  });
  assert.deepStrictEqual(out, []);
});

test('carryForwardGateFindings: a prior finding rejected by this round\'s gate-verify is dropped even on an unchanged file', () => {
  const out = gate.carryForwardGateFindings({
    priorGateOpen: [{ id: 'gate:cross-context:g', file: 'unchanged.txt', evidence: '', requirement: '', summary: 's' }],
    thisRoundIds: [],
    verifyRejectedIds: ['gate:cross-context:g'],
    dismissedIds: [],
    changedFiles: [],
  });
  assert.deepStrictEqual(out, []);
});

test('toGateFinding: derives class from the id\'s middle segment', () => {
  const out = gate.toGateFinding({ id: 'gate:threat-model:sk-exposure', file: 'a.js', span: 'x', requirement: 'r', summary: 's' });
  assert.deepStrictEqual(out, { id: 'gate:threat-model:sk-exposure', class: 'threat-model', file: 'a.js', evidence: 'x', requirement: 'r', summary: 's' });
});

test('toGateFinding: id with only two segments defaults class to cross-context', () => {
  const out = gate.toGateFinding({ id: 'gate:only-two-segments', file: 'a.js', summary: 's' });
  assert.strictEqual(out.class, 'cross-context');
});
