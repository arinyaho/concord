'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { world, pr, review, approve, comment, threadComment } = require('./world');

const repo = (prs) => ({ 'acme/app': { prs } });
const merged = (n) => `merged acme/app#${n} into main (squash) head head${n}; not passed: 0; unresolved threads: 0`;

test('another author\'s pull request is never acted on, approved or not: no line, no write, and its reviews are not read', () => {
  const p = pr(1, { author: 'hubot', reviews: [approve('monalisa', 'head1', 5)], issueComments: [comment('monalisa', 6)] });
  const r = world(repo([p])).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  assert.ok(!r.calls.some((c) => c.some((x) => /pulls\/1\/|issues\/1\//.test(x))), JSON.stringify(r.calls));
});

test('review activity on a PR the user authored is printed once per item, from any account but --self, approved or not', () => {
  const thread = threadComment('monalisa', { html_url: 'https://github.com/acme/app/pull/1#discussion_r7' });
  const own = pr(1, {
    author: 'octocat',
    reviews: [review('monalisa', 'CHANGES_REQUESTED', 'head1', 5, { body: 'see threads', html_url: 'https://github.com/acme/app/pull/1#pullrequestreview-1' }), review('monalisa', 'COMMENTED', 'head1', 6), review('octocat', 'COMMENTED', 'head1', 7, { body: 'mine' })],
    comments: [thread, threadComment('octocat', { in_reply_to_id: thread.id })],
    threads: [{ resolved: false, root: thread.id }],
    issueComments: [comment('ci-bot[bot]', 8, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-3' }), comment('stranger', 9, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-6' }), comment('x', 9, { user: null })],
  });
  const approvedOwn = pr(2, { author: 'octocat', reviews: [approve('monalisa', 'older', 5)], issueComments: [comment('monalisa', 9, { html_url: 'https://github.com/acme/app/pull/2#issuecomment-4' })] });
  const assigned = pr(3, { author: 'hubot', assignees: ['octocat'], issueComments: [comment('monalisa', 9)] });
  const w = world(repo([own, approvedOwn, assigned]), { permissions: { stranger: 'read' } });
  const r = w.run(['acme/app']);
  assert.deepEqual(r.reviews, [
    'review acme/app#1 head head1: review changes requested by monalisa https://github.com/acme/app/pull/1#pullrequestreview-1',
    'review acme/app#1 head head1: thread comment by monalisa https://github.com/acme/app/pull/1#discussion_r7',
    'review acme/app#1 head head1: comment by ci-bot[bot] https://github.com/acme/app/pull/1#issuecomment-3',
    'review acme/app#1 head head1: comment by stranger https://github.com/acme/app/pull/1#issuecomment-6',
    `review acme/app#2 head head2: review approved by monalisa ${approvedOwn.reviews[0].html_url}`,
    'review acme/app#2 head head2: comment by monalisa https://github.com/acme/app/pull/2#issuecomment-4',
  ]);
  assert.deepEqual(r.lines, ['stale approval acme/app#2 head head2: by monalisa at older, asked again, commits after it not read']);
  const again = w.run(['acme/app']);
  assert.deepEqual([...again.reviews, ...again.lines], []);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('monalisa', 20, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-5' })));
  assert.deepEqual(w.run(['acme/app']).reviews, ['review acme/app#1 head head1: comment by monalisa https://github.com/acme/app/pull/1#issuecomment-5']);
});

test('a PR listed as OWNER/REPO#N limits the run to it and does not make it the user\'s own', () => {
  const prs = [pr(1, { author: 'hubot', reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] }), pr(3, { reviews: [approve('monalisa', 'head3')] })];
  const r = world(repo(prs)).run(['acme/app#1', 'acme/app#2']);
  assert.deepEqual(r.lines, [merged(2)]);
  assert.equal(r.writes.length, 1);
});

test('a listed PR closed without merging is reported once; a merged one is not', () => {
  const w = world(repo([pr(1, { state: 'CLOSED' }), pr(2, { state: 'MERGED' })]));
  assert.deepEqual(w.run(['acme/app#1', 'acme/app#2']).lines, ['closed acme/app#1']);
  assert.deepEqual(w.run(['acme/app#1', 'acme/app#2']).lines, []);
});

test('draft PRs are ignored, approved or not', () => {
  const r = world(repo([pr(1, { isDraft: true, reviews: [approve('monalisa', 'head1')] }), pr(2, { isDraft: true, issueComments: [comment('monalisa', 5)] })])).run(['acme/app']);
  assert.deepEqual([...r.lines, ...r.reviews], []);
  assert.deepEqual(r.writes, []);
});

test('open PRs on a later page are read', () => {
  const r = world(repo([pr(1), pr(2), pr(3, { reviews: [approve('monalisa', 'head3')] })])).run(['acme/app']);
  assert.deepEqual(r.lines, [merged(3)]);
});

test('a failed API call is reported on stderr, the rest of the check goes on, and a repository that cannot be read fails the check', () => {
  const repos = { 'acme/app': { prs: [pr(1, { reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] })] }, 'acme/lib': { prs: [pr(3, { reviews: [approve('monalisa', 'head3')] })] } };
  const w = world(repos, { fail: ['pulls/1/reviews', 'name=lib'] });
  const r = w.run(['acme/app', 'acme/lib']);
  assert.deepEqual(r.lines, [merged(2)]);
  assert.match(r.stderr, /acme\/app#1: failed \(HTTP 502\)/);
  assert.match(r.stderr, /acme\/lib: failed \(HTTP 502\)/);
  assert.equal(r.code, 1);
  assert.equal(world({ 'acme/app': repos['acme/app'] }, { fail: ['pulls/1/reviews'] }).run(['acme/app']).code, 0, 'one pull request that cannot be read does not');
});

test('a check that fails changes nothing; the next check merges', () => {
  const w = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { fail: [{ match: 'statusCheckRollup', times: 1 }] });
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, []);
  assert.match(first.stderr, /502/);
  assert.deepEqual(w.run(['acme/app']).lines, [merged(1)]);
});

test('deleting the notice record repeats the notices, and nothing else; no file is left half written', () => {
  const p = [pr(1, { reviews: [approve('monalisa', 'older')] }), pr(2, { issueComments: [comment('monalisa', 5)] }), pr(3, { reviews: [approve('monalisa', 'head3')] })];
  const w = world(repo(p));
  const first = w.run(['--no-merge', 'acme/app']);
  assert.deepEqual(fs.readdirSync(w.skillDir).sort(), ['record.json', 'watch.json']);
  const second = w.run(['--no-merge', 'acme/app']);
  assert.deepEqual([...second.lines, ...second.reviews, ...second.writes], []);
  fs.rmSync(path.join(w.skillDir, 'record.json'));
  const again = w.run(['--no-merge', 'acme/app']);
  assert.deepEqual(again.reviews, first.reviews);
  assert.deepEqual(again.lines, first.lines.map((l) => l.replace('asked again', 'already requested')), 'the request GitHub still shows is not repeated');
  assert.deepEqual(first.lines, ['stale approval acme/app#1 head head1: by monalisa at older, asked again, commits after it not read', 'ready acme/app#3 head head3']);
  assert.equal(first.reviews.length, 3);
  assert.deepEqual(first.writes, [['api', '-X', 'POST', 'repos/acme/app/pulls/1/requested_reviewers', '-f', 'reviewers[]=monalisa']]);
  assert.deepEqual(again.writes, []);
});

test('usage errors exit with status 2 and print nothing on standard output: a bad option, a missing --harness, a --self that is not the gh account, a control character', () => {
  const w = world(repo([]));
  const today = new Date().toISOString().slice(0, 10);
  const add = (...args) => w.script(['watch', 'add', ...args]);
  for (const args of [
    ['acme/app', '--harness', 'claude', '--self', 'octocat', '--authorized', today, '--interval', '5'],
    ['acme/app', '--self', 'octocat', '--authorized', today],
    ['acme/app', '--harness', 'claude', '--self', 'monalisa', '--authorized', today],
    ['acme/app', '--harness', 'claude', '--self', 'octocat', '--authorized', today, '--blocked-label', 'a\nmerged x'],
    ['acme/app', 'acme/lib', '--harness', 'claude', '--self', 'octocat', '--authorized', today],
  ]) {
    const r = add(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  assert.match(add('acme/app', '--harness', 'claude', '--self', 'monalisa', '--authorized', today).stderr, /not the account gh is logged in as/);
  assert.match(add('acme/app', '--harness', 'claude', '--self', 'octocat', '--authorized', today, '--checkout', w.dir).stderr, /merge-tree --write-tree/);
  assert.equal(w.script(['nope', '--harness', 'claude']).status, 2);
});

test('a check that cannot read the gh account fails and changes nothing', () => {
  const r = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { fail: ['^api user$'] }).run(['acme/app']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  assert.equal(r.stderr, 'pr-to-merge: the gh account: failed (HTTP 502)\n');
});
