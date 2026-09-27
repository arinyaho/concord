'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lgtmState = require('../../core/lgtm-state');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-state-')); }
const CLI = path.join(__dirname, '..', 'review-lgtm-state.js');
const CLAUDE_SKILL = path.join(__dirname, '..', '..', 'skills', 'review-until-lgtm', 'SKILL.md');
const CODEX_SKILL = path.join(__dirname, '..', '..', '..', 'concord-codex', 'skills', 'review-until-lgtm', 'SKILL.md');

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
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: 901000, retryDeadlineMs: null, initialClaimed: false, initialRequested: false, retryClaimed: false, retryClaimedAtMs: null, retryRequested: false });
  assert.deepStrictEqual(lgtmState.openWindow({ ...input, now: 2000, durationMs: 900000 }), { created: false, deadlineMs: 901000 });
  assert.strictEqual(lgtmState.claimRetry({ ...input, now: 3000 }), true);
  assert.strictEqual(lgtmState.claimRetry(input), false);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: 901000, retryDeadlineMs: null, initialClaimed: false, initialRequested: false, retryClaimed: true, retryClaimedAtMs: 3000, retryRequested: false });
});

test('review requests distinguish a durable claim from a request that was sent', () => {
  const stateDir = temp();
  const input = { stateDir, pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.claimInitialRequest(input), true);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: null, retryDeadlineMs: null, initialClaimed: true, initialRequested: false, retryClaimed: false, retryClaimedAtMs: null, retryRequested: false });
  assert.strictEqual(lgtmState.markInitialRequested(input), true);
  assert.strictEqual(lgtmState.claimRetry({ ...input, now: 4000 }), true);
  assert.strictEqual(lgtmState.markRetryRequested(input), true);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: null, retryDeadlineMs: null, initialClaimed: true, initialRequested: true, retryClaimed: true, retryClaimedAtMs: 4000, retryRequested: true });
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
