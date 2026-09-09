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

test('buildReport: intent findings go to advisory, never to findings', () => {
  const out = report.buildReport({
    target: { type: 'git', identity: 'abc1234', base: 'def5678' },
    depth: 'gate',
    intent: 'docs/ticket.md',
    examined: ['b.js', 'a.js', 'b.js'],
    candidates: [
      { id: 'correctness:a', file: 'a.js', span: 'x', summary: 'a bug' },
      { id: 'intent:contradicts-ac', file: 'b.js', span: 'y', requirement: 'must retry', summary: 'does not retry' },
    ],
    rejections: [],
  });
  assert.strictEqual(out.schema, 'concord.report/1');
  assert.deepStrictEqual(out.target, { type: 'git', identity: 'abc1234', base: 'def5678' });
  assert.strictEqual(out.depth, 'gate');
  assert.strictEqual(out.intent, 'docs/ticket.md');
  assert.deepStrictEqual(out.examined, ['a.js', 'b.js']);
  assert.deepStrictEqual(out.findings.map((f) => f.id), ['correctness:a']);
  assert.deepStrictEqual(out.advisory.map((f) => f.id), ['intent:contradicts-ac']);
});

test('buildReport: an intent finding is never rejected, even if a verifier names it', () => {
  const out = report.buildReport({
    target: { type: 'git', identity: 'abc1234', base: 'def5678' },
    depth: 'correctness',
    intent: 'docs/ticket.md',
    examined: [],
    candidates: [{ id: 'intent:contradicts-ac', file: 'b.js', span: 'y', summary: 's' }],
    rejections: [{ id: 'intent:contradicts-ac', reason: 'design taste' }],
  });
  assert.deepStrictEqual(out.advisory.map((f) => f.id), ['intent:contradicts-ac']);
  assert.deepStrictEqual(out.rejected, []);
});

test('buildReport: no intent asked for means null intent and empty advisory', () => {
  const out = report.buildReport({
    target: { type: 'git', identity: 'abc1234', base: 'def5678' },
    depth: 'panel',
    intent: null,
    examined: ['a.js'],
    candidates: [],
    rejections: [],
  });
  assert.strictEqual(out.intent, null);
  assert.deepStrictEqual(out.advisory, []);
  assert.deepStrictEqual(out.findings, []);
});

test('buildReport: a clean review still carries every key, so an empty report is not a missing one', () => {
  const out = report.buildReport({
    target: { type: 'git', identity: 'abc1234', base: 'def5678' },
    depth: 'correctness',
    intent: null,
    examined: [],
    candidates: [],
    rejections: [],
  });
  assert.deepStrictEqual(Object.keys(out), ['schema', 'target', 'depth', 'intent', 'examined', 'findings', 'advisory', 'rejected']);
});

test('buildFailure: a failure carries no findings key, so it cannot read as a clean review', () => {
  const out = report.buildFailure('threat-model lens produced no artifact');
  assert.deepStrictEqual(out, { schema: 'concord.report/1', failed: 'threat-model lens produced no artifact' });
  assert.ok(!('findings' in out));
});

test('the panel fold is a single pass: no round, dry streak or convergence state exists here', () => {
  // The converging loop's panel stops after two rounds contribute nothing new.
  // A report is one round, so that rule has nothing to converge and this module
  // must not carry its state -- if it ever does, a reader will assume a loop.
  assert.deepStrictEqual(Object.keys(report).sort(), ['PANEL_LENSES', 'SCHEMA', 'buildFailure', 'buildReport', 'foldFindings', 'planRoles']);
  const twice = report.foldFindings({
    candidates: [{ id: 'gate:threat-model:key-in-log', file: 'a.js', span: 'x', summary: 's' }],
    rejections: [],
  });
  const again = report.foldFindings({
    candidates: [{ id: 'gate:threat-model:key-in-log', file: 'a.js', span: 'x', summary: 's' }],
    rejections: [],
  });
  assert.deepStrictEqual(twice, again); // no accumulated state between calls
});

test('report.js is pure: it reaches neither the filesystem nor a subprocess', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../core/report.js'), 'utf8');
  assert.ok(!/require\(['"]node:fs['"]\)/.test(src), 'report.js must not require node:fs');
  assert.ok(!/require\(['"]node:child_process['"]\)/.test(src), 'report.js must not require node:child_process');
});
