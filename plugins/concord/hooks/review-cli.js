#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { resolveStateDirFromCwd } = require('./lib/statedir');
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
    const { ledger: next, noOp } = beginRound(ledger, diffHash);
    writeLedger(stateDir, slug, next);
    process.stdout.write(JSON.stringify({ round: next.round, noOp, status: next.status, budget: next.budget }) + '\n');
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

try {
  main();
} catch (e) {
  process.stderr.write(`review-cli: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
