'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { acquireTarget } = require('../../core/target');

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
  assert.strictEqual(t.key, 'feat/x');
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
