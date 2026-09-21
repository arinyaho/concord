'use strict';
// Target-type seam: turns a target spec into the text-under-review + identity +
// whether it carries a Definition of Done. Phase 1 implements the git target
// (behavior-preserving extract from review-cli.js round-start); Task 2 adds
// the diffless file target. The git command invocations here are moved verbatim
// from review-cli.js -- same args, same cwd -- so the git/code review path
// stays byte-identical.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
// NOTE (finding #5): the diff is computed here, before round-start's separate
// reachability/resetUnreachable step. gitDiff is read-only and depends only on
// (repoRoot, base); resetUnreachable mutates only the ledger, not the tree or
// base. The two are input-independent, so their relative order is a true
// no-op -- head_sha, diff, and the ledger end identical either way.
function gitTarget(spec, repoRoot) {
  if (gitDirty(repoRoot)) throw new Error('round-start: working tree is dirty; commit or stash before review-until-green');
  const identity = gitHeadSha(repoRoot);
  const reviewText = gitDiff(repoRoot, spec.base);
  return { type: 'git', reviewText, identity, hasDoD: true };
}

// Content hash for a file target's identity (SHA-1 of the concatenated review
// text). Using SHA-1 matches the existing contentHash in review.js; 40-hex
// chars satisfy the /^[0-9a-f]{7,}$/ identity contract used in tests.
function contentHash(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// Resolve a Phase-1 glob (literal path or a simple single-'*' wildcard) against
// repoRoot to a sorted list of relative paths. Braces and '**' are out of scope
// for Phase 1 and are treated as literal characters (not expanded). Files that
// are directories are excluded; the match is case-sensitive (platform default).
function resolveGlob(glob, repoRoot) {
  const starIdx = glob.indexOf('*');
  if (starIdx === -1) {
    // Literal path -- no globbing needed.
    return [glob];
  }
  // Single '*': split on the first '*' to get prefix and suffix relative to
  // repoRoot. The '*' matches any sequence of characters NOT including '/'.
  const prefix = glob.slice(0, starIdx);
  const suffix = glob.slice(starIdx + 1);
  // Compute the directory to list and the filename prefix to match.
  // Cases:
  //   '*.md'     -> prefix='', dir=repoRoot, filePrefix=''
  //   'docs/*.md'  -> prefix='docs/', dir=<repoRoot>/docs, filePrefix=''
  //   'doc-*.md' -> prefix='doc-', dir=repoRoot, filePrefix='doc-'
  let dir;
  let filePrefix;
  const lastSlash = prefix.lastIndexOf('/');
  if (lastSlash === -1) {
    // No slash in prefix: the '*' is in the root dir of repoRoot.
    dir = repoRoot;
    filePrefix = prefix; // may be empty (e.g. '*.md') or a partial name (e.g. 'doc-*.md')
  } else {
    // Slash present: the part before lastSlash+1 is a subdirectory.
    dir = path.join(repoRoot, prefix.slice(0, lastSlash));
    filePrefix = prefix.slice(lastSlash + 1); // may be empty (e.g. 'docs/*.md')
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return []; // directory does not exist -> no matches
  }
  const matched = entries
    .filter((name) => {
      if (!name.startsWith(filePrefix)) return false;
      if (suffix && !name.endsWith(suffix)) return false;
      const abs = path.join(dir, name);
      try { return fs.statSync(abs).isFile(); } catch (e) { return false; }
    })
    .map((name) => {
      const abs = path.join(dir, name);
      return path.relative(repoRoot, abs);
    });
  return matched.sort();
}

// File target: reads each matched file's current content, concatenates them with
// '===== <relpath> =====' headers (sorted), content-hashes the result for
// identity, and carries hasDoD:false. Does NOT invoke git at any point.
function fileTarget(spec, repoRoot) {
  // Resolve each entry in spec.files (may be literal paths or simple globs).
  const rels = [];
  for (const pattern of spec.files) {
    const resolved = resolveGlob(pattern, repoRoot);
    for (const r of resolved) {
      if (!rels.includes(r)) rels.push(r);
    }
  }
  rels.sort();
  // A file target that matches nothing has no text to review and would
  // otherwise hash the empty string and silently "converge" on an empty
  // review. Fail loudly instead so a typo'd path or a glob with no match is
  // reported, not swallowed.
  if (rels.length === 0) {
    throw new Error(`round-start: file target matched no files: ${spec.files.join(', ')}`);
  }
  const blocks = rels.map((rel) => {
    const abs = path.resolve(repoRoot, rel);
    let body;
    try {
      body = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      // A literal path (no '*') is passed through by resolveGlob unresolved, so
      // a nonexistent literal reaches here. Report it as a clear no-such-file
      // error rather than a raw ENOENT stack.
      throw new Error(`round-start: file target could not read "${rel}": ${e.code || e.message}`);
    }
    return `===== ${rel} =====\n${body}\n`;
  });
  const reviewText = blocks.join('\n');
  return {
    type: 'file',
    reviewText,
    identity: contentHash(reviewText),
    hasDoD: false,
  };
}

function acquireTarget(spec, repoRoot) {
  // Dispatch: a spec with spec.files (array) -> file target (no git).
  // Any other spec (with a ref) -> git target.
  if (spec && Array.isArray(spec.files)) return fileTarget(spec, repoRoot);
  return gitTarget(spec, repoRoot);
}

module.exports = { acquireTarget, gitTarget, fileTarget, gitDiff, gitHeadSha, gitDirty };
