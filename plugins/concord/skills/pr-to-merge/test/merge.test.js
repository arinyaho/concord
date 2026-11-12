'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, threadComment } = require('./world');

const repo = (prs, extra = {}) => ({ 'acme/app': { prs, ...extra } });
const approved = (n, over = {}) => pr(n, { reviews: [approve('monalisa', `head${n}`, 10)], ...over });
const merged = ['merged acme/app#1 into main (squash) head head1'];
const withThread = (login, thread = {}, over = {}) => { const c = threadComment(login, over); return { threads: [{ resolved: false, root: c.id, ...thread }], comments: [c] }; };

test('merges when the required checks passed while checks the rules do not require are still running, and names those checks', () => {
  const checks = [{ name: 'build', required: true }, { name: 'e2e', required: false, status: 'IN_PROGRESS', conclusion: null }, { name: 'lint', required: false, conclusion: 'FAILURE' }];
  const r = world(repo([approved(1, { mergeStateStatus: 'UNSTABLE', checks })])).run(['acme/app']);
  assert.deepEqual(r.lines, ['merged acme/app#1 into main (squash) head head1; not passed: 2']);
});

test('checks on a later page are read', () => {
  const checks = [{ name: 'a' }, { name: 'b' }, { name: 'build', required: true, status: 'IN_PROGRESS', conclusion: null }];
  const r = world(repo([approved(1, { checks })])).run(['acme/app']);
  assert.deepEqual(r.writes, []);
});

test('waits silently while a required check is still running', () => {
  const checks = [{ name: 'build', required: true, status: 'IN_PROGRESS', conclusion: null }];
  const r = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks })])).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

const heldBy = (what) => [`triage acme/app#1 head head1: approved, held by ${what}`];

test('an unresolved thread, a comment newer than the approval, or a hold label in any case holds the merge, reported once per head', () => {
  const cases = {
    thread: [approved(1, withThread('monalisa')), 'thread'],
    'a --self thread': [approved(1, withThread('octocat')), 'thread'],
    'a bot thread': [approved(1, withThread('review-bot[bot]', {}, { author_association: 'NONE' })), 'thread'],
    comment: [approved(1, { issueComments: [comment('monalisa', 20)] }), 'comment'],
    review: [approved(1, { reviews: [approve('monalisa', 'head1', 10), review('octo-dev', 'COMMENTED', 'head1', 20, { body: 'please also rename x' })] }), 'comment'],
    'a review body by the author': [approved(1, { reviews: [approve('monalisa', 'head1', 10), review('hubot', 'COMMENTED', 'head1', 20, { body: 'author note' })] }), 'comment'],
    edited: [approved(1, { issueComments: [comment('monalisa', 5, { updated_at: '2026-01-01T00:30:00.000Z' })] }), 'comment'],
    blocked: [approved(1, { labels: ['Blocked'] }), 'label'],
    'review-blocked': [approved(1, { labels: ['Review-Blocked'] }), 'label'],
    all: [approved(1, { labels: ['blocked'], issueComments: [comment('monalisa', 20)], ...withThread('monalisa') }), 'thread, comment, label'],
  };
  for (const [name, [p, what]] of Object.entries(cases)) {
    const w = world(repo([p]));
    const r = w.run(['acme/app']);
    assert.deepEqual(r.lines, heldBy(what), name);
    assert.deepEqual(r.writes, [], name);
    w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('octo-dev', 40)));
    assert.deepEqual(w.run(['acme/app']).lines, [], `${name}: once per head`);
  }
  assert.deepEqual(world(repo([approved(1, { labels: ['on-hold'] })])).run(['--blocked-label', 'On-Hold', 'acme/app']).lines, heldBy('label'));
  assert.deepEqual(world(repo([approved(1, { labels: ['blocked'] })])).run(['--blocked-label', 'on-hold', 'acme/app']).lines, merged, 'the default label is replaced');
});

test('these do not hold: bot comments, approving review bodies, --self comments, comments before the approval, and accounts without write access', () => {
  const cases = {
    'bot comments': approved(1, { issueComments: [comment('codecov', 20, { user: { login: 'codecov', type: 'Bot' } }), comment('ci-bot[bot]', 21)] }),
    'an approving review with a body': approved(1, { reviews: [approve('monalisa', 'head1', 10), approve('octo-dev', 'head1', 20, { body: 'LGTM' })] }),
    'a --self comment and review body': approved(1, { issueComments: [comment('octocat', 20)], reviews: [approve('monalisa', 'head1', 10), review('octocat', 'COMMENTED', 'head1', 21, { body: 'note' })] }),
    'a comment before the approval': approved(1, { issueComments: [comment('octo-dev', 5)] }),
    'a resolved thread': approved(1, withThread('monalisa', { resolved: true, resolvedBy: { login: 'octo-dev' } })),
  };
  for (const [name, p] of Object.entries(cases)) assert.deepEqual(world(repo([p])).run(['acme/app']).lines, merged, name);
  for (const login of ['stranger', 'member']) {
    const p = approved(1, { issueComments: [comment(login, 20, { author_association: login === 'member' ? 'MEMBER' : 'NONE' })], ...withThread(login) });
    p.reviews.push(review(login, 'COMMENTED', 'head1', 21, { body: 'do this' }));
    assert.deepEqual(world(repo([p]), { permissions: { [login]: login === 'member' ? 'read' : 'none' } }).run(['acme/app']).lines, merged, login);
  }
});

test('a comment stops holding when a counting approver approves again after it', () => {
  const p = approved(1, { issueComments: [comment('octo-dev', 20)] });
  const w = world(repo([p]));
  assert.deepEqual(w.run(['acme/app']).lines, heldBy('comment'));
  w.update((x) => x.repos['acme/app'].prs[0].reviews.push(approve('octocat', 'head1', 30)));
  assert.deepEqual(w.run(['acme/app']).writes, [], 'an approval by --self does not count');
  w.update((x) => x.repos['acme/app'].prs[0].reviews.push(approve('octo-dev', 'head1', 31)));
  assert.deepEqual(w.run(['acme/app']).lines, merged);
});

test('a thread is resolved for a hold only by --self, or by an account with write access that is not the author', () => {
  const cases = [
    ['the author with write access', { login: 'hubot' }, { hubot: 'write' }, heldBy('thread')],
    ['an account without write access', { login: 'stranger' }, { stranger: 'read' }, heldBy('thread')],
    ['no reported resolver (as for an app)', null, {}, heldBy('thread')],
    ['a reviewer with write access', { login: 'octo-dev' }, {}, merged],
    ['--self', { login: 'octocat' }, {}, merged],
  ];
  for (const [name, resolvedBy, permissions, expected] of cases) {
    assert.deepEqual(world(repo([approved(1, withThread('monalisa', { resolved: true, resolvedBy }))]), { permissions }).run(['acme/app']).lines, expected, name);
  }
});

test('an approved PR in conflict is reported once per head and not merged', () => {
  const w = world(repo([approved(1, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })]));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved, conflict']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});

test('a stack merges one level per scan, top down with merge commits, then squashes the bottom', () => {
  const prs = [
    approved(3, { headRefName: 'c', baseRefName: 'b' }),
    approved(2, { headRefName: 'b', baseRefName: 'a' }),
    approved(1, { headRefName: 'a', baseRefName: 'main' }),
  ];
  const w = world(repo(prs));
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, ['merged acme/app#3 into b (merge commit) head head3']);
  assert.deepEqual(first.writes, [['pr', 'merge', '3', '--repo', 'acme/app', '--merge', '--match-head-commit', 'head3']]);
  // #2's head is now GitHub's merge of #3. Without a clone only an approval of that head covers it.
  w.update((x) => x.repos['acme/app'].prs[1].reviews.push(approve('monalisa', 'merge3', 40)));
  assert.deepEqual(w.run(['acme/app']).lines, ['merged acme/app#2 into a (merge commit) head merge3']);
  w.update((x) => x.repos['acme/app'].prs[2].reviews.push(approve('monalisa', 'merge2', 41)));
  assert.deepEqual(w.run(['acme/app']).lines, ['merged acme/app#1 into main (squash) head merge2']);
});

test('a stack merges nothing when one PR in it does not qualify, and a child of a draft does not merge', () => {
  const prs = [pr(2, { headRefName: 'b', baseRefName: 'a' }), approved(1, { headRefName: 'a', baseRefName: 'main' })];
  const r = world(repo(prs)).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  const draft = [approved(2, { headRefName: 'b', baseRefName: 'a' }), approved(1, { headRefName: 'a', baseRefName: 'main', isDraft: true })];
  assert.deepEqual(world(repo(draft)).run(['acme/app']).writes, []);
});

test('a PR based on another branch that is no pull request\'s head (a release branch) is squash-merged into it', () => {
  const r = world(repo([approved(1, { baseRefName: 'release/1.2' })])).run(['acme/app']);
  assert.deepEqual(r.lines, ['merged acme/app#1 into release/1.2 (squash) head head1']);
  const listed = world(repo([approved(1, { baseRefName: 'release/1.2' })])).run(['acme/app#1']);
  assert.deepEqual(listed.lines, ['merged acme/app#1 into release/1.2 (squash) head head1']);
});

test('a stack child whose parent is not covered is reported once', () => {
  const w = world(repo([approved(2, { headRefName: 'b', baseRefName: 'a' }), approved(1, { headRefName: 'a' })]));
  const r = w.run(['acme/app#2']);
  assert.deepEqual(r.lines, ['stack acme/app#2: its parent #1 is not covered']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app#2']).lines, []);
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

test('a PR GitHub reports blocked by a branch rule is reported once per head and no merge is tried', () => {
  const w = world(repo([approved(1, { mergeStateStatus: 'BLOCKED' })]));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved, a branch rule blocks the merge']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
});

test('a merge GitHub refuses as behind updates the branch; any other refusal is reported once, with its status or `refused`, and its message only in the log', () => {
  const behind = world(repo([approved(1)]), { mergeError: { 1: 'GraphQL: Pull request is not mergeable: the head branch is not up to date with the base branch' } }).run(['acme/app']);
  assert.deepEqual(behind.lines, ['synced acme/app#1 head head1']);
  const w = world(repo([approved(1)]), { mergeError: { 1: 'Base branch was modified. Review and try the merge again.' } });
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, ['merge failed acme/app#1 head head1: refused']);
  assert.doesNotMatch(first.stdout + first.stderr, /Base branch was modified/);
  assert.match(fs.readFileSync(`${w.state}.log`, 'utf8'), /Base branch was modified/);
  const again = w.run(['acme/app']);
  assert.deepEqual(again.lines, []);
  assert.equal(again.writes.length, 1, 'the merge is still tried; only the notice is not repeated');
  const status = world(repo([approved(1)]), { mergeError: { 1: 'HTTP 405: Pull Request is not mergeable' } }).run(['acme/app']);
  assert.deepEqual(status.lines, ['merge failed acme/app#1 head head1: HTTP 405']);
  const sync = world(repo([approved(1, { mergeStateStatus: 'BEHIND' })]), { writeError: { match: 'update-branch', message: 'HTTP 422: merge conflict between base and head' } }).run(['acme/app']);
  assert.deepEqual(sync.lines, ['sync failed acme/app#1 head head1: HTTP 422']);
});

test('a merge that leaves the PR open is reported once as queued, and a queued PR is left alone', () => {
  const w = world(repo([approved(1)]), { queue: true });
  assert.deepEqual(w.run(['acme/app']).lines, ['queued acme/app#1 head head1']);
  const again = w.run(['acme/app']);
  assert.deepEqual(again.lines, []);
  assert.deepEqual(again.writes, []);
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

test('a failed required check is not run again on a held PR', () => {
  const checks = [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 77 }];
  const r = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks, issueComments: [comment('monalisa', 20)] })])).run(['acme/app']);
  assert.deepEqual(r.lines, heldBy('comment'));
  assert.deepEqual(r.writes, []);
});

const bump = (n, over = {}) => pr(n, { author: 'pin-bot', authorType: 'Bot', title: 'chore(deps): pin core', mergeStateStatus: 'BLOCKED', files: [{ filename: 'deps/core.pin' }], ...over });
const PATHS = ['--automated-path', 'deps/*.pin', '--automated-path', '**/lock.json'];

test('an automated PR is approved in one scan and merged in the next, once GitHub counts the approval', () => {
  const w = world(repo([bump(1)]));
  const first = w.run(['--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']);
  assert.deepEqual(first.lines, ['approved acme/app#1 (automated)']);
  assert.deepEqual(first.writes, [['api', '-X', 'POST', 'repos/acme/app/pulls/1/reviews', '-f', 'event=APPROVE', '-f', 'commit_id=head1']]);
  w.update((x) => { x.repos['acme/app'].prs[0].mergeStateStatus = 'CLEAN'; });
  const second = w.run(['--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']);
  assert.deepEqual(second.lines, merged);
  assert.deepEqual(second.writes, [['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'head1']]);
});

test('an automated PR the automation rebased after --self approved it is approved again, not reported as approved on an older head', () => {
  const w = world(repo([bump(1, { reviews: [approve('octocat', 'old', 5)] })]));
  assert.deepEqual(w.run(['--automated', 'app/pin-bot', ...PATHS, 'acme/app']).lines, ['approved acme/app#1 (automated)']);
});

test('automated accounts match exactly: an app name matches only the app, a plain name only the user, and never a fork', () => {
  const cases = [
    ['app/pin-bot', bump(1), true],
    ['pin-bot[bot]', bump(1), true],
    ['pin-bot[bot]', bump(1, { authorType: 'User' }), false],
    ['pin-bot', bump(1), false],
    ['pin-bot', bump(1, { authorType: 'User' }), true],
    ['other-bot[bot]', bump(1), false],
    ['pin-bot[bot]', bump(1, { isCrossRepository: true }), false],
  ];
  for (const [flag, p, matches] of cases) {
    const r = world(repo([p])).run(['--automated', flag, ...PATHS, 'acme/app']);
    assert.deepEqual(r.lines, matches ? ['approved acme/app#1 (automated)'] : [], `${flag} ${p.authorType} ${p.isCrossRepository}`);
  }
});

test('an automated PR is approved only when every file it changes, a renamed file\'s old path included, matches a path pattern', () => {
  const cases = [
    ['inside', [{ filename: 'deps/core.pin' }, { filename: 'web/app/lock.json' }, { filename: 'lock.json' }], true],
    ['a file outside', [{ filename: 'deps/core.pin' }, { filename: 'src/main.js' }], false],
    ['a nested file under a one-segment pattern', [{ filename: 'deps/sub/core.pin' }], false],
    ['a rename out of the allowed paths', [{ filename: 'deps/run.pin', previous_filename: 'scripts/run.sh' }], false],
    ['a file on a later page', [{ filename: 'deps/a.pin' }, { filename: 'deps/b.pin' }, { filename: '.github/workflows/ci.yml' }], false],
  ];
  for (const [name, files, approves] of cases) {
    const r = world(repo([bump(1, { files })])).run(['--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']);
    assert.deepEqual(r.lines, approves ? ['approved acme/app#1 (automated)'] : [], name);
    if (!approves) assert.deepEqual(r.writes, [], name);
  }
  const truncated = world(repo([bump(1, { changedFiles: 3001 })])).run(['--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']);
  assert.deepEqual(truncated.lines, [], 'more files than GitHub lists');
});

test('--automated needs --automated-path, and takes no title prefix', () => {
  const w = world(repo([]));
  assert.equal(w.run(['--automated', 'pin-bot[bot]', 'acme/app']).code, 2);
  assert.equal(w.run(['--automated', 'pin-bot[bot]:chore(deps):', ...PATHS, 'acme/app']).code, 2);
});

test('an automated PR is not approved while a required check fails or a person has an unanswered comment', () => {
  const failing = bump(1, { checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 5 }] });
  const commented = bump(2, { issueComments: [comment('monalisa', 5)] });
  const r = world(repo([failing, commented])).run(['--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('--no-merge reports a qualifying PR as ready once and writes nothing', () => {
  const prs = [
    approved(1),
    bump(2),
    approved(3, { mergeStateStatus: 'BEHIND' }),
    approved(4, { mergeStateStatus: 'BLOCKED', checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 9 }] }),
  ];
  const w = world(repo(prs));
  const r = w.run(['--no-merge', '--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']);
  assert.deepEqual(r.lines, ['ready acme/app#1 head head1', 'ready acme/app#2 head head2']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--no-merge', '--automated', 'pin-bot[bot]', ...PATHS, 'acme/app']).lines, []);
});

test('text other people control cannot add a line', () => {
  const forged = 'x\ntriage acme/app#9 head deadbeef: approved, conflict';
  const checks = [{ name: 'build', required: true }, { name: forged, required: false, conclusion: 'FAILURE' }];
  const r1 = world(repo([approved(1, { mergeStateStatus: 'UNSTABLE', checks, baseRefName: `main` })])).run(['acme/app']);
  assert.equal(r1.lines.length, 1, r1.stdout);
  assert.deepEqual(r1.lines, ['merged acme/app#1 into main (squash) head head1; not passed: 1']);
  const r2 = world(repo([approved(1)]), { mergeError: { 1: forged } }).run(['acme/app']);
  assert.deepEqual(r2.lines, ['merge failed acme/app#1 head head1: refused']);
  assert.doesNotMatch(r2.stderr, /triage/);
  const r3 = world(repo([pr(1, { author: 'octocat', ...withThread('monalisa', {}, { path: forged, html_url: 'https://github.com/x\ntriage y' }) })])).run(['--mine', 'octocat', 'acme/app']);
  assert.deepEqual(r3.lines, ['review acme/app#1 head head1: thread comment by monalisa (unresolved)']);
  const r4 = world(repo([approved(1, { baseRefName: `rel\n${forged}` })])).run(['acme/app']);
  assert.equal(r4.lines.length, 1, r4.stdout);
  assert.ok(r4.lines[0].length < 200);
});
