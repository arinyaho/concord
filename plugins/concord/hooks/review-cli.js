#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { resolveStateDirFromCwd } = require('./lib/statedir');
const dodExec = require('./lib/dod-exec');
const intentLib = require('./lib/intent');
const gateLib = require('./lib/gate');
const {
  targetSlug,
  readLedger,
  writeLedger,
  deleteLedger,
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
function gitCommitFix(repoRoot, findingId, summary, files) {
  // Stage only the files the fix declares -- never `-A`. A whole-tree
  // `git add -A` sweeps in any other dirty content (untracked non-gitignored
  // dirs, a crash-recovery leftover, a driver-contract violation) and
  // silently mis-attributes it to this finding's commit. `files` is a list:
  // normally just the finding's own file, but a fix may legitimately touch a
  // companion file (e.g. a caller/import it had to update); every file the
  // fix subagent declared must land in the same attributed commit, or the
  // companion edit is wiped later by record()'s gitCheckoutTree.
  const fileList = Array.isArray(files) ? files : [files];
  sh('git', ['add', '--', ...fileList], { cwd: repoRoot });
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
  if (cfg.deferred) return { passed: true, deferred: true, results: [] };
  return dodExec.runDodExec({ cwd: repoRoot, commands: cfg.dod, execFn: dodExec.defaultExecFn });
}

// Terminal handoff (design §8): rounds, killed/fixed/parked counts, a per-fix
// rationale digest, and the needs-decision packets -- the "one consolidated
// handoff" that replaces the manual review<->fix relay. Moved here from
// review-engine.js (the headless claude-p engine being retired) so `record`
// can render it without depending on the file that Task 11 deletes.
// When the DoD gate failed, surface WHY, not just THAT. runDodExec is fail-fast,
// so the first non-passing result is the culprit; it already carries the command,
// its exit code, and the combined stdout+stderr the runner captured. Without this
// the handoff said only "DoD: FAILED", forcing the human to re-run the gate by
// hand to see a cause the runner had in hand -- a missing dep, a lint error, a
// single failing test -- often with an obvious fix. Bounded (tail of N lines, each
// clipped) so a noisy log cannot flood the handoff.
function renderDodFailure(dod) {
  const out = [];
  const failing = ((dod && dod.results) || []).find((r) => r && !r.passed);
  if (!failing) return out; // pre-`results` ledger, or nothing to show
  out.push(`  $ ${failing.cmd}  (exit ${failing.exitCode})`);
  const clip = (l) => (l.length > 200 ? l.slice(0, 200) + '...' : l);
  const body = String(failing.output == null ? '' : failing.output).replace(/\s+$/, '');
  if (!body) {
    out.push('    (no output captured)');
    return out;
  }
  const all = body.split('\n');
  const TAIL = 12;
  if (all.length > TAIL) out.push(`    ... (${all.length - TAIL} earlier line(s) omitted)`);
  for (const l of all.slice(-TAIL)) out.push(`    ${clip(l)}`);
  return out;
}

function renderHandoff(result) {
  const { ledger, aborted } = result;
  const lines = [];
  lines.push(`review-until-green: target ${ledger.target && ledger.target.ref} -- status: ${ledger.status}`);
  lines.push(`rounds: ${ledger.round}/${ledger.budget.max_rounds} (spent ${ledger.budget.spent})`);
  if (aborted) lines.push(`ABORTED (${aborted.kind}): ${aborted.message}`);

  const dodLine = !ledger.dod
    ? 'DoD: not run'
    : ledger.dod.deferred
      ? 'DoD: DEFERRED (no executable gate declared; validate out-of-band, e.g. post-deploy e2e)'
      : ledger.dod.passed
        ? 'DoD: passed'
        : 'DoD: FAILED';
  lines.push(dodLine);
  if (ledger.dod && !ledger.dod.deferred && !ledger.dod.passed) {
    lines.push(...renderDodFailure(ledger.dod));
  }
  lines.push(ledger.intentHash ? `intent: applied (${String(ledger.intentHash).slice(0, 12)}, ${ledger.intentBytes} bytes)` : 'intent: not configured');

  const fixed = (ledger.findings || []).filter((f) => f.status === 'fixed');
  const killedCount = (ledger.seen || []).filter((s) => s.status === 'killed').length;
  const parked = (ledger.findings || []).filter((f) => f.status === 'parked');
  lines.push(`findings: ${fixed.length} fixed, ${killedCount} killed (false-positive), ${parked.length} parked`);

  if (fixed.length) {
    const conf = ledger.status === 'intent-review' ? ' (pending confirmation)' : '';
    lines.push('', `Fix digest${conf}:`);
    for (const f of fixed) lines.push(`  - [${f.id}] ${f.summary} -> commit ${f.fix_commit}`);
  }
  const intentParked = ledger.intent_parked || [];
  if (intentParked.length) {
    lines.push('', 'Intent findings (design conformance -- your decision; fix code or source, then re-run):');
    for (const f of intentParked) {
      lines.push(`  - [${f.id}] ${f.file}: ${f.summary}`);
      lines.push(`    requirement: ${f.requirement || '(none)'}`);
      lines.push(`    contradicts: ${f.span || '(no line)'}`);
    }
  }
  const gateOpen = ledger.gate_open || [];
  if (gateOpen.length) {
    lines.push('', 'GATE findings (advisory -- your decision; fix, or dismiss the id):');
    for (const f of gateOpen) {
      lines.push(`  - [${f.id}] ${f.file}: ${f.summary}`);
      if (f.requirement) lines.push(`    requirement: ${f.requirement}`);
      if (f.evidence) lines.push(`    anchor: ${f.evidence}`);
    }
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

// Fail-closed gate artifact read (design invariant: a broken/missing gate must
// never be silently read as "zero findings" -- that can manufacture a
// spurious converged:clean out of a harness failure). Shared by plan-fixes
// and record; the caller decides what to do with the thrown harness-failure.
function readArtifact(stateDir, n, name) {
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
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug) || emptyLedger({ kind: 'local', ref });

    // intent-review is a re-runnable stop state: a fresh round-start clears it,
    // nulls diff_content_hash so beginRound advances a real round, and clears
    // intentHash + deletes the cached artifact so intent RE-FETCHES -- picking up
    // a correction the human made to the design source to retire a false positive.
    if (ledger.status === 'intent-review') {
      try { fs.unlinkSync(path.join(stateDir, `intent-${slug}.md`)); } catch (e) {}
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, intentHash: null, intentBytes: null, intent_parked: [] };
    }

    // gate-pending, like intent-review, is a re-runnable stop state: a fresh
    // round-start clears the reported gate findings and nulls the diff hash so a
    // real round advances and the gate re-evaluates. gate_dismissed is preserved
    // (a finding the human retired stays retired across re-runs).
    if (ledger.status === 'gate-pending') {
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, gate_open: [] };
    }

    // `resume <ref>` passes NO base token -- fall back to the base persisted
    // from the original fresh start (ledger.target.base). Without this, an
    // undefined base makes gitDiff below fall back to `git diff HEAD`, which
    // is EMPTY on a clean committed tree -- every cross-session resume of a
    // real branch would silently review nothing and converge clean.
    const base = rest[0] || (ledger.target && ledger.target.base);

    // Warn if `base` is a local branch behind its upstream. Diffing against a stale
    // local base sweeps in everything merged upstream since the branch point -> a
    // phantom diff of unrelated files and a confusing coverage harness-failure. A
    // remote-tracking ref (origin/...) has no upstream, so the default never trips this.
    if (base) {
      try {
        // stdio ignores git's stderr: a no-upstream base makes the `@{upstream}`
        // lookup fail with "fatal: ...", which the default origin/<main> base hits
        // every run. The non-zero exit still throws and is caught below; only the
        // noise is suppressed.
        const behind = sh('git', ['rev-list', '--count', `${base}..${base}@{upstream}`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (behind && behind !== '0') {
          process.stderr.write(`review-cli round-start: base "${base}" is ${behind} commit(s) behind its upstream -- the diff may include unrelated changes merged upstream; pass the remote ref (e.g. origin/${base}) instead.\n`);
        }
      } catch (e) { /* base has no upstream (e.g. a remote-tracking ref) -> nothing to compare */ }
    }

    // Capture BEFORE any mutation. Committed fixes from a crashed round change
    // the diff, so beginRound's noOp path (same diff hash -> no-op) cannot be
    // relied on to re-drive the same round -- we pin round/hash ourselves below
    // instead of calling beginRound at all on a resume.
    const resumed = ledger.phase === 'gates' || ledger.phase === 'fixes';
    const resumeRound = ledger.round;

    if (resumed) {
      gitCheckoutTree(repoRoot); // keep journaled commits, discard uncommitted
      deleteRoundArtifacts(stateDir, resumeRound);
      ledger = { ...ledger, phase: 'idle', planned: [], resolved_absent: [], intent_parked: [] };
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
        process.stdout.write(JSON.stringify({ decision: 'terminal', status: ledger.status, round: ledger.round, stateDir }) + '\n');
        return;
      }
      if (noOp) {
        writeLedger(stateDir, slug, ledger);
        process.stdout.write(JSON.stringify({ decision: 'no-op', round: ledger.round, budget: ledger.budget, stateDir }) + '\n');
        return;
      }
    }

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, `round-${ledger.round}-diff.txt`), diff);

    const intentCfg = intentLib.loadIntentConfig(repoRoot);
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    if (intentCfg) {
      const intentPath = path.join(stateDir, `intent-${slug}.md`);
      if (!ledger.intentHash) {
        const { text, sha, bytes } = intentLib.fetchIntent({ command: intentCfg.command, cwd: repoRoot, ref, base });
        const tmp = intentPath + '.tmp';
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, intentPath); // atomic: never leave a partial file a later step trusts
        ledger = { ...ledger, intentHash: sha, intentBytes: bytes };
      } else {
        let cached;
        try { cached = fs.readFileSync(intentPath, 'utf8'); } catch (e) {
          throw new Error(`harness-failure: intent artifact intent-${slug}.md missing on re-hash`);
        }
        const sha = contentHash(cached);
        if (sha !== ledger.intentHash) throw new Error('harness-failure: intent artifact changed mid-drive (hash mismatch)');
      }
    }

    const dod = runDod(repoRoot);
    ledger = { ...ledger, dod, phase: 'gates', target: { ...(ledger.target || { kind: 'local', ref }), base, head_sha: headSha } };
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ decision: 'work', round: ledger.round, budget: ledger.budget, dodPassed: dod.passed, intentApplied: !!intentCfg, gateApplied: !!gateCfg, stateDir }) + '\n');
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
        JSON.stringify({ decision: ledger._lastDecision || { continue: false }, handoff: renderHandoff({ ledger }) }) + '\n'
      );
      return;
    }
    if (!ledger || ledger.phase !== 'fixes') throw new Error(`record: expected phase "fixes", got "${ledger && ledger.phase}"`);

    // Per-finding fix artifacts (round-<n>-fix-<id>.json) stay lenient: a
    // missing/non-ok fix artifact is a legitimate outcome (the fixer never
    // edited, or crashed) and must PARK that finding needs-decision, not
    // blow up the whole record call. Only the correctness/verify GATE
    // artifacts are fail-closed -- see readArtifact above.
    const readJson = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-${name}.json`), 'utf8'));
      } catch (e) {
        return null;
      }
    };
    const cJson = readArtifact(stateDir, n, 'correctness');
    const vJson = readArtifact(stateDir, n, 'verify');
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
    // Journal-proven idempotent replays (plan-fixes' ledger.resolved_absent):
    // the span is gone AND this run's journal has the commit, so the fix already
    // landed and there is nothing left to commit. plan-fixes only routes a
    // finding here when the journal proves the commit, so an absent span WITHOUT
    // evidence never reaches this loop -- it is sent to the fixer (and parked if
    // unfixable), never silently marked 'fixed'. Stamp the real journal sha (not
    // a sentinel) so the handoff's fix digest shows the actual commit.
    for (const id of ledger.resolved_absent || []) {
      fixedIds.push(id);
      fixCommits[id] = journaled.get(id) || 'span already absent (idempotent replay)';
    }
    const outcome = { dodPassed: !!(ledger.dod && ledger.dod.passed), findings: candidates, fixedIds, parkedIds, killedIds, specDoubtScope: 'none', fixCommits, parkReasons, intentReviewCount: (ledger.intent_parked || []).length, gateOpenCount: (ledger.gate_open || []).length };
    let { ledger: applied, decision } = R.applyRoundOutcome(ledger, outcome);
    ledger = applied;
    // Park-budget override BEFORE the charge below, so a forced terminus doesn't burn a round.
    if (R.parkBudgetExceeded(ledger, REVIEW_PARK_BUDGET_DEFAULT)) {
      // converged/parked must move together with continue here -- a stale
      // converged:true would mislead a consumer that reads decision.converged
      // without also checking continue. Likewise clear intentReview and
      // gatePending: without this a park-budget terminus on an intent-review
      // or gate-pending decision would still print "resolve and re-run"
      // guidance for that stale state while the ledger status is truthfully
      // "parked" (which refuses to resume until `unpark`).
      decision = { ...decision, continue: false, converged: false, parked: true, intentReview: false, gatePending: false };
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
    process.stdout.write(JSON.stringify({ decision, handoff: renderHandoff({ ledger }) }) + '\n');
    return;
  }

  if (verb === 'plan-fixes') {
    requireRef(ref, 'plan-fixes');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./lib/gate-contract');
    const gateCfg = require('./lib/gate').loadGateConfig(repoRoot);
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger || ledger.phase !== 'gates') throw new Error(`plan-fixes: expected phase "gates", got "${ledger && ledger.phase}"`);
    const n = ledger.round;
    const cJson = readArtifact(stateDir, n, 'correctness');
    const vJson = readArtifact(stateDir, n, 'verify');
    const candidates = gc.parseGateFindings(JSON.stringify(cJson.findings || []));
    // Symmetric guard: an intent-prefixed id must never come from the
    // correctness (auto-fixing) gate -- only the intent detector may mint
    // "intent:" ids. Catching this here (not just on the intent side) keeps
    // the fold below trustworthy even if a gate misbehaves or is spoofed.
    for (const c of candidates) {
      if (c.id.startsWith('intent:')) {
        throw new Error(`harness-failure: intent-prefixed id "${c.id}" in the correctness artifact -- intent findings must come from the intent detector, never the auto-fixing gate`);
      }
      if (c.id.startsWith('gate:')) {
        throw new Error(`harness-failure: gate-prefixed id "${c.id}" in the correctness artifact -- gate findings must come from the gate reviewer, never the auto-fixing gate`);
      }
    }
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
    // A finding dedupeAgainstSeen marked `reopened: true` recurred after being
    // marked 'fixed' -- it is still present in `ledger.findings` with that
    // 'fixed' status (so `concluded` contains its id), but it is NOT actually
    // concluded: the fix didn't hold or was reverted. Let it bypass the
    // concluded check so it can reach the driver as a fix or a park, instead
    // of being silently discarded.
    const confirmedNonKilled = survivors.filter((f) => !killed.has(f.id) && (!concluded.has(f.id) || f.reopened));
    // A span still present is genuinely fixable and drives a fix subagent. A
    // span ABSENT from the file is a true idempotent replay -- a fix that already
    // landed in a prior/crashed attempt -- ONLY when this run's journal proves a
    // commit for it. An absent span WITHOUT that evidence is NOT a replay: it is
    // an additive/absence finding (nothing to quote) or a reviewer span that
    // never matched. Marking those 'fixed' would converge green with a confirmed
    // bug still live, so route them to the fixer instead (it adds the missing
    // code -> a real commit, or reports no-edit -> record parks it needs-decision).
    const journaledIds = new Set((ledger.journal || []).map((j) => j.id));
    const isReplay = (f) => !spanPresent(f.file, f.span) && journaledIds.has(f.id);
    const fixes = confirmedNonKilled
      .filter((f) => !isReplay(f))
      .map((f) => ({ id: f.id, file: f.file, span: f.span, summary: f.summary }));
    const resolvedAbsent = confirmedNonKilled
      .filter((f) => isReplay(f))
      .map((f) => f.id);
    // Intent fold: report-only, never routed into fixes/resolved_absent. If
    // intent was fetched this round (ledger.intentHash set), the detector
    // artifact is mandatory -- a skipped/missing detector is fail-closed
    // (harness-failure), never a silent "no intent findings".
    let intentParked = [];
    if (ledger.intentHash) {
      const iJson = readArtifact(stateDir, n, 'intent'); // fail-closed: skipped detector -> harness-failure
      const intentFindings = gc.parseGateFindings(JSON.stringify(iJson.findings || []));
      for (const f of intentFindings) {
        if (!f.id.startsWith('intent:')) throw new Error(`harness-failure: non-intent id "${f.id}" in the intent artifact`);
      }
      const changedSet = new Set(changed);
      intentParked = intentFindings
        .filter((f) => changedSet.has(f.file)) // out-of-PR-scope findings dropped
        .map((f) => ({ id: f.id, file: f.file, span: f.span, requirement: f.requirement || '', summary: f.summary }));
    }
    // Gate fold: report-only, never routed into fixes. Fail-closed like the
    // intent detector -- if the gate was applied this round, its artifact is
    // mandatory. Deliberately NOT filtered to changed files (unchanged-sibling
    // cross-context is the point). gate: namespace is guarded symmetrically.
    let gateOpen = [];
    if (gateCfg) {
      const gJson = readArtifact(stateDir, n, 'gate'); // fail-closed
      let gFindings;
      try { gFindings = gc.parseGateFindings(JSON.stringify(gJson.findings || [])); }
      catch (e) { throw new Error(`harness-failure: gate artifact invalid: ${e.message}`); }
      for (const f of gFindings) {
        if (!f.id.startsWith('gate:')) throw new Error(`harness-failure: non-gate id "${f.id}" in the gate artifact`);
      }
      // gate-verify itself stays lenient (missing/malformed artifact -> the
      // legacy shape { rejected: [] }, and a shape-invalid findings entry ->
      // an empty findings list): unlike the gate-review artifact above, a
      // broken verify pass is not a harness-failure -- it just means no
      // rejections and no verify-added findings this round.
      const gvRaw = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-gate-verify.json`), 'utf8')); } catch (e) { return { rejected: [], findings: [] }; } })();
      let verifyFindings;
      try { verifyFindings = gc.parseGateFindings(JSON.stringify(gvRaw.findings || [])); }
      catch (e) { verifyFindings = []; }
      for (const f of verifyFindings) {
        if (!f.id.startsWith('gate:')) throw new Error(`harness-failure: non-gate id "${f.id}" in the gate-verify artifact`);
      }
      // Distrust-green: gate-verify's different lens may surface a class of gap
      // gate-review missed, by adding it as a new gate: finding of its own. Merge
      // it into the candidate set BEFORE folding, deduped by id -- a verify
      // finding whose id collides with a gate-review finding collapses to the
      // gate-review entry (set second so it overwrites).
      const byId = new Map();
      for (const f of verifyFindings) byId.set(f.id, f);
      for (const f of gFindings) byId.set(f.id, f);
      const mergedGateFindings = Array.from(byId.values());
      const rejected = gc.parseVerifyVerdict(JSON.stringify({ rejected: gvRaw.rejected || [] }), mergedGateFindings).rejectedIds;
      const thisRound = gateLib.foldGateFindings({ gateFindings: mergedGateFindings, verifyRejectedIds: rejected, dismissedIds: ledger.gate_dismissed || [] });
      // Cross-round persistence (spec decision 4): gate findings must PERSIST
      // across rounds, not be overwritten fresh each round -- a round where the
      // gate subagent nondeterministically fails to re-report a real finding
      // must not silently erase it and let the run converge clean. Carry
      // forward anything from the PRIOR round's gate_open not already covered
      // by thisRound, unless it is plausibly resolved: dismissed, rejected by
      // this round's gate-verify, or its file was touched by the diff since
      // base (a fix plausibly addressed it). thisRound and carried are
      // disjoint by construction (carried excludes thisRound's ids).
      const carried = gateLib.carryForwardGateFindings({
        priorGateOpen: ledger.gate_open || [],
        thisRoundIds: thisRound.map((f) => f.id),
        verifyRejectedIds: rejected,
        dismissedIds: ledger.gate_dismissed || [],
        changedFiles: changed,
      });
      gateOpen = thisRound.concat(carried);
    }
    const next = { ...ledger, planned: fixes.map((f) => f.id), resolved_absent: resolvedAbsent, intent_parked: intentParked, gate_open: gateOpen, phase: 'fixes' };
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

  if (verb === 'dismiss') {
    requireRef(ref, 'dismiss');
    const gateId = rest[0];
    if (!gateId) throw new Error('review-cli dismiss: missing required <gateId> argument');
    if (!gateId.startsWith('gate:')) throw new Error(`review-cli dismiss: ${gateId} must be a gate: id`);
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`review-cli dismiss: no ledger for ref "${ref}"`);
    const dismissed = Array.from(new Set([...(ledger.gate_dismissed || []), gateId]));
    const gateOpen = (ledger.gate_open || []).filter((f) => f.id !== gateId);
    writeLedger(stateDir, slug, { ...ledger, gate_dismissed: dismissed, gate_open: gateOpen });
    process.stdout.write(`dismissed ${gateId}; it will no longer surface or block for ref "${ref}".\n`);
    return;
  }

  // Discards the ledger for a ref so the next round-start begins a fresh run.
  // The escape hatch for a ledger latched into a finding-less terminal state: a
  // no-progress or budget-exhausted park has zero parked findings, so `unpark`
  // has no target -- without `reset` the only recourse was deleting the state
  // file by hand. Also sweeps this run's round artifacts so a fresh start cannot
  // read a stale gate result left behind by the discarded run.
  if (verb === 'reset') {
    requireRef(ref, 'reset');
    const slug = targetSlug(ref);
    const prior = readLedger(stateDir, slug);
    if (!prior) {
      process.stdout.write(`review-cli reset: no ledger for ref "${ref}"; nothing to reset.\n`);
      return;
    }
    deleteLedger(stateDir, slug);
    for (let n = 1; n <= (prior.round || 0); n++) deleteRoundArtifacts(stateDir, n);
    process.stdout.write(
      `reset ref "${ref}" (was "${prior.status}"); cleared ${prior.round || 0} round(s) of artifacts. The next round-start begins a fresh run.\n`,
    );
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
    // The fix subagent declares every file it touched via `files` (finding.file
    // plus any companion edit -- e.g. a caller/import the fix legitimately had
    // to update). Fall back to [finding.file] for backward compatibility with
    // a fix artifact that never sets `files`.
    const files = ((fx && Array.isArray(fx.files) && fx.files.length) ? fx.files : [finding.file]).filter(Boolean);
    // File-scoped, not tree-wide: gating and staging on the whole tree would
    // sweep unrelated dirty content (a stray untracked dir, a crash-recovery
    // leftover) into this finding's commit -- the same mis-attribution the
    // per-finding journal exists to prevent. Staging every declared file (not
    // just finding.file) matters too: a fix that legitimately edits a second
    // file must have BOTH edits land in the same attributed commit, or the
    // companion edit is silently wiped by record()'s later gitCheckoutTree.
    if (fx && fx.status === 'ok' && fx.edited === true && finding.file && files.some((f) => gitIsDirtyForFile(repoRoot, f))) {
      const sha = gitCommitFix(repoRoot, id, finding.summary, files);
      ledger = { ...ledger, journal: [...(ledger.journal || []), { id, sha }] };
      writeLedger(stateDir, slug, ledger);
      process.stdout.write(JSON.stringify({ committed: true, sha }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ committed: false, reason: 'no edit or file unchanged' }) + '\n');
    }
    return;
  }

  throw new Error(`review-cli: unknown verb "${verb}" (expected show | round-start | plan-fixes | commit-fix | record | unpark | dismiss | reset)`);
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
