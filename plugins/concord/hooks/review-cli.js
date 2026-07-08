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
  unparkFinding,
  resetUnreachable,
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
function gitCommitFix(repoRoot, findingId, summary, file) {
  // Stage only the finding's own file -- never `-A`. A whole-tree `git add -A`
  // sweeps in any other dirty content (untracked non-gitignored dirs, a
  // crash-recovery leftover, a driver-contract violation) and silently
  // mis-attributes it to this finding's commit.
  sh('git', ['add', '--', file], { cwd: repoRoot });
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
function gitIsDirtyForFile(repoRoot, file) {
  return sh('git', ['status', '--porcelain', '--', file], { cwd: repoRoot }).trim().length > 0;
}
function gitCheckoutTree(repoRoot) {
  sh('git', ['checkout', '--', '.'], { cwd: repoRoot });
}
function runDod(repoRoot) {
  const cfg = dodExec.loadDodConfig(repoRoot);
  return dodExec.runDodExec({ cwd: repoRoot, commands: cfg.dod, execFn: dodExec.defaultExecFn });
}

// Terminal handoff (design §8): rounds, killed/fixed/parked counts, a per-fix
// rationale digest, and the needs-decision packets -- the "one consolidated
// handoff" that replaces the manual review<->fix relay. Moved here from
// review-engine.js (the headless claude-p engine being retired) so `record`
// can render it without depending on the file that Task 11 deletes.
function renderHandoff(result) {
  const { ledger, cost, aborted } = result;
  const lines = [];
  lines.push(`review-until-green: target ${ledger.target && ledger.target.ref} -- status: ${ledger.status}`);
  lines.push(
    `rounds: ${ledger.round}/${ledger.budget.max_rounds} (spent ${ledger.budget.spent})  cost: $${cost.totalUsd.toFixed(4)} across ${cost.calls} call(s)`
  );
  if (aborted) lines.push(`ABORTED (${aborted.kind}): ${aborted.message}`);

  const fixed = (ledger.findings || []).filter((f) => f.status === 'fixed');
  const killedCount = (ledger.seen || []).filter((s) => s.status === 'killed').length;
  const parked = (ledger.findings || []).filter((f) => f.status === 'parked');
  lines.push(`findings: ${fixed.length} fixed, ${killedCount} killed (false-positive), ${parked.length} parked`);

  if (fixed.length) {
    lines.push('', 'Fix digest:');
    for (const f of fixed) lines.push(`  - [${f.id}] ${f.summary} -> commit ${f.fix_commit}`);
  }
  if (parked.length) {
    lines.push('', 'Needs-decision packets:');
    for (const f of parked) {
      const reason = f.park_reason || {};
      lines.push(`  - [${f.id}] ${f.file}: ${f.summary}`);
      lines.push(`    kind: ${reason.kind || 'unknown'} -- ${reason.text || '(no reason recorded)'}`);
    }
  }
  return lines.join('\n');
}

function requireRef(ref, verb) {
  if (!ref) throw new Error(`review-cli ${verb}: missing required <ref> argument`);
}

// Deletes any state-dir file for round n (diff, gate artifacts, fix artifacts)
// so a re-driven round never reads a stale artifact left over from a crashed
// or superseded attempt.
function deleteRoundArtifacts(stateDir, n) {
  let names = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return;
  }
  const prefix = `round-${n}-`;
  for (const nm of names) {
    if (nm.startsWith(prefix)) {
      try {
        fs.unlinkSync(path.join(stateDir, nm));
      } catch (e) {
        // best-effort cleanup
      }
    }
  }
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
    const base = rest[0];
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug) || emptyLedger({ kind: 'local', ref });

    // Capture BEFORE any mutation. Committed fixes from a crashed round change
    // the diff, so beginRound's noOp path (same diff hash -> no-op) cannot be
    // relied on to re-drive the same round -- we pin round/hash ourselves below
    // instead of calling beginRound at all on a resume.
    const resumed = ledger.phase === 'gates' || ledger.phase === 'fixes';
    const resumeRound = ledger.round;

    if (resumed) {
      gitCheckoutTree(repoRoot); // keep journaled commits, discard uncommitted
      deleteRoundArtifacts(stateDir, resumeRound);
      ledger = { ...ledger, phase: 'idle', planned: [] };
    } else if (gitIsDirty(repoRoot)) {
      throw new Error('round-start: working tree is dirty; commit or stash before review-until-green');
    }
    // Dirty check is skipped when resumed -- the checkout above already made the tree clean.

    const headSha = sh('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
    if (ledger.target && ledger.target.head_sha && !gitIsReachable(repoRoot, ledger.target.head_sha)) {
      ledger = resetUnreachable(ledger);
    }
    const diff = gitDiff(repoRoot, base);
    const diffHash = contentHash(diff);

    if (resumed) {
      // Resume re-drives round N at zero budget by pinning round/diff_content_hash
      // directly, bypassing beginRound. This is a real work round: it proceeds to
      // DoD + phase='gates' below, without advancing round or charging budget.
      ledger = { ...ledger, diff_content_hash: diffHash, round: resumeRound };
    } else {
      deleteRoundArtifacts(stateDir, ledger.round + 1); // stale artifacts for the round about to run
      const { ledger: begun, noOp, terminal } = beginRound(ledger, diffHash);
      ledger = begun;
      if (terminal) {
        writeLedger(stateDir, slug, ledger);
        process.stdout.write(JSON.stringify({ decision: 'terminal', status: ledger.status, round: ledger.round }) + '\n');
        return;
      }
      if (noOp) {
        writeLedger(stateDir, slug, ledger);
        process.stdout.write(JSON.stringify({ decision: 'no-op', round: ledger.round, budget: ledger.budget }) + '\n');
        return;
      }
    }

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, `round-${ledger.round}-diff.txt`), diff);
    const dod = runDod(repoRoot);
    ledger = { ...ledger, dod, phase: 'gates', target: { ...(ledger.target || { kind: 'local', ref }), base, head_sha: headSha } };
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ decision: 'work', round: ledger.round, budget: ledger.budget, dodPassed: dod.passed }) + '\n');
    return;
  }

  if (verb === 'record') {
    requireRef(ref, 'record');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./lib/gate-contract');
    const R = require('./lib/review');
    const { REVIEW_PARK_BUDGET_DEFAULT } = require('./lib/config');
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug);
    const n = ledger && ledger.round;

    // Idempotency-first: this MUST be checked before the phase guard below,
    // since the first successful record already flips phase to 'done' -- a
    // guard-first ordering would throw on replay instead of reaching this branch.
    if (ledger && ledger.phase === 'done' && ledger.last_recorded_round === n) {
      process.stdout.write(
        JSON.stringify({ decision: ledger._lastDecision || { continue: false }, handoff: renderHandoff({ ledger, cost: { totalUsd: 0, calls: 0 } }) }) + '\n'
      );
      return;
    }
    if (!ledger || ledger.phase !== 'fixes') throw new Error(`record: expected phase "fixes", got "${ledger && ledger.phase}"`);

    const readJson = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-${name}.json`), 'utf8'));
      } catch (e) {
        return null;
      }
    };
    const cJson = readJson('correctness') || { findings: [] };
    const vJson = readJson('verify') || { rejected: [] };
    const candidates = gc.parseGateFindings(JSON.stringify(cJson.findings || []));
    const killedIds = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates).rejectedIds;

    const journaled = new Map((ledger.journal || []).map((j) => [j.id, j.sha]));
    const fixedIds = [];
    const parkedIds = [];
    const fixCommits = {};
    const parkReasons = {};
    for (const id of ledger.planned || []) {
      if (journaled.has(id)) {
        fixedIds.push(id);
        fixCommits[id] = journaled.get(id);
      } else {
        const fx = readJson(`fix-${id}`);
        parkedIds.push(id);
        parkReasons[id] = gc.validateParkReason({ kind: 'needs-decision', text: fx ? 'fix reported no edit or the file was unchanged' : 'fix artifact missing' });
      }
    }
    const outcome = { dodPassed: !!(ledger.dod && ledger.dod.passed), findings: candidates, fixedIds, parkedIds, killedIds, specDoubtScope: 'none', fixCommits, parkReasons };
    let { ledger: applied, decision } = R.applyRoundOutcome(ledger, outcome);
    ledger = applied;
    // Park-budget override BEFORE the charge below, so a forced terminus doesn't burn a round.
    if (R.parkBudgetExceeded(ledger, REVIEW_PARK_BUDGET_DEFAULT)) {
      decision = { ...decision, continue: false };
      ledger = { ...ledger, status: 'parked' };
    }
    if (decision.continue) ledger = { ...ledger, budget: { ...ledger.budget, spent: ledger.budget.spent + 1 } };
    if (!decision.continue && fixedIds.length > 0) {
      // Fixes already landed via commit-fix -- re-run DoD against the post-commit
      // tree so the handoff reports the true final state, not the pre-fix round-start snapshot.
      ledger = { ...ledger, dod: runDod(repoRoot) };
    }
    gitCheckoutTree(repoRoot); // clean any leftover dirty edit from a rejected/parked fixer
    ledger = { ...ledger, phase: 'done', last_recorded_round: n, _lastDecision: decision };
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ decision, handoff: renderHandoff({ ledger, cost: { totalUsd: 0, calls: 0 } }) }) + '\n');
    return;
  }

  if (verb === 'plan-fixes') {
    requireRef(ref, 'plan-fixes');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./lib/gate-contract');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger || ledger.phase !== 'gates') throw new Error(`plan-fixes: expected phase "gates", got "${ledger && ledger.phase}"`);
    const n = ledger.round;
    const readArtifact = (name) => {
      const p = path.join(stateDir, `round-${n}-${name}.json`);
      let raw;
      try {
        raw = fs.readFileSync(p, 'utf8');
      } catch (e) {
        throw new Error(`harness-failure: missing gate artifact ${name} for round ${n}`);
      }
      let j;
      try {
        j = JSON.parse(raw);
      } catch (e) {
        throw new Error(`harness-failure: ${name} artifact is not JSON`);
      }
      if (!j || j.status !== 'ok') throw new Error(`harness-failure: ${name} artifact missing status:"ok"`);
      return j;
    };
    const cJson = readArtifact('correctness');
    const vJson = readArtifact('verify');
    const candidates = gc.parseGateFindings(JSON.stringify(cJson.findings || []));
    // Coverage: every changed file must be in examined. Derive the changed-file
    // set from the diff file round-start already wrote (single-sourced diff) --
    // do NOT re-run git against ledger.target.base, which round-start never
    // persisted before Task 6's base-in-target fix and which duplicates a git
    // call the CLI already made once this round.
    const diffText = fs.readFileSync(path.join(stateDir, `round-${n}-diff.txt`), 'utf8');
    const changed = Array.from(new Set((diffText.match(/^\+\+\+ b\/(.+)$/gm) || []).map((l) => l.replace(/^\+\+\+ b\//, '').trim())));
    const examined = new Set(Array.isArray(cJson.examined) ? cJson.examined : []);
    const missing = changed.filter((f) => !examined.has(f));
    if (missing.length) throw new Error(`harness-failure: coverage -- changed file(s) never examined: ${missing.join(', ')}`);
    const verdict = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates);
    const killed = new Set(verdict.rejectedIds);
    const survivors = require('./lib/review').dedupeAgainstSeen(candidates, ledger.seen);
    const concluded = new Set((ledger.findings || []).filter((f) => f.status !== 'open').map((f) => f.id));
    const spanPresent = (file, span) => {
      if (!span) return true;
      try {
        return fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(span);
      } catch (e) {
        return false;
      }
    };
    const fixes = survivors
      // A finding dedupeAgainstSeen marked `reopened: true` recurred after being
      // marked 'fixed' -- it is still present in `ledger.findings` with that
      // 'fixed' status (so `concluded` contains its id), but it is NOT actually
      // concluded: the fix didn't hold or was reverted. Let it bypass the
      // concluded check so it can reach the driver as a fix or a park, instead
      // of being silently discarded.
      .filter((f) => !killed.has(f.id) && (!concluded.has(f.id) || f.reopened) && spanPresent(f.file, f.span))
      .map((f) => ({ id: f.id, file: f.file, span: f.span, summary: f.summary }));
    const next = { ...ledger, planned: fixes.map((f) => f.id), phase: 'fixes' };
    writeLedger(stateDir, slug, next);
    process.stdout.write(JSON.stringify({ fixes }) + '\n');
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

  if (verb === 'commit-fix') {
    requireRef(ref, 'commit-fix');
    const id = rest[0];
    if (!id) throw new Error('commit-fix: missing <findingId>');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug);
    if (!ledger || ledger.phase !== 'fixes') throw new Error(`commit-fix: expected phase "fixes", got "${ledger && ledger.phase}"`);
    const n = ledger.round;
    if ((ledger.journal || []).some((j) => j.id === id)) { process.stdout.write(JSON.stringify({ committed: false, reason: 'already journaled' }) + '\n'); return; } // idempotent
    const fx = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-fix-${id}.json`), 'utf8')); } catch (e) { return null; } })();
    const cJson = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-correctness.json`), 'utf8')); } catch (e) { return { findings: [] }; } })();
    const finding = (cJson.findings || []).find((f) => f.id === id) || { summary: '', file: null };
    // File-scoped, not tree-wide: gating and staging on the whole tree would
    // sweep unrelated dirty content (a stray untracked dir, a crash-recovery
    // leftover) into this finding's commit -- the same mis-attribution the
    // per-finding journal exists to prevent.
    if (fx && fx.status === 'ok' && fx.edited === true && finding.file && gitIsDirtyForFile(repoRoot, finding.file)) {
      const sha = gitCommitFix(repoRoot, id, finding.summary, finding.file);
      ledger = { ...ledger, journal: [...(ledger.journal || []), { id, sha }] };
      writeLedger(stateDir, slug, ledger);
      process.stdout.write(JSON.stringify({ committed: true, sha }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ committed: false, reason: 'no edit or file unchanged' }) + '\n');
    }
    return;
  }

  throw new Error(`review-cli: unknown verb "${verb}" (expected show | round-start | plan-fixes | commit-fix | record | unpark)`);
}

module.exports = { gitDiff, gitCommitFix, gitIsReachable, gitIsDirty, gitIsDirtyForFile, gitCheckoutTree, runDod };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`review-cli: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}
