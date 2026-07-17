'use strict';
// Target-type seam: turns a target spec into the text-under-review + identity +
// whether it carries a Definition of Done. Phase 1 implements the git target
// (behavior-preserving extract from review-cli.js round-start); a later task
// adds a diffless file target. The git command invocations here are moved
// verbatim from review-cli.js -- same args, same cwd -- so the git/code review
// path stays byte-identical.
const { execFileSync } = require('node:child_process');

function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
}

// Moved verbatim from review-cli.js gitDiff(). base ? range diff : working-tree
// diff vs HEAD.
function gitDiff(repoRoot, base) {
  const args = base ? ['diff', `${base}...HEAD`] : ['diff', 'HEAD'];
  return sh('git', args, { cwd: repoRoot });
}

// Moved verbatim from review-cli.js round-start L434 (`git rev-parse HEAD`).
function gitHeadSha(repoRoot) {
  return sh('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
}

// Moved verbatim from review-cli.js gitIsDirty() -- the working-tree dirty check.
function gitDirty(repoRoot) {
  return sh('git', ['status', '--porcelain'], { cwd: repoRoot }).trim().length > 0;
}

// Acquire a git target: the same dirty-check + identity + diff review-cli.js
// round-start ran inline. The dirty-tree throw fires on the identical condition
// and carries the identical message, so the fresh-start git path is unchanged.
function gitTarget(spec, repoRoot) {
  if (gitDirty(repoRoot)) throw new Error('round-start: working tree is dirty; commit or stash before review-until-green');
  const identity = gitHeadSha(repoRoot);
  const reviewText = gitDiff(repoRoot, spec.base);
  return { type: 'git', reviewText, identity, hasDoD: true, key: spec.ref };
}

function acquireTarget(spec, repoRoot) {
  // Phase 1: a spec carrying a git ref -> git target. (file target added later.)
  return gitTarget(spec, repoRoot);
}

module.exports = { acquireTarget, gitTarget, gitDiff, gitHeadSha, gitDirty };
