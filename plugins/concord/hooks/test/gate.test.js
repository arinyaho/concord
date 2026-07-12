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
