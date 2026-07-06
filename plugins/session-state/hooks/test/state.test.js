'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { emptyModel, mergeModel, renderMarkdown } = require('../lib/state');

function delta(over) {
  return { decisions: [], openLoops: [], nexts: [], resolved: [], facts: [], ...over };
}

test('decisions keep the latest per topic', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ decisions: ['[scope] first'] }));
  m = mergeModel(m, delta({ decisions: ['[scope] second'] }));
  assert.deepEqual(m.decisions, ['[scope] second']);
});

test('RESOLVED closes a matching open loop', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ openLoops: ['verify the injector'] }));
  m = mergeModel(m, delta({ resolved: ['verify the injector'] }));
  assert.deepEqual(m.openLoops, []);
});

test('RESOLVED matches normalized-exact only, so a short token cannot close unrelated loops', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ openLoops: ['write integration tests', 'verify the injector'] }));
  m = mergeModel(m, delta({ resolved: ['tests'] }));
  assert.equal(m.openLoops.length, 2); // short token closes nothing
  m = mergeModel(m, delta({ resolved: ['Write Integration Tests'] }));
  assert.deepEqual(m.openLoops, ['verify the injector']); // case/space-insensitive exact
});

test('facts are a bounded ring buffer', () => {
  let m = emptyModel();
  const many = Array.from({ length: 50 }, (_, i) => `edited f${i}.js`);
  m = mergeModel(m, delta({ facts: many }));
  assert.equal(m.facts.length, 40);
  assert.equal(m.facts[0], 'edited f10.js'); // oldest 10 dropped
});

test('facts dedup: churn collapses and cannot evict high-signal facts', () => {
  let m = emptyModel();
  const churn = Array.from({ length: 45 }, () => 'edited LEDGER.md');
  m = mergeModel(m, delta({ facts: ['ran: git commit -m x', 'ran: gh pr create', ...churn] }));
  assert.equal(m.facts.filter((f) => f === 'edited LEDGER.md').length, 1);
  assert.ok(m.facts.includes('ran: git commit -m x'));
  assert.ok(m.facts.includes('ran: gh pr create'));
});

test('renderMarkdown includes the machine-owned header and sections', () => {
  const m = mergeModel(emptyModel(), delta({ decisions: ['[x] d'], facts: ['edited a'] }));
  const md = renderMarkdown('abc', m);
  assert.ok(md.startsWith('# Session state — abc'));
  assert.ok(md.includes('# machine-owned - do not hand-edit'));
  assert.ok(md.includes('## Decisions'));
  assert.ok(md.includes('- [x] d'));
});
