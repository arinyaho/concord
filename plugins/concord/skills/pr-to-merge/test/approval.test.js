'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, gitPr } = require('./world');

const repo = (...prs) => ({ 'acme/app': { prs } });
const merges = (r) => r.writes.filter((c) => c[0] === 'pr');

test('an approval by a collaborator who was not requested counts, and the PR is squash-merged at its head', () => {
  const w = world(repo(pr(1, { reviews: [approve('monalisa', 'head1', 10, { author_association: 'COLLABORATOR' })] })));
  const r = w.run(['acme/app']);
  assert.deepEqual(r.lines, ['merged acme/app#1 into main (squash) head head1']);
  assert.deepEqual(merges(r), [['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'head1']]);
  assert.equal(r.code, 0);
});

test('an approval by the author or by someone outside the repository does not count', () => {
  for (const reviews of [
    [approve('hubot', 'head1')],
    [approve('stranger', 'head1', 10, { author_association: 'CONTRIBUTOR' })],
    [approve('stranger', 'head1', 10, { author_association: 'NONE' })],
  ]) {
    const r = world(repo(pr(1, { reviews }))).run(['acme/app']);
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.writes, []);
  }
});

test('a reviewer whose latest review requests changes blocks, and a later comment-only review does not withdraw it', () => {
  const blocked = [
    [approve('monalisa', 'head1', 10), review('octo-dev', 'CHANGES_REQUESTED', 'head1', 11)],
    [approve('monalisa', 'head1', 10), review('octo-dev', 'CHANGES_REQUESTED', 'head1', 11), review('octo-dev', 'COMMENTED', 'head1', 12)],
  ];
  for (const reviews of blocked) assert.deepEqual(world(repo(pr(1, { reviews }))).run(['acme/app']).writes, []);
  const cleared = [review('octo-dev', 'CHANGES_REQUESTED', 'head1', 9), approve('octo-dev', 'head1', 10)];
  assert.deepEqual(world(repo(pr(1, { reviews: cleared }))).run(['acme/app']).lines, ['merged acme/app#1 into main (squash) head head1']);
});

test('reviews on a later page are read', () => {
  const reviews = [review('a', 'COMMENTED', 'head1', 1, { body: '' }), review('b', 'COMMENTED', 'head1', 2, { body: '' }), review('c', 'COMMENTED', 'head1', 3, { body: '' }), approve('monalisa', 'head1', 10)];
  assert.deepEqual(world(repo(pr(1, { reviews }))).run(['acme/app']).lines, ['merged acme/app#1 into main (squash) head head1']);
});

// The git history: c0 on main; the PR commits A (approved); then what each case adds.
function covered(build, commits = {}) {
  const g = gitPr(5, build);
  const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', headRefOid: g.head, reviews: [approve('monalisa', g.approved)] })], commits } });
  return { g, w, r: w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']) };
}

test('an approval on an older head followed only by clean merges of the base covers the head', () => {
  const { g, r } = covered(({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    sh('checkout', '-q', 'main'); edit('one\ntwo\nTHREE\n', 'B');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-edit', 'main');
    sh('checkout', '-q', 'main'); edit('one\ntwo\nTHREE\nfour\n', 'C');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-edit', 'main');
    return { approved };
  });
  assert.deepEqual(r.lines, [`merged acme/app#5 into main (squash) head ${g.head.slice(0, 8)}`]);
  assert.ok(!r.calls.some((c) => c.some((x) => /\/commits\//.test(x))), 'a clean base merge needs no API call');
});

test('merge commits by --self cover the head whatever they merged: a stack bottom whose squash failed merges on the next scan', () => {
  // The bottom PR was approved at A; the script then merged the child (based on A) into it, and the squash failed.
  const g = gitPr(5, ({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    sh('checkout', '-q', '-b', 'child'); edit('ONE\ntwo\nthree\nchild\n', 'X');
    sh('checkout', '-q', 'pr'); sh('merge', '-q', '--no-ff', '--no-edit', 'child');
    return { approved };
  });
  for (const [author, expected] of [['octocat', [`merged acme/app#5 into main (squash) head ${g.head.slice(0, 8)}`]], ['hubot', [`triage acme/app#5 head ${g.head.slice(0, 8)}: approved on an older head only`]]]) {
    const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', headRefOid: g.head, reviews: [approve('monalisa', g.approved)] })], commits: { [g.head]: { author } } } });
    assert.deepEqual(w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']).lines, expected, author);
  }
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

test('a conflict-resolution merge made by --self covers the head; one made by anyone else does not', () => {
  const g = gitPr(5, conflictMerge);
  for (const [author, expected] of [['octocat', [`merged acme/app#5 into main (squash) head ${g.head.slice(0, 8)}`]], ['hubot', [`triage acme/app#5 head ${g.head.slice(0, 8)}: approved on an older head only`]]]) {
    const w = world({ 'acme/app': { prs: [pr(5, { headRefName: 'pr', headRefOid: g.head, reviews: [approve('monalisa', g.approved)] })], commits: { [g.head]: { author } } } });
    assert.deepEqual(w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']).lines, expected, author);
  }
});

test('any other commit after the approval leaves only an older head approved, reported once per head', () => {
  const { g, w, r } = covered(({ edit, sh }) => {
    sh('checkout', '-q', '-b', 'pr');
    const approved = edit('ONE\ntwo\nthree\n', 'A');
    edit('ONE\nTWO\nthree\n', 'more work');
    return { approved };
  });
  assert.deepEqual(r.lines, [`triage acme/app#5 head ${g.head.slice(0, 8)}: approved on an older head only`]);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(w.run(['--checkout', `acme/app=${g.checkout}`, 'acme/app']).lines, []);
});

test('without --checkout only an approval on the current head covers it', () => {
  const r = world(repo(pr(1, { reviews: [approve('monalisa', 'older')] }))).run(['acme/app']);
  assert.deepEqual(r.lines, ['triage acme/app#1 head head1: approved on an older head only']);
});
