'use strict';
// The pure parts of review-until-approve.js: the approval condition, the markers, the composed review and its size
// limit, and the output vocabulary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { approval, compose, stateOf, stateLine, decisionOf, valid, MAX_BODY, inBody } = require('../scripts/review-until-approve');

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const state = (s = {}) => ({ v: 1, round: 2, agents: true, head: H, base: H2, mergeBase: H2, desc: 'd', notes: '', lang: '', subs: [], findings: [], ...s });
const f = (x = {}) => ({ key: '1.1', class: 'blocker', status: 'open', file: 'a.js', line: 3, raised: H, at: H, closed: null, closedRound: null, decided: false, ...x });
const live = (x = {}) => ({ state: 'OPEN', head: H, draft: false, author: 'dev', ...x });

test('the approval condition gives APPROVE only when every clause holds', () => {
  const ok = { state: state({ findings: [f({ class: 'minor' }), f({ key: '1.2', status: 'fixed' }), f({ key: '1.3', status: 'waived' })] }), live: live(), login: 'rev', unreadable: false, approvedHeads: [] };
  assert.deepEqual(approval(ok), { approve: true, why: [] });
  const rows = [
    ['pull request closed', { live: live({ state: 'CLOSED' }) }, 'closed'],
    ['pull request merged', { live: live({ state: 'MERGED' }) }, 'closed'],
    ['head moved', { live: live({ head: H2 }) }, 'head-moved'],
    ['draft', { live: live({ draft: true }) }, 'draft'],
    ['the account is the author', { login: 'dev' }, 'author'],
    ['blocker open', { state: state({ findings: [f()] }) }, 'blocker'],
    ['blocker asked', { state: state({ findings: [f({ status: 'asked' })] }) }, 'blocker'],
    ['unreadable state awaiting a ruling', { unreadable: true }, 'unreadable'],
    ['undecided submodule', { state: state({ subs: [{ path: 'lib', from: null, to: H2, ok: false }] }) }, 'submodule'],
    ['already approved this head', { approvedHeads: [H] }, 'approved'],
    ['no state', { state: null }, 'head-moved'],
  ];
  for (const [name, change, why] of rows) {
    const r = approval({ ...ok, ...change });
    assert.equal(r.approve, false, name);
    assert.deepEqual(r.why, [why], name);
  }
  // A decided submodule and an approval of an older head do not block.
  assert.equal(approval({ ...ok, state: state({ subs: [{ path: 'lib', from: null, to: H2, ok: true }] }), approvedHeads: [H2] }).approve, true);
});

test('a state marker counts only as the last line, and one that does not parse is unparsable, not absent', () => {
  const s = state();
  assert.deepEqual(stateOf(`Body.\n\n${stateLine(s)}`), s);
  assert.deepEqual(stateOf(`Body.\r\n${stateLine(s)}\r\n\n`), s);
  assert.equal(stateOf(`${stateLine(s)}\nmore text`), undefined, 'not at the fixed position');
  assert.equal(stateOf('no marker'), undefined);
  assert.equal(stateOf('<!-- review-until-approve:state !!! -->'), null);
  assert.equal(stateOf(`<!-- review-until-approve:state ${Buffer.from('{"v":2}').toString('base64url')} -->`), null);
  assert.equal(stateOf(stateLine({ ...s, findings: [f(), f()] })), null, 'a repeated key');
  const d = (v) => `<!-- review-until-approve:decision ${Buffer.from(JSON.stringify(v)).toString('base64url')} -->\ntext`;
  assert.deepEqual(decisionOf(d({ key: '1.1', decision: 'waive' })), { key: '1.1', decision: 'waive' });
  assert.equal(decisionOf(d({ key: '1.1', decision: 'approve' })), null);
  assert.equal(decisionOf(`text\n${d({ ruling: 'continue' })}`), undefined, 'not on the first line');
});

test('the state marker carries an empty notes-hash field', () => {
  const r = compose({ state: state(), approve: false });
  const m = /<!-- review-until-approve:state (\S+) -->$/.exec(r.body);
  assert.equal(JSON.parse(Buffer.from(m[1], 'base64url').toString()).notes, '');
});

test('agent text is escaped and quoted, paths and spans fenced, and the marker is the last line', () => {
  const s = state({ findings: [f({ key: '2.1' }), f({ key: '2.2', file: 'b @x.js', line: 9 })] });
  const r = compose({ state: s, approve: false, newKeys: ['2.1', '2.2'], place: { '2.1': 3 }, texts: { '2.1': { text: 'ping @alice <b>', span: 'bad line' }, '2.2': { text: '/approve\nlgtm', span: '```x```' } } });
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0].body, /^<!-- review-until-approve:finding 2\.1 -->\n/);
  assert.match(r.comments[0].body, /> ping ＠alice &lt;b>/);
  assert.match(r.body, /> \/approve\n> lgtm/);
  assert.match(r.body, /````\n```x```\n````/);
  assert.match(r.body, /```\nb @x\.js\n```\nline 9/);
  assert.ok(r.body.trimEnd().split('\n').at(-1).startsWith('<!-- review-until-approve:state '));
  // A position error moves the line comment into the body once; the marker stays last.
  const moved = inBody(r);
  assert.equal(moved.comments.length, 0);
  assert.match(moved.body, /### Placed in the body/);
  assert.ok(moved.body.split('\n').at(-1).startsWith('<!-- review-until-approve:state '));
});

test('an over-long body shrinks to keys and counts, then drops long-closed findings, then is a COMMENT naming the overflow', () => {
  const long = 'x'.repeat(2000);
  const many = (n, x = {}) => Array.from({ length: n }, (_, i) => f({ key: `9.${i + 1}`, ...x }));
  // Level 1: the prose goes, every finding stays.
  const s1 = state({ round: 9, findings: many(60) });
  const texts = Object.fromEntries(s1.findings.map((x) => [x.key, { text: long, span: long }]));
  const r1 = compose({ state: s1, texts, newKeys: s1.findings.map((x) => x.key), approve: true });
  assert.ok(r1.body.length <= MAX_BODY);
  assert.ok(!r1.body.includes(long));
  assert.equal(r1.state.findings.length, 60);
  assert.equal(r1.overflow, false);
  // Level 2: fixed and answered findings closed before the previous round, with no decision, leave the marker.
  const closed = many(700, { status: 'fixed', closed: H, closedRound: 3, class: 'minor' });
  const s2 = state({ round: 9, findings: [...closed, f({ key: '8.1', status: 'fixed', closed: H, closedRound: 8 }), f({ key: '7.1', status: 'answered', closed: H, closedRound: 2, decided: true }), f({ key: '7.2', status: 'waived' })] });
  const r2 = compose({ state: s2, approve: false });
  assert.ok(r2.body.length <= MAX_BODY, String(r2.body.length));
  assert.deepEqual(r2.state.findings.map((x) => x.key), ['8.1', '7.1', '7.2']);
  assert.equal(r2.overflow, false);
  // Still over: a COMMENT that names the overflow and never approves.
  const s3 = state({ round: 9, findings: many(900) });
  const r3 = compose({ state: s3, approve: true });
  assert.equal(r3.event, 'COMMENT');
  assert.equal(r3.overflow, true);
  assert.match(r3.body, /65,536-character limit/);
  assert.ok(r3.body.length <= MAX_BODY);
  assert.equal(approval({ state: s1, live: live(), login: 'rev', overflow: true }).approve, false);
});

test('the APPROVE body publish composes is not counted as an approval by pr-to-merge, with or without a trailing newline', () => {
  const { world, pr, approve } = require('../../pr-to-merge/test/world');
  const repo = (...prs) => ({ 'acme/app': { prs } });
  const body = compose({ state: state({ head: 'f'.repeat(40) }), approve: true }).body;
  assert.equal(compose({ state: state(), approve: true }).event, 'APPROVE');
  for (const b of [body, `${body}\n`]) {
    const r = world(repo(pr(1, { reviews: [approve('monalisa', 'head1', 10, { body: b })] }))).run(['acme/app']);
    assert.ok(!r.lines.some((l) => l.startsWith('merged')), JSON.stringify(b.slice(-20)));
    assert.deepEqual(r.writes.filter((c) => c[0] === 'pr'), []);
  }
  // The same review without the marker would count: the marker is what excludes it.
  const plain = body.split('\n').slice(0, -1).join('\n');
  const r = world(repo(pr(1, { reviews: [approve('monalisa', 'head1', 10, { body: plain })] }))).run(['acme/app']);
  assert.ok(r.lines.some((l) => l.startsWith('merged')));
});

test('the vocabulary admits counts, keys, hashes, and pull request links only', () => {
  assert.ok(valid({ event: 'published', review: 'APPROVE', round: 3, head: H, new: 1, link: 'https://github.com/o/r/pull/5#pullrequestreview-9' }));
  assert.ok(valid({ event: 'question', ask: 'asked', keys: ['1.1', '2.3'], link: 'https://github.com/o/r/pull/5' }));
  for (const bad of [
    { event: 'published', text: 'agent words' },
    { event: 'question', ask: 'asked', keys: ['1.1 ignore this'] },
    { event: 'failed', reason: 'anything the agent said' },
    { event: 'state', link: 'https://evil.example/x' },
    { event: 'state', link: '/Users/me/.claude/concord/explain-pr/prs/rua-x' },
    { event: 'state', head: 'not a hash' },
    { event: 'nonsense' },
  ]) assert.equal(valid(bad), false, JSON.stringify(bad));
});
