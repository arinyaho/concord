'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { captureArtifactRoot, hashArtifact } = require('./bounded-artifact');
const { crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');

function sh(bin, args, opts = {}) {
  // opts.cwd is the reviewed repository at every call site in this file --
  // excluded from PATH resolution so a PATH contaminated by that
  // repository's own tooling (e.g. an npm/pnpm script prepending its
  // node_modules/.bin) cannot supply a trusted-looking binary.
  return execFileSync(crossPlatformCommand(bin, opts.cwd), crossPlatformArgs(args, needsDoubleEscape(bin, opts.cwd)), crossPlatformOpts({ encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts }));
}

// Splits Git's NUL-terminated output into UTF-8 strings, failing closed on a
// truncated, empty or non-UTF-8 entry.
function parseNulStrings(raw, label) {
  if (raw.length && raw[raw.length - 1] !== 0) throw new Error(`harness-failure: ${label} is not NUL terminated`);
  const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const strings = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0) continue;
    if (i === start) throw new Error(`harness-failure: ${label} contains an empty path`);
    try { strings.push(decode.decode(raw.subarray(start, i))); }
    catch (_) { throw new Error(`harness-failure: ${label} is not UTF-8`); }
    start = i + 1;
  }
  return strings;
}
function assertSafeRelativePath(file, label) {
  if (!file || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`harness-failure: ${label} contains an unsafe path`);
  }
}
function parseNulPaths(raw, label) {
  const paths = parseNulStrings(raw, label);
  for (const file of paths) assertSafeRelativePath(file, label);
  return paths;
}

// The range is the review base against the head; when the merge base is the head itself there is nothing to review.
function gitReviewSnapshot(repoRoot, baseCommit, headCommit) {
  const leftSha = sh('git', ['merge-base', baseCommit, headCommit], { cwd: repoRoot }).trim();
  if (leftSha === headCommit) throw new Error('harness-failure: review base and head resolve to the same commit; nothing to review');
  const reviewText = sh('git', ['diff', leftSha, headCommit, '--'], { cwd: repoRoot });
  const raw = sh('git', ['diff', '--name-only', '-z', '--no-renames', leftSha, headCommit, '--'], { cwd: repoRoot, encoding: null });
  const paths = parseNulPaths(raw, 'Git changed-path inventory');
  return { leftSha, headSha: headCommit, reviewText, paths: [...new Set(paths)].sort() };
}

function gitHeadSha(repoRoot) {
  return sh('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
}

function gitDirty(repoRoot) {
  return sh('git', ['status', '--porcelain'], { cwd: repoRoot }).trim().length > 0;
}

// Review-only runs prove the reviewer left the tracked checkout alone without
// asking the index, whose assume-unchanged and skip-worktree flags can hide an
// edit from `git status`. Paths come from the commit's tree object; each one is
// fingerprinted from the working tree with lstat and bounded reads, so no
// checkout filter (smudge, CRLF) runs and nothing follows a symlink. Two
// inventories of the same checkout are compared with changedTrackedPath. This
// proves "the reviewer changed no tracked path", not "the checkout equals the
// commit", and it does not cover untracked, ignored or generated files.
const INVENTORY_MAX_ENTRIES = 250000;
const INVENTORY_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const INVENTORY_BOUND_ERROR = 'harness-failure: tracked checkout exceeds the review-only inventory bound';
const UNINITIALIZED_SUBMODULE_NAMES = 1000;
// 250,000 entries of at most 4096-byte paths with their mode and object id.
const INVENTORY_LISTING_BYTES = 1100 * 1024 * 1024;

// True when a path.relative() result names a place outside its base, including
// another Windows volume, where the result is absolute.
function pathLeavesRoot(relative, pathModule = path) {
  return relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative);
}

function trackedCheckoutInventory(repoRoot, commitSha, budget = { entries: 0, bytes: 0 }, prefix = '') {
  const realRepo = fs.realpathSync(repoRoot);
  const label = 'Git tracked-path inventory';
  const raw = sh('git', ['ls-tree', '-r', '-z', '--full-tree', commitSha], { cwd: repoRoot, encoding: null, maxBuffer: INVENTORY_LISTING_BYTES });
  const inventory = new Map();
  const parents = new Map();
  const parentOf = (abs) => {
    const dir = path.dirname(abs);
    if (!parents.has(dir)) {
      let real = null;
      try { real = fs.realpathSync(dir); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
      if (real !== null && pathLeavesRoot(path.relative(realRepo, real))) throw new Error(`harness-failure: tracked path parent leaves the checkout: ${dir}`);
      parents.set(dir, real === null ? null : { rel: path.relative(realRepo, real), root: captureArtifactRoot(dir) });
    }
    return parents.get(dir);
  };
  for (const entry of parseNulStrings(raw, label)) {
    const tab = entry.indexOf('\t');
    const [mode] = entry.slice(0, tab).split(' ');
    const rel = entry.slice(tab + 1);
    if (tab < 0 || !mode) throw new Error(`harness-failure: ${label} is malformed`);
    assertSafeRelativePath(rel, label);
    if (++budget.entries > INVENTORY_MAX_ENTRIES) throw new Error(INVENTORY_BOUND_ERROR);
    const abs = path.join(realRepo, ...rel.split('/'));
    const parent = parentOf(abs);
    let stat = null;
    if (parent) {
      try { stat = fs.lstatSync(abs); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    }
    let fingerprint;
    if (!stat) fingerprint = 'missing';
    else if (mode === '160000') {
      if (!stat.isDirectory()) fingerprint = `other:${stat.mode}`;
      else if (fs.existsSync(path.join(abs, '.git'))) {
        const sha = sh('git', ['rev-parse', 'HEAD'], { cwd: abs }).trim();
        fingerprint = `gitlink:${stat.mode}:${sha}`;
        for (const [key, value] of trackedCheckoutInventory(abs, sha, budget, `${prefix}${rel}/`)) inventory.set(key, value);
      } else {
        const names = fs.readdirSync(abs).sort();
        if (names.length > UNINITIALIZED_SUBMODULE_NAMES) throw new Error(INVENTORY_BOUND_ERROR);
        fingerprint = `gitlink-empty:${stat.mode}:${names.join('\0')}`;
      }
    } else if (stat.isSymbolicLink()) fingerprint = `link:${stat.mode}:${fs.readlinkSync(abs, { encoding: 'buffer' }).toString('hex')}`;
    else if (stat.isDirectory()) fingerprint = `dir:${stat.mode}`;
    else if (!stat.isFile()) fingerprint = `other:${stat.mode}`;
    else {
      budget.bytes += stat.size;
      if (budget.bytes > INVENTORY_MAX_BYTES) throw new Error(INVENTORY_BOUND_ERROR);
      let digest;
      try { digest = hashArtifact(abs, parent.root); }
      catch (_) { throw new Error(`harness-failure: unsafe or oversized tracked file: ${prefix}${rel}`); }
      fingerprint = `file:${stat.mode}:${stat.size}:${digest}`;
    }
    inventory.set(`${prefix}${rel}`, `${parent ? parent.rel : ''}|${fingerprint}`);
  }
  return inventory;
}

// The first path whose fingerprint differs, or exists on only one side.
function changedTrackedPath(before, after) {
  for (const [file, fingerprint] of before) if (after.get(file) !== fingerprint) return file;
  for (const file of after.keys()) if (!before.has(file)) return file;
  return null;
}

module.exports = { gitReviewSnapshot, gitHeadSha, gitDirty, trackedCheckoutInventory, changedTrackedPath, pathLeavesRoot };
