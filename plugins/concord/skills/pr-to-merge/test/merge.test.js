'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, threadComment, T } = require('./world');

const repo = (prs, extra = {}) => ({ 'acme/app': { prs, ...extra } });
const approved = (n, over = {}) => pr(n, { reviews: [approve('monalisa', `head${n}`, 10)], ...over });
const mergedLine = (n, { base = 'main', how = 'squash', head = `head${n}`, notPassed = 0, threads = 0 } = {}) => `merged acme/app#${n} into ${base} (${how}) head ${head}; not passed: ${notPassed}; unresolved threads: ${threads}`;
const merged = [mergedLine(1)];
const triage = (what, n = 1) => [`triage acme/app#${n} head head${n}: ${what}`];
// A thread opened at `minute` (the approval is at minute 10); `thread` sets its resolution.
const withThread = (login, minute = 20, thread = {}, over = {}) => { const c = threadComment(login, { created_at: T(minute), updated_at: T(minute), ...over }); return { threads: [{ resolved: false, root: c.id, ...thread }], comments: [c] }; };
const resolvedBy = (login) => ({ resolved: true, resolvedBy: login ? { login } : null });

test('merges when the required checks passed while others are still running, and counts those and the unresolved threads', () => {
  const checks = [{ name: 'build', required: true }, { name: 'e2e', required: false, status: 'IN_PROGRESS', conclusion: null }, { name: 'lint', required: false, conclusion: 'FAILURE' }];
  const r = world(repo([approved(1, { mergeStateStatus: 'UNSTABLE', checks, ...withThread('monalisa', 5) })])).run(['acme/app']);
  assert.deepEqual(r.lines, [mergedLine(1, { notPassed: 2, threads: 1 })]);
  assert.deepEqual(r.writes, [['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'head1']]);
});

test('checks on a later page are read, and a required check still running is waited for silently', () => {
  const checks = [{ name: 'a' }, { name: 'b' }, { name: 'build', required: true, status: 'IN_PROGRESS', conclusion: null }];
  const r = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks })])).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('an approval settles what came before it: earlier threads and comments do not hold, resolved or not', () => {
  const cases = {
    'an unresolved thread': [approved(1, withThread('octo-dev', 5)), 1],
    'a thread the author resolved': [approved(1, withThread('octo-dev', 5, resolvedBy('hubot'))), 0],
    'a comment and a review body': [approved(1, { issueComments: [comment('octo-dev', 5)], reviews: [review('octo-dev', 'COMMENTED', 'head1', 6, { body: 'nit' }), approve('monalisa', 'head1', 10)] }), 0],
  };
  for (const [name, [p, threads]] of Object.entries(cases)) assert.deepEqual(world(repo([p])).run(['acme/app']).lines, [mergedLine(1, { threads })], name);
});

test('what a counting account adds after the newest covering approval holds, reported once per head', () => {
  const cases = {
    'a new thread': [approved(1, withThread('octo-dev')), 'held by thread'],
    'a new comment in an old thread': [(() => { const p = approved(1, withThread('octo-dev', 5)); p.comments.push(threadComment('octo-dev', { in_reply_to_id: p.comments[0].id, created_at: T(20), updated_at: T(20) })); return p; })(), 'held by thread'],
    'an edited thread comment': [approved(1, withThread('octo-dev', 5, {}, { updated_at: T(30) })), 'held by thread'],
    'a conversation comment': [approved(1, { issueComments: [comment('octo-dev', 20)] }), 'held by comment'],
    'an edited conversation comment': [approved(1, { issueComments: [comment('octo-dev', 5, { updated_at: T(30) })] }), 'held by comment'],
    'a review body': [approved(1, { reviews: [approve('monalisa', 'head1', 10), review('octo-dev', 'COMMENTED', 'head1', 20, { body: 'please also rename x' })] }), 'held by comment'],
    'the label': [approved(1, { labels: ['Blocked'] }), 'held by label'],
    all: [approved(1, { labels: ['blocked'], issueComments: [comment('octo-dev', 20)], ...withThread('octo-dev') }), 'held by thread, comment, label'],
  };
  for (const [name, [p, what]] of Object.entries(cases)) {
    const w = world(repo([p]));
    const r = w.run(['acme/app']);
    assert.deepEqual(r.lines, triage(what), name);
    assert.deepEqual(r.writes, [], name);
    w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('octo-dev', 40)));
    assert.deepEqual(w.run(['acme/app']).lines, [], `${name}: once per head`);
  }
  assert.deepEqual(world(repo([approved(1, { labels: ['on-hold'] })])).run(['--blocked-label', 'On-Hold', 'acme/app']).lines, triage('held by label'));
});

test('these never hold: automation accounts, --self, accounts without write access (the author included), approving review bodies, other labels', () => {
  const cases = {
    'an automated reviewer\'s thread and comment': [approved(1, { issueComments: [comment('ci-bot[bot]', 20)], ...withThread('review-bot[bot]') }), {}, 1],
    '--self': [approved(1, { issueComments: [comment('octocat', 20)], reviews: [approve('monalisa', 'head1', 10), review('octocat', 'COMMENTED', 'head1', 21, { body: 'note' })], ...withThread('octocat') }), {}, 1],
    'the author without write access': [approved(1, { issueComments: [comment('hubot', 20)], ...withThread('hubot') }), { hubot: 'read' }, 1],
    'an organization member without write access': [approved(1, { issueComments: [comment('member', 20)], ...withThread('member') }), { member: 'read' }, 1],
    'an approving review with a body': [approved(1, { reviews: [approve('monalisa', 'head1', 10), approve('octo-dev', 'head1', 20, { body: 'LGTM' })] }), {}, 0],
    'review-blocked': [approved(1, { labels: ['review-blocked'] }), {}, 0],
  };
  for (const [name, [p, permissions, threads]] of Object.entries(cases)) assert.deepEqual(world(repo([p]), { permissions }).run(['acme/app']).lines, [mergedLine(1, { threads })], name);
});

test('a later thread is released by a writer other than the author resolving it, by --self, or by a new approval; not by the author', () => {
  const cases = [
    ['the author, with write access', resolvedBy('hubot'), { hubot: 'write' }, triage('held by thread')],
    ['an account without write access', resolvedBy('member'), { member: 'read' }, triage('held by thread')],
    ['no reported resolver', resolvedBy(null), {}, triage('held by thread')],
    ['another writer', resolvedBy('monalisa'), {}, merged],
    ['--self', resolvedBy('octocat'), {}, merged],
  ];
  for (const [name, thread, permissions, expected] of cases) {
    assert.deepEqual(world(repo([approved(1, withThread('octo-dev', 20, thread))]), { permissions }).run(['acme/app']).lines, expected, name);
  }
  const w = world(repo([approved(1, { issueComments: [comment('octo-dev', 21)], ...withThread('octo-dev') })]));
  assert.deepEqual(w.run(['acme/app']).lines, triage('held by thread, comment'));
  w.update((x) => x.repos['acme/app'].prs[0].reviews.push(approve('octocat', 'head1', 30)));
  assert.deepEqual(w.run(['acme/app']).writes, [], 'an approval by --self releases nothing');
  w.update((x) => x.repos['acme/app'].prs[0].reviews.push(approve('octo-dev', 'head1', 31)));
  assert.deepEqual(w.run(['acme/app']).lines, [mergedLine(1, { threads: 1 })], 'a counting approval after it');
});

test('a PR in conflict, and one a branch rule blocks, are each reported once per head and not merged', () => {
  for (const [over, what] of [[{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'conflict'], [{ mergeStateStatus: 'BLOCKED' }, 'a branch rule blocks the merge']]) {
    const w = world(repo([approved(1, over)]));
    const r = w.run(['acme/app']);
    assert.deepEqual(r.lines, triage(what));
    assert.deepEqual(r.writes, []);
    assert.deepEqual(w.run(['acme/app']).lines, []);
  }
});

test('a PR waits while an open PR from the same repository is based on its branch, and merges once that one is gone', () => {
  const prs = [approved(2, { headRefName: 'b', baseRefName: 'a' }), approved(1, { headRefName: 'a' })];
  const w = world(repo(prs));
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, [mergedLine(2, { base: 'a', how: 'merge commit' }), 'stack acme/app#1: waits for #2']);
  assert.deepEqual(first.writes, [['pr', 'merge', '2', '--repo', 'acme/app', '--merge', '--match-head-commit', 'head2']]);
  // #1's head is now GitHub's merge of #2. Without a clone only an approval of that head covers it.
  w.update((x) => x.repos['acme/app'].prs[1].reviews.push(approve('monalisa', 'merge2', 40)));
  assert.deepEqual(w.run(['acme/app']).lines, [mergedLine(1, { head: 'merge2' })]);
});

test('the child that makes a PR wait may be unapproved, a draft, or outside the arguments; a fork\'s PR does not count', () => {
  const parent = () => approved(1, { headRefName: 'a' });
  const waits = ['stack acme/app#1: waits for #2'];
  const w = world(repo([pr(2, { baseRefName: 'a' }), parent()]));
  assert.deepEqual(w.run(['acme/app']).lines, waits);
  assert.deepEqual(w.run(['acme/app']).lines, [], 'once per head');
  assert.deepEqual(world(repo([pr(2, { baseRefName: 'a', isDraft: true }), parent()])).run(['acme/app']).lines, waits, 'a draft');
  assert.deepEqual(world(repo([pr(2, { baseRefName: 'a' }), parent()])).run(['acme/app#1']).lines, waits, 'not among the arguments');
  assert.deepEqual(world(repo([pr(2, { baseRefName: 'a', isCrossRepository: true }), parent()])).run(['acme/app']).lines, merged, 'a fork');
  const forkParent = approved(1, { headRefName: 'main', isCrossRepository: true });
  assert.deepEqual(world(repo([pr(2), forkParent])).run(['acme/app']).lines, merged, 'a fork\'s branch name is not a base in this repository');
});

test('the merge method follows the base and what the repository allows', () => {
  const stack = (settings) => world(repo([approved(2, { headRefName: 'b', baseRefName: 'a' }), pr(1, { headRefName: 'a' })], { settings })).run(['acme/app']);
  const single = (settings, over = {}) => world(repo([approved(1, over)], { settings })).run(['acme/app']);
  assert.equal(single({}).writes[0][5], '--squash');
  assert.equal(single({ allow_squash_merge: false }).writes[0][5], '--merge');
  const rebase = single({ allow_squash_merge: false, allow_merge_commit: false });
  assert.equal(rebase.writes[0][5], '--rebase');
  assert.deepEqual(rebase.lines, [mergedLine(1, { how: 'rebase' })]);
  assert.deepEqual(single({}, { baseRefName: 'release/1.2' }).lines, [mergedLine(1, { base: 'release/1.2' })], 'a release branch');
  assert.equal(stack({}).writes[0][5], '--merge');
  assert.equal(stack({ allow_merge_commit: false }).writes[0][5], '--squash');
  assert.equal(stack({ allow_merge_commit: false, allow_squash_merge: false }).writes[0][5], '--rebase');
});

test('a PR behind its base is updated with a merge commit, pinned to its head, and the run goes on', () => {
  const r = world(repo([approved(1, { mergeStateStatus: 'BEHIND' })])).run(['acme/app']);
  assert.deepEqual(r.lines, ['synced acme/app#1 head head1']);
  assert.deepEqual(r.writes, [['api', '-X', 'PUT', 'repos/acme/app/pulls/1/update-branch', '-f', 'expected_head_sha=head1']]);
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

test('a failed required check is run again once per head, then reported once as still red; one that is no workflow job is reported', () => {
  const checks = [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 77 }, { name: 'docs', required: false, conclusion: 'FAILURE', runId: 78 }];
  const w = world(repo([approved(1, { mergeStateStatus: 'BLOCKED', checks })], { runs: { 77: { status: 'completed', conclusion: 'failure', run_attempt: 1 } } }));
  const first = w.run(['acme/app']);
  assert.deepEqual(first.lines, ['rerun acme/app#1 head head1: run 77']);
  assert.deepEqual(first.writes, [['api', '-X', 'POST', 'repos/acme/app/actions/runs/77/rerun-failed-jobs']]);
  w.update((x) => { x.repos['acme/app'].runs[77].run_attempt = 2; });
  const second = w.run(['acme/app']);
  assert.deepEqual(second.lines, triage('required check still red after one re-run'));
  assert.deepEqual(second.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
  const external = approved(1, { mergeStateStatus: 'BLOCKED', checks: [{ context: 'ci/external\ntriage x', state: 'FAILURE', required: true }] });
  assert.deepEqual(world(repo([external])).run(['acme/app']).lines, triage('required check failed and cannot be re-run'));
  const held = approved(1, { mergeStateStatus: 'BLOCKED', checks, issueComments: [comment('monalisa', 20)] });
  assert.deepEqual(world(repo([held])).run(['acme/app']).writes, [], 'not on a held PR');
});

const bump = (n, over = {}) => pr(n, { author: 'pin-bot', authorType: 'Bot', mergeStateStatus: 'BLOCKED', files: [{ filename: 'deps/core.pin' }], ...over });
const AUTO = ['--automated', 'pin-bot[bot]', '--automated-path', 'deps/*.pin', '--automated-path', '**/lock.json'];
const approvedLine = ['approved acme/app#1 (automated)'];

test('an automated PR is approved, which does not end the run, and merged by a later scan once GitHub counts the approval', () => {
  const w = world(repo([bump(1)]));
  const first = w.run([...AUTO, 'acme/app']);
  assert.deepEqual(first.lines, approvedLine);
  assert.deepEqual(first.writes, [['api', '-X', 'POST', 'repos/acme/app/pulls/1/reviews', '-f', 'event=APPROVE', '-f', 'commit_id=head1']]);
  w.update((x) => { x.repos['acme/app'].prs[0].mergeStateStatus = 'CLEAN'; });
  assert.deepEqual(w.run([...AUTO, 'acme/app']).lines, merged);
  const oneRun = world(repo([bump(1, { mergeStateStatus: 'CLEAN' })])).run([...AUTO, '--interval', '0.1', 'acme/app'], { deadline: '20' });
  assert.deepEqual(oneRun.lines, [...approvedLine, ...merged]);
});

test('the automated route applies whenever no counting approval covers the head: a rebased head, and one a person approved earlier', () => {
  assert.deepEqual(world(repo([bump(1, { reviews: [approve('octocat', 'old', 5)] })])).run([...AUTO, 'acme/app']).lines, approvedLine);
  assert.deepEqual(world(repo([bump(1, { reviews: [approve('monalisa', 'old', 5)] })])).run([...AUTO, 'acme/app']).lines, approvedLine);
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
  for (const [account, p, matches] of cases) {
    const r = world(repo([p])).run(['--automated', account, '--automated-path', 'deps/*.pin', 'acme/app']);
    assert.deepEqual(r.lines, matches ? approvedLine : [], `${account} ${p.authorType} ${p.isCrossRepository}`);
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
    const r = world(repo([bump(1, { files })])).run([...AUTO, 'acme/app']);
    assert.deepEqual(r.lines, approves ? approvedLine : [], name);
    if (!approves) assert.deepEqual(r.writes, [], name);
  }
  assert.deepEqual(world(repo([bump(1, { changedFiles: 3001 })])).run([...AUTO, 'acme/app']).lines, [], 'more files than GitHub lists');
});

test('a head pushed between reading the files and approving is not approved', () => {
  const w = world(repo([bump(1, { pushAfterFiles: 'head1b' })]));
  const r = w.run([...AUTO, 'acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('the script withdraws its own approval when the head is not automated, and only its own', () => {
  const mine = approve('octocat', 'old', 5);
  const w = world(repo([bump(1, { files: [{ filename: 'src/main.js' }], reviews: [mine] })]));
  const r = w.run([...AUTO, 'acme/app']);
  assert.deepEqual(r.lines, triage('automated approval withdrawn'));
  assert.deepEqual(r.writes, [['api', '-X', 'PUT', `repos/acme/app/pulls/1/reviews/${mine.id}/dismissals`, '-f', 'message=This head is not an automated change.', '-f', 'event=DISMISS']]);
  assert.deepEqual(w.run([...AUTO, 'acme/app']).writes, []);
  const agent = approve('octocat', 'old', 5, { body: '<!-- concord-approve: old round:1 base:x -->\nApproved.' });
  assert.deepEqual(world(repo([bump(1, { files: [{ filename: 'src/main.js' }], reviews: [agent] })])).run([...AUTO, 'acme/app']).writes, [], 'an approval with a body is not the script\'s');
  const person = pr(1, { reviews: [approve('octocat', 'head1', 5)] });
  assert.deepEqual(world(repo([person])).run([...AUTO, 'acme/app']).writes, [], 'not on a person\'s pull request');
  const readOnly = world(repo([bump(1, { files: [{ filename: 'src/main.js' }], reviews: [approve('octocat', 'old', 5)] })])).run(['--no-merge', ...AUTO, 'acme/app']);
  assert.deepEqual(readOnly.writes, []);
});

test('an automated PR gets the same holds, lines and re-run: every item from a counting account holds it', () => {
  const failing = bump(1, { checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 5 }] });
  assert.deepEqual(world(repo([failing])).run([...AUTO, 'acme/app']).lines, ['rerun acme/app#1 head head1: run 5']);
  assert.deepEqual(world(repo([bump(1, { issueComments: [comment('monalisa', 5)] })])).run([...AUTO, 'acme/app']).lines, triage('held by comment'));
  assert.deepEqual(world(repo([bump(1, { reviews: [review('monalisa', 'CHANGES_REQUESTED', 'head1', 5)] })])).run([...AUTO, 'acme/app']).lines, triage('changes requested'));
  assert.deepEqual(world(repo([bump(1, { mergeable: 'CONFLICTING' })])).run([...AUTO, 'acme/app']).lines, triage('conflict'));
  const botTalk = bump(1, { issueComments: [comment('pin-bot[bot]', 5)] });
  assert.deepEqual(world(repo([botTalk])).run([...AUTO, 'acme/app']).lines, approvedLine, 'the automation account\'s own comments do not hold');
});

test('--automated needs --automated-path, and takes no title prefix', () => {
  const w = world(repo([]));
  assert.equal(w.run(['--automated', 'pin-bot[bot]', 'acme/app']).code, 2);
  assert.equal(w.run(['--automated', 'pin-bot[bot]:chore(deps):', '--automated-path', 'deps/**', 'acme/app']).code, 2);
});

test('--no-merge writes nothing: it reports ready, and where it would have updated a branch or re-run a check', () => {
  const prs = [
    approved(1),
    bump(2),
    approved(3, { mergeStateStatus: 'BEHIND' }),
    approved(4, { mergeStateStatus: 'BLOCKED', checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 9 }] }),
  ];
  const w = world(repo(prs));
  const r = w.run(['--no-merge', ...AUTO, 'acme/app']);
  assert.deepEqual(r.lines, ['ready acme/app#1 head head1', 'ready acme/app#2 head head2', 'triage acme/app#3 head head3: behind its base', 'triage acme/app#4 head head4: required check failed']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--no-merge', ...AUTO, 'acme/app']).lines, []);
});

test('text other people control cannot add a line', () => {
  const forged = 'x\ntriage acme/app#9 head deadbeef: conflict';
  const checks = [{ name: 'build', required: true }, { name: forged, required: false, conclusion: 'FAILURE' }];
  assert.deepEqual(world(repo([approved(1, { mergeStateStatus: 'UNSTABLE', checks })])).run(['acme/app']).lines, [mergedLine(1, { notPassed: 1 })]);
  const refused = world(repo([approved(1)]), { mergeError: { 1: forged } }).run(['acme/app']);
  assert.deepEqual(refused.lines, ['merge failed acme/app#1 head head1: refused']);
  assert.doesNotMatch(refused.stderr, /triage/);
  const own = pr(1, { author: 'octocat', ...withThread('monalisa', 20, {}, { path: forged, html_url: 'https://github.com/x\ntriage y' }) });
  assert.deepEqual(world(repo([own])).run(['--mine', 'octocat', 'acme/app']).lines, ['review acme/app#1 head head1: thread comment by monalisa']);
  const branch = world(repo([approved(1, { baseRefName: `rel\n${forged}` })])).run(['acme/app']);
  assert.equal(branch.lines.length, 1, branch.stdout);
  assert.ok(branch.lines[0].length < 200);
});
