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

// An open ledger finding whose span was verified verbatim at head h1.
const held = (id, file, span, extra = {}) => { const f = finding(id, file, span, extra); return { ...f, key: lib.findingKey(f), status: 'open', spanVerified: 'h1', ...extra }; };
const files = (table) => (p) => p in table ? table[p] : null;
const same = () => ({ renames: new Map(), live: new Set() });
const verdictOf = (v) => v.map((r) => [r.id, r.status, r.reason]);

test('classifyPrior: a verified finding is fixed only when its span is gone from its path and from every file the push left in place', () => {
  const open = [held('here', 'a.js', 'one'), held('gone', 'b.js', 'two'), held('moved', 'c.js', 'three')];
  const read = files({ 'a.js': Buffer.from('one'), 'b.js': Buffer.from('other'), 'c.js': Buffer.from('x'), 'd.js': Buffer.from('three') });
  const v = lib.classifyPrior(open, [], () => ({ renames: new Map(), live: new Set(['d.js']) }), read, 'h2');
  assert.deepEqual(verdictOf(v), [['here', 'open', 'span-present'], ['gone', 'fixed', undefined], ['moved', 'open', 'span-present']]);
  assert.deepEqual([v[0].spanVerified, v[2].file], ['h2', 'd.js']);
});

test('classifyPrior: a finding whose span was never verified stays open whatever the code says', () => {
  const open = [{ ...held('a', 'a.js', 'one'), spanVerified: undefined }, held('empty', 'a.js', '', { span: '' })];
  const v = lib.classifyPrior(open, [], same, files({ 'a.js': Buffer.from('nothing') }), 'h2');
  assert.deepEqual(verdictOf(v), [['a', 'open', 'unverified'], ['empty', 'open', 'unverified']]);
});

test('classifyPrior: the reviewer re-raising a finding keeps it open, and its silence fixes nothing without the code changing', () => {
  const open = [held('raised', 'a.js', 'one'), held('silent', 'b.js', 'two')];
  const v = lib.classifyPrior(open, [finding('raised', 'a.js', 'one')], same, files({ 'a.js': Buffer.from('x'), 'b.js': Buffer.from('two') }), 'h2');
  assert.deepEqual(verdictOf(v), [['raised', 'open', 'raised'], ['silent', 'open', 'span-present']]);
});

test('classifyPrior: raised again with the same id and file but a different span stays open', () => {
  const open = [held('a', 'a.js', 'old span')];
  const v = lib.classifyPrior(open, [finding('a', 'a.js', 'new span')], same, files({ 'a.js': Buffer.from('new span') }), 'h2');
  assert.deepEqual(verdictOf(v), [['a', 'open', 'raised']]);
});

test('classifyPrior: no more than the twenty listed findings matters, every verified one is judged', () => {
  const open = Array.from({ length: 25 }, (_, i) => held(`c${i}`, 'a.js', `s${i}`));
  const v = lib.classifyPrior(open, [], same, files({ 'a.js': Buffer.from('rewritten') }), 'h2');
  assert.equal(v.filter((r) => r.status === 'fixed').length, 25);
});

test('classifyPrior: a delta that cannot be computed, or a path that is no regular file, keeps the finding open', () => {
  const open = [held('a', 'a.js', 'one'), held('b', 'b.js', 'two'), held('c', 'c.js', 'three')];
  const v = lib.classifyPrior(open, [], (p) => p.id === 'a' ? null : same(), files({ 'b.js': 'other', 'c.js': 'big' }), 'h2');
  assert.deepEqual(verdictOf(v), [['a', 'open', 'path-unresolved'], ['b', 'open', 'path-unresolved'], ['c', 'open', 'path-unresolved']]);
});

test('classifyPrior: a rename is followed, and a deleted file with the span nowhere is fixed', () => {
  const open = [held('r', 'a.js', 'one'), held('d', 'b.js', 'two')];
  const resolve = () => ({ renames: new Map([['a.js', 'a2.js']]), live: new Set(['a2.js']) });
  const v = lib.classifyPrior(open, [], resolve, files({ 'a2.js': Buffer.from('one') }), 'h2');
  assert.deepEqual(verdictOf(v), [['r', 'open', 'span-present'], ['d', 'fixed', undefined]]);
  assert.equal(v[0].file, 'a2.js');
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

test('parseNameStatus: renames and the paths still present; a deletion is not present', () => {
  const raw = ['R100', 'src/a.js', 'src/a2.js', 'R087', 'src/b.js', 'src/b2.js', 'M', 'src/c.js', 'D', 'src/d.js', 'A', 'src/e.js', ''].join('\0');
  const { renames, live } = lib.parseNameStatus(raw);
  assert.deepEqual([...renames], [['src/a.js', 'src/a2.js'], ['src/b.js', 'src/b2.js']]);
  assert.deepEqual([...live].sort(), ['src/a2.js', 'src/b2.js', 'src/c.js', 'src/e.js']);
});
