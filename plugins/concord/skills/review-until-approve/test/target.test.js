'use strict';
// The tracked checkout inventory the runner compares before and after each reviewer, so a reviewer that edits the checkout fails the round.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gitDirty, trackedCheckoutInventory, changedTrackedPath, pathLeavesRoot } = require('../scripts/runner/target');
const { tempDir } = require('../../../hooks/test/temp-dir');

// A temp repository with two commits and a clean working tree.
function makeGitRepo() {
  const dir = tempDir('ruit-repo-');
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
  assert.match(inventoryOf(dir).get('link'), /^\|link:\d+:/, 'a symlink fingerprint carries its own mode');
  assert.strictEqual(changeAfter(dir, () => fs.rmSync(path.join(dir, 'gone.txt'))), 'gone.txt');
  assert.strictEqual(changeAfter(dir, () => { fs.rmSync(path.join(dir, 'swap.txt')); fs.mkdirSync(path.join(dir, 'swap.txt')); }), 'swap.txt');
});

test('tracked inventory: a parent directory swapped for an outside symlink fails closed or is reported', (t) => {
  const dir = inventoryRepo(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), 'same\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'sub');
  const outside = tempDir('ruit-outside-');
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

test('tracked inventory: a mode change on a submodule directory is reported', (t) => {
  if (process.platform === 'win32') return;
  for (const initialized of [true, false]) {
    const dir = inventoryRepo(t); const upstream = inventoryRepo(t);
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'submodule');
    if (!initialized) { fs.rmSync(path.join(dir, 'sub'), { recursive: true }); fs.mkdirSync(path.join(dir, 'sub')); }
    assert.strictEqual(changeAfter(dir, () => fs.chmodSync(path.join(dir, 'sub'), 0o700)), 'sub', `initialized=${initialized}`);
  }
});

test('tracked inventory: an uninitialized submodule directory over the name cap fails closed', (t) => {
  const dir = inventoryRepo(t); const upstream = inventoryRepo(t);
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'submodule');
  fs.rmSync(path.join(dir, 'sub'), { recursive: true }); fs.mkdirSync(path.join(dir, 'sub'));
  for (let i = 0; i < 1001; i++) fs.writeFileSync(path.join(dir, 'sub', `f${String(i).padStart(4, '0')}`), '');
  assert.throws(() => inventoryOf(dir), /harness-failure.*inventory bound/);
});

test('tracked inventory: a parent on another Windows volume leaves the checkout', () => {
  assert.strictEqual(pathLeavesRoot(path.win32.relative('C:\\repo', 'D:\\outside'), path.win32), true);
  assert.strictEqual(pathLeavesRoot(path.win32.relative('C:\\repo', 'C:\\outside'), path.win32), true);
  assert.strictEqual(pathLeavesRoot(path.win32.relative('C:\\repo', 'C:\\repo\\sub'), path.win32), false);
  assert.strictEqual(pathLeavesRoot('..hidden'), false);
});
