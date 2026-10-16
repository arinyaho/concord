'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../scripts/lib');

const round = (n, head, extra = {}) => ({ n, head, base: 'b0', mergeBase: 'm0', intent: 'i0', submittedAt: '2026-01-01T00:00:00Z', commentIds: [11, 12], ...extra });
const ledger = (extra = {}) => ({ reviewer: 'bot', rounds: [round(1, 'h1')], findings: [], ...extra });
const finding = (id, file, span, extra = {}) => ({ id, category: 'correctness', file, line: 3, span, summary: 's', ...extra });

test('chooseRange: a normal push reviews only what changed since the last head', () => {
  const live = { head: 'h2', mergeBase: 'm0', intent: 'i0' };
  assert.deepEqual(lib.chooseRange(round(1, 'h1'), live, () => true), { base: 'h1', broad: false });
});

test('chooseRange: a force push reviews the whole PR diff without the gate', () => {
  const live = { head: 'h2', mergeBase: 'm0', intent: 'i0' };
  assert.deepEqual(lib.chooseRange(round(1, 'h1'), live, () => false), { base: 'm0', broad: false });
});

test('chooseRange: a moved merge base (base branch merged in) cannot isolate the delta', () => {
  const live = { head: 'h2', mergeBase: 'm1', intent: 'i0' };
  assert.deepEqual(lib.chooseRange(round(1, 'h1'), live, () => true), { base: 'm1', broad: false });
});

test('chooseRange: a changed title or body runs the broad gate again', () => {
  const live = { head: 'h2', mergeBase: 'm0', intent: 'i1' };
  assert.deepEqual(lib.chooseRange(round(1, 'h1'), live, () => true), { base: 'm0', broad: true });
});

test('isPublished: matches by span despite a renamed id, by id+file when the span is empty', () => {
  const l = ledger({ findings: [{ ...finding('a:1', 'x.js', 'foo  bar'), status: 'open' }, { ...finding('b:2', 'y.js', ''), status: 'open' }] });
  assert.equal(lib.isPublished(l, finding('a:renamed', 'x.js', 'foo bar')), true);
  assert.equal(lib.isPublished(l, finding('b:2', 'y.js', '')), true);
  assert.equal(lib.isPublished(l, finding('b:2', 'z.js', '')), false);
  assert.equal(lib.isPublished(l, finding('c:3', 'x.js', 'other')), false);
});

test('isPublished: a reused id in the same file is the same finding, and a fixed finding that returns is not published', () => {
  const l = ledger({ findings: [{ ...finding('a:1', 'x.js', 'foo'), status: 'open' }, { ...finding('b:2', 'y.js', 'bar'), status: 'fixed' }, { ...finding('c:3', 'z.js', 'baz'), status: 'waived' }] });
  assert.equal(lib.isPublished(l, finding('a:1', 'x.js', 'different span')), true);
  assert.equal(lib.isPublished(l, finding('a:1', 'other.js', 'different span')), false);
  assert.equal(lib.isPublished(l, finding('b:2', 'y.js', 'bar')), false);
  assert.equal(lib.isPublished(l, finding('c:3', 'z.js', 'baz')), true);
});

test('classifyPrior: raised again or untouched with the span still present stays open, otherwise fixed', () => {
  const open = [
    { ...finding('raised', 'a.js', 'one'), status: 'open' },
    { ...finding('untouched', 'b.js', 'two'), status: 'open' },
    { ...finding('touched', 'c.js', 'three'), status: 'open' },
    { ...finding('gone', 'd.js', 'four'), status: 'open' },
  ];
  const raised = [finding('raised', 'a.js', 'one')];
  const changed = new Set(['a.js', 'c.js']);
  const spanAtHead = (file, span) => file === 'b.js' || file === 'c.js' ? true : false;
  assert.deepEqual(lib.classifyPrior(open, raised, changed, spanAtHead), { open: ['raised', 'untouched'], fixed: ['touched', 'gone'] });
});

test('evaluateApproval: approves only a reviewed, open, non-draft head with no open blocking finding', () => {
  const live = { head: 'h1', state: 'OPEN', isDraft: false, author: 'someone' };
  assert.deepEqual(lib.evaluateApproval(ledger(), live, 'h1'), { approve: true });
  const no = (l, v, head = 'h1') => lib.evaluateApproval(l, v, head);
  assert.equal(no(ledger(), { ...live, head: 'h2' }).reason, 'head-moved');
  assert.equal(no(ledger(), { ...live, state: 'MERGED' }).reason, 'not-open');
  assert.equal(no(ledger(), { ...live, isDraft: true }).reason, 'draft');
  assert.equal(no(ledger(), { ...live, author: 'bot' }).reason, 'self-review');
  assert.equal(no(ledger({ approval: { head: 'h1' } }), live).reason, 'already-approved');
  assert.equal(no(ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'open' }] }), live).reason, 'open-findings');
  assert.deepEqual(no(ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'waived' }, { ...finding('b', 'x', 't'), status: 'fixed' }] }), live), { approve: true });
});

const live = (extra = {}) => ({ head: 'h1', state: 'OPEN', isDraft: false, author: 'dev', ...extra });
const wake = (extra = {}) => lib.wakeDecision({ ledger: ledger(), live: live(), replies: [], now: Date.parse('2026-01-01T01:00:00Z'), stable: true, ...extra });

test('wakeDecision: push alone or reply alone does not start a round', () => {
  assert.equal(wake({ live: live({ head: 'h2' }) }), null);
  assert.equal(wake({ replies: ['2026-01-01T00:30:00Z'] }), null);
});

test('wakeDecision: push plus reply starts a round once the head is stable', () => {
  const args = { live: live({ head: 'h2' }), replies: ['2026-01-01T00:30:00Z'] };
  assert.deepEqual(wake(args), { event: 'round', head: 'h2' });
  assert.equal(wake({ ...args, stable: false }), null);
});

test('wakeDecision: merge and close wake the loop regardless of replies', () => {
  assert.deepEqual(wake({ live: live({ state: 'MERGED' }) }), { event: 'merged' });
  assert.deepEqual(wake({ live: live({ state: 'CLOSED' }) }), { event: 'closed' });
});

test('wakeDecision: one side alone nudges once after 24 hours, then the 7-day timeout ends the wait', () => {
  const day = 24 * 3600 * 1000;
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(wake({ live: live({ head: 'h2' }), now: t0 + day }), { event: 'nudge', kind: 'push-only', head: 'h2', replyAt: null });
  const replyOnly = { replies: ['2026-01-01T00:30:00Z'], now: t0 + day };
  assert.deepEqual(wake(replyOnly), { event: 'nudge', kind: 'reply-only', head: 'h1', replyAt: '2026-01-01T00:30:00Z' });
  const nudged = ledger({ nudged: { kind: 'reply-only', head: 'h1', replyAt: '2026-01-01T00:30:00Z' } });
  assert.equal(wake({ ...replyOnly, ledger: nudged }), null);
  assert.deepEqual(wake({ now: t0 + 7 * day }), { event: 'timeout' });
});

test('repliesSince: counts only the author, after the last review, in our threads or on the PR conversation', () => {
  const l = ledger();
  const pull = [
    { in_reply_to_id: 11, user: { login: 'dev' }, created_at: '2026-01-01T00:10:00Z' },
    { in_reply_to_id: 99, user: { login: 'dev' }, created_at: '2026-01-01T00:11:00Z' },
    { in_reply_to_id: 12, user: { login: 'other' }, created_at: '2026-01-01T00:12:00Z' },
    { in_reply_to_id: 12, user: { login: 'dev' }, created_at: '2025-12-31T00:00:00Z' },
  ];
  const issue = [{ user: { login: 'dev' }, created_at: '2026-01-01T00:20:00Z' }, { user: { login: 'other' }, created_at: '2026-01-01T00:21:00Z' }];
  assert.deepEqual(lib.repliesSince(l, pull, issue, 'dev'), ['2026-01-01T00:10:00Z', '2026-01-01T00:20:00Z']);
});

test('repliesSince: compares instants, not strings, and tolerates a comment without a user', () => {
  const l = ledger({ rounds: [round(1, 'h1', { submittedAt: '2026-01-01T00:00:00.500Z' })] });
  const issue = [{ user: { login: 'dev' }, created_at: '2026-01-01T00:00:01Z' }, { user: { login: 'dev' }, created_at: '2026-01-01T00:00:00Z' }, { user: null, created_at: '2026-01-01T00:00:02Z' }];
  assert.deepEqual(lib.repliesSince(l, [], issue, 'dev'), ['2026-01-01T00:00:01Z']);
});
