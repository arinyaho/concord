'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lgtmState = require('../../core/lgtm-state');

const CLI = path.join(__dirname, '..', 'review-lgtm-state.js');
const PR = 165;
const HEAD_A = 'f9cfe0fec4f559d125a72f7b93a2cd1dd1d3b328';
const HEAD_B = '0123456789abcdef0123456789abcdef01234567';
const BASE = 'a00dc8c9eaee93a7462bb819bd4ac81320b22528';
const CODEX = 'chatgpt-codex-connector[bot]';

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ready-')); }
function cli(stateDir, args, input) {
  return JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir }, input }));
}
function deliver(stateDir, headSha, overrides = {}) {
  return cli(stateDir, ['record-delivery', String(PR), headSha], JSON.stringify({
    baseSha: BASE, contractDigest: 'a'.repeat(64), reviewIds: [], acceptance: [{ id: 'AC1', met: true }],
    requiredChecks: [{ name: 'plugin-tests', conclusion: 'success' }], reviewsTerminal: true, openChoices: [], findings: [], tickets: [], ...overrides,
  }));
}
const evidence = (headSha, overrides = {}) => ({
  headSha, checks: [{ name: 'plugin-tests', conclusion: 'success' }],
  reviewers: [{ reviewer: CODEX, terminal: true, lgtm: true }], ...overrides,
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
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [] })).reasons, ['no-automated-review']);
  assert.deepStrictEqual(ready(stateDir, HEAD_A, evidence(HEAD_A, { reviewers: [{ reviewer: CODEX, terminal: false, lgtm: false, failure: 'timeout' }] })).reasons, [`reviewer-failure:${CODEX}:timeout`]);
  const blockedDir = temp();
  deliver(blockedDir, HEAD_A, { acceptance: [{ id: 'AC1', met: false }] });
  assert.deepStrictEqual(ready(blockedDir, HEAD_A, evidence(HEAD_A)).reasons, ['delivery-blocked']);
  assert.throws(() => ready(stateDir, HEAD_A, { headSha: HEAD_A, checks: 'green', reviewers: [] }), /merge-ready/);
});
