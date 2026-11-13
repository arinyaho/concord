'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const gc = require('../scripts/runner/gate-contract');

test('isValidFindingId: accepts a stable gate:slug, rejects unsafe filename chars', () => {
  assert.ok(gc.isValidFindingId('correctness:off-by-one'));
  assert.ok(!gc.isValidFindingId('correctness:bad/slash'));
  assert.ok(!gc.isValidFindingId('correctness:dot..dot'));
  assert.ok(!gc.isValidFindingId('correctness:' + 'x'.repeat(200)));
  assert.ok(!gc.isValidFindingId('NoGate'));
  assert.ok(!gc.isValidFindingId('correctness:'));
});

test('isValidFindingId: only "gate:" ids may have 3 segments; other prefixes stay 2-segment', () => {
  assert.ok(gc.isValidFindingId('gate:cross-context:foo'));
  assert.ok(gc.isValidFindingId('gate:foo'));
  assert.ok(gc.isValidFindingId('correctness:foo'));
  assert.ok(gc.isValidFindingId('intent:retry-count'));
  assert.ok(!gc.isValidFindingId('correctness:foo:bar'));
  assert.ok(!gc.isValidFindingId('intent:a:b'));
  assert.ok(!gc.isValidFindingId('gate:a:b:c'));
});

test('parseGateFindings: parses a valid array and stamps status confirmed', () => {
  const raw = JSON.stringify([{ id: 'correctness:a', gate: 'correctness', file: 'a.js', span: 'x', summary: 's' }]);
  const out = gc.parseGateFindings(raw);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'confirmed');
  assert.strictEqual(out[0].id, 'correctness:a');
});

test('parseGateFindings: throws on a malformed id (contract violation, not a dropped finding)', () => {
  const raw = JSON.stringify([{ id: 'bad id', gate: 'correctness', file: 'a.js', summary: 's' }]);
  assert.throws(() => gc.parseGateFindings(raw), /stable .* id/);
});

test('parseGateFindings: throws on non-array and on missing file/summary', () => {
  assert.throws(() => gc.parseGateFindings('{}'), /array/);
  assert.throws(() => gc.parseGateFindings(JSON.stringify([{ id: 'correctness:a', gate: 'correctness' }])), /file/);
});

test('parseVerifyVerdict: keeps only rejected ids present in candidates', () => {
  const cands = [{ id: 'correctness:a' }, { id: 'correctness:b' }];
  const v = gc.parseVerifyVerdict(JSON.stringify({ rejected: [{ id: 'correctness:a', reason: 'r' }, { id: 'correctness:zzz', reason: 'r' }] }), cands);
  assert.deepStrictEqual(v.rejectedIds, ['correctness:a']);
});

test('parseVerifyVerdict: returns each rejected candidate once', () => {
  const cands = [{ id: 'correctness:a' }];
  const v = gc.parseVerifyVerdict(JSON.stringify({ rejected: [
    { id: 'correctness:a', reason: 'first' },
    { id: 'correctness:a', reason: 'duplicate' },
  ] }), cands);
  assert.deepStrictEqual(v.rejectedIds, ['correctness:a']);
});

test('parseGateFindings: retains requirement when present, defaults to empty', () => {
  const withReq = gc.parseGateFindings(JSON.stringify([
    { id: 'intent:retry-count', file: 'a.js', span: 'retry(1)', summary: 'retries once', requirement: 'retry three times' },
  ]));
  assert.strictEqual(withReq[0].requirement, 'retry three times');
  const without = gc.parseGateFindings(JSON.stringify([
    { id: 'correctness:x', file: 'a.js', summary: 'bug' },
  ]));
  assert.strictEqual(without[0].requirement, '');
});
