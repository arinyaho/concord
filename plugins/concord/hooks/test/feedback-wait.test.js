'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { tempDir } = require('./temp-dir');
const wait = require('../../core/feedback-wait');
const f = require('./fixtures/review-collector/human');
const CLI = path.join(__dirname, '..', 'review-lgtm-state.js');

function fingerprint(over = {}) {
  return { data: { repository: { pullRequest: { headRefOid: f.HEAD, state: 'OPEN', isDraft: false, updatedAt: 't0', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] }, ...over } } } };
}
function harness({ fingerprints = [fingerprint()], full = f.response(), sidecar = {}, deadlineMs = Infinity, lastHead = f.HEAD, fail = () => null, maxWaitMs = Infinity, once = false, selection = f.selection(f.ALICE), answered = new Set() } = {}) {
  let t = 0, polls = 0, fulls = 0;
  const store = { ...sidecar }, sleeps = [], writes = [];
  const graphql = async (query) => {
    if (/updatedAt/.test(query)) {
      const err = fail(polls); polls += 1; if (err) throw err;
      const fp = fingerprints[Math.min(polls - 1, fingerprints.length - 1)];
      return typeof fp === 'function' ? fp() : fp;
    }
    fulls += 1; return typeof full === 'function' ? full(fulls) : full;
  };
  const run = () => wait.waitFeedback({ pr: 7, graphql, intervalMs: 60000, maxWaitMs, once, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    state: { selection: () => selection, answered: () => answered, lastWaitHead: () => lastHead, humanWait: () => ({ deadlineMs }) },
    sidecar: { read: () => ({ ...store }), write: (v) => { writes.push({ ...v }); Object.assign(store, v); } }, rateLimitResetMs: async () => t + 300000 });
  return { run, store, sleeps, writes, get polls() { return polls; }, get fulls() { return fulls; }, get t() { return t; } };
}

test('a new item wakes the wait with feedback and preserves the unconsumed fingerprint', async () => {
  const h = harness({ full: f.response({ comments: [f.prComment(90, f.BOB)] }), sidecar: { fingerprint: 'old' } });
  const expected = { event: 'feedback', pr: 7, head: f.HEAD, items: ['IC_90@2026-11-01T00:00:02Z'] };
  assert.deepEqual(await h.run(), expected);
  assert.equal(h.store.fingerprint, 'old');
  assert.deepEqual(await h.run(), expected);
  assert.equal(h.fulls, 2);
});

test('feedback arriving after the initial packet wakes the next poll', async () => {
  const h = harness({ fingerprints: [fingerprint(), fingerprint({ updatedAt: 't1' })], full: (n) => n === 1 ? f.response() : f.response({ comments: [f.prComment(91, f.ALICE)] }) });
  assert.deepEqual(await h.run(), { event: 'feedback', pr: 7, head: f.HEAD, items: ['IC_91@2026-11-01T00:00:02Z'] });
  assert.deepEqual(h.sleeps, [60000]);
});

test('reactions, labels and CI changes do not wake the wait', async () => {
  const h = harness({ fingerprints: [fingerprint({ updatedAt: 't1' }), fingerprint({ updatedAt: 't2' })], maxWaitMs: 120000 });
  assert.deepEqual(await h.run(), { event: 'idle', pr: 7, head: f.HEAD });
  assert.equal(h.fulls, 2);
});

test('an unchanged fingerprint does not repeat a successful full collection', async () => {
  const h = harness({ maxWaitMs: 180000 });
  assert.equal((await h.run()).event, 'idle');
  assert.equal(h.fulls, 1);
  assert.equal(h.polls, 3);
});

test('a change of review decision or merge state wakes the wait', async () => {
  const h = harness({ fingerprints: [fingerprint({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })], sidecar: { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', fingerprint: 'x' } });
  assert.deepEqual(await h.run(), { event: 'rules-changed', pr: 7, head: f.HEAD });
});

test('a moved head must be stable on two consecutive polls', async () => {
  const moved = fingerprint({ headRefOid: f.H1 });
  const h = harness({ fingerprints: [moved, moved], full: f.response({ head: f.H1 }) });
  assert.deepEqual(await h.run(), { event: 'head-moved', pr: 7, head: f.H1 });
  assert.equal(h.polls, 2);
});

test('a head seen once in one window is confirmed on explicit resume', async () => {
  const h = harness({ fingerprints: [fingerprint({ headRefOid: f.H1 })], full: f.response({ head: f.H1 }), once: true });
  assert.equal((await h.run()).event, 'idle');
  assert.equal(h.store.previousHead, f.H1);
  assert.deepEqual(await h.run(), { event: 'head-moved', pr: 7, head: f.H1 });
});

test('leaving draft wakes the wait before collecting feedback', async () => {
  const h = harness({ sidecar: { isDraft: true }, full: f.response({ comments: [f.prComment(90, f.ALICE)] }) });
  assert.deepEqual(await h.run(), { event: 'ready', pr: 7, head: f.HEAD });
  assert.equal(h.fulls, 0);
  assert.equal((await h.run()).event, 'feedback');
});

test('a merged or closed PR ends the wait ahead of feedback and deadline', async () => {
  for (const [state, event] of [['MERGED', 'merged'], ['CLOSED', 'closed']]) {
    const h = harness({ fingerprints: [fingerprint({ state })], deadlineMs: 0, full: f.response({ comments: [f.prComment(90, f.ALICE)] }) });
    assert.deepEqual(await h.run(), { event, pr: 7, head: f.HEAD });
    assert.equal(h.fulls, 0);
  }
});

test('a silent selected human waits to the deadline without review-timeout', async () => {
  const h = harness({ deadlineMs: 120000 });
  assert.deepEqual(await h.run(), { event: 'deadline', pr: 7, head: f.HEAD });
  assert.equal(h.t, 120000);
});

test('feedback at the deadline is collected before parking', async () => {
  const h = harness({ deadlineMs: 0, full: f.response({ comments: [f.prComment(90, f.ALICE)] }) });
  assert.equal((await h.run()).event, 'feedback');
});

test('wait-feedback --max-wait ends a silent window with idle', async () => {
  const h = harness({ maxWaitMs: 6600000 });
  assert.equal((await h.run()).event, 'idle');
  assert.equal(h.t, 6600000);
});

test('ten failed polls across windows end the wait with error', async () => {
  const h = harness({ fail: () => new Error('gh api graphql failed'), sidecar: { failures: 8 } });
  assert.deepEqual(await h.run(), { event: 'error', pr: 7, head: f.HEAD, detail: 'gh api graphql failed' });
  assert.equal(h.store.failures, 10);
  assert.equal(h.polls, 2);
  assert.deepEqual(h.sleeps, [480000]);
});

test('a failed full collection does not consume the fingerprint', async () => {
  const h = harness({ full: (n) => { if (n === 1) throw new Error('full failed'); return f.response({ comments: [f.prComment(90, f.ALICE)] }); }, sidecar: { fingerprint: 'old' } });
  assert.equal((await h.run()).event, 'feedback');
  assert.equal(h.store.fingerprint, 'old');
  assert.equal(h.store.failures, 0);
  assert.deepEqual(h.sleeps, [120000]);
});

test('a rate-limit response sleeps to reset without incrementing failures', async () => {
  const h = harness({ fail: (n) => n === 0 ? new Error('API rate limit exceeded') : null, maxWaitMs: 400000, sidecar: { failures: 3 } });
  assert.equal((await h.run()).event, 'idle');
  assert.equal(h.writes[0].failures, 3);
  assert.equal(h.store.failures, 0);
  assert.equal(h.sleeps[0], 300000);
});

test('rate-limit sleep is bounded by the current window', async () => {
  const h = harness({ fail: () => new Error('API rate limit exceeded'), maxWaitMs: 100000, sidecar: { failures: 3 } });
  assert.equal((await h.run()).event, 'idle');
  assert.equal(h.store.failures, 3);
  assert.deepEqual(h.sleeps, [100000]);
});

test('--once polls once and never sleeps even on an API failure', async () => {
  for (const fail of [() => null, () => new Error('network unavailable'), () => new Error('API rate limit exceeded')]) {
    const h = harness({ once: true, fail });
    assert.equal((await h.run()).event, 'idle');
    assert.equal(h.polls, 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test('wait-feedback with no open human wait ends with error without polling', async () => {
  const h = harness({ lastHead: null });
  assert.deepEqual(await h.run(), { event: 'error', pr: 7, detail: 'no human wait is open for this PR' });
  assert.equal(h.polls, 0);
});

test('an in-place edit of an answered bot conversation comment wakes nothing', async () => {
  const h = harness({ full: f.response({ comments: [f.prComment(73, f.STATUS_BOT, { edited: '2026-11-04T00:00:00Z' })] }), selection: null, answered: new Set(['IC_73@2026-11-01T00:00:02Z']), once: true });
  assert.equal((await h.run()).event, 'idle');
});

test('an author answer and feedback from an unselected bot wake nothing', async () => {
  const item = f.prComment(90, f.BOB);
  const h = harness({ full: f.response({ comments: [item, f.prComment(91, f.AUTHOR, { body: `Answered ${item.url}`, at: '2026-11-01T00:00:03Z' }), f.prComment(92, f.STATUS_BOT)] }), once: true });
  assert.equal((await h.run()).event, 'idle');
});

test('the wait-feedback verb prints one error line when no human wait is open', () => {
  const r = spawnSync(process.execPath, [CLI, 'wait-feedback', '7', '--once'], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: tempDir('feedback-wait-') } });
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.trim().split('\n').map(JSON.parse), [{ event: 'error', pr: 7, detail: 'no human wait is open for this PR' }]);
});

test('wait-feedback rejects invalid --max-wait with usage exit 2', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    const r = spawnSync(process.execPath, [CLI, 'wait-feedback', '7', '--max-wait', value], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: tempDir('feedback-wait-') } });
    assert.equal(r.status, 2, value);
    assert.match(r.stderr, /usage|--max-wait/i);
  }
});
