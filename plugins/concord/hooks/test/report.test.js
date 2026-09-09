'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const report = require('../../core/report');

test('planRoles: correctness depth is the diff-local pair', () => {
  assert.deepStrictEqual(report.planRoles('correctness'), ['correctness', 'verify']);
});

test('planRoles: gate depth adds the gate pair', () => {
  assert.deepStrictEqual(report.planRoles('gate'), ['correctness', 'verify', 'gate', 'gate-verify']);
});

test('planRoles: panel depth adds the five lenses and their verification, not the gate pair', () => {
  assert.deepStrictEqual(report.planRoles('panel'), [
    'correctness', 'verify',
    'ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model',
    'panel-verify',
  ]);
});

test('planRoles: intent is added at any depth when asked for', () => {
  assert.deepStrictEqual(report.planRoles('correctness', { intent: true }), ['correctness', 'verify', 'intent']);
  assert.ok(report.planRoles('panel', { intent: true }).includes('intent'));
});

test('planRoles: an unknown depth is a harness failure, not a silent default', () => {
  assert.throws(() => report.planRoles('deep'), /harness-failure: report: unknown depth "deep"/);
});

test('foldFindings: a candidate with no rejection survives', () => {
  const out = report.foldFindings({
    candidates: [{ id: 'correctness:stale-session', file: 'a.js', span: 'x', summary: 's' }],
    rejections: [],
  });
  assert.deepStrictEqual(out.findings, [{ id: 'correctness:stale-session', file: 'a.js', span: 'x', requirement: '', summary: 's' }]);
  assert.deepStrictEqual(out.rejected, []);
});

test('foldFindings: a rejected candidate moves to rejected with its reason', () => {
  const out = report.foldFindings({
    candidates: [{ id: 'gate:silent-gap:no-retry', file: 'a.js', span: 'x', summary: 's' }],
    rejections: [{ id: 'gate:silent-gap:no-retry', reason: 'read handler.js:44, the retry is there' }],
  });
  assert.deepStrictEqual(out.findings, []);
  assert.deepStrictEqual(out.rejected, [{ id: 'gate:silent-gap:no-retry', reason: 'read handler.js:44, the retry is there' }]);
});

test('foldFindings: the same id raised twice is reported once', () => {
  const out = report.foldFindings({
    candidates: [
      { id: 'gate:cross-context:cache', file: 'a.js', span: 'x', summary: 'first' },
      { id: 'gate:cross-context:cache', file: 'b.js', span: 'y', summary: 'second' },
    ],
    rejections: [],
  });
  assert.strictEqual(out.findings.length, 1);
  assert.strictEqual(out.findings[0].summary, 'first');
});

test('foldFindings: a rejection naming an unraised id is dropped, not reported', () => {
  const out = report.foldFindings({
    candidates: [{ id: 'correctness:a', file: 'a.js', span: 'x', summary: 's' }],
    rejections: [{ id: 'correctness:ghost', reason: 'no such finding' }],
  });
  assert.deepStrictEqual(out.findings.map((f) => f.id), ['correctness:a']);
  assert.deepStrictEqual(out.rejected, []);
});

test('foldFindings: a candidate whose id violates the contract is a harness failure', () => {
  assert.throws(
    () => report.foldFindings({ candidates: [{ id: 'Not An Id', file: 'a.js', summary: 's' }], rejections: [] }),
    /harness-failure: report: finding id "Not An Id" is not a valid finding id/,
  );
});
