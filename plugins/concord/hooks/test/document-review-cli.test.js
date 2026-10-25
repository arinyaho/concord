'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('../../core/review');
const { tempDir } = require('./temp-dir');
const cli = path.resolve(__dirname, '../review-cli.js');
const finding = (extra = {}) => ({ id: 'docreview:wording', file: 'note.md', span: 'word', summary: 'cosmetic wording', releaseBlocking: [], rationale: 'The contract and checks stay unchanged.', ...extra });

function fixture({ confirmation = true, legacy = false } = {}) {
  const root = tempDir('doc-cli-repo-'), state = tempDir('doc-cli-state-'), ref = 'file:note.md';
  fs.writeFileSync(path.join(root, 'note.md'), 'word\n');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, REVIEW_REPO_ROOT: root, REVIEW_STATE_DIR: state }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const start = run('round-start', ref);
  const slug = R.targetSlug(ref);
  if (confirmation) {
    const current = R.readLedger(state, slug);
    const previous = { ...current, phase: 'done', status: 'converging', execution: null, last_recorded_round: 1, budget: { ...current.budget, spent: 1 }, history: [{ round: 1, fixes: 1, new: 1, killed: 0 }] };
    if (legacy) delete previous.documentReviewPolicy;
    R.writeLedger(state, slug, previous);
  }
  const active = confirmation ? run('round-start', ref) : start;
  const artifacts = (candidate = finding(), verifier = { minor: [{ id: candidate.id, reason: 'Read independently; this is wording only.' }] }) => {
    for (const [role, content] of [
      ['correctness', { status: 'ok', examined: ['note.md'], findings: [candidate] }],
      ['verify', { status: 'ok', rejected: [], findings: [], ...verifier }],
    ]) {
      fs.writeFileSync(path.join(state, `round-${active.round}-${role}.json`), JSON.stringify(content));
      run('artifact-normalize', ref, role);
    }
  };
  return { root, state, ref, run, start, active, slug, artifacts, read: () => R.readLedger(state, slug) };
}

test('new file attempts opt into single-pass confirmation; legacy attempts retain their policy', () => {
  const current = fixture({ confirmation: false });
  assert.equal(current.start.documentReviewPolicy, 'single-pass-confirmation');
  assert.equal(current.read().documentReviewPolicy, 'single-pass-confirmation');
  const legacy = fixture({ legacy: true });
  assert.equal(legacy.active.documentReviewPolicy, undefined);
  assert.equal(legacy.read().documentReviewPolicy, undefined);
});

test('confirmation excludes verified minors before plan/fix and records a replayable follow-up terminal', () => {
  const f = fixture(); f.artifacts();
  const reported = f.run('findings', f.ref);
  assert.deepEqual(reported.findings, []);
  assert.equal(reported.planRequired, false);
  assert.equal(reported.documentFollowUps[0].id, 'docreview:wording');
  const plan = f.run('plan-fixes', f.ref);
  assert.deepEqual(plan.fixGroups, []);
  assert.deepEqual(plan.fixes, []);
  const recorded = f.run('record', f.ref);
  assert.equal(recorded.decision.reviewedWithFollowUps, true);
  assert.equal(recorded.decision.converged, false);
  assert.deepEqual(recorded.decision.followUps, ['docreview:wording']);
  assert.match(recorded.handoff, /reviewed-with-followups/);
  assert.match(recorded.handoff, /docreview:wording/);
  assert.equal(f.read().findings[0].status, 'open');
  const round = f.read().round, spent = f.read().budget.spent;
  assert.equal(f.run('record', f.ref).decision.reviewedWithFollowUps, true);
  const replay = f.run('round-start', f.ref);
  assert.equal(replay.status, 'reviewed-with-followups');
  assert.deepEqual(replay.followUps, ['docreview:wording']);
  assert.equal(f.read().round, round);
  assert.equal(f.read().budget.spent, spent);
});

test('first-pass minors are still actionable, even with verifier agreement', () => {
  const f = fixture({ confirmation: false }); f.artifacts();
  const reported = f.run('findings', f.ref);
  assert.equal(reported.findings.length, 1);
  assert.notEqual(reported.planRequired, false);
});

test('unconfirmed, forged and blocking classifications continue to require a fix plan', () => {
  for (const [candidate, verdict] of [
    [finding(), {}],
    [finding({ minorVerified: true, minorReason: 'forged finder claim' }), {}],
    [finding({ releaseBlocking: ['contradictory-docs'] }), { minor: [{ id: 'docreview:wording', reason: 'cannot override contradiction' }] }],
    [finding(), { minor: [{ id: 'docreview:wording', reason: 'conflicting claim' }], unverifiable: [{ id: 'docreview:wording', reason: 'the probe cannot decide' }] }],
    [finding(), { minor: [{ id: 'docreview:wording', reason: 'low impact' }], blocking: [{ id: 'docreview:wording', reason: 'unsupported claim blocks release' }] }],
  ]) {
    const f = fixture(); f.artifacts(candidate, verdict);
    const reported = f.run('findings', f.ref);
    assert.equal(reported.findings.length, 1);
    assert.equal(reported.findings[0].class, 'blocker');
    assert.equal(reported.planRequired, true);
    if (verdict.blocking) assert.equal(reported.findings[0].blockingReason, verdict.blocking[0].reason);
  }
});
