'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const gate = require('../lib/gate');

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

test('loadGateConfig: "gate": {} -> enabled', () => {
  assert.deepStrictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{}}' })), { enabled: true });
});

test('loadGateConfig: "gate": true (not an object) -> harness-failure', () => {
  assert.throws(() => gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":true}' })), /harness-failure/);
});

test('loadGateConfig: malformed JSON -> harness-failure', () => {
  assert.throws(() => gate.loadGateConfig('/repo', reader({ 'review.config.json': '{bad' })), /harness-failure/);
});

test('foldGateFindings: drops verify-rejected and dismissed, keeps unchanged-file findings', () => {
  const gateFindings = [
    { id: 'gate:cross-context:sibling-reopen', file: 'src/unchanged_sibling.js', span: 'spawn(opts)', summary: 'sibling reopens the gate', requirement: '' },
    { id: 'gate:silent-gap:missing-validate', file: 'src/verify.js', span: '', summary: 'design requires a target-exists check', requirement: 'verify must check the target exists' },
    { id: 'gate:ac-coverage:ac-b-partial', file: 'src/promote.js', span: '', summary: 'AC-B only partial', requirement: 'AC-B: automated end-to-end' },
  ];
  const out = gate.foldGateFindings({
    gateFindings,
    verifyRejectedIds: ['gate:ac-coverage:ac-b-partial'],   // a false positive
    dismissedIds: ['gate:silent-gap:missing-validate'],     // human-accepted/deferred
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'gate:cross-context:sibling-reopen');
  assert.strictEqual(out[0].class, 'cross-context');
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
