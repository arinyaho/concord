'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, threadComment } = require('./world');

const repo = (prs) => ({ 'acme/app': { prs } });

test('an unapproved PR of someone else produces no event, no write, and its reviews are not read', () => {
  const p = pr(1, { reviews: [review('monalisa', 'COMMENTED', 'head1', 5, { body: 'nit' })], issueComments: [comment('monalisa', 6)] });
  const r = world(repo([p])).run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  assert.ok(!r.calls.some((c) => c.some((x) => /pulls\/1\/|issues\/1\//.test(x))), JSON.stringify(r.calls));
});

test('review activity on the user\'s own unapproved PR is printed once per item, and a stranger\'s is ignored', () => {
  const thread = threadComment('monalisa', { html_url: 'https://github.com/acme/app/pull/1#discussion_r7' });
  const own = pr(1, {
    author: 'octocat',
    reviews: [review('monalisa', 'CHANGES_REQUESTED', 'head1', 5, { body: 'see threads', html_url: 'https://github.com/acme/app/pull/1#pullrequestreview-1' }), review('monalisa', 'COMMENTED', 'head1', 6), review('octocat', 'COMMENTED', 'head1', 7, { body: 'mine' })],
    comments: [thread, threadComment('octocat', { in_reply_to_id: thread.id })],
    threads: [{ resolved: false, root: thread.id }],
    issueComments: [comment('ci-bot[bot]', 8, { author_association: 'NONE', html_url: 'https://github.com/acme/app/pull/1#issuecomment-3' }), comment('stranger', 9, { author_association: 'NONE' })],
  });
  const assigned = pr(2, { assignees: ['octocat'], issueComments: [comment('monalisa', 9, { html_url: 'https://github.com/acme/app/pull/2#issuecomment-4' })] });
  const w = world(repo([own, assigned]));
  const r = w.run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, [
    'review acme/app#1 head head1: review changes requested by monalisa https://github.com/acme/app/pull/1#pullrequestreview-1',
    'review acme/app#1 head head1: thread comment by monalisa (unresolved) https://github.com/acme/app/pull/1#discussion_r7',
    'review acme/app#1 head head1: comment by ci-bot[bot] https://github.com/acme/app/pull/1#issuecomment-3',
    'review acme/app#2 head head2: comment by monalisa https://github.com/acme/app/pull/2#issuecomment-4',
  ]);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--mine', 'octocat', 'acme/app']).lines, []);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('monalisa', 20, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-5' })));
  assert.deepEqual(w.run(['--mine', 'octocat', 'acme/app']).lines, ['review acme/app#1 head head1: comment by monalisa https://github.com/acme/app/pull/1#issuecomment-5']);
});

test('a PR listed as OWNER/REPO#N is the user\'s own and is the only one read in that repository', () => {
  const w = world(repo([pr(1, { issueComments: [comment('monalisa', 5, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-1' })] }), pr(2, { reviews: [approve('monalisa', 'head2')] })]));
  const r = w.run(['acme/app#1']);
  assert.deepEqual(r.lines, ['review acme/app#1 head head1: comment by monalisa https://github.com/acme/app/pull/1#issuecomment-1']);
  assert.deepEqual(r.writes, []);
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
  assert.deepEqual(r.lines, ['merged acme/app#3 into main (squash) head head3']);
});

test('a failed API call is reported on stderr and the rest of the scan goes on', () => {
  const repos = { 'acme/app': { prs: [pr(1, { reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] })] }, 'acme/lib': { prs: [pr(3, { reviews: [approve('monalisa', 'head3')] })] } };
  const w = world(repos, { fail: ['pulls/1/reviews', 'name=lib'] });
  const r = w.run(['acme/app', 'acme/lib']);
  assert.deepEqual(r.lines, ['merged acme/app#2 into main (squash) head head2']);
  assert.match(r.stderr, /acme\/app#1: .*502/);
  assert.match(r.stderr, /acme\/lib: .*502/);
  assert.equal(r.code, 0);
});

test('a scan that fails does not end the run: the next scan after the interval merges', () => {
  const w = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { fail: [{ match: 'statusCheckRollup', times: 1 }] });
  const r = w.run(['--interval', '0.2', 'acme/app'], { deadline: '20' });
  assert.deepEqual(r.lines, ['merged acme/app#1 into main (squash) head head1']);
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

test('usage errors, including a --self that is not the gh account, exit with status 2', () => {
  const w = world(repo([]));
  for (const args of [['--interval', 'soon', 'acme/app'], ['nope'], ['--deadline', '-1', 'acme/app']]) assert.equal(w.run(args).code, 2, args.join(' '));
  const other = w.run(['acme/app'], { self: 'monalisa' });
  assert.equal(other.code, 2);
  assert.match(other.stderr, /not the account gh is logged in as/);
  assert.equal(other.calls.length, 1);
});
