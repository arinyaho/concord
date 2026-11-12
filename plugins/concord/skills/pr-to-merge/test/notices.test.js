'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment } = require('./world');

const repo = (prs) => ({ 'acme/app': { prs } });

test('an unapproved PR of someone else produces no event, no write, and its reviews are not read', () => {
  const p = pr(1, { reviews: [review('monalisa', 'COMMENTED', 'head1', 5, { body: 'nit' })], issueComments: [comment('monalisa', 6)] });
  const r = world(repo([p])).run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  assert.ok(!r.calls.some((c) => c.some((x) => /pulls\/1\/|issues\/1\//.test(x))), JSON.stringify(r.calls));
});

test('review activity on the user\'s own unapproved PR is printed once per item', () => {
  const own = pr(1, {
    author: 'octocat',
    reviews: [review('monalisa', 'CHANGES_REQUESTED', 'head1', 5, { body: 'see threads', html_url: 'u1' }), review('monalisa', 'COMMENTED', 'head1', 6), review('octocat', 'COMMENTED', 'head1', 7, { body: 'mine' })],
    comments: [{ id: 7, user: { login: 'monalisa' }, path: 'src/a.js', line: 12, html_url: 'u2' }, { id: 8, in_reply_to_id: 7, user: { login: 'octocat' }, path: 'src/a.js', line: 12 }],
    threads: [{ resolved: false, path: 'src/a.js', line: 12, root: 7 }],
    issueComments: [comment('ci-bot[bot]', 8, { html_url: 'u3' })],
  });
  const assigned = pr(2, { assignees: ['octocat'], issueComments: [comment('monalisa', 9, { html_url: 'u4' })] });
  const w = world(repo([own, assigned]));
  const r = w.run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, [
    'review acme/app#1 head head1: review changes requested by monalisa u1',
    'review acme/app#1 head head1: thread comment by monalisa on src/a.js:12 (unresolved) u2',
    'review acme/app#1 head head1: comment by ci-bot[bot] u3',
    'review acme/app#2 head head2: comment by monalisa u4',
  ]);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--mine', 'octocat', 'acme/app']).lines, []);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('monalisa', 20, { html_url: 'u5' })));
  assert.deepEqual(w.run(['--mine', 'octocat', 'acme/app']).lines, ['review acme/app#1 head head1: comment by monalisa u5']);
});

test('a PR listed as OWNER/REPO#N is the user\'s own and is the only one read in that repository', () => {
  const w = world(repo([pr(1, { issueComments: [comment('monalisa', 5, { html_url: 'u' })] }), pr(2, { reviews: [approve('monalisa', 'head2')] })]));
  const r = w.run(['acme/app#1']);
  assert.deepEqual(r.lines, ['review acme/app#1 head head1: comment by monalisa u']);
  assert.deepEqual(r.writes, []);
});

test('a listed PR closed without merging is reported once; a merged one is not', () => {
  const w = world(repo([pr(1, { state: 'CLOSED' }), pr(2, { state: 'MERGED' })]));
  assert.deepEqual(w.run(['acme/app#1', 'acme/app#2']).lines, ['closed acme/app#1']);
  assert.deepEqual(w.run(['acme/app#1', 'acme/app#2']).lines, []);
  const mine = world(repo([]), { closed: [{ number: 9 }] });
  assert.deepEqual(mine.run(['--mine', 'octocat', 'acme/app']).lines, ['closed acme/app#9']);
});

test('draft PRs are ignored, approved or not', () => {
  const r = world(repo([pr(1, { isDraft: true, reviews: [approve('monalisa', 'head1')] }), pr(2, { isDraft: true, author: 'octocat', issueComments: [comment('monalisa', 5)] })])).run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
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

test('deleting the state file repeats the notices and nothing else', () => {
  const p = [pr(1, { reviews: [approve('monalisa', 'older')] }), pr(2, { author: 'octocat', issueComments: [comment('monalisa', 5, { html_url: 'u' })] }), pr(3, { reviews: [approve('monalisa', 'head3')] })];
  const w = world(repo(p));
  const first = w.run(['--no-merge', '--mine', 'octocat', 'acme/app']);
  assert.deepEqual(w.run(['--no-merge', '--mine', 'octocat', 'acme/app']).lines, []);
  fs.rmSync(w.state);
  const again = w.run(['--no-merge', '--mine', 'octocat', 'acme/app']);
  assert.deepEqual(again.lines, first.lines);
  assert.equal(first.lines.length, 3);
  assert.deepEqual(again.writes, []);
});

test('usage errors exit with status 2', () => {
  const w = world(repo([]));
  for (const args of [['--interval', 'soon', 'acme/app'], ['nope'], ['--deadline', '-1', 'acme/app']]) assert.equal(w.run(args).code, 2, args.join(' '));
});
