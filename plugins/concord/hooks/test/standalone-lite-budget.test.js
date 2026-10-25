'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
for (const [name, R] of [
  ['native', require('../../core/review')],
  ['codex', require('../../../concord-codex/engine/review')],
  ['copilot', require('../../../concord-copilot/engine/review')],
]) {
  test(`${name}: standalone lite stops after three progressive fix rounds`, () => {
    let ledger = { ...R.emptyLedger({ type: 'git', ref: 'feature/lite' }), reviewMode: 'standalone-lite', budget: { max_rounds: 3, spent: 0 } };
    for (let round = 1; round <= 3; round++) {
      const id = `correctness:round-${round}`;
      const result = R.applyRoundOutcome({ ...ledger, round }, { findings: [{ id, file: 'code.js', span: 'bad', summary: 'bug' }], fixedIds: [id], killedIds: [], parkedIds: [], dodPassed: true, targetUnchanged: false });
      assert.equal(result.decision.continue, round < 3);
      if (round === 3) { assert.equal(result.decision.parked, true); assert.equal(result.decision.converged, false); }
      ledger = { ...result.ledger, budget: { ...result.ledger.budget, spent: round } };
    }
  });
  test(`${name}: standalone lite may finish clean on the third unchanged round`, () => {
    const ledger = { ...R.emptyLedger({ type: 'git', ref: 'feature/lite' }), reviewMode: 'standalone-lite', round: 3, budget: { max_rounds: 3, spent: 2 } };
    assert.equal(R.applyRoundOutcome(ledger, { findings: [], fixedIds: [], dodPassed: true, targetUnchanged: true }).decision.converged, true);
  });
}
