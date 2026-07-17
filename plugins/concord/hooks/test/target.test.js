'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { acquireTarget } = require('../../core/target');

// Non-git temp directory helper: a plain temp dir with NO git init. Used to
// verify the file target performs zero git operations.
function mkdtempNonGit() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
}

// Inline git-repo helper mirroring review-cli.test.js: init a temp repo with a
// committed change against a base, leaving a CLEAN working tree (so the git
// target's dirty-check passes) while `git diff base...HEAD` is non-empty.
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // Second commit -> a non-empty base...HEAD diff on a clean tree.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: dir });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, headSha };
}

test('acquireTarget git: reviewText is the diff, identity is HEAD sha, hasDoD true', () => {
  const { dir, headSha } = makeGitRepo();
  const t = acquireTarget({ ref: 'feat/x', base: 'HEAD~1' }, dir);
  assert.strictEqual(t.type, 'git');
  assert.strictEqual(t.hasDoD, true);
  assert.match(t.identity, /^[0-9a-f]{40}$/);
  assert.strictEqual(t.identity, headSha);
  assert.ok(t.reviewText.includes('diff --git'), 'reviewText should be a git diff');
  // The ledger is keyed off the CLI ref (targetSlug(ref)); acquireTarget does
  // not carry a redundant `key` field (finding #5 -- dead contract removed).
  assert.strictEqual('key' in t, false, 'git target must not carry a computed-but-unused key field');
});

test('acquireTarget git: base undefined diffs the working tree vs HEAD (empty on a clean tree)', () => {
  const { dir } = makeGitRepo();
  // Clean tree + base undefined -> `git diff HEAD` is empty; identity is still HEAD.
  const t = acquireTarget({ ref: 'HEAD', base: undefined }, dir);
  assert.strictEqual(t.type, 'git');
  assert.strictEqual(t.reviewText, '');
});

test('acquireTarget git: dirty working tree throws the identical round-start error', () => {
  const { dir } = makeGitRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n'); // uncommitted
  assert.throws(
    () => acquireTarget({ ref: 'HEAD', base: undefined }, dir),
    /working tree is dirty; commit or stash before review-until-green/,
  );
});

// ---- file target tests (Task 2) ----

test('acquireTarget file: reviewText contains file content, identity is a hex hash, hasDoD false', () => {
  const dir = mkdtempNonGit();
  fs.writeFileSync(path.join(dir, 'note.md'), '# Note\nclaim without evidence\n');
  const t = acquireTarget({ files: ['note.md'] }, dir);
  assert.strictEqual(t.type, 'file');
  assert.strictEqual(t.hasDoD, false);
  assert.ok(t.reviewText.includes('claim without evidence'), 'reviewText must contain the file body');
  assert.ok(t.reviewText.includes('===== note.md ====='), 'reviewText must contain the section header');
  assert.match(t.identity, /^[0-9a-f]{7,}$/, 'identity must be a hex string (content hash)');
});

test('acquireTarget file: does not carry a computed-but-unused key field (finding #5)', () => {
  const dir = mkdtempNonGit();
  fs.writeFileSync(path.join(dir, 'a.md'), 'A\n');
  fs.writeFileSync(path.join(dir, 'b.md'), 'B\n');
  const t = acquireTarget({ files: ['b.md', 'a.md'] }, dir);
  // The ledger keys off the CLI ref (targetSlug(ref)), not a resolved-relpath
  // slug -- so a stable `file:*.md` invocation keys the same ledger every run.
  // `key` was dead (round-start ignored it) and is removed to keep the contract
  // clean and the ledger identity stable across sessions.
  assert.strictEqual('key' in t, false, 'file target must not carry a computed-but-unused key field');
});

test('acquireTarget file: multiple files are sorted and concatenated with section headers', () => {
  const dir = mkdtempNonGit();
  fs.writeFileSync(path.join(dir, 'z.md'), 'Z content\n');
  fs.writeFileSync(path.join(dir, 'a.md'), 'A content\n');
  const t = acquireTarget({ files: ['z.md', 'a.md'] }, dir);
  // Sorted order: a.md before z.md
  const aIdx = t.reviewText.indexOf('===== a.md =====');
  const zIdx = t.reviewText.indexOf('===== z.md =====');
  assert.ok(aIdx !== -1, 'a.md header must be present');
  assert.ok(zIdx !== -1, 'z.md header must be present');
  assert.ok(aIdx < zIdx, 'a.md must come before z.md (sorted order)');
});

test('acquireTarget file: identity changes when file content changes', () => {
  const dir = mkdtempNonGit();
  const fp = path.join(dir, 'note.md');
  fs.writeFileSync(fp, 'original\n');
  const t1 = acquireTarget({ files: ['note.md'] }, dir);
  fs.writeFileSync(fp, 'modified\n');
  const t2 = acquireTarget({ files: ['note.md'] }, dir);
  assert.notStrictEqual(t1.identity, t2.identity, 'identity must change when content changes');
});

test('acquireTarget file: performs NO git operation (no .git created in non-git dir)', () => {
  const dir = mkdtempNonGit();
  fs.writeFileSync(path.join(dir, 'note.md'), 'x\n');
  acquireTarget({ files: ['note.md'] }, dir);
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'file target must not create a .git directory');
});

test('acquireTarget file: simple single-* glob resolves matching files', () => {
  const dir = mkdtempNonGit();
  fs.writeFileSync(path.join(dir, 'doc-a.md'), 'Doc A\n');
  fs.writeFileSync(path.join(dir, 'doc-b.md'), 'Doc B\n');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a md\n');
  const t = acquireTarget({ files: ['*.md'] }, dir);
  assert.ok(t.reviewText.includes('doc-a.md'), 'glob must match doc-a.md');
  assert.ok(t.reviewText.includes('doc-b.md'), 'glob must match doc-b.md');
  assert.ok(!t.reviewText.includes('readme.txt'), 'glob must not match readme.txt');
});
