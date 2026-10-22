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

const answer = (id, file, span, reason = 'a guard precedes it') => ({ id, evidence: { file, span, reason } });
const addressedOf = (v) => v.map((r) => [r.id, r.status, r.reason, r.why]);

test('classifyPrior: a span-present finding the reviewer lists as addressed with evidence quoted once from the head is closed, and silence closes nothing (#395)', () => {
  const open = [held('answered', 'a.js', 'bad()'), held('silent', 'b.js', 'worse()')];
  const read = files({ 'a.js': Buffer.from('if (ok) {\n bad()\n}\n'), 'b.js': Buffer.from('worse()') });
  const v = lib.classifyPrior(open, [], same, read, 'h2', [answer('answered', 'a.js', 'if (ok) {')]);
  assert.deepEqual(addressedOf(v), [['answered', 'addressed', undefined, undefined], ['silent', 'open', 'span-present', undefined]]);
  assert.deepEqual(v[0].evidence, { file: 'a.js', span: 'if (ok) {', reason: 'a guard precedes it' });
  assert.equal(v[0].spanVerified, 'h2');
});

test('classifyPrior: a verdict for an id shared by several open findings closes none of them and is reported as ambiguous-id', () => {
  const open = [held('dup', 'a.js', 'bad()'), held('dup', 'b.js', 'worse()')];
  const read = files({ 'a.js': Buffer.from('if (ok) {\n bad()\n}\n'), 'b.js': Buffer.from('worse()') });
  const v = lib.classifyPrior(open, [], same, read, 'h2', [answer('dup', 'a.js', 'if (ok) {')]);
  assert.deepEqual(addressedOf(v), [['dup', 'open', 'span-present', 'ambiguous-id'], ['dup', 'open', 'span-present', 'ambiguous-id']]);
});

test('classifyPrior: an addressed verdict is refused unless it is raised by no one, offered, unique and backed by a quote that exists once and is not the span itself (#395)', () => {
  const read = files({ 'a.js': Buffer.from('x\nx\nbad()\nok()\n') });
  const run = (verdict, raised = []) => addressedOf(lib.classifyPrior([held('f', 'a.js', 'bad()')], raised, same, read, 'h2', verdict));
  assert.deepEqual(run([answer('f', 'a.js', 'ok()')], [finding('f', 'a.js', 'bad()')]), [['f', 'open', 'raised', 'raised']]);
  assert.deepEqual(run([answer('f', 'a.js', 'ok()'), answer('f', 'a.js', 'ok()')]), [['f', 'open', 'span-present', 'duplicate']]);
  assert.deepEqual(run([answer('f', 'a.js', 'x')]), [['f', 'open', 'span-present', 'evidence-ambiguous']]);
  assert.deepEqual(run([answer('f', 'a.js', 'nope')]), [['f', 'open', 'span-present', 'evidence-absent']]);
  assert.deepEqual(run([answer('f', 'gone.js', 'ok()')]), [['f', 'open', 'span-present', 'evidence-absent']]);
  assert.deepEqual(run([answer('f', 'a.js', ' bad()  ')]), [['f', 'open', 'span-present', 'evidence-is-span']]);
  assert.deepEqual(run([answer('f', 'a.js', 'ok()', ' ')]), [['f', 'open', 'span-present', 'no-reason']]);
  assert.deepEqual(run([answer('f', 'a.js', 'ok()', 'y'.repeat(501))]), [['f', 'open', 'span-present', 'no-reason']]);
});

test('classifyPrior: evidence that contains the finding span plus extra text is refused as evidence-is-span (#395)', () => {
  const read = files({ 'a.js': Buffer.from('if (ok) {\n bad()\n}\n') });
  const run = (span) => addressedOf(lib.classifyPrior([held('f', 'a.js', 'bad()')], [], same, read, 'h2', [answer('f', 'a.js', span)]));
  assert.deepEqual(run('if (ok) {\n bad()'), [['f', 'open', 'span-present', 'evidence-is-span']]);
  assert.deepEqual(run('if (ok) {'), [['f', 'addressed', undefined, undefined]]);
});

test('classifyPrior: evidence that is a substring of the finding span is refused as evidence-is-span', () => {
  const read = files({ 'a.js': Buffer.from('if (ok) {\n bad()\n}\n') });
  const run = (span) => addressedOf(lib.classifyPrior([held('f', 'a.js', 'bad()')], [], same, read, 'h2', [answer('f', 'a.js', span)]));
  assert.deepEqual(run('bad'), [['f', 'open', 'span-present', 'evidence-is-span']]);
  assert.deepEqual(run('if (ok) {'), [['f', 'addressed', undefined, undefined]]);
});

test('classifyPrior: an unverified, path-unresolved or gone-span finding is never closed by a verdict (#395)', () => {
  const read = files({ 'a.js': Buffer.from('ok()'), 'big.js': 'big' });
  const open = [{ ...held('u', 'a.js', 'bad()'), spanVerified: undefined }, held('p', 'big.js', 'bad()'), held('g', 'a.js', 'bad()')];
  const v = lib.classifyPrior(open, [], same, read, 'h2', [answer('u', 'a.js', 'ok()'), answer('p', 'a.js', 'ok()'), answer('g', 'a.js', 'ok()')]);
  assert.deepEqual(addressedOf(v), [['u', 'open', 'unverified', undefined], ['p', 'open', 'path-unresolved', undefined], ['g', 'fixed', undefined, undefined]]);
});

test('classifyPrior: an addressed finding is re-checked every round: it stays closed while both quotes stand, is fixed when the span goes, and reopens when the evidence goes or the span is raised again (#395)', () => {
  const closed = (id) => ({ ...held(id, 'a.js', 'bad()'), status: 'addressed', addressedEvidence: { file: 'a.js', span: 'ok()', reason: 'r' } });
  const both = Buffer.from('ok()\nbad()');
  assert.deepEqual(addressedOf(lib.classifyPrior([closed('c')], [], same, files({ 'a.js': both }), 'h3')), [['c', 'addressed', undefined, undefined]]);
  assert.deepEqual(addressedOf(lib.classifyPrior([closed('c')], [], same, files({ 'a.js': Buffer.from('ok()') }), 'h3')), [['c', 'fixed', undefined, undefined]]);
  assert.deepEqual(addressedOf(lib.classifyPrior([closed('c')], [], same, files({ 'a.js': Buffer.from('bad()') }), 'h3')), [['c', 'open', 'evidence-gone', undefined]]);
  assert.deepEqual(addressedOf(lib.classifyPrior([closed('c')], [finding('c', 'a.js', 'bad()')], same, files({ 'a.js': both }), 'h3')), [['c', 'open', 'raised', undefined]]);
  assert.deepEqual(addressedOf(lib.classifyPrior([closed('c')], [], same, files({ 'a.js': 'big' }), 'h3')), [['c', 'addressed', undefined, undefined]]);
});

test('classifyPrior: an addressed finding whose evidence file was renamed keeps its closure (#395)', () => {
  const closed = { ...held('c', 'a.js', 'bad()'), status: 'addressed', addressedEvidence: { file: 'a.js', span: 'ok()', reason: 'r' } };
  const resolve = () => ({ renames: new Map([['a.js', 'b.js']]), live: new Set(['b.js']) });
  assert.deepEqual(addressedOf(lib.classifyPrior([closed], [], resolve, files({ 'b.js': Buffer.from('ok()\nbad()') }), 'h3')), [['c', 'addressed', undefined, undefined]]);
});

test('evaluateApproval: an addressed finding no longer blocks (#395)', () => {
  const live = { head: 'h1', state: 'OPEN', isDraft: false, author: 'someone' };
  assert.deepEqual(lib.evaluateApproval(ledger({ findings: [{ ...finding('a', 'a.js', 'x'), status: 'addressed' }] }), live, 'h1'), { approve: true });
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
  assert.equal(no(ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'open' }] }), live).reason, 'open-blockers');
  // Only an explicit minor class lets an open finding through; a missing or any other class blocks.
  const open = (extra) => ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'open', ...extra }] });
  assert.deepEqual(no(open({ class: 'minor', reason: 'wording only' }), live), { approve: true });
  assert.equal(no(open({ class: 'blocker', reason: 'r' }), live).reason, 'open-blockers');
  assert.equal(no(open({ class: 'Minor' }), live).reason, 'open-blockers');
  assert.equal(no(open({ class: undefined }), live).reason, 'open-blockers');
  assert.equal(no(ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'open', class: 'minor' }, { ...finding('b', 'x', 't'), status: 'open' }] }), live).reason, 'open-blockers');
  assert.deepEqual(no(ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'waived' }, { ...finding('b', 'x', 't'), status: 'fixed' }] }), live), { approve: true });
});

const live = (extra = {}) => ({ head: 'h1', state: 'OPEN', isDraft: false, author: 'dev', ...extra });
// The default ledger waits on the author: it holds an open blocker. A clean, unapproved ledger is the draft case.
const waiting = (extra = {}) => ledger({ findings: [{ ...finding('w', 'x', 's'), status: 'open' }], ...extra });
const wake = (extra = {}) => lib.wakeDecision({ ledger: waiting(), live: live(), replies: [], now: Date.parse('2026-01-01T01:00:00Z'), stable: true, ...extra });

test('wakeDecision: push alone or reply alone does not start a round', () => {
  assert.equal(wake({ live: live({ head: 'h2' }) }), null);
  assert.equal(wake({ replies: ['2026-01-01T00:30:00Z'] }), null);
});

test('wakeDecision: push plus reply starts a round once the head is stable', () => {
  const args = { live: live({ head: 'h2' }), replies: ['2026-01-01T00:30:00Z'] };
  assert.deepEqual(wake(args), { event: 'round', head: 'h2' });
  assert.equal(wake({ ...args, stable: false }), null);
});

test('wakeDecision: after a failed round at h2, h2 with no newer reply waits; h3 or a newer reply wakes (#391)', () => {
  const attempt = { head: 'h2', at: '2026-01-01T00:40:00Z' };
  const old = ['2026-01-01T00:30:00Z'];
  const args = { ledger: ledger({ attempt }), live: live({ head: 'h2' }), replies: old };
  assert.equal(wake(args), null);
  assert.deepEqual(wake({ ...args, live: live({ head: 'h3' }) }), { event: 'round', head: 'h3' });
  assert.deepEqual(wake({ ...args, replies: [...old, '2026-01-01T00:50:00Z'] }), { event: 'round', head: 'h2' });
});

test('a first round that failed has no review to wait on: the watch wakes for a head newer than the attempt, never throws (#391)', () => {
  const first = ledger({ rounds: [], attempt: { head: 'h2', at: '2026-01-01T00:40:00Z' } });
  assert.deepEqual(lib.repliesSince(first, [], [], 'dev'), []);
  const call = (head, stable = true) => lib.wakeDecision({ ledger: first, live: live({ head }), replies: [], now: Date.parse('2026-01-01T01:00:00Z'), stable });
  assert.equal(call('h2'), null);
  assert.equal(call('h3', false), null);
  assert.deepEqual(call('h3'), { event: 'round', head: 'h3' });
});

test('wakeDecision: a clean round on a draft keeps the watch: ready at the same head wakes "ready", a new head starts a round, a draft stays quiet (#420)', () => {
  const args = { ledger: ledger() };
  assert.equal(wake({ ...args, live: live({ isDraft: true }) }), null);
  assert.deepEqual(wake({ ...args, live: live({ isDraft: false }) }), { event: 'ready', head: 'h1' });
  assert.deepEqual(wake({ ...args, live: live({ isDraft: true, head: 'h2' }) }), { event: 'round', head: 'h2' });
  assert.equal(wake({ ...args, live: live({ head: 'h2' }), stable: false }), null);
  // An open blocker, a head already approved or an unreviewed submodule is not waiting for ready.
  const blocked = ledger({ findings: [{ ...finding('a', 'x', 's'), status: 'open' }] });
  assert.equal(wake({ ledger: blocked }), null);
  assert.equal(wake({ ledger: ledger({ approval: { head: 'h1' } }) }), null);
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
  const nudged = waiting({ nudged: { kind: 'reply-only', head: 'h1', replyAt: '2026-01-01T00:30:00Z' } });
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

test('submoduleRepo accepts only GitHub repositories in the known forms and rejects anything else', () => {
  const ok = { 'https://github.com/o/lib': 'o/lib', 'https://github.com/o/lib.git/': 'o/lib', 'git@github.com:o/lib.git': 'o/lib', 'ssh://git@github.com/o/lib': 'o/lib', '../lib.git': 'p/lib', '../../q/lib': 'q/lib' };
  for (const [url, repo] of Object.entries(ok)) assert.equal(lib.submoduleRepo(url, 'p/r'), repo, url);
  for (const url of ['file:///x/o/lib.git', 'ext::sh -c id', '../../../../etc', 'https://github.com.evil.com/o/lib', 'https://github.com/o/../lib', 'https://github.com/o/..', 'https://u@github.com/o/lib', 'https://github.com/o/lib?x=1', 'https://github.com/o/%6Cib', '--upload-pack=id', '/abs/o/lib.git', 'git@github.com:o/lib\n', 'ssh://git@evil.com/o/lib', 'lib']) assert.equal(lib.submoduleRepo(url, 'p/r'), null, url);
});

test('an unreviewed submodule range keeps the round from approving its head and widens the next range', () => {
  const ledger = { reviewer: 'bot', findings: [], rounds: [{ head: 'h1', mergeBase: 'm', intent: 'i', unreviewed: [{ path: 'lib', reason: 'fetch' }] }] };
  assert.equal(lib.evaluateApproval(ledger, { head: 'h1', state: 'OPEN', isDraft: false, author: 'dev' }, 'h1').reason, 'unreviewed-submodule');
  assert.equal(lib.evaluateApproval({ ...ledger, rounds: [{ ...ledger.rounds[0], head: 'h0' }] }, { head: 'h1', state: 'OPEN', isDraft: false, author: 'dev' }, 'h1').approve, true);
  assert.deepEqual(lib.chooseRange(ledger.rounds[0], { head: 'h2', mergeBase: 'm', intent: 'i' }, () => true), { base: 'm', broad: false });
});

test('classOf: the gate verifier\'s blocking reason replaces the finder\'s non-blocking rationale; without one the rationale stands', () => {
  const overridden = lib.classOf({ class: 'blocker', releaseBlocking: [], rationale: 'wording only', blockingReason: 'it breaks callers' });
  assert.deepEqual([overridden.class, overridden.reason], ['blocker', 'it breaks callers']);
  assert.equal(lib.classOf({ class: 'minor', releaseBlocking: [], rationale: 'wording only', blockingReason: 'x' }).class, 'blocker');
  assert.equal(lib.classOf({ class: 'blocker', releaseBlocking: ['serious-bug'], rationale: 'breaks login' }).reason, 'breaks login');
});

test('baseMergeOnly: only merges of the base branch over an unchanged pull request diff skip a round', () => {
  const prior = round(1, 'h1', { unreviewed: [] });
  const merge = { sha: 'm', parents: [{ sha: 'h1', inBase: false }, { sha: 'b1', inBase: true }] };
  const facts = (extra = {}) => ({ prior, live: { head: 'm', intent: 'i0' }, ancestor: true, commits: [merge], before: 'f', after: 'f', replies: [], ...extra });
  assert.equal(lib.baseMergeOnly(facts()), true);
  assert.equal(lib.baseMergeOnly(facts({ commits: [{ ...merge, parents: [{ sha: 'b1', inBase: true }, { sha: 'h1', inBase: false }] }] })), true);
  const no = {
    'no prior round': { prior: null },
    'intent changed': { live: { head: 'm', intent: 'i1' } },
    'unreviewed range': { prior: round(1, 'h1', { unreviewed: [{ path: 'x' }] }) },
    'force push': { ancestor: false },
    'same head': { live: { head: 'h1', intent: 'i0' } },
    'author reply': { replies: ['2026-01-02T00:00:00Z'] },
    'no new commit of the pull request': { commits: [] },
    'plain commit': { commits: [{ sha: 'p', parents: [{ sha: 'h1', inBase: false }] }] },
    'octopus': { commits: [{ ...merge, parents: [...merge.parents, { sha: 'b2', inBase: true }] }] },
    'merge of another branch': { commits: [{ ...merge, parents: [{ sha: 'h1', inBase: false }, { sha: 'x', inBase: false }] }] },
    'merge that drops the last head': { commits: [{ ...merge, parents: [{ sha: 'z', inBase: false }, { sha: 'b1', inBase: true }] }] },
    'diff changed': { after: 'g' },
  };
  for (const [why, extra] of Object.entries(no)) assert.equal(lib.baseMergeOnly(facts(extra)), false, why);
});
