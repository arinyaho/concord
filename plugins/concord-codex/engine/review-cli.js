#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const dodExec = require('./dod-exec');
const intentLib = require('./intent');
const gateLib = require('./gate');
const gatePanelLib = require('./gate-panel');
const artifactContract = require('./artifact-contract');
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
} = require('./review');
const { acquireTarget, gitDiff, gitHeadSha, gitDirty } = require('./target');

function resolveStateDir(resolveFromCwd) {
  if (process.env.REVIEW_STATE_DIR) return process.env.REVIEW_STATE_DIR;
  return resolveFromCwd();
}

const GATE_PANEL_LENSES = ['ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model'];

// Impure git/DoD boundary. lib/review.js and lib/gate-contract.js stay pure
// (no child_process, no fs beyond ledger I/O); all process/git/DoD work for
// the orchestrator lives here so it can be injected/tested against a real
// temp repo without touching the caller's own working tree.
function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
}
// gitDiff, the dirty-check (gitDirty), and the HEAD rev-parse (gitHeadSha) moved
// to core/target.js (the target-acquisition seam). They are re-imported above so
// existing call sites and the module's public surface stay unchanged.
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
// Re-exported alias for the dirty-check now living in core/target.js, so the
// module's public `gitIsDirty` surface (and its resume/record call sites) are
// unchanged by the extract.
const gitIsDirty = gitDirty;
function gitIsDirtyForFile(repoRoot, file) {
  return sh('git', ['status', '--porcelain', '--', file], { cwd: repoRoot }).trim().length > 0;
}

function pathWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateFixFiles(repoRoot, stateDir, files) {
  const repo = path.resolve(repoRoot);
  const artifacts = path.resolve(stateDir);
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('harness-failure: commit-fix: declared files must be non-empty repository-relative paths');
    }
    const resolved = path.resolve(repo, file);
    if (path.isAbsolute(file) || !pathWithin(resolved, repo)) {
      throw new Error(`harness-failure: commit-fix: declared file "${file}" is outside the repository`);
    }
    if (pathWithin(resolved, artifacts)) {
      throw new Error(`harness-failure: commit-fix: declared file "${file}" is a stateDir artifact`);
    }
  }
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
  if (ledger.gate_panel && ledger.gate_panel.status === 'done' && ledger.gate_panel.round > 0) {
    lines.push(`Broad-review panel: ${ledger.gate_panel.round} round(s), ${(ledger.gate_panel.confirmed || []).length} confirmed`);
  }
  const gateOpen = ledger.gate_open || [];
  if (gateOpen.length) {
    lines.push('', 'Broad review findings (advisory -- your decision; fix, or dismiss the id):');
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

// Derive the complete changed-path set from a unified git diff. Looking only at
// `+++ b/...` silently omits deletions (`+++ /dev/null`) and pure renames,
// allowing a reviewer to skip them without triggering the coverage guard.
// Keep this parser shared by artifact normalization and plan-fixes so retry and
// fail-closed coverage enforce the same contract.
function changedGitPaths(diffText) {
  const paths = [];
  const add = (file) => {
    if (file && file !== '/dev/null' && !paths.includes(file)) paths.push(file);
  };
  for (const line of String(diffText).split('\n')) {
    let match = /^--- a\/(.+?)(?:\t.*)?$/.exec(line);
    if (match) { add(match[1]); continue; }
    match = /^\+\+\+ b\/(.+?)(?:\t.*)?$/.exec(line);
    if (match) { add(match[1]); continue; }
    match = /^rename from (.+)$/.exec(line);
    if (match) { add(match[1]); continue; }
    match = /^rename to (.+)$/.exec(line);
    if (match) add(match[1]);
  }
  return paths;
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
  try {
    const canonical = artifactContract.normalizeArtifact(name, raw);
    const text = JSON.stringify(canonical) + '\n';
    if (raw !== text) fs.writeFileSync(p, text);
    return canonical;
  } catch (e) {
    throw new Error(`harness-failure: ${e.message}`);
  }
}

// Fail-closed ordering guard: a verify-style artifact whose mtime predates
// the artifact it was supposed to review means it was spawned before that
// artifact finished writing -- possibly racing ahead on a missing/empty
// file. Silently trusting its content (e.g. an honest "rejected: []" from a
// verify pass that never actually saw the candidates) would launder a
// spawn-ordering bug into a false-clean result. See review-until-green.md
// step 3: correctness and verify must be spawned sequentially, never in
// parallel, precisely so this can't happen -- this is the CLI-side check
// that catches it if a session spawns them in parallel anyway.
function requireArtifactAfter(stateDir, n, firstName, secondName) {
  const firstPath = path.join(stateDir, `round-${n}-${firstName}.json`);
  const secondPath = path.join(stateDir, `round-${n}-${secondName}.json`);
  const statArtifact = (name, artifactPath) => {
    try {
      return fs.statSync(artifactPath);
    } catch (e) {
      // existsSync followed by statSync leaves a TOCTOU gap: a reviewer can
      // remove or replace its artifact after the existence check, leaking a
      // raw ENOENT instead of preserving the gate's fail-closed contract.
      throw new Error(`harness-failure: missing gate artifact ${name} for round ${n}`);
    }
  };
  const firstStat = statArtifact(firstName, firstPath);
  const secondStat = statArtifact(secondName, secondPath);
  if (secondStat.mtimeMs < firstStat.mtimeMs) {
    throw new Error(`harness-failure: round-${n}-${secondName}.json predates round-${n}-${firstName}.json -- it was spawned before ${firstName} finished writing (see review-until-green.md step 3: correctness and verify must run sequentially, never in parallel)`);
  }
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

function main(resolveFromCwd) {
  const [verb, ref, ...rest] = process.argv.slice(2);
  const stateDir = resolveStateDir(resolveFromCwd);

  if (verb === 'artifact-normalize') {
    requireRef(ref, 'artifact-normalize');
    const name = rest[0];
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    const n = ledger && ledger.round;
    if (!n) throw new Error(`harness-failure: artifact-normalize: no active round for ref "${ref}"`);
    const p = path.join(stateDir, `round-${n}-${name}.json`);
    const retryPath = path.join(stateDir, `round-${n}-${name}.retry`);
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { throw new Error(`harness-failure: missing gate artifact ${name} for round ${n}`); }
    try {
      const canonical = artifactContract.normalizeArtifact(name, raw);
      // Correctness coverage is part of the artifact contract for git targets:
      // retry the reviewer while its original artifact is still intact rather
      // than canonicalizing an incomplete examined list and discovering the
      // problem only after verify has already run. File targets hold document
      // contents, not a unified diff, so their examined list stays advisory.
      if (name === 'correctness' && (!ledger.target || ledger.target.type === 'git')) {
        const diffText = fs.readFileSync(path.join(stateDir, `round-${n}-diff.txt`), 'utf8');
        const changed = changedGitPaths(diffText);
        const examined = new Set(canonical.examined);
        const missing = changed.filter((file) => !examined.has(file));
        if (missing.length) {
          const error = new artifactContract.ArtifactError('retry', `correctness coverage is incomplete; missing changed file(s): ${missing.join(', ')}`);
          error.coveragePaths = changed;
          throw error;
        }
      }
      fs.writeFileSync(p, JSON.stringify(canonical) + '\n');
      try { fs.unlinkSync(retryPath); } catch (e) { /* no prior retry */ }
      process.stdout.write(JSON.stringify({ status: 'ok', artifact: name }) + '\n');
      return;
    } catch (e) {
      if (e instanceof artifactContract.ArtifactError && e.kind === 'retry') {
        if (!fs.existsSync(retryPath)) {
          fs.writeFileSync(retryPath, '1\n');
          const prompt = e.coveragePaths
            ? `Rewrite only round artifact correctness as JSON. The "examined" array MUST contain every changed path exactly as listed: ${e.coveragePaths.map((file) => JSON.stringify(file)).join(', ')}. Do not infer, omit, or rewrite paths; preserve your actual findings and do not add prose or extra top-level fields.`
            : artifactContract.retryPrompt(name, ({ correctness: 'correctness:|docreview:', verify: 'correctness:|docreview:', intent: 'intent:', gate: 'gate:', 'gate-verify': 'gate:' })[name]);
          process.stdout.write(JSON.stringify({ status: 'retry', artifact: name, prompt }) + '\n');
          return;
        }
      }
      throw new Error(`harness-failure: ${e.message}`);
    }
  }

  if (verb === 'show') {
    requireRef(ref, 'show');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug) || emptyLedger({ kind: 'local', ref });
    process.stdout.write(JSON.stringify(ledger) + '\n');
    return;
  }

  if (verb === 'gate-panel-round-start') {
    requireRef(ref, 'gate-panel-round-start');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    if (!gateCfg || !gateCfg.panel) throw new Error('harness-failure: gate-panel-round-start: gate.panel is not enabled in review.config.json');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`harness-failure: gate-panel-round-start: no ledger for ref "${ref}"`);
    const gp = ledger.gate_panel || gatePanelLib.emptyGatePanel();
    if (gp.status === 'done') throw new Error('harness-failure: gate-panel-round-start: the panel already finished this convergence attempt -- call record, not another panel round');
    const round = (gp.round || 0) + 1;
    process.stdout.write(JSON.stringify({ round, rejectedIds: gp.rejectedIds || [], stateDir }) + '\n');
    return;
  }

  if (verb === 'gate-panel-round-record') {
    requireRef(ref, 'gate-panel-round-record');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./gate-contract');
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    if (!gateCfg || !gateCfg.panel) throw new Error('harness-failure: gate-panel-round-record: gate.panel is not enabled in review.config.json');
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`harness-failure: gate-panel-round-record: no ledger for ref "${ref}"`);
    const gp = ledger.gate_panel || gatePanelLib.emptyGatePanel();
    if (gp.status === 'done') throw new Error('harness-failure: gate-panel-round-record: the panel already finished this convergence attempt');
    const n = ledger.round;
    const m = (gp.round || 0) + 1;

    // Each lens is read leniently (missing/malformed -> zero findings this
    // round) -- a single flaky lens subagent must not blow up a
    // multi-million-token panel round. Contrast with correctness/verify's
    // fail-closed readArtifact: those gate an auto-fixing loop where a
    // manufactured "zero findings" is dangerous; the panel is report-only
    // and self-verifying, so a missing lens just means fewer candidates.
    let allCandidates = [];
    for (const lens of GATE_PANEL_LENSES) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-gate-panel-${m}-${lens}.json`), 'utf8'));
      } catch (e) {
        continue;
      }
      let findings;
      try {
        findings = gc.parseGateFindings(JSON.stringify(raw.findings || []));
      } catch (e) {
        continue; // malformed lens output -- treated as zero findings, not a harness-failure
      }
      for (const f of findings) {
        const seg = f.id.split(':');
        if (seg[1] !== lens) {
          throw new Error(`harness-failure: gate-panel-round-record: finding "${f.id}" from the "${lens}" lens file must use the "${lens}" class in its id`);
        }
      }
      allCandidates = allCandidates.concat(findings);
    }

    // A human-dismissed id (review-cli.js dismiss verb, existing gate_dismissed
    // set) must never re-enter the panel's confirmed set -- mergePanelIntoGate
    // (lib/gate-panel.js) only dedupes against the CURRENT gate_open, it does
    // not know about gate_dismissed, so a dismissed finding a lens re-raises
    // would otherwise silently reappear once the panel completes. Drop it here,
    // at the earliest point it's known, same as foldGateFindings/
    // carryForwardGateFindings already do for the lightweight GATE (lib/gate.js).
    const dismissed = new Set(ledger.gate_dismissed || []);
    allCandidates = allCandidates.filter((f) => !dismissed.has(f.id));

    // The verify pass is the opposite lenience direction: missing/malformed
    // means nothing is confirmed to have survived, NOT that everything
    // survived -- promoting unverified findings by default would defeat the
    // entire point of an adversarial-verify pass (distrust-green).
    let survivedIds;
    try {
      const vRaw = JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-gate-panel-${m}-verify.json`), 'utf8'));
      if (vRaw.status !== 'ok' || !Array.isArray(vRaw.rejected)) {
        throw new Error('malformed verify artifact shape');
      }
      const rejected = new Set(vRaw.rejected);
      survivedIds = allCandidates.map((f) => f.id).filter((id) => !rejected.has(id));
    } catch (e) {
      survivedIds = []; // missing, unreadable, or shape-malformed verify artifact -- nothing survives this round
    }

    const result = gatePanelLib.foldPanelRound({ gatePanel: gp, roundFindings: allCandidates, survivedIds });
    ledger = { ...ledger, gate_panel: result };
    if (result.status === 'done') {
      // Revert phase so a subsequent `record` call passes its `phase ===
      // 'fixes'` guard and re-runs normally instead of hitting record's
      // done-idempotency short-circuit left over from the earlier
      // panelPending call (Task 4).
      ledger = { ...ledger, phase: 'fixes' };
    }
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ status: result.status, round: result.round, dryStreak: result.dryStreak, newlyConfirmedCount: result.newlyConfirmedCount, rejectedIds: result.rejectedIds }) + '\n');
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
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, intentHash: null, intentBytes: null, intent_parked: [], gate_panel: gatePanelLib.emptyGatePanel() };
    }

    // gate-pending, like intent-review, is a re-runnable stop state: a fresh
    // round-start clears the reported gate findings and nulls the diff hash so a
    // real round advances and the gate re-evaluates. gate_dismissed is preserved
    // (a finding the human retired stays retired across re-runs). gate_panel also
    // resets -- the panel must re-run fresh on every convergence attempt (design
    // decision 4: "exactly once per convergence attempt", not once per ledger
    // lifetime), otherwise stale confirmed findings from the prior panel run would
    // keep resurfacing in gate_open even after being fixed or dismissed.
    if (ledger.status === 'gate-pending') {
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, gate_open: [], gate_panel: gatePanelLib.emptyGatePanel() };
    }

    // gate-panel-pending is also re-runnable: a session may have crashed or been
    // interrupted mid-panel (between record() first returning panelPending and the
    // panel loop completing). A fresh round-start here resets gate_panel so the
    // panel restarts cleanly from round 1 rather than leaving a half-finished panel
    // stranded with no way to resume.
    if (ledger.status === 'gate-panel-pending') {
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, gate_panel: gatePanelLib.emptyGatePanel() };
    }

    // Broad-review enable flag (--broad, alias --gate): a per-invocation
    // override so a repo can turn broad review on without editing
    // review.config.json. Lives among round-start's trailing arguments,
    // order-independent against the optional `base` token below. Any other
    // "--"-prefixed token is a usage error rather than silently falling
    // through to `base` (which would produce a confusing downstream git
    // error against a nonsense ref).
    const BROAD_FLAGS = new Set(['--broad', '--gate']);
    const broadFlagPassed = rest.some((a) => BROAD_FLAGS.has(a));
    const positional = rest.filter((a) => !BROAD_FLAGS.has(a));
    for (const tok of positional) {
      if (tok.startsWith('--')) throw new Error(`review-cli round-start: unknown flag "${tok}"`);
    }

    // Detect a file target: the single file-target surface is `file:<arg>` in
    // the ref slot, where <arg> is a literal path OR a simple single-'*' glob
    // (e.g. `file:note.md`, `file:*.md`). The glob is resolved by fileTarget's
    // resolveGlob against repoRoot, so both forms flow through one path. A file
    // target carries hasDoD:false and does not use git at all.
    const fileRefMatch = ref && ref.match(/^file:(.+)$/);
    const fileSpec = fileRefMatch ? { files: [fileRefMatch[1]] } : null;
    const isFileTarget = fileSpec !== null;

    // `resume <ref>` passes NO base token -- fall back to the base persisted
    // from the original fresh start (ledger.target.base). Without this, an
    // undefined base makes gitDiff below fall back to `git diff HEAD`, which
    // is EMPTY on a clean committed tree -- every cross-session resume of a
    // real branch would silently review nothing and converge clean.
    // For file targets base is irrelevant; this line is harmless (undefined).
    const base = positional[0] || (ledger.target && ledger.target.base);

    // Warn if `base` is a local branch behind its upstream. Diffing against a stale
    // local base sweeps in everything merged upstream since the branch point -> a
    // phantom diff of unrelated files and a confusing coverage harness-failure. A
    // remote-tracking ref (origin/...) has no upstream, so the default never trips this.
    // Skip entirely for file targets -- base is irrelevant and a git call in a
    // non-git directory would throw.
    if (!isFileTarget && base) {
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

    // Resume housekeeping is TARGET-AGNOSTIC: an interrupted round leaves stale
    // round artifacts (and, for a file target, a stale fix-<id>.json that has no
    // git journal to override it), so BOTH target types must purge them and
    // reset the round's planned/absent/intent arrays before re-driving. Only the
    // git-specific working-tree discard (gitCheckoutTree) is gated on git; a file
    // target has no working tree to check out. Before this, a resumed file target
    // took the file-acquisition branch first and skipped all of it, so a stale
    // edited:true fix artifact could false-signal in record. (finding #3)
    const isGit = !isFileTarget;
    if (resumed) {
      if (isGit) gitCheckoutTree(repoRoot); // git-only: keep journaled commits, discard uncommitted
      deleteRoundArtifacts(stateDir, resumeRound); // both: purge the interrupted round's artifacts
      ledger = { ...ledger, phase: 'idle', planned: [], resolved_absent: [], intent_parked: [] };
    }

    // Target acquisition goes through the core/target.js seam. On a FRESH git
    // start acquireTarget runs the dirty-check + HEAD rev-parse + diff (identical
    // command invocations, identical dirty-tree throw). On a git RESUME the
    // checkout above already made the tree clean, so the dirty-check is
    // deliberately skipped -- we call the seam's primitives (gitHeadSha +
    // gitDiff) directly rather than acquireTarget, preserving today's
    // resume-skips-dirty-check behavior (an untracked file must not block a
    // resume). resetUnreachable stays below: it is git-ledger reachability
    // logic, not acquisition. A file target reads content directly (no git ops)
    // on both fresh and resume; its identity is a content hash.
    let headSha;
    let diff;
    let acquiredTarget;
    if (isFileTarget) {
      acquiredTarget = acquireTarget(fileSpec, repoRoot);
      headSha = acquiredTarget.identity; // content hash, not a sha; field name reused for compat
      diff = acquiredTarget.reviewText;
    } else if (resumed) {
      headSha = gitHeadSha(repoRoot); // no dirty-check on resume
      diff = gitDiff(repoRoot, base);
    } else {
      const target = acquireTarget({ ref, base }, repoRoot); // throws the same dirty-tree error
      acquiredTarget = target;
      headSha = target.identity;
      diff = target.reviewText;
    }
    // Reachability check and resetUnreachable are git-ledger-only operations:
    // a file target carries no head_sha ref and git must not be invoked.
    if (!isFileTarget && ledger.target && ledger.target.head_sha && !gitIsReachable(repoRoot, ledger.target.head_sha)) {
      ledger = resetUnreachable(ledger);
    }
    const diffHash = contentHash(diff);

    if (resumed) {
      // Resume re-drives round N at zero budget by pinning round/diff_content_hash
      // directly, bypassing beginRound. This is a real work round: it proceeds to
      // DoD + phase='gates' below, without advancing round or charging budget.
      ledger = { ...ledger, diff_content_hash: diffHash, round: resumeRound };
    } else {
      deleteRoundArtifacts(stateDir, ledger.round + 1); // stale artifacts for the round about to run
      const { ledger: begun, noOp, terminal } = beginRound(ledger, diffHash, { reReviewOnStableContent: isFileTarget });
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
    // Sticky: once broad review is applied for this ledger (config, flag, or a
    // prior round), it stays applied even if a later round-start call omits the
    // flag -- mirrors how `base` falls back to the persisted `ledger.target.base`
    // above. plan-fixes reads this ledger field instead of re-deriving from
    // review.config.json (see Task 3).
    const gateApplied = !!gateCfg || broadFlagPassed || !!ledger.gateApplied;
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

    // DoD is a git-target concept (a CI command the code must pass before
    // review-until-green can declare done). File targets carry hasDoD:false
    // and skip the DoD entirely -- runDod would throw in a non-git dir because
    // review.config.json is not expected to exist there.
    const dod = isFileTarget ? { passed: true, deferred: true, results: [] } : runDod(repoRoot);
    // Persist the extended target object. For file targets, add type/hasDoD/spec
    // so later verbs (record, decideTermination) can branch on target type without
    // re-parsing the ref. For git targets, the existing ref/base/head_sha fields
    // are preserved; type/hasDoD are added for consistency.
    const targetType = isFileTarget ? 'file' : 'git';
    const baseTarget = ledger.target || { kind: 'local', ref };
    const targetUpdate = isFileTarget
      ? { ...baseTarget, type: 'file', hasDoD: false, spec: fileSpec }
      : { ...baseTarget, type: 'git', hasDoD: true, spec: { ref, base }, base, head_sha: headSha };
    ledger = { ...ledger, dod, phase: 'gates', gateApplied, target: targetUpdate };
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ decision: 'work', round: ledger.round, budget: ledger.budget, dodPassed: dod.passed, intentApplied: !!intentCfg, gateApplied, targetType, stateDir }) + '\n');
    return;
  }

  if (verb === 'record') {
    requireRef(ref, 'record');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./gate-contract');
    const R = require('./review');
    const { REVIEW_PARK_BUDGET_DEFAULT } = require('./config');
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
    requireArtifactAfter(stateDir, n, 'correctness', 'verify');
    const cJson = readArtifact(stateDir, n, 'correctness');
    const vJson = readArtifact(stateDir, n, 'verify');
    const candidates = gc.parseGateFindings(JSON.stringify(cJson.findings || []));
    const killedIds = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates).rejectedIds;

    // Holistic GATE panel (spec: 2026-07-15-gate-holistic-panel-design.md):
    // once the panel has finished (gate-panel-round-record set gate_panel.status
    // to 'done' and reverted phase to 'fixes' so this call could even happen),
    // fold its confirmed findings into gate_open BEFORE computing gateOpenCount
    // below -- same merge every repeat call, mergePanelIntoGate is idempotent
    // by construction (dedup by id).
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    let gateOpen = ledger.gate_open || [];
    if (ledger.gate_panel && ledger.gate_panel.status === 'done') {
      gateOpen = gatePanelLib.mergePanelIntoGate(gateOpen, ledger.gate_panel.confirmed || [], ledger.gate_dismissed || []);
      ledger = { ...ledger, gate_open: gateOpen };
    }

    // Branch fixed-signal on target type: git uses the commit journal; file
    // targets use the per-fix artifact's edited flag (no git commit happens).
    const isGit = !ledger.target || ledger.target.type === 'git';
    const journaled = new Map((ledger.journal || []).map((j) => [j.id, j.sha]));
    const fixedIds = [];
    const parkedIds = [];
    const fixCommits = {};
    const parkReasons = {};
    for (const id of ledger.planned || []) {
      const fx = readJson(`fix-${id}`);
      const fixedByGit = isGit && journaled.has(id);
      const fixedByReport = !isGit && fx && fx.edited === true;
      if (fixedByGit) {
        fixedIds.push(id);
        fixCommits[id] = journaled.get(id);
      } else if (fixedByReport) {
        // File-target fix: the fixer edited the file directly; no git commit.
        // Stamp 'file-edit' as a sentinel so the handoff clearly shows the
        // fix landed via a direct edit, not a git commit sha.
        fixedIds.push(id);
        fixCommits[id] = 'file-edit';
      } else {
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
    const outcome = {
      dodPassed: !!(ledger.dod && ledger.dod.passed), findings: candidates, fixedIds, parkedIds, killedIds, specDoubtScope: 'none', fixCommits, parkReasons,
      intentReviewCount: (ledger.intent_parked || []).length,
      gateOpenCount: gateOpen.length,
      panelConfigured: !!(gateCfg && gateCfg.panel),
      panelDone: !!(ledger.gate_panel && ledger.gate_panel.status === 'done'),
    };
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
    if (isGit && !decision.continue && fixedIds.length > 0) {
      // Git: fixes already landed via commit-fix -- re-run DoD against the post-commit
      // tree so the handoff reports the true final state, not the pre-fix round-start snapshot.
      // File targets skip this: there is no DoD, and no git tree to re-check.
      ledger = { ...ledger, dod: runDod(repoRoot) };
    }
    // Git only: clean any leftover uncommitted edit from a rejected/parked fixer.
    // File targets have no working tree to discard.
    if (isGit) gitCheckoutTree(repoRoot);
    ledger = { ...ledger, phase: 'done', last_recorded_round: n, _lastDecision: decision };
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ decision, handoff: renderHandoff({ ledger }) }) + '\n');
    return;
  }

  if (verb === 'plan-fixes') {
    requireRef(ref, 'plan-fixes');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./gate-contract');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger || ledger.phase !== 'gates') throw new Error(`plan-fixes: expected phase "gates", got "${ledger && ledger.phase}"`);
    // Read round-start's decision from the ledger, not a fresh
    // review.config.json read: gateApplied may have come from the --broad
    // flag, which leaves no trace in the config file. Re-deriving from
    // loadGateConfig here would silently miss a flag-enabled round and
    // discard that round's gate-review/gate-verify findings.
    const gateApplied = !!ledger.gateApplied;
    const n = ledger.round;
    requireArtifactAfter(stateDir, n, 'correctness', 'verify');
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
    // Coverage: every changed file must be in examined. This is a GIT-DIFF-shaped
    // check -- `changed` is parsed from old/new headers and rename metadata -- so both the
    // derivation and the assertion are gated on the target being git (same isGit
    // test record uses). For a file target, round-<n>-diff.txt holds raw document
    // CONTENT, not a git diff; a doc that merely QUOTES a unified diff (a line
    // starting `+++ b/...`) would otherwise mint a phantom "changed file" the doc
    // reviewer never examined and throw a spurious coverage harness-failure. A
    // file target has no diff-header notion of changed files, so `changed` stays
    // empty and the coverage invariant does not apply -- the reviewer's examined
    // list is advisory there. `changed` remains in scope (empty for file targets)
    // for the intent/gate folds below, which are git-only concepts. (finding #2)
    const isGit = !ledger.target || ledger.target.type === 'git';
    let changed = [];
    if (isGit) {
      // Derive the changed-file set from the diff file round-start already wrote
      // (single-sourced diff) -- do NOT re-run git against ledger.target.base,
      // which duplicates a git call the CLI already made once this round.
      const diffText = fs.readFileSync(path.join(stateDir, `round-${n}-diff.txt`), 'utf8');
      changed = changedGitPaths(diffText);
      const examined = new Set(Array.isArray(cJson.examined) ? cJson.examined : []);
      const missing = changed.filter((f) => !examined.has(f));
      if (missing.length) throw new Error(`harness-failure: coverage -- changed file(s) never examined: ${missing.join(', ')}`);
    }
    const verdict = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates);
    const killed = new Set(verdict.rejectedIds);
    const survivors = require('./review').dedupeAgainstSeen(candidates, ledger.seen);
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
    if (gateApplied) {
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
    if (fx && Array.isArray(fx.files)) validateFixFiles(repoRoot, stateDir, files);
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

  throw new Error(`review-cli: unknown verb "${verb}" (expected show | round-start | plan-fixes | commit-fix | record | gate-panel-round-start | gate-panel-round-record | unpark | dismiss | reset)`);
}

// Wraps main() with the graceful operator-facing error format. Exported (not
// just run inline below) so the hooks/review-cli.js shim -- the actual
// require.main on every real invocation (manifest + review-until-green
// command both run the shim, never this file directly) -- can call it too and
// get the same `review-cli: <msg>` one-liner instead of a raw stack trace.
function runMain(resolveFromCwd) {
  try {
    main(resolveFromCwd);
  } catch (e) {
    process.stderr.write(`review-cli: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

module.exports = { gitDiff, gitCommitFix, gitIsReachable, gitIsDirty, gitIsDirtyForFile, gitCheckoutTree, runDod, changedGitPaths, main, runMain };
