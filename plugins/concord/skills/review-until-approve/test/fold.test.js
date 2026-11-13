'use strict';
// The runner's fold helpers: which changed paths a correctness artifact left unexamined, how gate findings fold, and the target slug.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fold = require('../scripts/runner/fold');
const { tempDir } = require('../../../hooks/test/temp-dir');

function tmpDir() { return tempDir('fold-'); }

function initRepo() {
  const repo = tempDir('fold-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

test('unexaminedPaths resolves every changed path with one git call and keeps its result (#286)', { skip: process.platform === 'win32' }, () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'same\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'same\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'other\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'files'], { cwd: repo });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const log = path.join(tmpDir(), 'git.log');
  const bin = tmpDir();
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$1" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const pathBefore = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${pathBefore}`;
  try {
    // b.txt shares a blob with the examined a.txt; c.txt differs; gone.txt is absent at head.
    const missing = fold.unexaminedPaths(repo, { target: { head_sha: head } }, ['a.txt', 'b.txt', 'c.txt', 'gone.txt'], ['a.txt']);
    assert.deepStrictEqual(missing, ['c.txt', 'gone.txt']);
  } finally { process.env.PATH = pathBefore; }
  assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('unexaminedPaths: the old path of a rename is covered by the new path; a modified or deleted path still needs its name (#463)', { skip: process.platform === 'win32' }, () => {
  const repo = initRepo();
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'old.txt'), 'renamed content line one\nline two\nline three\n');
  fs.writeFileSync(path.join(repo, 'mod.txt'), 'before\n');
  fs.writeFileSync(path.join(repo, 'del.txt'), 'delete me\n');
  git('add', '-A'); git('commit', '-qm', 'files');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'old.txt', 'new.txt');
  fs.writeFileSync(path.join(repo, 'mod.txt'), 'after\n');
  git('rm', '-q', 'del.txt');
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD');
  const ledger = { target: { base_sha: base, head_sha: head } };
  const changed = ['del.txt', 'mod.txt', 'new.txt', 'old.txt'];
  assert.deepStrictEqual(fold.unexaminedPaths(repo, ledger, changed, ['new.txt'], base), ['del.txt', 'mod.txt']);
  assert.deepStrictEqual(fold.unexaminedPaths(repo, ledger, changed, ['mod.txt', 'del.txt'], base), ['new.txt', 'old.txt']);
  // A base after the rename puts the rename outside the range: the old path is not covered.
  fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n');
  git('add', '-A'); git('commit', '-qm', 'later');
  const later = git('rev-parse', 'HEAD');
  assert.deepStrictEqual(fold.unexaminedPaths(repo, { target: { head_sha: later } }, changed, ['new.txt'], head), ['del.txt', 'mod.txt', 'old.txt']);
  // No base: rename detection is skipped.
  assert.deepStrictEqual(fold.unexaminedPaths(repo, ledger, changed, ['new.txt']), ['del.txt', 'mod.txt', 'old.txt']);
});

test('foldGateFindings: drops verify-rejected and dismissed, keeps unchanged-file findings', () => {
  const gateFindings = [
    { id: 'gate:silent-gap:sibling-reopen', file: 'src/unchanged_sibling.js', span: 'spawn(opts)', summary: 'sibling reopens the gate', requirement: 'must not reopen a resolved sibling' },
    { id: 'gate:ac-coverage:missing-validate', file: 'src/verify.js', span: '', summary: 'design requires a target-exists check', requirement: 'verify must check the target exists' },
    { id: 'gate:cross-context:ac-b-partial', file: 'src/promote.js', span: '', summary: 'AC-B only partial', requirement: 'AC-B: automated end-to-end' },
  ];
  const out = fold.foldGateFindings({
    gateFindings,
    verifyRejectedIds: ['gate:cross-context:ac-b-partial'],   // a false positive
    dismissedIds: ['gate:ac-coverage:missing-validate'],      // human-accepted/deferred
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'gate:silent-gap:sibling-reopen');
  assert.strictEqual(out[0].class, 'silent-gap'); // non-default class, actually derived (not a hardcoded default)
  assert.strictEqual(out[0].evidence, 'spawn(opts)'); // evidence maps from the finding's span
  assert.strictEqual(out[0].requirement, 'must not reopen a resolved sibling'); // requirement passes through
  assert.strictEqual(out[0].summary, 'sibling reopens the gate'); // summary passes through
  assert.strictEqual(out[0].file, 'src/unchanged_sibling.js'); // NOT filtered though it is an unchanged file
});

test('foldGateFindings: class derives from the id segment, defaults to cross-context', () => {
  const out = fold.foldGateFindings({
    gateFindings: [{ id: 'gate:only-two-segments', file: 'a.js', span: '', summary: 's', requirement: '' }],
    verifyRejectedIds: [],
    dismissedIds: [],
  });
  assert.strictEqual(out[0].class, 'cross-context');
});

test('targetSlug: branch names with "/" become "-"', () => {
  assert.strictEqual(fold.targetSlug('feat/review-until-green-shell'), 'feat-review-until-green-shell');
});

test('targetSlug: PR ref "#123" strips the "#"', () => {
  assert.strictEqual(fold.targetSlug('#123'), '123');
});

test('targetSlug: empty/absent ref falls back to "unknown"', () => {
  assert.strictEqual(fold.targetSlug(''), 'unknown');
  assert.strictEqual(fold.targetSlug(undefined), 'unknown');
});

test('targetSlug: collapses runs of unsafe chars and trims edges', () => {
  assert.strictEqual(fold.targetSlug('weird//: name!!'), 'weird-name');
});
