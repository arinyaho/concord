'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emptyModel, mergeModel } = require('../../core/state');
// The review-until-green LEDGER (distinct from the session-state model above) is
// persisted by core/review.js's readLedger/writeLedger. The dry-round feature
// adds two persisted fields -- ledger.dryStreak and the extended ledger.target
// ({type,hasDoD,...}) -- so the ledger's state round-trip is asserted here.
const review = require('../../core/review');

function delta(over) {
  return { decisions: [], openLoops: [], nexts: [], resolved: [], facts: [], ...over };
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-ledger-'));
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

test('open loops dedup: the same loop from two sources collapses to one', () => {
  let m = emptyModel();
  m = mergeModel(m, delta({ openLoops: ['verify the injector', 'verify the injector'] }));
  assert.deepEqual(m.openLoops, ['verify the injector']);
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

// ---- ledger state round-trip: dryStreak + extended target (Task 3) ----

test('ledger state: dryStreak and the extended target ({type,hasDoD}) round-trip through write/read', () => {
  const dir = tmpStateDir();
  const slug = review.targetSlug('file:doc.md');
  const ledger = { ...review.emptyLedger({ kind: 'local', ref: 'file:doc.md', type: 'file', hasDoD: false }), dryStreak: 2 };
  review.writeLedger(dir, slug, ledger);
  const back = review.readLedger(dir, slug);
  assert.strictEqual(back.dryStreak, 2);
  assert.strictEqual(back.target.type, 'file');
  assert.strictEqual(back.target.hasDoD, false);
  assert.deepStrictEqual(back, ledger);
});

test('ledger state: a pre-existing ledger absent dryStreak/target.hasDoD round-trips and reads as absent (backward-compat)', () => {
  const dir = tmpStateDir();
  const slug = review.targetSlug('feat/pre-existing');
  // No dryStreak, no target.hasDoD -> a ledger written before the dry-round feature.
  const legacy = review.emptyLedger({ kind: 'local', ref: 'feat/pre-existing' });
  assert.strictEqual('dryStreak' in legacy, false);
  review.writeLedger(dir, slug, legacy);
  const back = review.readLedger(dir, slug);
  assert.strictEqual(back.dryStreak, undefined); // read sites default absent -> 0
  assert.strictEqual(back.target.hasDoD, undefined); // derived as git/true downstream
  assert.deepStrictEqual(back, legacy);
});
