'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RUNTIMES = [
  ['core', require('../../core/review')],
  ['codex', require('../../../concord-codex/engine/review')],
  ['copilot', require('../../../concord-copilot/engine/review')],
];
const minor = (id = 'docreview:wording', extra = {}) => ({ id, gate: 'docreview', file: 'note.md', span: 'word', summary: 'cosmetic wording', releaseBlocking: [], rationale: 'The wording has no effect on the documented contract.', minorVerified: true, minorReason: 'Read the line independently; meaning and checks are unchanged.', ...extra });

for (const [engine, R] of RUNTIMES) {
  const ledger = (extra = {}) => ({ ...R.emptyLedger({ type: 'file', ref: 'file:note.md', hasDoD: false }), documentReviewPolicy: 'single-pass-confirmation', round: 2, ...extra });
  const apply = (current, findings, extra = {}) => R.applyRoundOutcome(current, { findings, fixedIds: [], killedIds: [], parkedIds: [], dodPassed: false, dodDeferred: true, targetUnchanged: true, ...extra });

  test(`${engine}: verified minor confirmation stops with open follow-ups instead of clean or budget exhaustion`, () => {
    const current = ledger(), finding = minor();
    const result = apply(current, [finding]);
    assert.equal(result.decision.continue, false);
    assert.equal(result.decision.converged, false);
    assert.equal(result.decision.parked, false);
    assert.equal(result.decision.reviewedWithFollowUps, true);
    assert.deepEqual(result.decision.followUps, [finding.id]);
    assert.equal(result.ledger.status, 'reviewed-with-followups');
    assert.equal(result.ledger.findings[0].status, 'open');
    assert.equal(result.ledger.findings[0].minorVerified, true);
    assert.equal(result.ledger.findings[0].minorReason, finding.minorReason);
    assert.deepEqual(result.ledger.budget, current.budget);
    assert.ok(R.TERMINAL_STATUSES.has('reviewed-with-followups'));
  });

  test(`${engine}: first-pass minor fixes require confirmation before stopping`, () => {
    const first = apply(ledger({ round: 1 }), [minor()], { fixedIds: ['docreview:wording'], targetUnchanged: false });
    assert.equal(first.decision.continue, true);
    const second = apply({ ...first.ledger, round: 2 }, [minor('docreview:another-word')]);
    assert.equal(second.decision.reviewedWithFollowUps, true);
    assert.deepEqual(second.decision.followUps, ['docreview:another-word']);
  });

  test(`${engine}: blockers and unconfirmed severity never qualify as document follow-ups`, () => {
    for (const extra of [
      { releaseBlocking: ['contradictory-docs'] }, { releaseBlocking: ['unproven-premise'] },
      { releaseBlocking: ['serious-bug'] }, { releaseBlocking: ['future-unknown-class'] },
      { minorVerified: false }, { minorReason: '' }, { rationale: '' }, { releaseBlocking: undefined },
    ]) {
      const result = apply(ledger(), [minor('docreview:blocking', extra)]);
      assert.equal(result.decision.continue, true);
      assert.notEqual(result.decision.reviewedWithFollowUps, true);
    }
  });

  test(`${engine}: no findings still converge on the first unchanged dry round`, () => {
    const result = apply(ledger({ round: 1 }), []);
    assert.equal(result.decision.converged, true);
    assert.equal(result.ledger.status, 'clean');
  });

  test(`${engine}: changed confirmations and fresh fixes require another review`, () => {
    assert.equal(apply(ledger(), [minor()], { targetUnchanged: false }).decision.continue, true);
    assert.equal(apply(ledger(), [minor()], { fixedIds: ['docreview:wording'] }).decision.continue, true);
  });

  test(`${engine}: legacy files and git targets retain their previous termination rules`, () => {
    assert.equal(apply(ledger({ documentReviewPolicy: undefined }), [minor()]).decision.continue, true);
    const git = ledger({ target: { type: 'git', ref: 'feature/x', hasDoD: false } });
    assert.equal(apply(git, [minor()]).decision.continue, true);
    const withDod = ledger({ target: { type: 'git', ref: 'feature/x', hasDoD: true } });
    assert.notEqual(apply(withDod, [minor()], { dodPassed: true }).decision.reviewedWithFollowUps, true);
  });

  test(`${engine}: intent, parked and gate blockers keep priority over minor follow-ups`, () => {
    assert.equal(apply(ledger(), [minor()], { intentReviewCount: 1 }).decision.intentReview, true);
    assert.equal(apply(ledger(), [minor()], { parkedIds: ['docreview:wording'] }).decision.parked, true);
    assert.equal(apply(ledger(), [minor()], { gateOpenCount: 1 }).decision.gatePending, true);
  });

  test(`${engine}: terminal reports list minor follow-ups without suggesting automatic resume`, () => {
    const result = apply(ledger(), [minor()]);
    const text = R.renderReviewReport([{ ledger: result.ledger }]);
    assert.match(text, /reviewed-with-followups/);
    assert.match(text, /docreview:wording/);
    assert.doesNotMatch(text, /resume with/);
  });
}
