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

test('Claude and Codex ship review-until-lgtm with host-specific CLI discovery', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  for (const skill of [claude, codex]) {
    assert.match(skill, /node .*STATE_CLI/);
    assert.match(skill, /PowerShell/);
    assert.match(skill, /cmd\.exe/);
    assert.match(skill, /Node-based locator/);
    assert.match(skill, /validates the Concord plugin manifest/);
    assert.match(skill, /newest installed Concord version/);
    assert.doesNotMatch(skill, /q=\[process\.cwd/);
  }
  assert.match(claude, /review-lgtm-state\.js/);
  assert.match(codex, /review-lgtm-state\.js/);
});

test('review-until-lgtm persists its monitoring window and request budget', () => {
  const stateDir = temp();
  const input = { stateDir, pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  const first = lgtmState.openWindow({ ...input, now: 1000, durationMs: 900000 });
  assert.deepStrictEqual(first, { created: true, deadlineMs: 901000 });

  // Simulates a process/session interruption: a new invocation reconstructs
  // the exact same deadline and cannot restart the bounded wait window.
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: 901000, requestEligibleAtMs: null, requestBudget: { max: 3, spent: 0, remaining: 3 }, fixBudget: { max: 3, spent: 0, remaining: 3 }, waivers: [], initialClaimed: false, initialClaimedAtMs: null, initialRecoveryClaimed: false, initialRequested: false, reconciliation: null, delivery: null });
  assert.deepStrictEqual(lgtmState.openWindow({ ...input, now: 2000, durationMs: 900000 }), { created: false, deadlineMs: 901000 });
});

test('an initial request waits for automatic review activity before it can be claimed', () => {
  const input = { stateDir: temp(), pr: 159, headSha: '1111111111111111111111111111111111111111' };
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ ...input, now: 1000 }), {
    claimed: false,
    reason: 'auto-review-grace',
    eligibleAtMs: 121000,
  });
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ ...input, now: 120999 }), {
    claimed: false,
    reason: 'auto-review-grace',
    eligibleAtMs: 121000,
  });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: 121000 }), true);
});

test('manual review requests share a cumulative three-request budget across PR heads', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  for (const [index, headSha] of heads.entries()) {
    lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha, now: 1000 + index });
    const result = lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha, now: 121000 + index });
    if (index < 3) assert.strictEqual(result, true);
    else assert.deepStrictEqual(result, { claimed: false, reason: 'request-budget-exhausted', budget: { max: 3, spent: 3, remaining: 0 } });
  }
});

test('legacy sent-request markers count toward the PR-wide request budget without double-counting slots', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  lgtmState.markInitialRequested({ stateDir, pr: 159, headSha: heads[0] });
  lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha: heads[0], now: 1000 });
  assert.strictEqual(lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha: heads[0], now: 121000 }), true);
  lgtmState.markInitialRequested({ stateDir, pr: 159, headSha: heads[1] });
  fs.writeFileSync(lgtmState.markerPath({ stateDir, pr: 159, headSha: heads[2] }, 'retry-request'), `${JSON.stringify({ pr: 159, headSha: heads[2], kind: 'retry', requested: true })}\n`);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: 159, headSha: heads[3] }).requestBudget, { max: 3, spent: 3, remaining: 0 });
  lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha: heads[3], now: 1000 });
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha: heads[3], now: 121000 }), {
    claimed: false,
    reason: 'request-budget-exhausted',
    budget: { max: 3, spent: 3, remaining: 0 },
  });
});

test('a legacy orphan request claim conservatively consumes one request attempt', () => {
  const input = { stateDir: temp(), pr: 159, headSha: '1'.repeat(40) };
  fs.writeFileSync(lgtmState.markerPath(input, 'initial-claim'), `${JSON.stringify({ pr: 159, headSha: input.headSha, kind: 'initial', claimedAtMs: 1000 })}\n`);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 1, remaining: 2 });
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 2, remaining: 1 });
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + 2 * lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 3, remaining: 0 });
  assert.deepStrictEqual(lgtmState.recoverInitialRequest({ ...input, now: 1000 + 3 * lgtmState.INITIAL_CLAIM_LEASE_MS }), {
    claimed: false,
    reason: 'request-budget-exhausted',
    budget: { max: 3, spent: 3, remaining: 0 },
  });
});

test('legacy recovery claims each consume a possible request attempt', () => {
  const input = { stateDir: temp(), pr: 159, headSha: '1'.repeat(40) };
  fs.writeFileSync(lgtmState.markerPath(input, 'initial-claim'), `${JSON.stringify({ pr: 159, headSha: input.headSha, kind: 'initial', claimedAtMs: 1000 })}\n`);
  fs.writeFileSync(lgtmState.markerPath(input, 'initial-recovery-claim-901000'), `${JSON.stringify({ pr: 159, headSha: input.headSha, kind: 'initial-recovery', claimedAtMs: 901000 })}\n`);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 2, remaining: 1 });
});

test('manual request claims are independent per provider on one head', () => {
  const input = { stateDir: temp(), pr: 159, headSha: '1'.repeat(40) };
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'codex', now: 1000 }).claimed, false);
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'codex', now: 121000 }), true);
  assert.strictEqual(lgtmState.markInitialRequested({ ...input, provider: 'codex' }), true);
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'copilot', now: 121001 }), true);
  assert.strictEqual(lgtmState.markInitialRequested({ ...input, provider: 'copilot' }), true);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 2, remaining: 1 });
});

test('request-budget exhaustion remains visible after the failed claim is resumed', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  for (const [index, headSha] of heads.slice(0, 3).entries()) {
    lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha, now: 1000 + index });
    assert.strictEqual(lgtmState.claimInitialRequest({ stateDir, pr: 159, headSha, now: 121000 + index }), true);
  }
  const input = { stateDir, pr: 159, headSha: heads[3] };
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ ...input, now: 1000 }), {
    claimed: false,
    reason: 'request-budget-exhausted',
    budget: { max: 3, spent: 3, remaining: 0 },
  });
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ ...input, now: 2000 }), {
    claimed: false,
    reason: 'request-budget-exhausted',
    budget: { max: 3, spent: 3, remaining: 0 },
  });
});

test('review requests distinguish a durable claim from a request that was sent', () => {
  const stateDir = temp();
  const input = { stateDir, pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  lgtmState.claimInitialRequest({ ...input, now: 2000 });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: 122000 }), true);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: null, requestEligibleAtMs: 122000, requestBudget: { max: 3, spent: 1, remaining: 2 }, fixBudget: { max: 3, spent: 0, remaining: 3 }, waivers: [], initialClaimed: true, initialClaimedAtMs: 122000, initialRecoveryClaimed: false, initialRequested: false, reconciliation: null, delivery: null });
  assert.strictEqual(lgtmState.markInitialRequested(input), true);
  assert.deepStrictEqual(lgtmState.status(input), { deadlineMs: null, requestEligibleAtMs: 122000, requestBudget: { max: 3, spent: 1, remaining: 2 }, fixBudget: { max: 3, spent: 0, remaining: 3 }, waivers: [], initialClaimed: true, initialClaimedAtMs: 122000, initialRecoveryClaimed: false, initialRequested: true, reconciliation: null, delivery: null });
});

test('status exposes a provider-specific sent request so resume can open its window', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567', provider: 'codex' };
  lgtmState.claimInitialRequest({ ...input, now: 1000 });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: 121000 }), true);
  assert.strictEqual(lgtmState.status(input).initialClaimed, true);
  assert.strictEqual(lgtmState.status(input).initialClaimedAtMs, 121000);
  assert.strictEqual(lgtmState.markInitialRequested(input), true);
  assert.strictEqual(lgtmState.status(input).initialRequested, true);
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'copilot', now: 121001 }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, provider: 'copilot', now: 121001 + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.strictEqual(lgtmState.status(input).initialRecoveryClaimed, true);
});

test('status exposes a sent legacy retry without a window as resumable activity', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  fs.writeFileSync(lgtmState.markerPath(input, 'retry-request'), `${JSON.stringify({ pr: 116, headSha: input.headSha, kind: 'retry', requested: true })}\n`);
  assert.strictEqual(lgtmState.status(input).initialRequested, true);
  assert.strictEqual(lgtmState.status(input).deadlineMs, null);
});

test('concurrent provider claims serialize without losing a request slot', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  lgtmState.claimInitialRequest({ ...input, provider: 'existing', now: 1000 });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'existing', now: 121000 }), true);
  const linkSync = fs.linkSync;
  let contender;
  let interleaved = false;
  fs.linkSync = (source, destination) => {
    if (!interleaved && destination.endsWith('pr-116.request-slot-2.json')) {
      interleaved = true;
      contender = lgtmState.claimInitialRequest({ ...input, provider: 'provider-b', now: 121002 });
    }
    linkSync(source, destination);
  };
  let winner;
  try {
    winner = lgtmState.claimInitialRequest({ ...input, provider: 'provider-a', now: 121001 });
  } finally {
    fs.linkSync = linkSync;
  }
  assert.strictEqual(winner, true);
  assert.deepStrictEqual(contender, { claimed: false, reason: 'transition-busy' });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'provider-b', now: 121003 }), true);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 3, remaining: 0 });
});

test('an initial request recovery claim waits for the original claimant lease', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.INITIAL_CLAIM_LEASE_MS, 15 * 60 * 1000);
  lgtmState.claimInitialRequest({ ...input, now: 1000 });
  const claimedAtMs = 1000 + lgtmState.AUTO_REVIEW_GRACE_MS;
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: claimedAtMs }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + lgtmState.INITIAL_CLAIM_LEASE_MS - 1 }), false);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + lgtmState.INITIAL_CLAIM_LEASE_MS }), false);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + 2 * lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
});

test('each recovered provider request consumes another PR-wide request slot', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  lgtmState.claimInitialRequest({ ...input, now: 1000 });
  const claimedAtMs = 1000 + lgtmState.AUTO_REVIEW_GRACE_MS;
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, now: claimedAtMs }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + 2 * lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.deepStrictEqual(lgtmState.recoverInitialRequest({ ...input, now: claimedAtMs + 3 * lgtmState.INITIAL_CLAIM_LEASE_MS }), {
    claimed: false,
    reason: 'request-budget-exhausted',
    budget: { max: 3, spent: 3, remaining: 0 },
  });
});

test('an initial request cannot be recovered without an original claim', () => {
  const input = { stateDir: temp(), pr: 116, headSha: '0123456789abcdef0123456789abcdef01234567' };
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, now: Date.now() }), false);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 0, remaining: 3 });
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

test('review-until-lgtm CLI restores a completed review window after a new process starts', () => {
  const stateDir = temp();
  const pr = '116';
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const open = JSON.parse(execFileSync('node', [CLI, 'open-window', pr, head, '900'], { encoding: 'utf8', env }));
  const resumed = JSON.parse(execFileSync('node', [CLI, 'status', pr, head], { encoding: 'utf8', env }));
  assert.strictEqual(resumed.deadlineMs, open.deadlineMs);
});

test('an active legacy retry window remains the collection deadline after upgrade', () => {
  const input = { stateDir: temp(), pr: 116, headSha: 'abcdef0123456789abcdef0123456789abcdef01' };
  lgtmState.openWindow({ ...input, now: 1000, durationMs: 1000 });
  lgtmState.openWindow({ ...input, now: 3000, durationMs: 900000 }, 'retry-window');
  assert.strictEqual(lgtmState.status(input).deadlineMs, 903000);
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

function observation({ reviewId = '5332811440', reviewer = 'chatgpt-codex-connector[bot]', commitId = HEAD_A, state = 'completed', lgtm = false, findings = [inlineFinding()] } = {}) {
  return { reviewId, reviewer, reviewUrl: `https://github.com/arinyaho/concord/pull/122#pullrequestreview-${reviewId}`, commitId, state, lgtm, findings };
}

test('an abandoned fix-round claim fails closed for human reconciliation', () => {
  const stateDir = temp();
  const input = { stateDir, pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 500, observation: observation() });
  fs.writeFileSync(lgtmState.markerPath(input, 'fix-round-claim'), `${JSON.stringify({ pr: PR_122, headSha: HEAD_A, claimedAtMs: 1000 })}\n`);
  const expected = { claimed: false, reason: 'abandoned-fix-claim', humanRequired: true };
  assert.deepStrictEqual(lgtmState.claimFixRound({ ...input, now: 900000 }), expected);
  assert.deepStrictEqual(lgtmState.claimFixRound({ ...input, now: 1000 + lgtmState.INITIAL_CLAIM_LEASE_MS, owner: 'worker-a' }), expected);
  assert.deepStrictEqual(lgtmState.status(input).fixBudget, { max: 3, spent: 0, remaining: 3 });
  assert.deepStrictEqual(lgtmState.status(input).reconciliation, {
    pr: PR_122,
    headSha: HEAD_A,
    reviews: [{ id: '5332811440', reviewer: 'chatgpt-codex-connector[bot]', url: 'https://github.com/arinyaho/concord/pull/122#pullrequestreview-5332811440', findings: [inlineFinding()] }],
    batchCount: 1,
    p1Count: 1,
    p2Count: 0,
    signals: [],
    classification: 'requires-architecture-review',
    action: 'human-reconciliation',
    humanRequired: true,
    requires: 'human decision: abandoned fix-round claim',
  });
});

test('a concurrent fix claimant receives busy without consuming another slot', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 500, observation: observation() });
  const linkSync = fs.linkSync;
  let contender;
  fs.linkSync = (source, destination) => {
    linkSync(source, destination);
    if (destination.endsWith('.fix-round-claim.json')) {
      contender = lgtmState.claimFixRound({ ...input, now: 1001, owner: 'contender' });
    }
  };
  let original;
  try {
    original = lgtmState.claimFixRound({ ...input, now: 1000, owner: 'original' });
  } finally {
    fs.linkSync = linkSync;
  }
  assert.deepStrictEqual(contender, { claimed: false, reason: 'transition-busy' });
  assert.strictEqual(original.claimed, true);
  assert.strictEqual(original.owner, 'original');
  assert.deepStrictEqual(lgtmState.status(input).fixBudget, { max: 3, spent: 1, remaining: 2 });
});

test('a reserved fix-round keeps one immutable owner', () => {
  const stateDir = temp();
  const input = { stateDir, pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 500, observation: observation() });
  assert.deepStrictEqual(lgtmState.claimFixRound({ ...input, now: 1000, owner: 'worker-a' }), {
    claimed: true,
    owner: 'worker-a',
    round: 1,
    budget: { max: 3, spent: 1, remaining: 2 },
  });
  assert.deepStrictEqual(lgtmState.renewFixRound({ ...input, now: 800000, owner: 'worker-a' }), {
    renewed: true,
  });
  const expected = {
    claimed: false,
    reason: 'fix-round-owned',
    humanRequired: true,
    owner: 'worker-a',
  };
  assert.deepStrictEqual(lgtmState.claimFixRound({ ...input, now: 2000, owner: 'worker-b' }), expected);
  assert.deepStrictEqual(lgtmState.claimFixRound({ ...input, now: 800000 + lgtmState.INITIAL_CLAIM_LEASE_MS, owner: 'worker-b' }), expected);
  assert.deepStrictEqual(lgtmState.renewFixRound({ ...input, now: 2000000, owner: 'worker-a' }), { renewed: true });
});

test('review records preserve provider identity in one head batch', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: '1', reviewer: 'chatgpt-codex-connector[bot]' }) });
  lgtmState.recordReview({ ...input, now: 6000, observation: observation({ reviewId: '2', reviewer: 'copilot-pull-request-reviewer[bot]' }) });
  assert.deepStrictEqual(lgtmState.status(input).reconciliation.reviews.map(({ id, reviewer }) => ({ id, reviewer })), [
    { id: '1', reviewer: 'chatgpt-codex-connector[bot]' },
    { id: '2', reviewer: 'copilot-pull-request-reviewer[bot]' },
  ]);
});

test('legacy review records expose unknown provider provenance', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  fs.writeFileSync(lgtmState.markerPath(input, 'review-1'), `${JSON.stringify({ pr: PR_122, headSha: HEAD_A, reviewId: '1', reviewUrl: 'https://github.com/arinyaho/concord/pull/122#pullrequestreview-1', recordedAtMs: 5000, findings: [inlineFinding()] })}\n`);
  assert.strictEqual(lgtmState.status(input).reconciliation.reviews[0].reviewer, 'legacy/unknown');
});

test('batch fixes share a cumulative three-round budget across PR heads', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  for (const [index, headSha] of heads.entries()) {
    lgtmState.recordReview({ stateDir, pr: 159, headSha, now: 1000 + index, observation: observation({ reviewId: String(index + 1), commitId: headSha }) });
    const result = lgtmState.claimFixRound({ stateDir, pr: 159, headSha, now: 2000 + index, owner: `worker-${index}` });
    if (index < 3) assert.deepStrictEqual(result, { claimed: true, owner: `worker-${index}`, round: index + 1, budget: { max: 3, spent: index + 1, remaining: 2 - index } });
    else assert.deepStrictEqual(result, { claimed: false, reason: 'fix-round-budget-exhausted', budget: { max: 3, spent: 3, remaining: 0 } });
  }
});

test('fix-budget exhaustion remains terminal after session replacement', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  for (const [index, headSha] of heads.entries()) {
    lgtmState.recordReview({ stateDir, pr: 159, headSha, now: 1000 + index, observation: observation({ reviewId: String(index + 1), commitId: headSha }) });
    const result = lgtmState.claimFixRound({ stateDir, pr: 159, headSha, now: 2000 + index, owner: `worker-${index}` });
    if (index === 3) {
      assert.deepStrictEqual(result, { claimed: false, reason: 'fix-round-budget-exhausted', budget: { max: 3, spent: 3, remaining: 0 } });
      assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: 159, headSha, now: 3000 + index, owner: `replacement-${index}` }), result);
      assert.deepStrictEqual(lgtmState.status({ stateDir, pr: 159, headSha }).reconciliation.action, 'human-reconciliation');
      assert.strictEqual(lgtmState.status({ stateDir, pr: 159, headSha }).reconciliation.humanRequired, true);
    }
  }
});

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

test('a fully rejected review batch is durably disposed without an empty fix commit', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const rejectedObservation = observation({ reviewId: '1', findings: [inlineFinding()] });
  lgtmState.recordReview({ ...input, now: 5000, observation: rejectedObservation });
  assert.deepStrictEqual(lgtmState.rejectReviewBatch({ ...input, now: 6000, reviewIds: ['1'], reason: 'Verifier reproduced no defect.' }), {
    rejected: true,
    reviewIds: ['1'],
  });
  assert.strictEqual(lgtmState.status(input).reconciliation, null);
  assert.deepStrictEqual(lgtmState.recordReview({ ...input, now: 6500, observation: rejectedObservation }), { outcome: 'rejected', recorded: false, duplicate: true });
  assert.deepStrictEqual(lgtmState.claimFixRound({ ...input, now: 7000 }), { claimed: false, reason: 'no-findings' });
  assert.deepStrictEqual(lgtmState.recordReview({ ...input, now: 8000, observation: observation({ reviewId: '2', lgtm: true, findings: [] }) }), { outcome: 'green', recorded: false });
});

test('batch rejection and fix-round claims are one serialized transition', () => {
  const rejecting = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...rejecting, now: 5000, observation: observation({ reviewId: '1' }) });
  const linkSync = fs.linkSync;
  let contender;
  fs.linkSync = (source, destination) => {
    if (destination.includes('.disposition-')) contender = lgtmState.claimFixRound({ ...rejecting, now: 6001, owner: 'worker-a' });
    linkSync(source, destination);
  };
  let rejected;
  try {
    rejected = lgtmState.rejectReviewBatch({ ...rejecting, now: 6000, reviewIds: ['1'], reason: 'Verifier reproduced no defect.' });
  } finally {
    fs.linkSync = linkSync;
  }
  assert.deepStrictEqual(rejected, { rejected: true, reviewIds: ['1'] });
  assert.deepStrictEqual(contender, { claimed: false, reason: 'transition-busy' });
  assert.deepStrictEqual(lgtmState.status(rejecting).fixBudget, { max: 3, spent: 0, remaining: 3 });

  const claimed = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.recordReview({ ...claimed, now: 7000, observation: observation({ reviewId: '2' }) });
  assert.strictEqual(lgtmState.claimFixRound({ ...claimed, now: 8000, owner: 'worker-b' }).claimed, true);
  assert.deepStrictEqual(lgtmState.rejectReviewBatch({ ...claimed, now: 9000, reviewIds: ['2'], reason: 'Verifier reproduced no defect.' }), {
    rejected: false,
    reason: 'fix-round-claimed',
    humanRequired: true,
    owner: 'worker-b',
  });
  assert.strictEqual(lgtmState.status(claimed).reconciliation.action, 'complete-claimed-fix-round');
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

test('a numeric reviewId is normalized while provider collection remains available', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const result = lgtmState.recordReview({ ...input, now: 5000, observation: observation({ reviewId: 5332811440, findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] }) });
  assert.deepStrictEqual(result, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
  const packet = lgtmState.status(input).reconciliation;
  assert.strictEqual(packet.reviews[0].id, '5332811440');
  assert.deepStrictEqual(lgtmState.claimInitialRequest({ ...input, now: 6000 }), { claimed: false, reason: 'auto-review-grace', eligibleAtMs: 126000 });
});

test('CLI record-review accepts a JSON number reviewId and keeps provider collection available', () => {
  const stateDir = temp();
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const obs = observation({ reviewId: 5332811440, findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  const out = JSON.parse(execFileSync('node', [CLI, 'record-review', String(PR_122), HEAD_A], { encoding: 'utf8', env, input: JSON.stringify(obs) }));
  assert.deepStrictEqual(out, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
  const claim = execFileSync('node', [CLI, 'claim-initial-request', String(PR_122), HEAD_A], { encoding: 'utf8', env });
  assert.strictEqual(JSON.parse(claim).reason, 'auto-review-grace');
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

test('a missing reviewer is rejected', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  const bad = observation();
  delete bad.reviewer;
  assert.throws(() => lgtmState.recordReview({ ...input, now: 5000, observation: bad }), /reviewer is required/);
});

test('recorded findings do not block bounded requests needed to complete the provider batch', () => {
  const input = { stateDir: temp(), pr: PR_122, headSha: HEAD_A };
  lgtmState.claimInitialRequest({ ...input, provider: 'copilot', now: 1000 });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'copilot', now: 121000 }), true);
  lgtmState.recordReview({ ...input, now: 5000, observation: observation({ findings: [inlineFinding()] }) });
  assert.strictEqual(lgtmState.claimInitialRequest({ ...input, provider: 'codex', now: 122000 }), true);
  assert.strictEqual(lgtmState.recoverInitialRequest({ ...input, provider: 'copilot', now: 121000 + lgtmState.INITIAL_CLAIM_LEASE_MS }), true);
  assert.deepStrictEqual(lgtmState.status(input).requestBudget, { max: 3, spent: 3, remaining: 0 });
});

test('a different head of the same PR is unaffected by another head being marked', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR_122, headSha: HEAD_A, now: 5000, observation: observation({ findings: [inlineFinding()] }) });
  lgtmState.claimInitialRequest({ stateDir, pr: PR_122, headSha: HEAD_B, now: 6000 });
  assert.strictEqual(lgtmState.claimInitialRequest({ stateDir, pr: PR_122, headSha: HEAD_B, now: 6000 + lgtmState.AUTO_REVIEW_GRACE_MS }), true);
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR_122, headSha: HEAD_B }).reconciliation, null);
});

test('an abbreviated head is rejected by a claim verb and by record-review', () => {
  const stateDir = temp();
  const shortHead = HEAD_A.slice(0, 7);
  assert.throws(() => lgtmState.claimInitialRequest({ stateDir, pr: PR_122, headSha: shortHead, now: 1000 }), /head SHA must be a full 40- or 64-character hexadecimal SHA \(the PR headRefOid\)/);
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
    reviews: [{ id: '5332811440', reviewer: obs.reviewer, url: obs.reviewUrl, findings: [{ url: obs.findings[0].url, priority: 'P1', signals: ['lifecycle'] }] }],
    batchCount: 1,
    p1Count: 1,
    p2Count: 0,
    signals: ['lifecycle'],
    classification: 'requires-architecture-review',
    action: 'verify-and-fix',
    humanRequired: false,
    requires: 'verify the batch and claim a fix round',
  });
});

test('CLI record-review reads the observation as JSON on stdin', () => {
  const stateDir = temp();
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const obs = observation({ findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  const out = JSON.parse(execFileSync('node', [CLI, 'record-review', String(PR_122), HEAD_A], { encoding: 'utf8', env, input: JSON.stringify(obs) }));
  assert.deepStrictEqual(out, { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
});

test('CLI claim-initial-request keeps a recorded head available for provider collection', () => {
  const stateDir = temp();
  const env = { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir };
  const obs = observation({ findings: [inlineFinding({ priority: 'P1', signals: ['lifecycle'] })] });
  execFileSync('node', [CLI, 'record-review', String(PR_122), HEAD_A], { encoding: 'utf8', env, input: JSON.stringify(obs) });
  const initial = execFileSync('node', [CLI, 'claim-initial-request', String(PR_122), HEAD_A], { encoding: 'utf8', env });
  assert.strictEqual(JSON.parse(initial).reason, 'auto-review-grace');
});

test('Claude, Codex, and Copilot review-until-lgtm skills pin the reconciliation extraction rules', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  const copilot = fs.readFileSync(COPILOT_SKILL, 'utf8');
  for (const skill of [claude, codex, copilot]) {
    assert.match(skill, /record-review <pr> <head-sha>/);
    assert.match(skill, /reviewId.*reviewer.*reviewUrl.*commitId.*state.*lgtm/);
    assert.match(skill, /headRefOid/);
    assert.match(skill, /P1/);
    assert.match(skill, /P2/);
    assert.match(skill, /needs-reconciliation/);
    assert.match(skill, /Record every review in the collection batch/);
    assert.match(skill, /unresolved finding.*takes precedence.*LGTM/i);
  }
});

test('Claude, Codex, and Copilot review-until-lgtm skills pin the no-review-object green rule', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  const copilot = fs.readFileSync(COPILOT_SKILL, 'utf8');
  for (const skill of [claude, codex, copilot]) {
    assert.match(skill, /positive reaction on the PR itself/i);
    assert.match(skill, /Codex's clean no-review-object path/);
    assert.match(skill, /no Codex review object for the full `headRefOid`/);
    assert.match(skill, /`status\.reconciliation === null`/);
    assert.match(skill, /`✅ Completed` summary row whose commit is a prefix of that head/);
    assert.match(skill, /chatgpt-codex-connector\[bot\].*\+1 reaction.*created at or after the row's completion time/);
    assert.match(skill, /stale reaction never counts/i);
  }
});

test('Claude, Codex, and Copilot review-until-lgtm skills pin bounded batch fixes', () => {
  const claude = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  const codex = fs.readFileSync(CODEX_SKILL, 'utf8');
  const copilot = fs.readFileSync(COPILOT_SKILL, 'utf8');
  for (const skill of [claude, codex, copilot]) {
    assert.match(skill, /Codex, Copilot, or another explicitly configured reviewer/);
    assert.match(skill, /Do not start fixing when the first review arrives/);
    assert.match(skill, /complete collected set.*one clean-context verifier/);
    assert.match(skill, /partition every accepted finding into exactly one explicit root-cause group/);
    assert.match(skill, /round-scoped transaction/);
    assert.match(skill, /independent certifier/);
    assert.match(skill, /three fix-and-push rounds are a PR-wide hard cap, not a quality guarantee/);
    assert.match(skill, /one commit and one push/);
    assert.match(skill, /`initialRequested` is true but `deadlineMs` is absent.*open-window/is);
    assert.match(skill, /APPROVED.*COMMENTED.*CHANGES_REQUESTED.*DISMISSED.*`completed`/is);
    assert.match(skill, /provider-id/);
    assert.doesNotMatch(skill, /renew-fix-round.*every 10 minutes.*before.*push/is);
    assert.match(skill, /one owner.*must not automatically transfer.*human reconciliation/is);
    assert.match(skill, /reject-review-batch.*every finding.*false positive/is);
    assert.match(skill, /record-delivery <pr> <head-sha>/);
    assert.match(skill, /follow-up tickets only within the recorded tracker authorization/);
    assert.match(skill, /Never request a second full review on the same head solely to obtain a missing reaction/);
    assert.match(skill, /identity.*ownership.*retry accounting.*ordering.*idempotency.*lease.*fence.*deadline.*TTL/is);
    assert.match(skill, /approved design.*uniquely determines.*one structural fix/is);
    assert.match(skill, /before editing.*human reconciliation/is);
  }
});

function claimRounds(stateDir, pr, count, first = 1) {
  const results = [];
  for (let index = first; index < first + count; index += 1) {
    const headSha = String(index).repeat(40);
    lgtmState.recordReview({ stateDir, pr, headSha, now: 1000 + index, observation: observation({ reviewId: String(index), commitId: headSha }) });
    results.push(lgtmState.claimFixRound({ stateDir, pr, headSha, now: 2000 + index, owner: `worker-${index}` }));
  }
  return results;
}

test('waive-fix-budget records the waiver and allows the waived rounds only', () => {
  const stateDir = temp();
  assert.ok(claimRounds(stateDir, 221, 3).every((result) => result.claimed));
  assert.strictEqual(claimRounds(stateDir, 221, 1, 4)[0].reason, 'fix-round-budget-exhausted');
  assert.deepStrictEqual(lgtmState.waiveFixBudget({ stateDir, pr: 221, person: 'someone', count: 2, now: 9000 }), { waived: true, waiver: { person: 'someone', count: 2, atMs: 9000 } });
  const headSha = '4'.repeat(40);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: 221, headSha }).waivers, [{ person: 'someone', count: 2, atMs: 9000 }]);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: 221, headSha }).fixBudget, { max: 5, spent: 3, remaining: 2 });
  const more = claimRounds(stateDir, 221, 3, 4);
  assert.deepStrictEqual(more.map((result) => result.claimed), [true, true, false]);
  assert.deepStrictEqual(more[1].budget, { max: 5, spent: 5, remaining: 0 });
  assert.strictEqual(more[2].reason, 'fix-round-budget-exhausted');
});

test('waive-fix-budget is idempotent and rejects invalid input without changing state', () => {
  const stateDir = temp();
  const input = { stateDir, pr: 221, person: 'someone', count: 2 };
  lgtmState.waiveFixBudget({ ...input, now: 1000 });
  lgtmState.waiveFixBudget({ ...input, now: 2000 });
  const headSha = '1'.repeat(40);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: 221, headSha }).waivers, [{ person: 'someone', count: 2, atMs: 1000 }]);
  for (const bad of [{ person: '' }, { person: '  ' }, { count: 0 }, { count: -1 }, { count: 1.5 }, { count: '2' }]) {
    assert.throws(() => lgtmState.waiveFixBudget({ ...input, ...bad }), /review-lgtm-state:/);
  }
  assert.strictEqual(lgtmState.status({ stateDir, pr: 221, headSha }).waivers.length, 1);
  assert.strictEqual(lgtmState.status({ stateDir, pr: 221, headSha }).fixBudget.max, 5);
});

test('waive-fix-budget CLI exits non-zero for an empty person', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  assert.throws(() => execFileSync('node', [CLI, 'waive-fix-budget', '221', '', '2'], { cwd: repo, stdio: 'pipe' }), /person/);
  const out = execFileSync('node', [CLI, 'waive-fix-budget', '221', 'someone', '2'], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(out).waived, true);
});

function git(repo, ...args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); }

test('self-feeding reports whether the previous fix commit added the finding lines', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-self-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  const lines = (n, prefix) => `${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n')}\n`;
  fs.writeFileSync(path.join(repo, 'rule.md'), lines(9, 'base'));
  git(repo, 'add', 'rule.md');
  git(repo, 'commit', '-qm', 'base');
  const reviewed = git(repo, 'rev-parse', 'HEAD');
  const added = Array.from({ length: 11 }, (_, i) => `fix${i + 1}`).join('\n');
  const body = lines(9, 'base').split('\n');
  body.splice(9, 0, added);
  fs.writeFileSync(path.join(repo, 'rule.md'), `${body.join('\n')}`);
  git(repo, 'commit', '-qam', 'fix');
  const head = git(repo, 'rev-parse', 'HEAD');
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: 221, headSha: reviewed, now: 1000, observation: observation({ reviewId: '1', commitId: reviewed }) });
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: 221, headSha: reviewed, now: 2000, owner: 'w' }).claimed, true);
  const check = (file, start, end) => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file, start, end });
  assert.deepStrictEqual(check('rule.md', 15, 15), { selfFeeding: true, previousFixHead: reviewed });
  assert.strictEqual(check('rule.md', 10, 20).selfFeeding, true);
  assert.strictEqual(check('rule.md', 5, 5).selfFeeding, false);
  assert.strictEqual(check('rule.md', 1, 9).selfFeeding, false);
  assert.throws(() => check('../outside.md', 1, 1), /file/);
  assert.throws(() => check('/etc/passwd', 1, 1), /file/);
  assert.throws(() => check('rule.md', 5, 3), /range/);
});

test('self-feeding is false when no earlier fix round exists', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-self-none-'));
  git(repo, 'init', '-q');
  assert.deepStrictEqual(lgtmState.selfFeeding({ repoRoot: repo, stateDir: temp(), pr: 221, headSha: 'a'.repeat(40), file: 'x.md', start: 1, end: 1 }), { selfFeeding: false, previousFixHead: null });
});

test('self-feeding uses the latest earlier round on the head ancestry and matches the file literally', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-self-anc-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
  const commit = (message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD'); };
  write('a.md', '1\n2\n3\n');
  write('b.md', '1\n2\n3\n');
  const first = commit('base');
  write('a.md', '1\n2\n3\nA4\n');
  const second = commit('fix one adds a.md line 4');
  write('b.md', '1\n2\n3\nB4\n');
  const third = commit('fix two adds b.md line 4');
  git(repo, 'checkout', '-q', '-b', 'side', first);
  write('a.md', 'side\n2\n3\n');
  const side = commit('unrelated head');
  git(repo, 'checkout', '-q', third);
  const stateDir = temp();
  const claim = (headSha, now) => {
    lgtmState.recordReview({ stateDir, pr: 221, headSha, now, observation: observation({ reviewId: String(now), commitId: headSha }) });
    assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: 221, headSha, now, owner: `w-${now}` }).claimed, true);
  };
  claim(second, 1000);
  claim(side, 2000);
  const check = (file, start, end) => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: third, file, start, end });
  assert.deepStrictEqual(check('b.md', 4, 4), { selfFeeding: true, previousFixHead: second });
  assert.strictEqual(check('a.md', 4, 4).selfFeeding, false);
  assert.throws(() => check(':(top)b.md', 4, 4), /no such path/);
  assert.throws(() => check('*.md', 4, 4), /no such path/);
  const cli = execFileSync('node', [CLI, 'self-feeding', '221', third, 'b.md', '4', '4'], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir } });
  assert.deepStrictEqual(JSON.parse(cli), { selfFeeding: true, previousFixHead: second });
});

function selfFeedingRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  return {
    repo,
    write: (file, text) => fs.writeFileSync(path.join(repo, file), text),
    commit: (message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD'); },
  };
}

function claimFixHead(stateDir, headSha, now) {
  lgtmState.recordReview({ stateDir, pr: 221, headSha, now, observation: observation({ reviewId: String(now), commitId: headSha }) });
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: 221, headSha, now, owner: `w-${now}` }).claimed, true);
}

test('self-feeding ignores unchanged content of a renamed file', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-rename-');
  for (const name of ['old', 'other1', 'other2', 'other3']) write(`${name}.md`, 'one\ntwo\nthree\nfour\n');
  const reviewed = commit('base');
  for (const name of ['old', 'other1', 'other2', 'other3']) git(repo, 'mv', `${name}.md`, `${name === 'old' ? 'new' : `${name}-moved`}.md`);
  git(repo, 'config', 'diff.renameLimit', '1');
  const head = commit('rename only');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  const check = (start, end) => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: 'new.md', start, end });
  assert.strictEqual(check(2, 3).selfFeeding, false);
});

test('self-feeding accepts a tracked path that begins with a dash', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-dash-');
  write('-notes.md', '1\n2\n');
  const reviewed = commit('base');
  write('-notes.md', '1\n2\n3\n');
  const head = commit('fix');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  assert.strictEqual(lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: '-notes.md', start: 3, end: 3 }).selfFeeding, true);
});

test('self-feeding reports only added lines whatever diff context the repository configures', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-hunk-');
  write('a.md', Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
  const reviewed = commit('base');
  git(repo, 'config', 'diff.interHunkContext', '20');
  write('a.md', Array.from({ length: 30 }, (_, i) => (i === 4 || i === 14 ? `changed${i + 1}` : `l${i + 1}`)).join('\n') + '\n');
  const head = commit('two distant edits');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  const check = (start, end) => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: 'a.md', start, end }).selfFeeding;
  assert.strictEqual(check(5, 5), true);
  assert.strictEqual(check(10, 10), false);
});

test('self-feeding picks the latest fix round by slot order, not by timestamp', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-slot-');
  write('a.md', '1\n');
  const first = commit('base');
  write('a.md', '1\n2\n');
  const second = commit('fix one');
  write('a.md', '1\n2\n3\n');
  const head = commit('fix two');
  const stateDir = temp();
  claimFixHead(stateDir, first, 5000);
  claimFixHead(stateDir, second, 5000);
  assert.deepStrictEqual(lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: 'a.md', start: 2, end: 2 }), { selfFeeding: false, previousFixHead: second });
});

test('self-feeding surfaces git failures instead of reporting not self-feeding', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-missing-');
  write('a.md', '1\n');
  const head = commit('base');
  const stateDir = temp();
  claimFixHead(stateDir, 'b'.repeat(40), 1000);
  assert.throws(() => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: 'a.md', start: 1, end: 1 }));
});

test('self-feeding does not depend on the configured diff path prefix', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-prefix-');
  write('a.md', '1\n2\n');
  const reviewed = commit('base');
  git(repo, 'config', 'diff.noprefix', 'true');
  write('a.md', '1\n2\n3\n');
  const head = commit('fix');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  assert.strictEqual(lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: 'a.md', start: 3, end: 3 }).selfFeeding, true);
});

test('self-feeding reads paths, attributes and added lines literally', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-literal-');
  write('q"x.md', '1\n2\n');
  write('bin.md', '1\n2\n');
  write('plus.md', '1\n2\n');
  write('.gitattributes', 'bin.md -diff\n');
  const reviewed = commit('base');
  write('q"x.md', '1\n2\n3\n');
  write('bin.md', '1\n2\n3\n');
  write('plus.md', '1\n2\n++ b/plus.md\n');
  const head = commit('fix');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  const check = (file, start) => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file, start, end: start }).selfFeeding;
  for (const file of ['q"x.md', 'bin.md', 'plus.md']) {
    assert.strictEqual(check(file, 3), true, file);
    assert.strictEqual(check(file, 2), false, file);
  }
});

test('self-feeding is unaffected by a large unrelated change in the fix round', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-large-');
  write('a.md', '1\n2\n');
  const reviewed = commit('base');
  write('big.txt', `${'x'.repeat(100)}\n`.repeat(30000));
  write('a.md', '1\n2\n3\n');
  const head = commit('fix with a 3 MB unrelated file');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  assert.strictEqual(lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file: 'a.md', start: 3, end: 3 }).selfFeeding, true);
});

test('self-feeding clamps a range ending past the file end and rejects one starting past it or a missing file', () => {
  const { repo, write, commit } = selfFeedingRepo('lgtm-self-eof-');
  write('a.md', '1\n2\n');
  const reviewed = commit('base');
  write('a.md', '1\n2\n3\n');
  const head = commit('fix');
  const stateDir = temp();
  claimFixHead(stateDir, reviewed, 1000);
  const check = (file, start, end) => lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: 221, headSha: head, file, start, end }).selfFeeding;
  assert.strictEqual(check('a.md', 3, 50), true);
  assert.strictEqual(check('a.md', 1, 50), true);
  assert.throws(() => check('a.md', 4, 4), /has only 3 lines/);
  assert.throws(() => check('gone.md', 1, 1), /no such path/);
});
