'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lgtmState = require('../../core/lgtm-state');
const { tempDir } = require('./temp-dir');

const CLI = path.join(__dirname, '..', 'review-lgtm-state.js');
const PR = 165;
const HEAD_A = 'f9cfe0fec4f559d125a72f7b93a2cd1dd1d3b328';
const HEAD_B = '0123456789abcdef0123456789abcdef01234567';
const BASE = 'a00dc8c9eaee93a7462bb819bd4ac81320b22528';
const CODEX = 'chatgpt-codex-connector[bot]';

function temp() { const stateDir = tempDir('merge-ready-'); lgtmState.selectReviewers({ stateDir, pr: PR, logins: [CODEX], github: { userByLogin: () => ({ login: 'chatgpt-codex-connector', id: 900, type: 'Bot' }), userById: () => null, prAuthorId: () => 1 } }); return stateDir; }
function cli(stateDir, args, input) {
  return JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir }, input }));
}
function deliver(stateDir, headSha, overrides = {}) {
  return cli(stateDir, ['record-delivery', String(PR), headSha], JSON.stringify({
    baseSha: BASE, contractDigest: 'a'.repeat(64), reviewIds: [], acceptance: [{ id: 'AC1', met: true }],
    requiredChecks: [{ name: 'plugin-tests', conclusion: 'success' }], reviewsTerminal: true, openChoices: [], findings: [], droppedMinors: [], tickets: [], ...overrides,
  }));
}
const evidence = (headSha, overrides = {}) => ({
  headSha, baseSha: BASE, contractDigest: 'a'.repeat(64), checks: [{ name: 'plugin-tests', conclusion: 'success' }],
  reviewers: [{ reviewer: CODEX, terminal: true, lgtm: true }], expectedReviewers: [CODEX], branchRules: { mergeStateStatus: 'CLEAN', reviewDecision: null }, ...overrides,
});
const ready = (stateDir, headSha, ev) => cli(stateDir, ['merge-ready', String(PR), headSha], JSON.stringify(ev));

test('merge-ready prints ready only with green CI, terminal reviewers with a fresh LGTM and a current mergeable delivery', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)), { result: 'ready', reasons: [] });
});

test('the #165 ordering: CI green while the review is pending blocks, and the completed review with LGTM unblocks without a new request', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  const pending = ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [{ reviewer: CODEX, terminal: false, lgtm: false }] }));
  assert.deepStrictEqual(pending, { result: 'blocked', reasons: [`reviewer-pending:${CODEX}`] });
  assert.strictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)).result, 'ready');
});

test('a terminal review with no fresh LGTM blocks even with green CI', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [{ reviewer: CODEX, terminal: true, lgtm: false }] })), { result: 'blocked', reasons: [`no-lgtm:${CODEX}`] });
});

test('findings recorded for the head lift the delivery and keep the gate blocked until reconciled', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD_A, now: 1000, observation: {
    reviewId: 5410169503, reviewer: CODEX, reviewUrl: 'https://github.com/arinyaho/concord/pull/165#pullrequestreview-5410169503',
    commitId: HEAD_A, state: 'completed', lgtm: false, findings: [{ url: 'https://github.com/arinyaho/concord/pull/165#discussion_r1', priority: 'P1', signals: [] }],
  } });
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)).reasons, ['delivery-stale']);
});

test('a new head invalidates everything recorded for the old head', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_B, evidence(HEAD_B)).reasons, ['no-delivery']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_B)).reasons, [`head-mismatch:${HEAD_B}`]);
});

test('failing or missing checks, a blocked delivery, no observed reviewer and a provider failure all block with their reasons', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { checks: [{ name: 'plugin-tests', conclusion: 'failure' }] })).reasons, ['check:plugin-tests:failure']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [], expectedReviewers: [] })).reasons, ['no-automated-review']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [] })).reasons, [`reviewer-missing:${CODEX}`]);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [{ reviewer: CODEX, terminal: false, lgtm: false, failure: 'timeout' }] })).reasons, [`reviewer-failure:${CODEX}:timeout`]);
  const blockedDir = temp();
  deliver(blockedDir, HEAD_A, { acceptance: [{ id: 'AC1', met: false }] });
  assert.deepStrictEqual(ready(blockedDir, HEAD_A, evidence(HEAD_A)).reasons, ['delivery-blocked']);
  assert.throws(() => ready(stateDir, HEAD_A, { headSha: HEAD_A, baseSha: BASE, contractDigest: 'a'.repeat(64), checks: 'green', reviewers: [], expectedReviewers: [] }), /merge-ready/);
});

test('the live base and the live contract digest must equal the delivery record', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { baseSha: HEAD_B })).reasons, ['base-changed']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { contractDigest: 'b'.repeat(64) })).reasons, ['contract-changed']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { baseSha: BASE.toUpperCase(), contractDigest: 'A'.repeat(64) })).reasons, []);
});

test('every required check the delivery record names must be present and successful on the live head', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { checks: [] })).reasons, ['check-missing:plugin-tests']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { checks: [{ name: 'lint', conclusion: 'success' }] })).reasons, ['check-missing:plugin-tests']);
});

test('every expected reviewer must be observed, and a reviewer entry needs an identity', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { expectedReviewers: [CODEX, 'copilot-pull-request-reviewer[bot]'] })).reasons, ['reviewer-missing:copilot-pull-request-reviewer[bot]']);
  assert.throws(() => ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [{ terminal: true, lgtm: true }] })), /merge-ready/);
  assert.throws(() => ready(stateDir, HEAD_A, evidence(HEAD_A, { expectedReviewers: undefined })), /merge-ready/);
});

test('an open fix claim on the head blocks the merge even when the delivery record is current', () => {
  const stateDir = temp();
  const observation = { reviewId: 5410169503, reviewer: CODEX, reviewUrl: 'https://github.com/arinyaho/concord/pull/165#pullrequestreview-5410169503', commitId: HEAD_A, state: 'completed', lgtm: false, findings: [{ url: 'https://github.com/arinyaho/concord/pull/165#discussion_r1', priority: 'P1', signals: [] }] };
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD_A, now: 1000, observation });
  deliver(stateDir, HEAD_A, { reviewIds: [5410169503], findings: [{ id: 'f1', url: observation.findings[0].url, disposition: 'fixed', rootCause: 'rc', releaseBlocking: [], rationale: 'fixed' }] });
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)).reasons, []);
  cli(stateDir, ['waive-fix-budget', String(PR), 'someone', '1']);
  assert.strictEqual(cli(stateDir, ['claim-fix-round', String(PR), HEAD_A]).claimed, true);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)).reasons, ['fix-round-open']);
});

test('a fix claim marker with no slot blocks merge-ready with fix-round-open', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  const key = { stateDir, pr: PR, headSha: HEAD_A };
  fs.writeFileSync(lgtmState.markerPath(key, 'fix-round-claim'), `${JSON.stringify({ pr: PR, headSha: HEAD_A, claimedAtMs: 1000 })}\n`);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)), { result: 'blocked', reasons: ['fix-round-open'] });
});

test('a minor collected after the delivery record makes it stale until the delivery is recorded again', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.strictEqual(cli(stateDir, ['status', String(PR), HEAD_A]).delivery.current, true);
  cli(stateDir, ['collect-minor', String(PR), HEAD_A], JSON.stringify({ id: 'c-1', url: 'https://github.com/arinyaho/concord/pull/165#discussion_r1', reason: 'late minor' }));
  assert.strictEqual(cli(stateDir, ['status', String(PR), HEAD_A]).delivery.current, false);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)).reasons, ['delivery-stale']);
  deliver(stateDir, HEAD_A, { droppedMinors: [{ id: 'c-1', reason: 'duplicate of an existing ticket' }] });
  assert.strictEqual(cli(stateDir, ['status', String(PR), HEAD_A]).delivery.current, true);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)), { result: 'ready', reasons: [] });
});

test('a mergeable-without-review record blocks merge-ready with no-automated-review alone and no delivery-blocked', () => {
  const stateDir = temp();
  assert.strictEqual(deliver(stateDir, HEAD_A, { reviewerUnavailable: true }).classification, 'mergeable-without-review');
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [], expectedReviewers: [CODEX] })), { result: 'blocked', reasons: ['no-automated-review'] });
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A)), { result: 'blocked', reasons: ['no-automated-review'] });
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { checks: [{ name: 'plugin-tests', conclusion: 'failure' }] })).reasons, ['check:plugin-tests:failure', 'no-automated-review']);
});


test('merge-ready reports branch rules while exempting a selected human from pending and LGTM', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: { userByLogin: () => ({ login: 'alice', id: 101, type: 'User' }), userById: () => null, prAuthorId: () => 1 } });
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { expectedReviewers: ['alice'], branchRules: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, reviewers: [{ reviewer: 'alice', type: 'User', terminal: false, lgtm: false }] })), { result: 'blocked', reasons: ['branch-rules-unmet:BLOCKED:REVIEW_REQUIRED'] });
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { expectedReviewers: ['alice'], reviewers: [] })), { result: 'ready', reasons: [] });
});

test('merge-ready in empty mode requires branch rules and delivery but awaits no account', () => {
  const stateDir = tempDir('merge-ready-empty-');
  deliver(stateDir, HEAD_A);
  for (const reviewers of [[], [{ reviewer: 'vercel', terminal: false, lgtm: false }]]) assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { expectedReviewers: [], reviewers })), { result: 'ready', reasons: [] });
  assert.throws(() => ready(stateDir, HEAD_A, evidence(HEAD_A, { branchRules: undefined })), /branchRules/);
});


test('a selected bot cannot be exempted by a caller labelling it User', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [{ reviewer: CODEX, type: 'User', terminal: false, lgtm: false }] })), { result: 'blocked', reasons: [`reviewer-pending:${CODEX}`] });
});


test('a caller cannot omit a selected bot from expected reviewers and replace it with a human', () => {
  const stateDir = temp();
  deliver(stateDir, HEAD_A);
  const result = ready(stateDir, HEAD_A, evidence(HEAD_A, { expectedReviewers: [], reviewers: [{ reviewer: 'alice', type: 'User', terminal: false, lgtm: false }] }));
  assert.deepStrictEqual(result, { result: 'blocked', reasons: ['reviewer-missing:chatgpt-codex-connector'] });
});
