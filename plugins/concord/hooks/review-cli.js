#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { resolveStateDirFromCwd } = require('./lib/statedir');
const dodExec = require('./lib/dod-exec');
const {
  targetSlug,
  readLedger,
  writeLedger,
  emptyLedger,
  contentHash,
  beginRound,
  applyRoundOutcome,
  unparkFinding,
} = require('./lib/review');

function resolveStateDir() {
  if (process.env.REVIEW_STATE_DIR) return process.env.REVIEW_STATE_DIR;
  return resolveStateDirFromCwd();
}

// Impure git/DoD boundary. lib/review.js and lib/gate-contract.js stay pure
// (no child_process, no fs beyond ledger I/O); all process/git/DoD work for
// the orchestrator lives here so it can be injected/tested against a real
// temp repo without touching the caller's own working tree.
function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
}
function gitDiff(repoRoot, base) {
  const args = base ? ['diff', `${base}...HEAD`] : ['diff', 'HEAD'];
  return sh('git', args, { cwd: repoRoot });
}
function gitCommitFix(repoRoot, findingId, summary) {
  sh('git', ['add', '-A'], { cwd: repoRoot });
  sh('git', ['commit', '-m', `fix(review-until-green): ${findingId}\n\n${summary}`], { cwd: repoRoot });
  return sh('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
}
function gitIsReachable(repoRoot, sha) {
  try {
    sh('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: repoRoot });
    return true;
  } catch (e) {
    return false;
  }
}
function gitIsDirty(repoRoot) {
  return sh('git', ['status', '--porcelain'], { cwd: repoRoot }).trim().length > 0;
}
function gitCheckoutTree(repoRoot) {
  sh('git', ['checkout', '--', '.'], { cwd: repoRoot });
}
function runDod(repoRoot) {
  const cfg = dodExec.loadDodConfig(repoRoot);
  return dodExec.runDodExec({ cwd: repoRoot, commands: cfg.dod, execFn: dodExec.defaultExecFn });
}

// User/agent-supplied data (the diff, finding text, summaries) always arrives via
// STDIN as JSON, never as an argv token -- the same shell-injection-safe pattern
// charter-cli.js uses for `set`. Only the target ref and a finding id (both
// caller-controlled identifiers, not free text) are taken from argv.
function readStdinJson() {
  const raw = fs.readFileSync(0, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function requireRef(ref, verb) {
  if (!ref) throw new Error(`review-cli ${verb}: missing required <ref> argument`);
}

function main() {
  const [verb, ref, ...rest] = process.argv.slice(2);
  const stateDir = resolveStateDir();

  if (verb === 'show') {
    requireRef(ref, 'show');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug) || emptyLedger({ kind: 'local', ref });
    process.stdout.write(JSON.stringify(ledger) + '\n');
    return;
  }

  if (verb === 'round-start') {
    requireRef(ref, 'round-start');
    const slug = targetSlug(ref);
    const payload = readStdinJson();
    const target = payload.target || { kind: 'local', ref };
    const ledger = readLedger(stateDir, slug) || emptyLedger(target);
    const diffHash = contentHash(payload.diff || '');
    const { ledger: next, noOp, workHappened, terminal } = beginRound(ledger, diffHash);
    writeLedger(stateDir, slug, next);
    const out = { round: next.round, noOp, workHappened, status: next.status, budget: next.budget };
    if (terminal) out.message = `Already ${next.status}; not starting a new round.`;
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  if (verb === 'record') {
    requireRef(ref, 'record');
    const slug = targetSlug(ref);
    const outcome = readStdinJson();
    const ledger = readLedger(stateDir, slug) || emptyLedger({ kind: 'local', ref });
    const { ledger: next, decision } = applyRoundOutcome(ledger, outcome);
    writeLedger(stateDir, slug, next);
    process.stdout.write(JSON.stringify({ status: next.status, decision }) + '\n');
    return;
  }

  if (verb === 'unpark') {
    requireRef(ref, 'unpark');
    const findingId = rest[0];
    if (!findingId) throw new Error('review-cli unpark: missing required <findingId> argument');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`review-cli unpark: no ledger for ref "${ref}"`);
    const next = unparkFinding(ledger, findingId);
    writeLedger(stateDir, slug, next);
    process.stdout.write(`unparked ${findingId}; ledger status is now "${next.status}".\n`);
    return;
  }

  throw new Error(`review-cli: unknown verb "${verb}" (expected show | round-start | record | unpark)`);
}

module.exports = { gitDiff, gitCommitFix, gitIsReachable, gitIsDirty, gitCheckoutTree, runDod };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`review-cli: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}
