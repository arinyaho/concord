'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, gitPr } = require('./world');

const repo = (...prs) => ({ 'acme/app': { prs } });
const merges = (r) => r.writes.filter((c) => c[0] === 'pr');
const merged = (n, head = `head${n}`) => [`merged acme/app#${n} into main (squash) head ${head.slice(0, 8)}`];

test('an approval by any account with write access counts, requested or not, and the PR is squash-merged at its head', () => {
  for (const role of ['write', 'maintain', 'admin']) {
    const r = world(repo(pr(1, { reviews: [approve('monalisa', 'head1', 10, { author_association: 'CONTRIBUTOR' })] })), { permissions: { monalisa: role } }).run(['acme/app']);
    assert.deepEqual(r.lines, merged(1), role);
    assert.deepEqual(merges(r), [['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'head1']], role);
  }
});

test('an approval by the author, by a read-only member, or by an account whose access cannot be read does not count', () => {
  for (const [reviews, permissions] of [
    [[approve('hubot', 'head1')], {}],
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

test('a lost approval is reported once per head; one still standing, or one requested again, is not', () => {
  const dismissed = review('monalisa', 'DISMISSED', 'older', 10);
  const w = world(repo(pr(1, { reviews: [dismissed] })));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approval dismissed']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['acme/app']).lines, []);
  w.update((x) => { x.repos['acme/app'].prs[0].headRefOid = 'head1b'; });
  assert.deepEqual(w.run(['acme/app']).lines, ['triage acme/app#1 head head1b: approval dismissed']);
  const changes = review('monalisa', 'DISMISSED', 'older', 10, { previous: 'CHANGES_REQUESTED' });
  assert.deepEqual(world(repo(pr(1, { reviews: [changes] }))).run(['acme/app']).lines, [], 'a dismissed request for changes');
  const selfDismissed = review('octocat', 'DISMISSED', 'older', 10);
  assert.deepEqual(world(repo(pr(1, { reviews: [selfDismissed] }))).run(['acme/app']).lines, [], '--self\'s dismissed approval');
  const still = pr(1, { reviews: [review('octo-dev', 'DISMISSED', 'older', 5), approve('monalisa', 'head1', 10)] });
  assert.deepEqual(world(repo(still)).run(['acme/app']).lines, merged(1), 'another approval still stands');
});

test('the write access of an approver is read once per scan', () => {
  const r = world(repo(pr(1, { reviews: [approve('monalisa', 'head1')] }), pr(2, { reviews: [approve('monalisa', 'head2')] }))).run(['acme/app']);
  assert.equal(r.calls.filter((c) => /permission$/.test(c[1] || '')).length, 1);
});

test('a reviewer whose latest review requests changes blocks, and a later comment-only review does not withdraw it', () => {
  const blocked = [
    [approve('monalisa', 'head1', 10), review('octo-dev', 'CHANGES_REQUESTED', 'head1', 11)],
    [approve('monalisa', 'head1', 10), review('octo-dev', 'CHANGES_REQUESTED', 'head1', 11), review('octo-dev', 'COMMENTED', 'head1', 12)],
  ];
  for (const reviews of blocked) assert.deepEqual(world(repo(pr(1, { reviews }))).run(['acme/app']).writes, []);
  const cleared = [review('octo-dev', 'CHANGES_REQUESTED', 'head1', 9), approve('octo-dev', 'head1', 10)];
  assert.deepEqual(world(repo(pr(1, { reviews: cleared }))).run(['acme/app']).lines, merged(1));
  const stranger = [approve('monalisa', 'head1', 10), review('member', 'CHANGES_REQUESTED', 'head1', 11)];
  assert.deepEqual(world(repo(pr(1, { reviews: stranger })), { permissions: { member: 'read' } }).run(['acme/app']).lines, merged(1), 'a request for changes without write access is ignored');
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
function run(build, { commits = {}, issueComments = [] } = {}) {
  const g = gitPr(5, build);
  const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', headRefOid: g.head, reviews: [approve('monalisa', g.approved)], issueComments: issueComments.map((c) => c(g)) })], commits: typeof commits === 'function' ? commits(g) : commits } });
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

test('a conflict merge counts as --self\'s only by GitHub\'s own record or a --self marker comment, never by the author field', () => {
  const cases = [
    ['forged author', { commits: (g) => ({ [g.head]: { author: 'octocat', committer: 'octocat', verified: false } }) }, false],
    ['web-flow, unverified', { commits: (g) => ({ [g.head]: { author: 'octocat', committer: 'web-flow', verified: false } }) }, false],
    ['web-flow merge by someone else', { commits: (g) => ({ [g.head]: { author: 'hubot', committer: 'web-flow', verified: true } }) }, false],
    ['web-flow merge by --self', { commits: (g) => ({ [g.head]: { author: 'octocat', committer: 'web-flow', verified: true } }) }, true],
    ['marker by --self', { issueComments: [(g) => comment('octocat', 30, { body: `Merged main, keeping both sides.\n<!-- pr-to-merge:merge ${g.head} -->` })] }, true],
    ['marker by someone else', { issueComments: [(g) => comment('monalisa', 30, { body: `<!-- pr-to-merge:merge ${g.head} -->` })] }, false],
    ['marker by --self naming a short sha', { issueComments: [(g) => comment('octocat', 30, { body: `<!-- pr-to-merge:merge ${g.head.slice(0, 12)} -->` })] }, false],
  ];
  for (const [name, setup, covers] of cases) {
    const { g, r } = run(conflictMerge, setup);
    if (covers) assert.deepEqual(r.lines, merged(5, g.head), name);
    else assert.deepEqual(r.lines.filter((l) => l.startsWith('triage') && l.endsWith('older head only')), stale(g), name);
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
    assert.deepEqual(r.lines, covers ? [`merged acme/app#5 into release (squash) head ${g.head.slice(0, 8)}`] : stale(g), from);
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
