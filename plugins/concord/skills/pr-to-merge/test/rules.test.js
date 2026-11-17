'use strict';
// The rules the watcher's check applies to the user's own pull requests: the base that requires no review, --confirm
// and `confirm`, review requests, asking a stale approver again, the holds measured from a confirmation, and the
// lines and notifications a check records.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, T } = require('./world');

const repo = (prs, extra = {}) => ({ 'acme/app': { prs, ...extra } });
const H1 = '1'.repeat(40), H2 = '2'.repeat(40);
const merged = (n, head) => `merged acme/app#${n} into main (squash) head ${head.slice(0, 8)}; not passed: 0; unresolved threads: 0`;
const merges = (r) => r.writes.filter((c) => c[0] === 'pr');
// The user's own pull request on a base that requires no review (GitHub reports no review decision there).
const open = (over = {}) => pr(1, { reviewDecision: null, headRefOid: H1, ...over });
const confirm = (w, sha, n = 1) => w.script(['confirm', `acme/app#${n}`, sha, '--harness', 'claude']);

test('another author\'s pull request with a counting approval is not merged and produces no line', () => {
  for (const reviewDecision of ['APPROVED', null]) {
    const r = world(repo([pr(1, { author: 'hubot', reviewDecision, reviews: [approve('monalisa', 'head1')] })])).run(['acme/app']);
    assert.deepEqual([...r.lines, ...r.reviews], [], String(reviewDecision));
    assert.deepEqual(r.writes, [], String(reviewDecision));
  }
});

test('on a base that requires no review, the user\'s own pull request with passing required checks and nothing holding it merges without an approval', () => {
  const r = world(repo([open()])).run(['acme/app']);
  assert.deepEqual(r.lines, [merged(1, H1)]);
  assert.deepEqual(merges(r), [['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', H1]]);
  const held = world(repo([open({ issueComments: [comment('octo-dev', 5)] })])).run(['acme/app']);
  assert.deepEqual(held.lines, [`triage acme/app#1 head ${H1}: held by comment`], 'with no approval or confirmation, everything a counting account added holds');
  const waiting = world(repo([open({ checks: [{ name: 'build', required: true, status: 'IN_PROGRESS', conclusion: null }] })])).run(['acme/app']);
  assert.deepEqual([waiting.lines, merges(waiting)], [[], []], 'a required check still running');
  const required = world(repo([open({ reviewDecision: 'REVIEW_REQUIRED' })])).run(['acme/app']);
  assert.deepEqual([required.lines, merges(required)], [[], []], 'a base that requires a review');
});

test('--confirm: every head waits for `confirm <sha>`; a later push waits again; the confirmation survives deleting the notice record', () => {
  const w = world(repo([open()]));
  const first = w.run(['--confirm', 'acme/app']);
  assert.deepEqual(first.lines, [`confirm acme/app#1 head ${H1}`]);
  assert.deepEqual(merges(first), []);
  assert.deepEqual(w.run(['--confirm', 'acme/app']).lines, [], 'recorded once per head');
  const c = confirm(w, H1);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stdout, `confirmed acme/app#1 head ${H1}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.skillDir, 'watch.json'), 'utf8')).entries['acme/app'].confirmations['1'].map((x) => x.sha), [H1]);
  // A push before the next check: the new head waits again.
  w.update((x) => { x.repos['acme/app'].prs[0].headRefOid = H2; });
  const pushed = w.run(['--confirm', 'acme/app']);
  assert.deepEqual(pushed.lines, [`confirm acme/app#1 head ${H2}`]);
  assert.deepEqual(merges(pushed), []);
  confirm(w, H2);
  fs.rmSync(path.join(w.skillDir, 'record.json'));
  assert.deepEqual(w.run(['--confirm', 'acme/app']).lines, [merged(1, H2)]);
});

test('`confirm` takes only the full SHA of a watched pull request', () => {
  const w = world(repo([open()]));
  w.run(['--confirm', 'acme/app#1']);
  assert.equal(confirm(w, H1.slice(0, 8)).status, 2);
  assert.equal(confirm(w, H1, 2).status, 2, 'not watched');
  assert.equal(w.script(['confirm', 'acme/app', H1, '--harness', 'claude']).status, 2);
  assert.equal(confirm(w, H1).status, 0);
});

test('under --no-merge, `confirm` alone authorizes merging that head', () => {
  const w = world(repo([open()]));
  const ready = w.run(['--no-merge', 'acme/app']);
  assert.deepEqual(ready.lines, [`ready acme/app#1 head ${H1.slice(0, 8)}`]);
  assert.deepEqual(merges(ready), []);
  confirm(w, H1);
  assert.deepEqual(w.run(['--no-merge', 'acme/app']).lines, [merged(1, H1)]);
  const both = world(repo([open({ mergeStateStatus: 'BEHIND' })]));
  assert.deepEqual(both.run(['--no-merge', '--confirm', 'acme/app']).lines, [`confirm acme/app#1 head ${H1}`], 'behind and unconfirmed: nothing is updated');
  assert.deepEqual(both.run(['--no-merge', '--confirm', 'acme/app']).writes, []);
  confirm(both, H1);
  const synced = both.run(['--no-merge', '--confirm', 'acme/app']);
  assert.deepEqual(synced.lines, [`synced acme/app#1 head ${H1.slice(0, 8)}`], 'a confirmation authorizes updating that branch');
});

test('with no reviewer ever requested and no counting review, the entry\'s reviewers are requested once; with none in the entry, `no reviewer`', () => {
  const fresh = () => pr(1, { timeline: [] });
  const w = world(repo([fresh()]));
  const r = w.run(['--reviewer', 'monalisa', '--reviewer', 'acme/core', '--reviewer', 'octocat', 'acme/app']);
  assert.deepEqual(r.lines, ['requested acme/app#1 head head1: monalisa, acme/core']);
  assert.deepEqual(r.writes, [['api', '-X', 'POST', 'repos/acme/app/pulls/1/requested_reviewers', '-f', 'reviewers[]=monalisa', '-f', 'team_reviewers[]=core']]);
  const again = w.run(['--reviewer', 'monalisa', 'acme/app']);
  assert.deepEqual([again.lines, again.writes], [[], []], 'a request is outstanding');
  const none = world(repo([fresh()]));
  assert.deepEqual(none.run(['acme/app']).lines, ['no reviewer acme/app#1 head head1']);
  assert.deepEqual(none.run(['acme/app']).lines, []);
  for (const [name, over] of [['requested once before', { timeline: [{ event: 'review_requested', created_at: T(1) }] }], ['a counting review', { timeline: [], reviews: [review('octo-dev', 'COMMENTED', 'head1', 5, { body: 'hm' })] }]]) {
    const x = world(repo([pr(1, over)])).run(['--reviewer', 'monalisa', 'acme/app']);
    assert.deepEqual([x.lines, x.writes], [[], []], name);
  }
});

test('a stale approval: the newest counting approver is asked again once per head, or named as already requested', () => {
  const w = world(repo([pr(1, { reviews: [approve('octo-dev', 'old0', 5), approve('monalisa', 'old1', 10)] })]));
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, ['stale approval acme/app#1 head head1: by monalisa at old1, asked again, commits after it not read']);
  assert.deepEqual(first.writes, [['api', '-X', 'POST', 'repos/acme/app/pulls/1/requested_reviewers', '-f', 'reviewers[]=monalisa']]);
  assert.deepEqual(w.run(['acme/app']).writes, []);
  w.update((x) => { x.repos['acme/app'].prs[0].headRefOid = 'head1b'; });
  const next = w.run(['acme/app']);
  assert.deepEqual(next.lines, ['stale approval acme/app#1 head head1b: by monalisa at old1, already requested, commits after it not read']);
  assert.deepEqual(next.writes, []);
  const noReview = world(repo([pr(1, { reviewDecision: null, reviews: [approve('monalisa', 'old1', 10)] })])).run(['acme/app']);
  assert.ok(!noReview.lines.some((l) => l.startsWith('stale')), 'not where the base requires no review');
});

test('holds: a push does not release a later comment; on a base that requires no review the user\'s confirmation does', () => {
  const w = world(repo([open({ issueComments: [comment('octo-dev', 20)] })]));
  assert.deepEqual(w.run(['acme/app']).lines, [`triage acme/app#1 head ${H1}: held by comment`]);
  w.update((x) => { x.repos['acme/app'].prs[0].headRefOid = H2; });
  const pushed = w.run(['acme/app']);
  assert.deepEqual(pushed.lines, [`triage acme/app#1 head ${H2}: held by comment`]);
  assert.deepEqual(merges(pushed), []);
  confirm(w, H2);
  assert.deepEqual(w.run(['acme/app']).lines, [merged(1, H2)]);
  // A confirmation settles only what came before it.
  w.update((x) => { const p = x.repos['acme/app'].prs[0]; Object.assign(p, { state: 'OPEN', headRefOid: '3'.repeat(40), issueComments: [...p.issueComments, comment('octo-dev', 0, { created_at: new Date(Date.now() + 60000).toISOString(), updated_at: new Date(Date.now() + 60000).toISOString() })] }); });
  assert.deepEqual(w.run(['acme/app']).lines, [`triage acme/app#1 head ${'3'.repeat(40)}: held by comment`]);
});

test('an outstanding review request holds the user\'s own pull request on a base that requires no review for 24 hours, unless confirmed after it', () => {
  const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const requested = (hours) => open({ requested: ['monalisa'], timeline: [{ event: 'review_requested', created_at: ago(hours) }] });
  const w = world(repo([requested(1)]));
  assert.deepEqual(w.run(['acme/app']).lines, [`triage acme/app#1 head ${H1}: held by review request`]);
  confirm(w, H1);
  assert.deepEqual(w.run(['acme/app']).lines, [merged(1, H1)]);
  assert.deepEqual(world(repo([requested(25)])).run(['acme/app']).lines, [merged(1, H1)]);
});

test('a check notifies once when it records a line that is not informational, never for approved, rerun, synced, or requested', () => {
  const merging = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] })]));
  merging.run(['acme/app']);
  assert.deepEqual(merging.notifications().length, 1);
  assert.match(merging.notifications()[0].join(' '), /pr-to-merge: 4 new notices/, 'two merged lines and two review lines');
  assert.doesNotMatch(merging.notifications()[0].join(' '), /acme|#1/);
  // Automated pull requests, which have no review lines.
  const bump = (over) => repo([pr(1, { author: 'pin-bot', authorType: 'Bot', mergeStateStatus: 'BLOCKED', files: [{ filename: 'deps/a.pin' }], ...over })]);
  const auto = ['--automated', 'pin-bot[bot]', '--automated-path', 'deps/*.pin'];
  const quiet = [
    ['approved', bump({}), auto],
    ['rerun', bump({ checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 7 }] }), auto],
    ['synced', bump({ mergeStateStatus: 'BEHIND' }), auto],
    ['requested', repo([pr(1, { timeline: [] })]), ['--reviewer', 'monalisa']],
  ];
  for (const [kind, repos, args] of quiet) {
    const w = world(repos);
    const r = w.run([...args, 'acme/app']);
    assert.match(r.lines.join('\n'), new RegExp(`^${kind} `), kind);
    assert.deepEqual(w.notifications(), [], kind);
  }
});

test('after a merge, a failed run on the merge commit is run again once, and a second failure is recorded as post-merge failed', () => {
  const run = { id: 70, status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: 'mc1', updated_at: new Date().toISOString(), html_url: 'https://github.com/acme/app/actions/runs/70' };
  const w = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })], { runsBySha: { mc1: [run] } }));
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, [merged(1, 'head1'), 'rerun acme/app#1 head head1: run 70']);
  w.update((x) => { x.repos['acme/app'].runsBySha.mc1[0].run_attempt = 2; });
  const second = w.run(['acme/app']);
  assert.deepEqual(second.lines, ['post-merge failed acme/app#1 run 70 https://github.com/acme/app/actions/runs/70']);
  assert.deepEqual(w.run(['acme/app']).lines, [], 'followed no longer');
});

test('a check short of GitHub quota records `rate limited` once and acts on nothing', () => {
  const w = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { rateLimit: { graphql: { remaining: 12, reset: 1767225600 } } });
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['rate limited: GitHub\'s quota is nearly used up; resets at 2026-01-01T00:00:00.000Z']);
  assert.deepEqual(r.writes, []);
  assert.equal(w.notifications().length, 1);
  assert.deepEqual(w.run(['acme/app']).lines, []);
  const refused = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { fail: ['pulls/1/reviews'], failMessage: 'HTTP 403: API rate limit exceeded for user' }).run(['acme/app']);
  assert.match(refused.lines.join('\n'), /^rate limited: /);
});

test('an entry whose --self is not the gh account records `account` once and is skipped', () => {
  const w = world(repo([pr(1, { reviews: [approve('monalisa', 'head1')] })]), { self: 'monalisa' });
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['account acme/app: gh is logged in as monalisa, not octocat']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});
