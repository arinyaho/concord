'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, threadComment } = require('./world');

const repo = (prs) => ({ 'acme/app': { prs } });
const merged = (n) => `merged acme/app#${n} into main (squash) head head${n}; not passed: 0; unresolved threads: 0`;

test('an unapproved PR of someone else produces no event, no write, and its reviews are not read', () => {
  const p = pr(1, { reviews: [review('monalisa', 'COMMENTED', 'head1', 5, { body: 'nit' })], issueComments: [comment('monalisa', 6)] });
  const r = world(repo([p])).run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  assert.ok(!r.calls.some((c) => c.some((x) => /pulls\/1\/|issues\/1\//.test(x))), JSON.stringify(r.calls));
});

test('review activity on a PR the user authored is printed once per item, from counting accounts and bots, approved or not', () => {
  const thread = threadComment('monalisa', { html_url: 'https://github.com/acme/app/pull/1#discussion_r7' });
  const own = pr(1, {
    author: 'octocat',
    reviews: [review('monalisa', 'CHANGES_REQUESTED', 'head1', 5, { body: 'see threads', html_url: 'https://github.com/acme/app/pull/1#pullrequestreview-1' }), review('monalisa', 'COMMENTED', 'head1', 6), review('octocat', 'COMMENTED', 'head1', 7, { body: 'mine' })],
    comments: [thread, threadComment('octocat', { in_reply_to_id: thread.id })],
    threads: [{ resolved: false, root: thread.id }],
    issueComments: [comment('ci-bot[bot]', 8, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-3' }), comment('stranger', 9), comment('x', 9, { user: null })],
  });
  const approvedOwn = pr(2, { author: 'octocat', reviews: [approve('monalisa', 'older', 5)], issueComments: [comment('monalisa', 9, { html_url: 'https://github.com/acme/app/pull/2#issuecomment-4' })] });
  const assigned = pr(3, { assignees: ['octocat'], issueComments: [comment('monalisa', 9)] });
  const w = world(repo([own, approvedOwn, assigned]), { permissions: { stranger: 'read' } });
  const r = w.run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, [
    'review acme/app#1 head head1: review changes requested by monalisa https://github.com/acme/app/pull/1#pullrequestreview-1',
    'review acme/app#1 head head1: thread comment by monalisa https://github.com/acme/app/pull/1#discussion_r7',
    'review acme/app#1 head head1: comment by ci-bot[bot] https://github.com/acme/app/pull/1#issuecomment-3',
    `review acme/app#2 head head2: review approved by monalisa ${approvedOwn.reviews[0].html_url}`,
    'review acme/app#2 head head2: comment by monalisa https://github.com/acme/app/pull/2#issuecomment-4',
    'triage acme/app#2 head head2: approved on an older head only',
  ]);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--mine', 'octocat', 'acme/app']).lines, []);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('monalisa', 20, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-5' })));
  assert.deepEqual(w.run(['--mine', 'octocat', 'acme/app']).lines, ['review acme/app#1 head head1: comment by monalisa https://github.com/acme/app/pull/1#issuecomment-5']);
});

test('a PR listed as OWNER/REPO#N limits the run to it and does not make it the user\'s own', () => {
  const prs = [pr(1, { issueComments: [comment('monalisa', 5)] }), pr(2, { reviews: [approve('monalisa', 'head2')] }), pr(3, { reviews: [approve('monalisa', 'head3')] })];
  const r = world(repo(prs)).run(['acme/app#1', 'acme/app#2']);
  assert.deepEqual(r.lines, [merged(2)]);
  assert.equal(r.writes.length, 1);
});

test('a listed PR closed without merging is reported once; a merged one and a --mine one are not', () => {
  const w = world(repo([pr(1, { state: 'CLOSED' }), pr(2, { state: 'MERGED' })]));
  assert.deepEqual(w.run(['acme/app#1', 'acme/app#2']).lines, ['closed acme/app#1']);
  assert.deepEqual(w.run(['acme/app#1', 'acme/app#2']).lines, []);
  assert.deepEqual(world(repo([pr(1, { state: 'CLOSED', author: 'octocat' })])).run(['--mine', 'octocat', 'acme/app']).lines, []);
});

test('draft PRs are ignored, approved or not', () => {
  const r = world(repo([pr(1, { isDraft: true, reviews: [approve('monalisa', 'head1')] }), pr(2, { isDraft: true, author: 'octocat', issueComments: [comment('monalisa', 5)] })])).run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('open PRs on a later page are read', () => {
  const r = world(repo([pr(1), pr(2), pr(3, { reviews: [approve('monalisa', 'head3')] })])).run(['acme/app']);
  assert.deepEqual(r.lines, [merged(3)]);
});

test('a failed API call is reported on stderr and the rest of the scan goes on', () => {
  const repos = { 'acme/app': { prs: [pr(1, { reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] })] }, 'acme/lib': { prs: [pr(3, { reviews: [approve('monalisa', 'head3')] })] } };
  const w = world(repos, { fail: ['pulls/1/reviews', 'name=lib'] });
  const r = w.run(['acme/app', 'acme/lib']);
  assert.deepEqual(r.lines, [merged(2)]);
  assert.match(r.stderr, /acme\/app#1: failed \(HTTP 502\)/);
  assert.match(r.stderr, /acme\/lib: failed \(HTTP 502\)/);
  assert.equal(r.code, 0);
});

test('a scan that fails does not end the run: the next scan after the interval merges', () => {
  const w = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { fail: [{ match: 'statusCheckRollup', times: 1 }] });
  const r = w.run(['--interval', '0.2', 'acme/app'], { deadline: '20' });
  assert.deepEqual(r.lines, [merged(1)]);
  assert.match(r.stderr, /502/);
});

test('with nothing to report the script exits at the deadline and prints nothing', () => {
  const started = Date.now();
  const r = world(repo([pr(1)])).run(['--interval', '0.1', 'acme/app'], { deadline: '0.5' });
  assert.deepEqual(r.lines, []);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - started >= 500);
});

test('deleting the state file repeats the notices and nothing else; the file is replaced, never left half written', () => {
  const p = [pr(1, { reviews: [approve('monalisa', 'older')] }), pr(2, { author: 'octocat', issueComments: [comment('monalisa', 5)] }), pr(3, { reviews: [approve('monalisa', 'head3')] })];
  const w = world(repo(p));
  const first = w.run(['--no-merge', '--mine', 'octocat', 'acme/app']);
  assert.deepEqual(fs.readdirSync(w.stateDir), ['state.json']);
  assert.deepEqual(w.run(['--no-merge', '--mine', 'octocat', 'acme/app']).lines, []);
  fs.rmSync(w.state);
  const again = w.run(['--no-merge', '--mine', 'octocat', 'acme/app']);
  assert.deepEqual(again.lines, first.lines);
  assert.equal(first.lines.length, 3);
  assert.deepEqual(again.writes, []);
});

test('usage errors exit with status 2: a bad option, a missing --state, a --self that is not the gh account', () => {
  const w = world(repo([]));
  for (const args of [['--interval', 'soon', 'acme/app'], ['nope'], ['--deadline', '-1', 'acme/app']]) assert.equal(w.run(args).code, 2, args.join(' '));
  const noState = w.run(['acme/app'], { noState: true });
  assert.equal(noState.code, 2);
  assert.match(noState.stderr, /--state is required/);
  const other = w.run(['acme/app'], { self: 'monalisa' });
  assert.equal(other.code, 2);
  assert.match(other.stderr, /not the account gh is logged in as/);
  assert.equal(other.calls.length, 1);
  const unread = world(repo([]), { fail: ['^api user$'] }).run(['acme/app']);
  assert.equal(unread.code, 1, 'a failed read of the account is not a usage error');
  assert.equal(unread.stderr, 'pr-to-merge: cannot read the account gh is logged in as (HTTP 502)\n');
});
