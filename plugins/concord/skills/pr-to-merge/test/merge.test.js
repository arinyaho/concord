'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment } = require('./world');

const repo = (prs, extra = {}) => ({ 'acme/app': { prs, ...extra } });
const approved = (n, over = {}) => pr(n, { reviews: [approve('monalisa', `head${n}`, 10)], ...over });

test('merges when the required checks passed while checks the rules do not require are still running, and names those checks', () => {
  const checks = [{ name: 'build', required: true }, { name: 'e2e', required: false, status: 'IN_PROGRESS', conclusion: null }, { name: 'lint', required: false, conclusion: 'FAILURE' }];
  const r = world(repo([approved(1, { mergeStateStatus: 'UNSTABLE', checks })])).run(['acme/app']);
  assert.deepEqual(r.lines, ['merged acme/app#1 into main (squash) head head1; not passed: e2e (pending), lint (failure)']);
});

test('waits silently while a required check is still running', () => {
  const checks = [{ name: 'build', required: true, status: 'IN_PROGRESS', conclusion: null }];
  const r = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks })])).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('an unresolved thread, an unanswered comment after the approval, or the blocked label keeps a PR from merging', () => {
  const cases = {
    thread: approved(1, { threads: [{ resolved: false, path: 'a.js', line: 3, root: 7 }], comments: [{ id: 7, user: { login: 'monalisa' }, path: 'a.js', line: 3 }] }),
    comment: approved(1, { issueComments: [comment('monalisa', 20)] }),
    review: approved(1, { reviews: [approve('monalisa', 'head1', 10), review('octo-dev', 'COMMENTED', 'head1', 20, { body: 'please also rename x' })] }),
  };
  for (const [name, p] of Object.entries(cases)) {
    const w = world(repo([p]));
    const r = w.run(['acme/app']);
    assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved, open points'], name);
    assert.deepEqual(r.writes, [], name);
    assert.deepEqual(w.run(['acme/app']).lines, [], `${name}: reported once`);
  }
  const labeled = world(repo([approved(1, { labels: ['blocked'] })])).run(['acme/app']);
  assert.deepEqual(labeled.writes, []);
  const custom = world(repo([approved(1, { labels: ['hold'] })])).run(['--blocked-label', 'hold', 'acme/app']);
  assert.deepEqual(custom.writes, []);
});

test('new activity on a blocked PR is reported as open points again, once per item', () => {
  const w = world(repo([approved(1, { issueComments: [comment('monalisa', 20)] })]));
  assert.deepEqual(w.run(['acme/app']).lines, ['triage acme/app#1 head head1: approved, open points']);
  // The skill labels the PR and comments; neither is new activity.
  w.update((x) => { const p = x.repos['acme/app'].prs[0]; p.labels.push('blocked'); p.issueComments.push(comment('octocat', 25)); });
  assert.deepEqual(w.run(['acme/app']).lines, []);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('hubot', 30)));
  assert.deepEqual(w.run(['acme/app']).lines, ['triage acme/app#1 head head1: approved, open points']);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});

test('a comment after the approval answered by a later --self comment, and a comment before the approval, do not hold the merge', () => {
  const p = approved(1, { issueComments: [comment('octo-dev', 5), comment('monalisa', 20), comment('octocat', 25, { body: 'Filed as #12.' })] });
  assert.deepEqual(world(repo([p])).run(['acme/app']).lines, ['merged acme/app#1 into main (squash) head head1']);
});

test('an approved PR in conflict is reported once per head and not merged', () => {
  const w = world(repo([approved(1, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })]));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved, conflict']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});

test('a stack merges top down with merge commits, each merge naming the head it expects, then squashes the bottom', () => {
  const prs = [
    approved(3, { headRefName: 'c', baseRefName: 'b' }),
    approved(2, { headRefName: 'b', baseRefName: 'a' }),
    approved(1, { headRefName: 'a', baseRefName: 'main' }),
  ];
  const w = world(repo(prs));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, [
    'merged acme/app#3 into b (merge commit) head head3',
    'merged acme/app#2 into a (merge commit) head merge3',
    'merged acme/app#1 into main (squash) head merge2',
  ]);
  assert.deepEqual(r.writes.map((c) => [c[2], c[5], c[7]]), [['3', '--merge', 'head3'], ['2', '--merge', 'merge3'], ['1', '--squash', 'merge2']]);
});

test('a stack merges nothing when one PR in it does not qualify', () => {
  const prs = [pr(2, { headRefName: 'b', baseRefName: 'a' }), approved(1, { headRefName: 'a', baseRefName: 'main' })];
  const r = world(repo(prs)).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('a stack whose child does not contain its parent\'s head is reported once and not merged', () => {
  const prs = [approved(2, { headRefName: 'b', baseRefName: 'a' }), approved(1, { headRefName: 'a', baseRefName: 'main' })];
  const w = world(repo(prs, { compare: { 'head1...head2': 'diverged' } }));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['stack acme/app#2: a child does not contain its parent\'s head']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});

test('a PR behind its base is updated with a merge commit, pinned to its head, and the run goes on', () => {
  const r = world(repo([approved(1, { mergeStateStatus: 'BEHIND' })])).run(['acme/app']);
  assert.deepEqual(r.lines, ['synced acme/app#1 head head1']);
  assert.deepEqual(r.writes, [['api', '-X', 'PUT', 'repos/acme/app/pulls/1/update-branch', '-f', 'expected_head_sha=head1']]);
});

test('a merge GitHub refuses as behind updates the branch; any other refusal is reported once with its message', () => {
  const behind = world(repo([approved(1)]), { mergeError: { 1: 'GraphQL: Pull request is not mergeable: the head branch is not up to date with the base branch' } }).run(['acme/app']);
  assert.deepEqual(behind.lines, ['synced acme/app#1 head head1']);
  const w = world(repo([approved(1, { mergeStateStatus: 'BLOCKED' })]), { mergeError: { 1: 'Waiting on code owner review from acme/core.' } });
  assert.deepEqual(w.run(['acme/app']).lines, ['merge failed acme/app#1 head head1: Waiting on code owner review from acme/core.']);
  const again = w.run(['acme/app']);
  assert.deepEqual(again.lines, []);
  assert.equal(again.writes.length, 1, 'the merge is still tried; only the notice is not repeated');
});

test('a failed required check is run again once per head, then reported once as still red', () => {
  const checks = [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 77 }, { name: 'docs', required: false, conclusion: 'FAILURE', runId: 78 }];
  const w = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks })], { runs: { 77: { status: 'completed', conclusion: 'failure', run_attempt: 1 } } }));
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, ['rerun acme/app#1 head head1: run 77']);
  assert.deepEqual(first.writes, [['api', '-X', 'POST', 'repos/acme/app/actions/runs/77/rerun-failed-jobs']]);
  w.update((x) => { x.repos['acme/app'].runs[77].run_attempt = 2; });
  const second = w.run(['acme/app']);
  assert.deepEqual(second.lines, ['triage acme/app#1 head head1: required check still red after one re-run']);
  assert.deepEqual(second.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});

test('a failed required check is not run again on a PR with an open point', () => {
  const checks = [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 77 }];
  const r = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks, issueComments: [comment('monalisa', 20)] })])).run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved, open points']);
  assert.deepEqual(r.writes, []);
});

test('an automated PR from a named account, with the named title prefix, is approved and merged; others are left alone', () => {
  const bump = (n, author, title) => pr(n, { author, title, mergeStateStatus: 'BLOCKED' });
  const w = world(repo([bump(1, 'pin-bot', 'chore(deps): pin core'), bump(2, 'pin-bot', 'feat: something else'), bump(3, 'other-bot', 'chore(deps): pin core')]));
  const r = w.run(['--automated', 'pin-bot[bot]:chore(deps):', 'acme/app']);
  assert.deepEqual(r.lines, ['approved acme/app#1 (automated)', 'merged acme/app#1 into main (squash) head head1']);
  assert.deepEqual(r.writes, [
    ['api', '-X', 'POST', 'repos/acme/app/pulls/1/reviews', '-f', 'event=APPROVE', '-f', 'commit_id=head1'],
    ['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'head1'],
  ]);
  const any = world(repo([bump(2, 'pin-bot', 'feat: something else')])).run(['--automated', 'app/pin-bot', 'acme/app']);
  assert.deepEqual(any.lines, ['approved acme/app#2 (automated)', 'merged acme/app#2 into main (squash) head head2']);
});

test('an automated PR is not approved while a required check fails or someone else has an unanswered comment', () => {
  const failing = pr(1, { author: 'pin-bot', mergeStateStatus: 'BLOCKED', checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 5 }] });
  const commented = pr(2, { author: 'pin-bot', mergeStateStatus: 'BLOCKED', issueComments: [comment('monalisa', 5)] });
  const r = world(repo([failing, commented])).run(['--automated', 'pin-bot', 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('--no-merge reports a qualifying PR as ready once and writes nothing', () => {
  const prs = [
    approved(1),
    pr(2, { author: 'pin-bot', mergeStateStatus: 'BLOCKED' }),
    approved(3, { mergeStateStatus: 'BEHIND' }),
    approved(4, { mergeStateStatus: 'BLOCKED', checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 9 }] }),
  ];
  const w = world(repo(prs));
  const r = w.run(['--no-merge', '--automated', 'pin-bot', 'acme/app']);
  assert.deepEqual(r.lines, ['ready acme/app#1 head head1', 'ready acme/app#2 head head2']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--no-merge', '--automated', 'pin-bot', 'acme/app']).lines, []);
});
