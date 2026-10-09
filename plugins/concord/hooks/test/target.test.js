'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { acquireTarget, fileTarget, gitDirty, trackedCheckoutInventory, changedTrackedPath, pathLeavesRoot } = require('../../core/target');

test('acquireTarget ignores only its own untracked review lock, keeping other dirty files visible', (t) => {
  const { dir } = makeGitRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, '.review-state', 'review-head.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
  const spec = { ref: 'HEAD', base: 'HEAD~1', reviewLock: lock };
  assert.strictEqual(acquireTarget(spec, dir).type, 'git');
  const sibling = path.join(dir, '.review-state', 'unrelated.txt');
  fs.writeFileSync(sibling, 'must remain visible');
  assert.throws(() => acquireTarget(spec, dir), /working tree is dirty/);
  fs.rmSync(sibling);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'tracked change');
  assert.throws(() => acquireTarget(spec, dir), /working tree is dirty/);
});

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

test('untrusted file-target identity caps the aggregate review text across files', () => {
  const dir = mkdtempNonGit();
  for (const name of ['a.md', 'b.md']) {
    const fd = fs.openSync(path.join(dir, name), 'w');
    try { fs.ftruncateSync(fd, 11 * 1024 * 1024); } finally { fs.closeSync(fd); }
  }
  assert.throws(() => fileTarget({ files: ['a.md', 'b.md'] }, dir, { untrusted: true }), /unsafe or oversized file target: b\.md/);
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

// --- index-independent tracked checkout inventory (#207) ---
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }); }
function inventoryOf(dir) { return trackedCheckoutInventory(dir, git(dir, 'rev-parse', 'HEAD').trim()); }
function inventoryRepo(t) {
  const { dir } = makeGitRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function changeAfter(dir, mutate) {
  const before = inventoryOf(dir);
  mutate();
  return changedTrackedPath(before, inventoryOf(dir));
}

test('tracked inventory: an unchanged checkout, including CRLF conversion, compares equal', (t) => {
  const dir = inventoryRepo(t);
  git(dir, 'config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt text=auto\n');
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nb\r\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'crlf');
  assert.strictEqual(changeAfter(dir, () => {}), null);
});

test('tracked inventory: an ordinary edit is reported', (t) => {
  const dir = inventoryRepo(t);
  assert.strictEqual(changeAfter(dir, () => fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n')), 'a.txt');
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`tracked inventory: an edit hidden by ${flag} is reported although git status is clean`, (t) => {
  const dir = inventoryRepo(t);
  git(dir, 'update-index', flag, 'a.txt');
  const changed = changeAfter(dir, () => fs.writeFileSync(path.join(dir, 'a.txt'), 'hidden edit\n'));
  assert.strictEqual(gitDirty(dir), false, 'the index flag hides the edit from git status');
  assert.strictEqual(changed, 'a.txt');
});

test('tracked inventory: mode, symlink target, deletion and type changes are reported', (t) => {
  const dir = inventoryRepo(t);
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'swap.txt'), 'x\n');
  fs.symlinkSync('x', path.join(dir, 'link'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'more');
  if (process.platform !== 'win32') assert.strictEqual(changeAfter(dir, () => fs.chmodSync(path.join(dir, 'run.sh'), 0o755)), 'run.sh');
  assert.strictEqual(changeAfter(dir, () => { fs.unlinkSync(path.join(dir, 'link')); fs.symlinkSync('y', path.join(dir, 'link')); }), 'link');
  assert.strictEqual(changeAfter(dir, () => fs.rmSync(path.join(dir, 'gone.txt'))), 'gone.txt');
  assert.strictEqual(changeAfter(dir, () => { fs.rmSync(path.join(dir, 'swap.txt')); fs.mkdirSync(path.join(dir, 'swap.txt')); }), 'swap.txt');
});

test('tracked inventory: a parent directory swapped for an outside symlink fails closed or is reported', (t) => {
  const dir = inventoryRepo(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), 'same\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'sub');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'f.txt'), 'same\n');
  const before = inventoryOf(dir);
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'sub'));
  try { assert.ok(changedTrackedPath(before, inventoryOf(dir))); } catch (e) { assert.match(e.message, /harness-failure/); }
});

test('tracked inventory: a tracked file over the read bound fails closed', (t) => {
  const dir = inventoryRepo(t);
  fs.writeFileSync(path.join(dir, 'big.bin'), '');
  fs.truncateSync(path.join(dir, 'big.bin'), 20 * 1024 * 1024 + 1);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'big');
  assert.throws(() => inventoryOf(dir), /harness-failure/);
});

test('tracked inventory: a sparse path stays missing and is reported once it appears', (t) => {
  const dir = inventoryRepo(t);
  git(dir, 'update-index', '--skip-worktree', 'a.txt');
  fs.rmSync(path.join(dir, 'a.txt'));
  assert.strictEqual(changeAfter(dir, () => {}), null);
  assert.strictEqual(changeAfter(dir, () => fs.writeFileSync(path.join(dir, 'a.txt'), 'back\n')), 'a.txt');
});

test('tracked inventory: edits inside an initialized submodule, even hidden by its index flags, are reported', (t) => {
  const dir = inventoryRepo(t);
  const upstream = inventoryRepo(t);
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'submodule');
  git(path.join(dir, 'sub'), 'update-index', '--assume-unchanged', 'a.txt');
  assert.strictEqual(changeAfter(dir, () => {}), null);
  assert.strictEqual(changeAfter(dir, () => fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'hidden\n')), 'sub/a.txt');
});

test('tracked inventory: files dropped into an uninitialized submodule directory are reported', (t) => {
  const dir = inventoryRepo(t);
  const upstream = inventoryRepo(t);
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'submodule');
  fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.strictEqual(changeAfter(dir, () => fs.writeFileSync(path.join(dir, 'sub', 'dropped.txt'), 'x\n')), 'sub');
});

test('tracked inventory: a tree listing larger than the default command buffer is read in full', (t) => {
  const dir = inventoryRepo(t);
  const blob = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
  const prefix = 'x'.repeat(70);
  const lines = [];
  for (let i = 0; i < 160000; i++) lines.push(`100644 ${blob}\t${prefix}${String(i).padStart(9, '0')}`);
  execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: lines.join('\n') + '\n', maxBuffer: 1 << 28 });
  const tree = git(dir, 'write-tree').trim();
  const commit = git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', '-m', 'many', tree).trim();
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: dir, maxBuffer: 1 << 28 }).length;
  assert.ok(listing > 20 * 1024 * 1024, `fixture listing is ${listing} bytes`);
  assert.strictEqual(trackedCheckoutInventory(dir, commit).size, 160001);
});

test('tracked inventory: a parent on another Windows volume leaves the checkout', () => {
  assert.strictEqual(pathLeavesRoot(path.win32.relative('C:\\repo', 'D:\\outside'), path.win32), true);
  assert.strictEqual(pathLeavesRoot(path.win32.relative('C:\\repo', 'C:\\outside'), path.win32), true);
  assert.strictEqual(pathLeavesRoot(path.win32.relative('C:\\repo', 'C:\\repo\\sub'), path.win32), false);
  assert.strictEqual(pathLeavesRoot('..hidden'), false);
});
