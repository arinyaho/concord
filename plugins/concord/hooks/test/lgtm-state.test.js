'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CORE_STATE = path.join(__dirname, '..', '..', 'core', 'lgtm-state.js');
const { execFileSync } = require('node:child_process');
const lgtmState = require('../../core/lgtm-state');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-state-')); }
const CLI = path.join(__dirname, '..', 'review-lgtm-state.js');
const CLAUDE_SKILL = path.join(__dirname, '..', '..', 'skills', 'review-until-lgtm', 'SKILL.md');
const CODEX_SKILL = path.join(__dirname, '..', '..', '..', 'concord-codex', 'skills', 'review-until-lgtm', 'SKILL.md');
const COPILOT_SKILL = path.join(__dirname, '..', '..', '..', 'concord-copilot', 'skills', 'review-until-lgtm', 'SKILL.md');

test('Claude and Codex ship durable review-until-lgtm instructions with host-specific CLI discovery', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  for (const skill of [claude, codex]) {
    assert.match(skill, /open-window <pr> <head-sha> 900/);
    assert.match(skill, /claim-initial-request/);
    assert.match(skill, /claim-initial-request.*\{"claimed":true\}/);
    assert.match(skill, /mark-retry-requested/);
    assert.match(skill, /retryClaimedAtMs/);
    assert.match(skill, /review-timeout/);
    assert.match(skill, /open-retry-window/);
    assert.match(skill, /node .*STATE_CLI/);
    assert.match(skill, /PowerShell/);
    assert.match(skill, /cmd\.exe/);
    assert.match(skill, /initialRequested.*deadlineMs/);
    assert.match(skill, /Node-based locator/);
    assert.match(skill, /recover-initial-request/);
    assert.match(skill, /recover-retry-request/);
    assert.match(skill, /matching activity.*open-window/);
    assert.match(skill, /validates the Concord plugin manifest/);
    assert.match(skill, /newest installed Concord version/);
    assert.match(skill, /matching retry-era activity exists.*mark-retry-requested.*open-retry-window/);
    assert.match(skill, /15-minute lease/);
    assert.doesNotMatch(skill, /q=\[process\.cwd/);
  }
  assert.match(claude, /review-lgtm-state\.js/);
  assert.match(codex, /review-lgtm-state\.js/);
});

test('review-until-lgtm persists its monitoring window and permits exactly one retry per PR head', () => {
  const stateDir = temp();
  const input = { stateDir, pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  const first = lgtmState.openWindow({ ...input, now: 1000, durationMs: 900000 });
  assert.deepStrictEqual(first, { created: true, deadlineMs: 901000 });

  // Simulates a process/session interruption: a new invocation reconstructs
  // the exact same deadline and cannot restart the bounded wait window.
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: 901000, retryDeadlineMs: null, initialClaimed: false, initialClaimedAtMs: null, initialRecoveryClaimed: false, initialRequested: false, retryClaimed: false, retryClaimedAtMs: null, retryRequested: false, reconciliation: null });
  assert.deepStrictEqual(lgtmState.openWindow({ ...input, now: 2000, durationMs: 900000 }), { created: false, deadlineMs: 901000 });
  assert.strictEqual(lgtmState.claimRetry({ ...input, now: 3000 }), true);
  assert.strictEqual(lgtmState.claimRetry(input), false);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: 901000, retryDeadlineMs: null, initialClaimed: false, initialClaimedAtMs: null, initialRecoveryClaimed: false, initialRequested: false, retryClaimed: true, retryClaimedAtMs: 3000, retryRequested: false, reconciliation: null });
});

test('review requests distinguish a durable claim from a request that was sent', () => {
  const stateDir = temp();
  const input = { stateDir, pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: 2000 }), true);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: null, retryDeadlineMs: null, initialClaimed: true, initialClaimedAtMs: 2000, initialRecoveryClaimed: false, initialRequested: false, retryClaimed: false, retryClaimedAtMs: null, retryRequested: false, reconciliation: null });
  assert.strictEqual(lgtmState.markInitialRequested(input), true);
  assert.strictEqual(lgtmState.claimRetry({ ...input, now: 4000 }), true);
  assert.strictEqual(lgtmState.markRetryRequested(input), true);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: null, retryDeadlineMs: null, initialClaimed: true, initialClaimedAtMs: 2000, initialRecoveryClaimed: false, initialRequested: true, retryClaimed: true, retryClaimedAtMs: 4000, retryRequested: true, reconciliation: null });
});

test('an initial request recovery claim waits for the original claimant lease', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.INITIAL_CLAIM_LEASE_MS, 15 * 60 * 1000);
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: 1000 }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS - 1 }), false);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS }), false);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + 2 * lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
});

test('a retry recovery claim waits for and can replace a stale retry claimant', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.claimRetry({ ...input, now: 1000 }), true);
  assert.strictEqual(lgtmState.recoverRetryRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS - 1 }), false);
  assert.strictEqual(lgtmState.recoverRetryRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.strictEqual(lgtmState.recoverRetryRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS }), false);
  assert.strictEqual(lgtmState.recoverRetryRequest({ ...input, now: 1000 + 2 * lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
});

test('default state directory is shared by linked worktrees and resolves Git outside the checkout', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-worktree-'));
  const linked = `${repo}-linked`;
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  execFileSync('git', ['worktree', 'add', '-qb', 'linked', linked], { cwd: repo });
  assert.strictEqual(lgtmState.defaultStateDir(repo), lgtmState.defaultStateDir(linked));
  assert.match(fs.readFileSync(CORE_STATE, 'utf8'), /crossPlatformCommand\('git', repoRoot\)/);
});

test('a retry claim records the boundary for retry-activity reconciliation', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.claimRetry({ ...input, now: 123456 }), true);
  assert.strictEqual(lgtmState.status(input).retryClaimedAtMs, 123456);
});

test('a retry request receives its own durable monitoring deadline', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.deepStrictEqual(lgtmState.openWindow({ ...input, now: 1000, durationMs: 900000 }), { created: true, deadlineMs: 901000 });
  assert.deepStrictEqual(lgtmState.openRetryWindow({ ...input, now: 1000000, durationMs: 900000 }), { created: true, deadlineMs: 1900000 });
  assert.strictEqual(lgtmState.status(input).retryDeadlineMs, 1900000);
});

test('review-until-lgtm CLI restores a completed review window after a new process starts', () => {
  const stateDir = temp();
  const pr = '116';
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const open = JSON.parse(execFileSync('node', [CLI, 'open-window', pr, head, '900'], { encoding: 'utf8', env }));
  const resumed = JSON.parse(execFileSync('node', [CLI, 'status', pr, head], { encoding: 'utf8', env }));
  assert.strictEqual(resumed.deadlineMs, open.deadlineMs);
  assert.strictEqual(JSON.parse(execFileSync('node', [CLI, 'claim-retry', pr, head], { encoding: 'utf8', env })).claimed, true);
  assert.strictEqual(JSON.parse(execFileSync('node', [CLI, 'claim-retry', pr, head], { encoding: 'utf8', env })).claimed, false);
});

// --- Reconciliation: record-review, classification, and claim blocking ---
// Fixtures modeled on real GitHub Codex bot reviews from PR #122.
const PR_122 = 122;
const HEAD_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';

function inlineFinding({ priority = 'P1', signals = [], url = 'https://github.com/arinyaho/concord/pull/122#discussion_r1958211440' } = {}) {
  return { url, priority, signals };
}

function summaryFinding({ priority = 'P2', signals = [], reviewId = '5332811440' } = {}) {
  return { url: `https://github.com/arinyaho/concord/pull/122#pullrequestreview-${reviewId}`, priority, signals };
}

function observation({ reviewId = '5332811440', commitId = HEAD_A, state = 'completed', lgtm = false, findings = [inlineFinding()] } = {}) {
  return { reviewId, reviewUrl: `https://github.com/arinyaho/concord/pull/122#pullrequestreview-${reviewId}`, commitId, state, lgtm, findings };
}

test('record-review persists an inline finding as needs-reconciliation', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] }) });
  assert.deepStrictEqual(result, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
});

test('record-review persists a summary-level finding using the review URL', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [summaryFinding({ priority: 'P2' })] }) });
  assert.strictEqual(result.outcome, 'needs-reconciliation');
  assert.strictEqual(result.recorded, true);
});

test('record-review reports needs-reconciliation for a finding even when the LGTM reaction is present', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ lgtm: true, findings: [inlineFinding()] }) });
  assert.strictEqual(result.outcome, 'needs-reconciliation');
});

test('record-review reports green for an explicit LGTM with no findings', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ lgtm: true, findings: [] }) });
  assert.deepStrictEqual(result, { outcome: 'green', recorded: false });
});

test('record-review reports completed-without-lgtm when no findings and no LGTM', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ lgtm: false, findings: [] }) });
  assert.deepStrictEqual(result, { outcome: 'completed-without-lgtm', recorded: false });
});

test('record-review reports stale when the review commitId differs from the head and never records', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ commitId: HEAD_B, findings: [inlineFinding()] }) });
  assert.deepStrictEqual(result, { outcome: 'stale', recorded: false });
  assert.deepStrictEqual(lgtmState.status(input).reconciliation, null);
});

test('record-review reports in-progress and never records', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ state: 'in-progress', findings: [inlineFinding()] }) });
  assert.deepStrictEqual(result, { outcome: 'in-progress', recorded: false });
  assert.deepStrictEqual(lgtmState.status(input).reconciliation, null);
});

test('replaying the same reviewId returns a duplicate result and leaves the record unchanged', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const obs = observation({ findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  const first = lgtmState.recordReview({ ...input, now: 5000, observation: obs });
  assert.strictEqual(first.recorded, true);
  const before = lgtmState.status(input).reconciliation;
  const replay = lgtmState.recordReview({ ...input, now: 9000, observation: obs });
  assert.deepStrictEqual(replay, { outcome: 'needs-reconciliation', recorded: false, duplicate: true });
  assert.deepStrictEqual(lgtmState.status(input).reconciliation, before);
});

test('a later clean review on a marked head reports needs-reconciliation without writing a new record', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '5332811440', findings: [inlineFinding()] }) });
  const clean = lgtmState.recordReview({ ...input, now: 6000, observation: observation({ reviewId: '5332945959', lgtm: true, findings: [] }) });
  assert.deepStrictEqual(clean, { outcome: 'needs-reconciliation', recorded: false, duplicate: false });
  assert.strictEqual(lgtmState.status(input).reconciliation.batchCount, 1);
});

test('status.reconciliation.reviews are ordered by recordedAtMs ascending regardless of file-name order', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  // '1111111111' sorts before '9999999999' by file name, but is recorded later.
  lgtmState.recordReview({ ...input, now: 9000, observation: observation({ reviewId: '1111111111', findings: [inlineFinding({ priority: 'P2', signals: [] })] }) });
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '9999999999', findings: [inlineFinding({ priority: 'P2', signals: [] })] }) });
  const packet = lgtmState.status(input).reconciliation;
  assert.deepStrictEqual(packet.reviews.map((r) => r.id), ['9999999999', '1111111111']);
});

test('a second distinct reviewId recorded for the head produces requires-architecture-review', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '5332811440', findings: [inlineFinding({ priority: 'P2', signals: [] })] }) });
  lgtmState.recordReview({ ...input, now: 6000, observation: observation({ reviewId: '5333706190', findings: [inlineFinding({ priority: 'P2', signals: [] })] }) });
  assert.strictEqual(lgtmState.status(input).reconciliation.classification, 'requires-architecture-review');
  assert.strictEqual(lgtmState.status(input).reconciliation.batchCount, 2);
});

test('a single P1 finding produces requires-architecture-review', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding({ priority: 'P1', signals: [] })] }) });
  const packet = lgtmState.status(input).reconciliation;
  assert.strictEqual(packet.classification, 'requires-architecture-review');
  assert.strictEqual(packet.p1Count, 1);
});

test('a single signal-free P2 finding produces light-implementation-eligible', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding({ priority: 'P2', signals: [] })] }) });
  const packet = lgtmState.status(input).reconciliation;
  assert.strictEqual(packet.classification, 'light-implementation-eligible');
  assert.strictEqual(packet.p2Count, 1);
});

for (const signal of ['lifecycle', 'ledger', 'audit-privacy', 'provider-parity', 'ac-conflict', 'unsupported-test']) {
  test(`the ${signal} signal alone produces requires-architecture-review`, () => {
    const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
    lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding({ priority: null, signals: [signal] })] }) });
    assert.strictEqual(lgtmState.status(input).reconciliation.classification, 'requires-architecture-review');
  });
}

test('an unknown signal is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding({ signals: ['not-a-real-signal'] })] }) }), /unknown signal/);
});

test('a missing signals field is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const bad = observation({ findings: [{ url: 'https://github.com/arinyaho/concord/pull/122#discussion_r1', priority: 'P1' }] });
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: bad }), /finding signals is required and must be an array/);
});

test('a bad priority is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding({ priority: 'P3' })] }) }), /finding priority must be P1, P2, or null/);
});

test('a finding missing the priority key entirely is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const bad = observation({ findings: [{ url: 'https://github.com/arinyaho/concord/pull/122#discussion_r1', signals: [] }] });
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: bad }), /finding priority is required and must be P1, P2, or null/);
});

test('a non-digit reviewId is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: 'abc123' }) }), /reviewId must be a positive safe integer or decimal digits/);
});

test('a numeric reviewId is accepted, normalized to a decimal string, and blocks claim-retry afterward', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: 5332811440, findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] }) });
  assert.deepStrictEqual(result, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
  const packet = lgtmState.status(input).reconciliation;
  assert.strictEqual(packet.reviews[0].id, '5332811440');
  assert.deepStrictEqual(lgtmState.claimRetry({ ...input, now: 6000 }), { claimed: false, reason: 'needs-reconciliation' });
});

test('CLI record-review accepts a JSON number reviewId on stdin and claim-retry then refuses', () => {
  const stateDir = temp();
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const obs = observation({ reviewId: 5332811440, findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  const out = JSON.parse(execFileSync('node', [CLI, 'record-review', String(PR_122), HEAD_A], { encoding: 'utf8', env, input: JSON.stringify(obs) }));
  assert.deepStrictEqual(out, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
  const retry = execFileSync('node', [CLI, 'claim-retry', String(PR_122), HEAD_A], { encoding: 'utf8', env });
  assert.strictEqual(retry, '{"claimed":false,"reason":"needs-reconciliation"}\n');
});

test('a reviewId string with leading zeros canonicalizes to the same review as its plain digits', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const first = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '05', findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] }) });
  assert.strictEqual(first.recorded, true);
  assert.strictEqual(lgtmState.status(input).reconciliation.reviews[0].id, '5');
  const replay = lgtmState.recordReview({ ...input, now: 6000, observation: observation({ reviewId: 5, findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] }) });
  assert.deepStrictEqual(replay, { outcome: 'needs-reconciliation', recorded: false, duplicate: true });
});

test('a reviewId of "0" or all zeros is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '0' }) }), /reviewId must be a positive safe integer or decimal digits/);
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '000' }) }), /reviewId must be a positive safe integer or decimal digits/);
});

test('a float, negative, or unsafe-integer reviewId is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: 1.5 }) }), /reviewId must be a positive safe integer or decimal digits/);
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: -5 }) }), /reviewId must be a positive safe integer or decimal digits/);
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: Number.MAX_SAFE_INTEGER + 10 }) }), /reviewId must be a positive safe integer or decimal digits/);
});

test('a missing field is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const bad = observation();
  delete bad.commitId;
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: bad }), /commitId must be a full 40- or 64-character hexadecimal SHA/);
});

test('once a head is marked, the four claim/recover verbs report needs-reconciliation while mark-*/open-* verbs still work', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding()] }) });
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ ...input, now: 6000 }), { claimed: false, reason: 'needs-reconciliation' });
  assert.deepStrictEqual(lgtmState.recoverInitialRequest({ ...input, now: 6000 }), { claimed: false, reason: 'needs-reconciliation' });
  assert.deepStrictEqual(lgtmState.claimRetry({ ...input, now: 6000 }), { claimed: false, reason: 'needs-reconciliation' });
  assert.deepStrictEqual(lgtmState.recoverRetryRequest({ ...input, now: 6000 }), { claimed: false, reason: 'needs-reconciliation' });
  assert.strictEqual(lgtmState.markInitialRequested(input), true);
  assert.deepStrictEqual(lgtmState.openWindow({ ...input, now: 6000, durationMs: 900000 }), { created: true, deadlineMs: 906000 });
  assert.strictEqual(lgtmState.markRetryRequested(input), true);
  assert.deepStrictEqual(lgtmState.openRetryWindow({ ...input, now: 6000, durationMs: 900000 }), { created: true, deadlineMs: 906000 });
});

test('a different head of the same PR is unaffected by another head being marked', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR_122, headSha: HEAD_A, now: 5000, observation: observation({ findings: [inlineFinding()] }) });
  assert.strictEqual(lgtmState.claimInitialRequest({ stateDir, pr: PR_122, headSha: HEAD_B, now: 6000 }), true);
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR_122, headSha: HEAD_B }).reconciliation, null);
});

test('an abbreviated head is rejected by a claim verb and by record-review', () => {
  const stateDir = temp();
  const shortHead = HEAD_A.slice(0, 7);
  assert.throws(() => lgtmState.claimRetry({ stateDir, pr: PR_122, headSha: shortHead, now: 1000 }), /head SHA must be a full 40- or 64-character hexadecimal SHA \(the PR headRefOid\)/);
  assert.throws(() => lgtmState.recordReview({ stateDir, pr: PR_122, headSha: shortHead, now: 1000, observation: observation({ commitId: shortHead, findings: [] }) }), /head SHA must be a full 40- or 64-character hexadecimal SHA \(the PR headRefOid\)/);
});

test('status.reconciliation is null when unmarked and a full packet once marked', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  assert.strictEqual(lgtmState.status(input).reconciliation, null);
  const obs = observation({ reviewId: '5332811440', findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  lgtmState.recordReview({ ...input, now: 5000, observation: obs });
  const packet = lgtmState.status(input).reconciliation;
  assert.deepStrictEqual(packet, {
    pr: PR_122,
    headSha: HEAD_A,
    reviews: [{ id: '5332811440', url: obs.reviewUrl, findings: [{ url: obs.findings[0].url, priority: 'P1', signals: ['lifecycle'] }] }],
    batchCount: 1,
    p1Count: 1,
    p2Count: 0,
    signals: ['lifecycle'],
    classification: 'requires-architecture-review',
    retryEligible: false,
    choices: ['resume', 'revise', 'split', 'defer'],
    requires: 'human decision or new head',
  });
});

test('CLI record-review reads the observation as JSON on stdin', () => {
  const stateDir = temp();
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const obs = observation({ findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  const out = JSON.parse(execFileSync('node', [CLI, 'record-review', String(PR_122), HEAD_A], { encoding: 'utf8', env, input: JSON.stringify(obs) }));
  assert.deepStrictEqual(out, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
});

test('CLI claim-retry and claim-initial-request refuse a head with a recorded review', () => {
  const stateDir = temp();
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const obs = observation({ findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  execFileSync('node', [CLI, 'record-review', String(PR_122), HEAD_A], { encoding: 'utf8', env, input: JSON.stringify(obs) });
  const retry = execFileSync('node', [CLI, 'claim-retry', String(PR_122), HEAD_A], { encoding: 'utf8', env });
  assert.strictEqual(retry, '{"claimed":false,"reason":"needs-reconciliation"}\n');
  const initial = execFileSync('node', [CLI, 'claim-initial-request', String(PR_122), HEAD_A], { encoding: 'utf8', env });
  assert.strictEqual(initial, '{"claimed":false,"reason":"needs-reconciliation"}\n');
});

test('Claude, Codex, and Copilot review-until-lgtm skills pin the reconciliation extraction rules', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  const copilot = fs.readFileSync(COPILOT_SKILL, 'utf8');
  for (const skill of [claude, codex, copilot]) {
    assert.match(skill, /record-review <pr> <head-sha>/);
    assert.match(skill, /before any retry claim/);
    assert.match(skill, /commit_id/);
    assert.match(skill, /headRefOid/);
    assert.match(skill, /P1/);
    assert.match(skill, /P2/);
    assert.match(skill, /badge/);
    assert.match(skill, /unresolved bot thread/);
    assert.match(skill, /light-implementation-eligible/);
    assert.match(skill, /requires-architecture-review/);
    assert.match(skill, /needs-reconciliation/);
    assert.match(skill, /does not edit source/);
    assert.match(skill, /no existing review record for the head/);
    assert.match(skill, /When a matching Codex review object exists for the head, defer to `record-review`'s outcome/);
    assert.match(skill, /each recorded review's id and URL/);
    assert.match(skill, /each unresolved finding's URL with its P1\/P2 priority/);
    assert.match(skill, /the batch count/);
    assert.match(skill, /resume, revise, split, and defer choices/);
    assert.match(skill, /a new head \(a new commit\) is required/);
    assert.match(skill, /if `record-review` exits non-zero or rejects the observation, stop and report it; never claim or request a review for that head afterward/i);
  }
});

test('Claude, Codex, and Copilot review-until-lgtm skills pin the no-review-object green rule', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  const copilot = fs.readFileSync(COPILOT_SKILL, 'utf8');
  for (const skill of [claude, codex, copilot]) {
    assert.match(skill, /no Codex review has `commit_id` equal to the full `headRefOid`/);
    assert.match(skill, /`reconciliation` is `null`/);
    assert.match(skill, /every row of the bot-authored summary comment is `✅ Completed` and its Commit is a prefix of the full `headRefOid`/);
    assert.match(skill, /a \+1 reaction on the PR from the Codex bot login.*created_at.*at or after that row's completion/);
    assert.match(skill, /A \+1 created before the completion time never counts/);
    assert.match(skill, /If 1-3 hold but no qualifying \+1 appears by the persisted deadline, report `completed-without-lgtm`/);
    assert.match(skill, /the reaction lands on the PR, never on the summary comment/);
    assert.match(skill, /Count only unresolved bot threads created by this matching review as findings/);
    assert.match(skill, /an unresolved thread left over from an earlier head's review is not a finding for this head's review/);
    assert.match(skill, /state the reaction's `created_at` and the row's completion time/);
  }
});
