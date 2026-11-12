'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, gitPr, sh } = require('./world');

const repo = (...prs) => ({ 'acme/app': { prs } });
const merges = (r) => r.writes.filter((c) => c[0] === 'pr');
const merged = (n, head = `head${n}`) => [`merged acme/app#${n} into main (squash) head ${head.slice(0, 8)}; not passed: 0; unresolved threads: 0`];

test('an approval by any account with write access counts, requested or not, and the PR is squash-merged at its head', () => {
  for (const role of ['write', 'maintain', 'admin']) {
    const r = world(repo(pr(1, { reviews: [approve('monalisa', 'head1', 10, { author_association: 'CONTRIBUTOR' })] })), { permissions: { monalisa: role } }).run(['acme/app']);
    assert.deepEqual(r.lines, merged(1), role);
    assert.deepEqual(merges(r), [['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'head1']], role);
  }
});

test('an approval by the author, by a read-only member, or by an account whose access cannot be read does not count', () => {
  for (const [reviews, permissions] of [
    [[approve('hubot', 'head1')], { hubot: 'write' }],
    [[approve('nobody-here', 'head1')], {}],
    [[approve('review-bot[bot]', 'head1')], {}],
    [[approve('monalisa', 'head1')], { monalisa: 'read' }],
    [[approve('monalisa', 'head1')], { monalisa: 'triage' }],
    [[approve('monalisa', 'head1')], { monalisa: 'error' }],
  ]) {
    const r = world(repo(pr(1, { reviews })), { permissions }).run(['acme/app']);
    assert.deepEqual(r.lines, [], JSON.stringify(permissions));
    assert.deepEqual(r.writes, []);
    if (permissions.monalisa === 'error') assert.match(r.stderr, /permission of monalisa/);
  }
});

test('an approval by --self never counts, alone or on an ordinary pull request', () => {
  const r = world(repo(pr(1, { reviews: [approve('octocat', 'head1')] }))).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
  const both = world(repo(pr(1, { reviews: [approve('octocat', 'head1'), approve('monalisa', 'older')] }))).run(['acme/app']);
  assert.deepEqual(both.lines, ['triage acme/app#1 head head1: approved on an older head only'], 'only the other approval is judged');
});

test('a lost approval, for example to a dismissal, is simply not approved and prints nothing', () => {
  const r = world(repo(pr(1, { reviews: [review('monalisa', 'DISMISSED', 'older', 10)] }))).run(['acme/app']);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.writes, []);
});

test('an approval whose body begins with a concord-approve line never counts, whoever posted it', () => {
  const agent = approve('monalisa', 'head1', 10, { body: '<!-- concord-approve: head1 round:2 base:abc -->\nApproved.' });
  assert.deepEqual(world(repo(pr(1, { reviews: [agent] }))).run(['acme/app']).lines, []);
  assert.deepEqual(world(repo(pr(1, { reviews: [agent, approve('octo-dev', 'head1', 11)] }))).run(['acme/app']).lines, merged(1));
  const quoted = approve('monalisa', 'head1', 10, { body: 'Approved; see <!-- concord-approve: x round:1 base:y -->' });
  assert.deepEqual(world(repo(pr(1, { reviews: [quoted] }))).run(['acme/app']).lines, merged(1), 'only a first line counts as the marker');
});

test('the write access of an approver is read once per scan', () => {
  const r = world(repo(pr(1, { reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] }))).run(['acme/app']);
  assert.equal(r.calls.filter((c) => /permission$/.test(c[1] || '')).length, 1);
});

test('a counting account\'s latest review requesting changes holds with its own line; a comment-only review does not withdraw it', () => {
  const changes = ['triage acme/app#1 head head1: changes requested'];
  const held = [
    [approve('monalisa', 'head1', 10), review('octo-dev', 'CHANGES_REQUESTED', 'head1', 11)],
    [approve('monalisa', 'head1', 10), review('octo-dev', 'CHANGES_REQUESTED', 'head1', 11), review('octo-dev', 'COMMENTED', 'head1', 12)],
    [review('octo-dev', 'CHANGES_REQUESTED', 'head1', 5), approve('monalisa', 'head1', 10)],
  ];
  for (const reviews of held) {
    const w = world(repo(pr(1, { reviews })));
    const r = w.run(['acme/app']);
    assert.deepEqual(r.lines, changes);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(w.run(['acme/app']).lines, [], 'once per head');
  }
  const cleared = [review('octo-dev', 'CHANGES_REQUESTED', 'head1', 9), approve('octo-dev', 'head1', 10)];
  assert.deepEqual(world(repo(pr(1, { reviews: cleared }))).run(['acme/app']).lines, merged(1));
  const ignored = {
    'an account without write access': [review('member', 'CHANGES_REQUESTED', 'head1', 11), { member: 'read' }],
    'the author without write access': [review('hubot', 'CHANGES_REQUESTED', 'head1', 11), { hubot: 'read' }],
    'an automation account': [review('review-bot[bot]', 'CHANGES_REQUESTED', 'head1', 11), {}],
    '--self': [review('octocat', 'CHANGES_REQUESTED', 'head1', 11), {}],
  };
  for (const [name, [r, permissions]] of Object.entries(ignored)) {
    assert.deepEqual(world(repo(pr(1, { reviews: [approve('monalisa', 'head1', 10), r] })), { permissions }).run(['acme/app']).lines, merged(1), name);
  }
});

test('reviews on a later page are read', () => {
  const reviews = [review('a', 'COMMENTED', 'head1', 1), review('b', 'COMMENTED', 'head1', 2), review('c', 'COMMENTED', 'head1', 3), approve('monalisa', 'head1', 10)];
  assert.deepEqual(world(repo(pr(1, { reviews }))).run(['acme/app']).lines, merged(1));
});

test('a review with no commit covers nothing and does not stop the scan', () => {
  const r = world(repo(pr(1, { reviews: [approve('monalisa', null)] }))).run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved on an older head only']);
  assert.equal(r.stderr, '');
});

// The git history: c0 on main; the PR commits A (approved); then what each case adds.
function run(build, { commits = {} } = {}) {
  const g = gitPr(5, build);
  const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', headRefOid: g.head, reviews: [approve('monalisa', g.approved)] })], commits: typeof commits === 'function' ? commits(g) : commits } });
  return { g, w, r: w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']) };
}
const stale = (g) => [`triage acme/app#5 head ${g.head.slice(0, 8)}: approved on an older head only`];

test('an approval on an older head followed only by clean merges of the base covers the head, with no API call', () => {
  const { g, r } = run(({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    sh('checkout', '-q', 'main'); edit('one\ntwo\nTHREE\n', 'B');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-edit', 'main');
    sh('checkout', '-q', 'main'); edit('one\ntwo\nTHREE\nfour\n', 'C');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-edit', 'main');
    return { approved };
  });
  assert.deepEqual(r.lines, merged(5, g.head));
  assert.ok(!r.calls.some((c) => c.some((x) => /\/commits\//.test(x))), 'a clean base merge needs no API call');
});

function conflictMerge({ edit, sh, work }) {
  sh('checkout', '-q', '-b', 'pr');
  const approved = edit('ONE\ntwo\nthree\n', 'A');
  sh('checkout', '-q', 'main'); edit('uno\ntwo\nthree\n', 'B');
  sh('checkout', '-q', 'pr');
  try { sh('merge', '-q', '--no-edit', 'main'); } catch (_) { /* the conflict is expected */ }
  require('node:fs').writeFileSync(`${work}/a.txt`, 'ONE uno\ntwo\nthree\n');
  sh('commit', '-q', '-am', 'Merge main, keeping both');
  return { approved };
}

test('a conflict merge keeps coverage only when GitHub made it for --self, never by the author field', () => {
  const cases = [
    ['forged author', { author: 'octocat', committer: 'octocat', verified: false }, false],
    ['web-flow, unverified', { author: 'octocat', committer: 'web-flow', verified: false }, false],
    ['web-flow merge by someone else', { author: 'hubot', committer: 'web-flow', verified: true }, false],
    ['web-flow merge by --self', { author: 'octocat', committer: 'web-flow', verified: true }, true],
  ];
  for (const [name, commit, covers] of cases) {
    const { g, r } = run(conflictMerge, { commits: (h) => ({ [h.head]: commit }) });
    assert.deepEqual(r.lines, covers ? merged(5, g.head) : stale(g), name);
    if (!covers) assert.deepEqual(r.writes, [], name);
  }
});

test('a merge commit GitHub made for --self covers the head whatever it merged: a stack bottom whose child was merged into it merges', () => {
  const build = ({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    sh('checkout', '-q', '-b', 'child'); edit('ONE\ntwo\nthree\nchild\n', 'X');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-ff', '--no-edit', 'child');
    return { approved };
  };
  const self = run(build, { commits: (g) => ({ [g.head]: { author: 'octocat', committer: 'web-flow', verified: true } }) });
  assert.deepEqual(self.r.lines, merged(5, self.g.head));
  const forged = run(build, { commits: (g) => ({ [g.head]: { author: 'octocat', committer: 'octocat' } }) });
  assert.deepEqual(forged.r.lines, stale(forged.g));
});

test('any other commit after the approval leaves only an older head approved, reported once per head', () => {
  const { g, w, r } = run(({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    edit('ONE\nTWO\nthree\n', 'more work');
    return { approved };
  });
  assert.deepEqual(r.lines, stale(g));
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']).lines, []);
});

test('a clean merge counts only from the pull request\'s own base: the default branch merged into a release-branch PR does not cover', () => {
  const build = (mergeFrom) => ({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'release');
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    sh('checkout', '-q', mergeFrom); edit(mergeFrom === 'main' ? 'one\ntwo\nTHREE\n' : 'one\ntwo\nthree\nfix\n', 'B');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-edit', mergeFrom);
    return { approved };
  };
  for (const [from, covers] of [['main', false], ['release', true]]) {
    const g = gitPr(5, build(from));
    const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', baseRefName: 'release', headRefOid: g.head, reviews: [approve('monalisa', g.approved)] })] } });
    const r = w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']);
    assert.deepEqual(r.lines, covers ? [`merged acme/app#5 into release (squash) head ${g.head.slice(0, 8)}; not passed: 0; unresolved threads: 0`] : stale(g), from);
  }
});

test('without --checkout only an approval on the current head covers it', () => {
  const r = world(repo(pr(1, { reviews: [approve('monalisa', 'older')] }))).run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved on an older head only']);
});

test('a --checkout path that is not a clone is a usage error', () => {
  const w = world(repo());
  const r = w.run(['--checkout', `acme/app=${w.dir}`, 'acme/app']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /merge-tree --write-tree/);
});

test('end to end: a branch behind its base is updated, the approval covers the new head, and a later scan merges', () => {
  const g = gitPr(5, ({ edit, sh: git }) => {
    git('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    git('checkout', '-q', 'main'); edit('one\ntwo\nTHREE\n', 'B');
    git('checkout', '-q', 'pr');
    return { approved };
  });
  const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', headRefOid: g.head, mergeStateStatus: 'BEHIND', reviews: [approve('monalisa', g.approved)] })] } });
  const args = ['--checkout', `acme/app=${g.checkout}`, 'acme/app'];
  const first = w.run(args);
  assert.deepEqual(first.lines, [`synced acme/app#5 head ${g.head.slice(0, 8)}`]);
  assert.deepEqual(first.writes, [['api', '-X', 'PUT', 'repos/acme/app/pulls/5/update-branch', '-f', `expected_head_sha=${g.head}`]]);
  // What GitHub does for the update: a merge of the base into the branch, committed by web-flow for --self.
  sh(g.work, 'merge', '-q', '--no-edit', 'main');
  const updated = sh(g.work, 'rev-parse', 'HEAD');
  sh(g.work, 'push', '-q', g.bare, 'pr', `pr:refs/pull/5/head`);
  w.update((x) => {
    Object.assign(x.repos['acme/app'].prs[0], { headRefOid: updated, mergeStateStatus: 'CLEAN' });
    x.repos['acme/app'].commits = { [updated]: { author: 'octocat', committer: 'web-flow', verified: true } };
  });
  assert.deepEqual(w.run(args).lines, merged(5, updated));
});
