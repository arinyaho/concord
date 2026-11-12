'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');

function sh(bin, args, opts = {}) {
  // opts.cwd is the reviewed repository at every call site in this file --
  // excluded from PATH resolution for the same reason as target.js's sh().
  return execFileSync(crossPlatformCommand(bin, opts.cwd), crossPlatformArgs(args, needsDoubleEscape(bin, opts.cwd)), crossPlatformOpts({ encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts }));
}

function pathWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const MAX_REVIEW_SOURCE_BYTES = 20 * 1024 * 1024;
// Reviewer-supplied paths are evidence, not trusted filenames. Resolve inside
// the checkout and inspect an opened regular file before reading bounded bytes.
function readReviewSource(repoRoot, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) return null;
  let fd;
  try {
    const root = fs.realpathSync(repoRoot);
    const requested = path.resolve(root, file);
    const real = fs.realpathSync(requested);
    if (!pathWithin(real, root) || real !== requested) return null; // a symlink anywhere on the path is not the file itself
    const before = fs.lstatSync(real);
    if (!before.isFile() || before.size > MAX_REVIEW_SOURCE_BYTES) return null;
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_REVIEW_SOURCE_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    if (fs.realpathSync(requested) !== real) return null;
    const after = fs.lstatSync(real);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) return null;
    const chunks = []; let total = 0;
    while (total <= MAX_REVIEW_SOURCE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_REVIEW_SOURCE_BYTES + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total).toString('utf8');
      chunks.push(chunk.subarray(0, count)); total += count;
    }
  } catch (_) { /* Unsafe or unavailable evidence cannot supply a source span. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

// True only when the path is provably absent inside the checkout: every
// Changed paths the reviewer did not examine. A path whose bytes at the
// reviewed head equal those of an examined changed path is covered: the
// generated bundle copies are byte copies of their source, which bundle-drift
// tests enforce. A deleted path has no blob and must be listed by name.
function unexaminedPaths(repoRoot, ledger, changed, examinedList, base) {
  const examined = new Set(examinedList);
  const head = ledger.target?.head_sha;
  let missing = changed.filter((file) => !examined.has(file));
  if (!missing.length || !head) return missing;
  // The old path of a rename between the round's base and head has no blob at
  // head; it is covered once the reviewer lists the new path. A deleted path
  // keeps the rule above: it must be listed by name.
  if (base) {
    try {
      const f = sh('git', ['diff', '--name-status', '-M', '-z', base, head], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
      const renamedTo = new Map();
      for (let i = 0; i < f.length; i++) if (/^R/.test(f[i])) { renamedTo.set(f[i + 1], f[i + 2]); i += 2; } else i += 1;
      missing = missing.filter((file) => !(renamedTo.has(file) && examined.has(renamedTo.get(file))));
    } catch (_) { /* no rename information: fall back to the by-name rule */ }
    if (!missing.length) return missing;
  }
  // One batched call resolves every path's blob at head; a path absent at head has none.
  const files = [...new Set(changed)];
  let out;
  try { out = sh('git', ['cat-file', '--batch-check'], { cwd: repoRoot, input: files.map((file) => `${head}:${file}\n`).join(''), stdio: ['pipe', 'pipe', 'ignore'] }).split('\n'); } catch (_) { return missing; }
  const blobs = new Map(files.map((file, i) => [file, /^[0-9a-f]+ blob /.test(out[i] || '') ? out[i].split(' ')[0] : null]));
  const covered = new Set(changed.filter((file) => examined.has(file)).map((file) => blobs.get(file)).filter(Boolean));
  return missing.filter((file) => !covered.has(blobs.get(file)));
}

function roundCandidates(gc, cJson, vJson) {
  const byId = new Map();
  for (const f of gc.parseGateFindings(JSON.stringify((vJson && vJson.findings) || []))) byId.set(f.id, f);
  for (const f of gc.parseGateFindings(JSON.stringify((cJson && cJson.findings) || []))) byId.set(f.id, f);
  return Array.from(byId.values());
}

function toGateFinding(f) {
  const seg = String(f.id).split(':');
  const cls = seg.length >= 3 && seg[1] ? seg[1] : 'cross-context';
  return { id: f.id, class: cls, file: f.file, evidence: f.span || '', requirement: f.requirement || '', summary: f.summary };
}

// Fold a round's gate-review candidates + gate-verify verdict + the ledger's
// dismissed set into the open gate findings for this round. Report-only:
// deliberately NOT filtered to changed files (the cross-context case is an
// UNCHANGED sibling that a changed line's guarantee depends on -- filtering to
// changed files, as the intent detector does, would drop exactly the class the
// gate exists to catch). Each finding is re-derived fresh every round, so a
// later fix that resolves a gap simply stops the gate raising it.
function foldGateFindings({ gateFindings, verifyRejectedIds, dismissedIds }) {
  const rejected = new Set(verifyRejectedIds || []);
  const dismissed = new Set(dismissedIds || []);
  return (gateFindings || [])
    .filter((f) => !rejected.has(f.id) && !dismissed.has(f.id))
    .map((f) => ({ ...toGateFinding(f), ...(f.releaseBlocking !== undefined ? { releaseBlocking: f.releaseBlocking } : {}), ...(f.rationale !== undefined ? { rationale: f.rationale } : {}) }));
}

function gateFollowUpEligible(f) {
  return Array.isArray(f.releaseBlocking) && f.releaseBlocking.length === 0
    && typeof f.rationale === 'string' && f.rationale.trim() !== '' && !f.blockingReason;
}

function targetSlug(ref) {
  const slug = String(ref || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

const INTENT_MAX_BYTES = 256 * 1024;
function readIntentFile(file, readFileFn = fs.readFileSync) {
  let text;
  try { text = String(readFileFn(file, 'utf8')); } catch (e) {
    throw new Error(`harness-failure: intent file ${file} is unreadable: ${e && e.message ? e.message : e}`);
  }
  if (text.trim() === '') throw new Error(`harness-failure: intent file ${file} is empty`);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > INTENT_MAX_BYTES) throw new Error(`harness-failure: intent file ${bytes} bytes exceeds cap ${INTENT_MAX_BYTES}`);
  return { text, sha: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), bytes };
}

module.exports = { readReviewSource, unexaminedPaths, roundCandidates, foldGateFindings, gateFollowUpEligible, targetSlug, readIntentFile };
