#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { safeIdForFilename } = require('./artifact-name');
const { writeFileAtomic, publishDirectoryAtomic } = require('./atomic-write');
const { captureArtifactRoot, readArtifactBytes } = require('./bounded-artifact');
const dodExec = require('./dod-exec');
const { lockOwner: targetOwnerPid, pidRunning } = require('./run-lock');
const intentLib = require('./intent');
const gateLib = require('./gate');
const gatePanelLib = require('./gate-panel');
const artifactContract = require('./artifact-contract');
const reportLib = require('./report');
const reviewTelemetry = require('./review-telemetry');
const { REVIEW_MAX_RUNS_DEFAULT } = require('./config');
const {
  targetSlug,
  readLedger,
  ledgerPath,
  writeLedger: persistLedger,
  deleteLedger,
  emptyLedger,
  contentHash,
  beginRound,
  unparkFinding,
  resetUnreachable,
  gateFollowUpEligible,
} = require('./review');
const crypto = require('node:crypto');
const { canonicalPath, openInitiativeRun, claimBroadSweep, reserveLaunchBatch, denialReason, recordDisposition, finaliseInitiativeRun, consumeDispositionDelivery, escalateInitiativeRun, lockDiagnosis, resolveBaseCommit, repositoryIdentity, runPath, terminalDispositionInLedger } = require('./initiative-review-run');
const { acquireTarget, gitDiff, gitReviewSnapshot, gitHeadSha, gitDirty } = require('./target');
const { crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');

function resolveStateDir(resolveFromCwd) {
  if (process.env.REVIEW_STATE_DIR) return process.env.REVIEW_STATE_DIR;
  return resolveFromCwd();
}

// Every "no ledger / no active round" error is really "you are pointed at a
// different state dir than the run you mean" -- the dir is derived from cwd, so
// running a verb one directory up from the worktree silently keys a different
// project. Naming the resolved dir (and where it came from) turns a mystifying
// harness-failure into an obvious one.
function stateDirHint(stateDir) {
  const origin = process.env.REVIEW_STATE_DIR ? 'from REVIEW_STATE_DIR' : `derived from cwd ${process.cwd()}`;
  return `(state dir ${stateDir}, ${origin})`;
}

// Single source of truth is report.js's PANEL_LENSES (the pure module) --
// this alias keeps the rest of this file's call sites unchanged.
const GATE_PANEL_LENSES = reportLib.PANEL_LENSES;

// Impure git/DoD boundary. lib/review.js and lib/gate-contract.js stay pure
// (no child_process, no fs beyond ledger I/O); all process/git/DoD work for
// the orchestrator lives here so it can be injected/tested against a real
// temp repo without touching the caller's own working tree.
function sh(bin, args, opts = {}) {
  // opts.cwd is the reviewed repository at every call site in this file --
  // excluded from PATH resolution for the same reason as target.js's sh().
  return execFileSync(crossPlatformCommand(bin, opts.cwd), crossPlatformArgs(args, needsDoubleEscape(bin, opts.cwd)), crossPlatformOpts({ encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts }));
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
  // -F - (read the message from stdin) instead of -m '<multi-line message>':
  // a GitHub Codex review on this exact code (PR #113) caught that on
  // Windows, crossPlatformOpts' shell:true routes this through cmd.exe, and
  // cmd.exe reads an embedded newline in the message (this one always has
  // one, before `summary`) as a command boundary rather than message text.
  // -F - is portable and equally correct on POSIX, so this isn't gated on
  // win32 -- it removes the multi-line-argv risk everywhere, not just there.
  sh('git', ['commit', '-F', '-'], { cwd: repoRoot, input: `fix(review-until-green): ${findingId}\n\n${summary}` });
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
function gitHeadFileContains(repoRoot, file, span) {
  try {
    return sh('git', ['show', `HEAD:${file}`], { cwd: repoRoot }).includes(span);
  } catch (e) {
    return false;
  }
}
function gitWorktreeFileLacksSpan(repoRoot, file, span) {
  try {
    return !fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(span);
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    throw e;
  }
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
    if (!pathWithin(real, root)) return null;
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
  sh('git', ['checkout', 'HEAD', '--', '.'], { cwd: repoRoot });
}
function runDod(repoRoot) {
  const cfg = dodExec.loadDodConfig(repoRoot);
  // deferredBy is carried through so the handoff can say WHY (an absent config
  // is not the same claim as `"dod": null`, which declares there is no gate).
  if (cfg.deferred) return { passed: true, deferred: true, deferredBy: cfg.deferredBy, results: [] };
  return dodExec.runDodExec({ cwd: repoRoot, commands: cfg.dod, execFn: dodExec.defaultExecFn });
}

function pendingDod(repoRoot) {
  const cfg = dodExec.loadDodConfig(repoRoot);
  if (cfg.deferred) return { passed: true, deferred: true, deferredBy: cfg.deferredBy, results: [] };
  return { passed: true, deferred: true, deferredBy: 'pending-final', results: [] };
}

const DOD_DEFERRAL_LINES = {
  '--no-dod': 'DoD: DEFERRED (--no-dod: no executable gate ran this run)',
  'no-config': `DoD: DEFERRED (no ${dodExec.CONFIG_FILENAME}: reviewed without an executable gate -- add {"dod":["<your test command>"]} to gate future runs)`,
  'pending-final': 'DoD: pending (runs once after review convergence)',
};

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
  // Exit 78 (EX_CONFIG) is the DoD-routine convention for "the environment could
  // not be prepared" (e.g. dependency install failed); label it so it is not read
  // as a test failure of the reviewed change. Text only -- the gate still failed.
  if (failing.exitCode === 78) {
    out.push('  DoD environment/setup error (exit 78): the gate could not be prepared; this is not a test failure of the reviewed change.');
  }
  const clip = (l) => (l.length > 200 ? l.slice(0, 200) + '...' : l);
  const body = String(failing.output == null ? '' : failing.output).replace(/\s+$/, '');
  if (!body) {
    out.push('    (no output captured)');
    return out;
  }
  const all = body.split(/\r?\n/);
  const TAIL = 12;
  if (all.length > TAIL) out.push(`    ... (${all.length - TAIL} earlier line(s) omitted)`);
  for (const l of all.slice(-TAIL)) out.push(`    ${clip(l)}`);
  return out;
}

// The round's candidate findings: the correctness pass PLUS anything the verify
// pass's different lens added (distrust-green, same as the gate pair). Every
// stage that asks "what did this round find" must go through here -- plan-fixes
// routes them, commit-fix looks up the finding a fix belongs to, and record
// folds them into the ledger. A stage that reads the correctness artifact alone
// silently drops the verify-added ones at ITS step, which looks exactly like
// the harness working: the finding was raised, and then nothing happened.
// Deduped by id with the correctness entry winning a collision.
function roundCandidates(gc, cJson, vJson) {
  const byId = new Map();
  for (const f of gc.parseGateFindings(JSON.stringify((vJson && vJson.findings) || []))) byId.set(f.id, f);
  for (const f of gc.parseGateFindings(JSON.stringify((cJson && cJson.findings) || []))) byId.set(f.id, f);
  return Array.from(byId.values());
}

function renderHandoff(result) {
  const { ledger, aborted } = result;
  const lines = [];
  lines.push(`review-until-green: target ${ledger.target && ledger.target.ref} -- status: ${ledger.status}`);
  lines.push(`rounds: ${ledger.round}/${ledger.budget.max_rounds} (spent ${ledger.budget.spent})`);
  lines.push(`full runs: ${(ledger.runs || []).length + 1}/${ledger.run_budget?.max_runs ?? REVIEW_MAX_RUNS_DEFAULT}`);
  if (ledger._lastDecision && ledger._lastDecision.reason) lines.push(`termination: ${ledger._lastDecision.reason}`);
  if (ledger.reviewRouting) {
    const reviewer = `${ledger.reviewRouting.reviewer || 'host-default'}${ledger.reviewRouting.reviewerModel ? ` (${ledger.reviewRouting.reviewerModel})` : ''}`;
    const fixer = `${ledger.reviewRouting.fixer || 'host-default'}${ledger.reviewRouting.fixerModel ? ` (${ledger.reviewRouting.fixerModel})` : ''}`;
    lines.push(`routing: reviewer ${reviewer}; fixer ${fixer}`);
  }
  if (ledger.engine) lines.push(`reviewer engine: ${ledger.engine}`);
  if (ledger.telemetry) lines.push(`review usage: ${ledger.telemetry.totalTokens ?? 'unknown'} tokens across ${ledger.telemetry.calls} call(s), ${ledger.telemetry.partialCalls} partial${ledger.telemetry.missingCalls ? `, ${ledger.telemetry.missingCalls} missing` : ''}${ledger.telemetry.malformedCalls ? `, ${ledger.telemetry.malformedCalls} malformed` : ''}`);
  for (const r of ledger.runs || []) {
    lines.push(`prior run #${r.run} (${r.engine || 'engine unrecorded'}): ${r.status} -- ${r.rounds} round(s), ${(r.fixed || []).length} fixed, ${(r.parked || []).length} parked, ${(r.killed || []).length} killed`);
  }
  if (aborted) lines.push(`ABORTED (${aborted.kind}): ${aborted.message}`);

  const dodLine = !ledger.dod
    ? 'DoD: not run'
    : ledger.dod.deferred
      // Neither the --no-dod flag nor an absent config is a DECLARATION that the
      // repo has no gate -- nothing was declared. Saying so would misreport the
      // run, so each reason gets its own wording.
      ? (DOD_DEFERRAL_LINES[ledger.dod.deferredBy]
        || 'DoD: DEFERRED (no executable gate declared; validate out-of-band, e.g. post-deploy e2e)')
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
  // A killed finding is a real finding a reviewer talked the loop out of. Show
  // the basis it gave, so a rejection can be audited from the handoff alone.
  const killedDigest = ledger.killed_digest || [];
  if (killedDigest.length) {
    lines.push('', 'Killed (rejected as false-positive) -- the reviewer\'s stated basis:');
    for (const k of killedDigest) lines.push(`  - [${k.id}] ${k.reason || '(no basis recorded -- pre-contract artifact)'}`);
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
  // Where broad review actually ran. The front pass and the panel cover
  // different halves (latent tree defects vs defects this loop's own fixes
  // introduced), so a run with only one of them is not fully covered -- say
  // which one ran rather than letting "clean" imply both.
  const gateRounds = ledger.gate_rounds || [];
  if (gateRounds.length) lines.push(`Broad review (front pass): round ${gateRounds.join(', ')}`);
  else if (ledger.gateArmed === false) {
    // Discriminate WHY, the same way dod.deferredBy does: a file target is
    // disarmed by the CLI itself, and blaming a flag nobody passed sends the
    // reader looking for an opt-out that is not in their invocation.
    lines.push(ledger.gateDisarmedBy === 'file-target'
      ? 'Broad review (front pass): not applicable to a file target (pass --broad to sweep the tree against it)'
      : ledger.gateDisarmedBy === 'prior-front-pass'
        ? `Broad review (front pass): reused from prior run #${ledger.broad_reuse.run}; this run reviews the changed diff`
        : 'Broad review (front pass): skipped (--no-broad)');
  }
  if (ledger.gate_panel && ledger.gate_panel.status === 'done' && ledger.gate_panel.round > 0) {
    lines.push(`Legacy panel evidence: ${ledger.gate_panel.round} round(s), ${(ledger.gate_panel.confirmed || []).length} confirmed`);
  }
  const gateOpen = ledger.gate_open || [];
  const followUps = ledger.status === 'clean' ? gateOpen.filter(gateFollowUpEligible) : [];
  if (followUps.length) {
    lines.push('', "Follow-up candidates (not fixed; roll over as root-cause tickets, then record the PR's delivery disposition):");
    for (const f of followUps) lines.push(`  - [${f.id}] ${f.file}: ${f.summary}`, `    rationale: ${f.rationale}`);
    lines.push('Note: `clean` here means the local loop converged; it is not the PR delivery disposition.');
  }
  if (gateOpen.length && !followUps.length) {
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

// Every re-entry that follows a HUMAN decision routes here. The three stop
// states a human re-enters from -- intent-review, gate-pending, and unparking a
// parked run -- all print a remedy that includes "correct the design source",
// so the next look must start from a re-fetched intent: dropping intentHash and
// the cached artifact makes round-start fetch fresh instead of tripping the
// drift check on a change the human was told to make.
// NOT for a mid-round resume or a gate-panel-pending restart: those are the
// SAME run continuing, and their intent stays pinned.
function clearIntentForFreshLook(stateDir, slug, ledger) {
  try { fs.unlinkSync(path.join(stateDir, `intent-${slug}.md`)); } catch (e) {}
  return { ...ledger, intentHash: null, intentBytes: null };
}

function requireRef(ref, verb) {
  if (!ref) throw new Error(`review-cli ${verb}: missing required <ref> argument`);
}

function readReviewArtifact(file, stateDir, encoding = null) {
  if (process.env.CONCORD_UNTRUSTED_ARTIFACTS !== '1') return fs.readFileSync(file, encoding || undefined);
  const bytes = readArtifactBytes(file, captureArtifactRoot(stateDir));
  return encoding ? bytes.toString(encoding) : bytes;
}

function writeReviewArtifact(file, bytes) {
  if (process.env.CONCORD_UNTRUSTED_ARTIFACTS === '1') writeFileAtomic(file, bytes, { flag: 'wx', mode: 0o600 });
  else fs.writeFileSync(file, bytes);
}

function readChangeManifest(stateDir, ledger, ref, n) {
  if (ledger.target?.type === 'file') return null;
  const declared = ledger.execution?.changeManifest;
  if (ledger.execution?.round !== n || declared?.version !== 1 || !/^[0-9a-f]{64}$/.test(declared.sha256 || '')) {
    throw new Error('harness-failure: Git changed-path manifest is missing; resume/round-start to regenerate round inputs');
  }
  let bytes;
  try { bytes = readReviewArtifact(path.join(stateDir, `round-${n}-changes.json`), stateDir); }
  catch (_) { throw new Error('harness-failure: Git changed-path manifest is missing or corrupt'); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== declared.sha256) throw new Error('harness-failure: Git changed-path manifest hash changed');
  try {
    if (contentHash(readReviewArtifact(path.join(stateDir, `round-${n}-diff.txt`), stateDir, 'utf8')) !== ledger.execution.diffHash) {
      throw new Error('harness-failure: Git review diff changed after round-start');
    }
  } catch (error) {
    if (/^harness-failure:/.test(error.message)) throw error;
    throw new Error('harness-failure: Git review diff is missing');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch (_) { throw new Error('harness-failure: Git changed-path manifest is malformed'); }
  if (manifest.version !== 1 || manifest.round !== n || manifest.target?.type !== 'git' || manifest.target.ref !== ref
    || manifest.target.headSha !== ledger.target?.head_sha
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.target.baseSha || '')
    || manifest.target.baseSha.length !== manifest.target.headSha.length
    || manifest.diffHash !== ledger.execution.diffHash || !Array.isArray(manifest.paths)
    || manifest.paths.some((file) => typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file) || path.win32.isAbsolute(file)
      || file.split('/').some((part) => part === '' || part === '.' || part === '..'))
    || JSON.stringify(manifest.paths) !== JSON.stringify([...new Set(manifest.paths)].sort())) {
    throw new Error('harness-failure: Git changed-path manifest binding is invalid');
  }
  return manifest;
}
function readChangedPaths(stateDir, ledger, ref, n) {
  return readChangeManifest(stateDir, ledger, ref, n)?.paths || [];
}

// Fail-closed gate artifact read (design invariant: a broken/missing gate must
// never be silently read as "zero findings" -- that can manufacture a
// spurious converged:clean out of a harness failure). Shared by plan-fixes
// and record; the caller decides what to do with the thrown harness-failure.
function readArtifact(stateDir, n, name) {
  const p = path.join(stateDir, `round-${n}-${name}.json`);
  let raw;
  try {
    raw = readReviewArtifact(p, stateDir, 'utf8');
  } catch (e) {
    throw new Error(`harness-failure: missing gate artifact ${name} for round ${n}`);
  }
  try {
    const canonical = artifactContract.normalizeArtifact(name, raw);
    const text = JSON.stringify(canonical) + '\n';
    if (raw !== text) writeReviewArtifact(p, text);
    return canonical;
  } catch (e) {
    throw new Error(`harness-failure: ${e.message}`);
  }
}

// A DECLARED `blocked` is terminal even on the panel read paths that are
// otherwise lenient (panel lenses and panel verify). Those paths tolerate a
// missing or malformed artifact as "zero findings" so one flaky subagent can't
// blow up an expensive round. Gate-verify is fail-closed through readArtifact.
// A non-empty `blocked` is not flakiness: it
// is the reviewer positively stating the check it was assigned never ran.
// Reading that as zero findings advances the panel's dry streak and can
// converge it to `done` -- exactly the false clean the `blocked` field exists
// to prevent. Mirrors normalizeArtifact's fatal handling in artifact-contract.js.
function requireNotBlocked(what, parsed) {
  const blocked = parsed ? parsed.blocked : undefined;
  // Any DECLARED `blocked` is terminal, whatever shape it was written in: only
  // an absent field or an explicitly empty array is a clean reviewer. A
  // non-array `blocked` (e.g. the string "playwright: denied") is fatal in
  // normalizeArtifact, so treating it as zero findings here would be the same
  // false clean by a different door.
  if (blocked !== undefined && !(Array.isArray(blocked) && !blocked.length)) {
    const detail = Array.isArray(blocked) ? blocked.map((b) => String(b)).join('; ') : String(blocked);
    throw new Error(`harness-failure: ${what} reviewer could not run: ${detail} -- it was blocked from the method it was assigned, so this round has no usable verdict. Fix the reviewer's environment (sandbox, permissions, missing tool) and re-run; do not accept the artifact.`);
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

function requireVerifierOrder(stateDir, n, gateApplied, gateMode) {
  requireArtifactAfter(stateDir, n, 'correctness', 'verify');
  if (!gateApplied || gateMode === 'design-conformance') return;
  requireArtifactAfter(stateDir, n, 'gate', 'verify');
  if (fs.existsSync(path.join(stateDir, `round-${n}-gate-verify.json`))) {
    requireArtifactAfter(stateDir, n, 'correctness', 'gate-verify');
    requireArtifactAfter(stateDir, n, 'gate', 'gate-verify');
  }
}

// Deletes any state-dir file for round n (diff, gate artifacts, fix artifacts)
// so a re-driven round never reads a stale artifact left over from a crashed
// or superseded attempt.
function deleteRoundArtifacts(stateDir, n, preserve = new Set()) {
  let names = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return;
  }
  const prefix = `round-${n}-`;
  for (const nm of names) {
    if (nm.startsWith(prefix) && !preserve.has(nm)) {
      try {
        fs.unlinkSync(path.join(stateDir, nm));
      } catch (e) {
        // best-effort cleanup
      }
    }
  }
}

function retryArtifactMap(execution) {
  const retries = { ...(execution && execution.retryArtifacts) };
  const legacy = execution && execution.retryArtifact;
  if (legacy && typeof legacy.role === 'string' && typeof legacy.prompt === 'string' && !retries[legacy.role]) retries[legacy.role] = legacy.prompt;
  return retries;
}

function firstRetryArtifact(retries) {
  const [role, prompt] = Object.entries(retries)[0] || [];
  return role ? { role, prompt } : null;
}

// Keyed initiative runs (native Claude/Copilot drivers). The host model spawns
// reviewers, so the CLI cannot stop a launch: it reserves launches up front
// (`reserve`) and refuses to accept evidence from an unreserved launch.
const INITIATIVE_FLAGS = [['--initiative-run-key', 'key'], ['--initiative-id', 'initiativeId'], ['--initiative-state-dir', 'stateDir'], ['--initiative-max-launches', 'maxLaunches'], ['--initiative-max-rounds', 'maxRounds']];
const MODE_FLAG = '--initiative-mode';
const RUN_VERBS = new Set(['finalise', 'consume', 'escalate', 'session-checkpoint']);
const CLI_VERBS = ['show', 'round-start', 'telemetry-slot', 'findings', 'plan-fixes', 'plan-dispatch', 'commit-fix', 'record', 'round-failure', 'gate-panel-round-start', 'gate-panel-round-record', 'unpark', 'dismiss', 'reset', 'rerun', 'artifact-normalize', 'reserve', 'carry', 'finalise', 'consume', 'escalate', 'session-checkpoint', 'feedback'];
const RESERVE_ROLES = ['correctness', 'verify', 'plan', 'intent', 'gate-review', 'gate-verify', 'fix', 'certify', 'lens', 'vote'];
const ARTIFACT_RESERVE_ROLE = { correctness: 'correctness', verify: 'verify', plan: 'plan', intent: 'intent', gate: 'gate-review', 'gate-verify': 'gate-verify' };

function unknownVerb(verb) {
  return new Error(`review-cli: unknown verb "${verb}" (expected ${CLI_VERBS.join(' | ')})`);
}

function reserveOptions(rest) {
  const role = rest[0];
  if (!RESERVE_ROLES.includes(role)) throw new Error(`reserve: role must be one of ${RESERVE_ROLES.join(' | ')}`);
  const flag = rest.indexOf('--count');
  const count = flag === -1 ? (role === 'lens' ? GATE_PANEL_LENSES.length : 1) : Number(rest[flag + 1]);
  const valid = Number.isInteger(count) && count >= 1 && (role === 'lens' ? count === GATE_PANEL_LENSES.length : role === 'vote' ? count % 3 === 0 : role === 'fix' || count === 1);
  if (!valid) throw new Error(`reserve: invalid --count ${count} for role "${role}" (lens: exactly ${GATE_PANEL_LENSES.length}; vote: a multiple of 3; fix: any positive count; others: 1)`);
  return { role, count };
}

function rerunOptions(rest) {
  const engineFlag = rest.indexOf('--engine');
  if (engineFlag >= 0 && !rest[engineFlag + 1]) throw new Error('review-cli rerun: --engine needs a name (e.g. --engine codex)');
  return { engine: engineFlag >= 0 ? rest[engineFlag + 1] : null };
}

function carryOptions(rest) {
  const flag = rest.indexOf('--from-run-key');
  if (flag === -1 || !rest[flag + 1]) throw new Error('review-cli carry: requires --from-run-key <oldKey>');
  return { fromRunKey: rest[flag + 1] };
}

function requireRoundStartMode(run, rest) {
  if (run && runMode(run) === 'lite' && rest.some((a) => ['--broad', '--gate', '--no-broad'].includes(a))) throw new Error('review-cli round-start: a lite initiative run takes no --broad, --gate or --no-broad; lite always runs the one design-conformance gate (escalate to base before the first launch for the full gate pair)');
}

function extractInitiative(argv) {
  const args = argv.slice();
  const found = {};
  for (const [flag, field] of INITIATIVE_FLAGS) {
    const i = args.indexOf(flag);
    if (i === -1) continue;
    found[field] = args[i + 1];
    args.splice(i, 2);
  }
  const modeAt = args.indexOf(MODE_FLAG);
  if (modeAt !== -1) {
    found.mode = args[modeAt + 1];
    args.splice(modeAt, 2);
    if (!['base', 'lite'].includes(found.mode)) throw new Error('review-cli: --initiative-mode must be base or lite');
  }
  if (Object.keys(found).filter((field) => field !== 'mode').length === 0) {
    if (found.mode) throw new Error('review-cli: --initiative-mode needs the initiative run flags');
    return { args, initiative: null };
  }
  if (!found.key || !found.stateDir || !/^[1-9]\d*$/.test(found.maxLaunches || '') || !/^[1-9]\d*$/.test(found.maxRounds || '')) {
    throw new Error('review-cli: --initiative-run-key, --initiative-state-dir, --initiative-max-launches and --initiative-max-rounds must be used together, with positive integer budgets');
  }
  if (!path.isAbsolute(found.stateDir)) throw new Error('review-cli: --initiative-state-dir must be absolute');
  return { args, initiative: found };
}

function openKeyedRun(initiative) {
  const stateDir = canonicalPath(initiative.stateDir);
  const run = openInitiativeRun({ stateDir, key: initiative.key, initiativeId: initiative.initiativeId || initiative.key, repository: canonicalPath(process.env.REVIEW_REPO_ROOT || process.cwd()), maxLaunches: Number(initiative.maxLaunches), maxRounds: Number(initiative.maxRounds), allowTerminal: true, mode: initiative.mode || 'base' });
  const mode = runMode(run);
  if (initiative.mode && initiative.mode !== mode) throw new Error(`review-cli: --initiative-mode ${initiative.mode} disagrees with the run ledger: run mode is ${mode}`);
  return run;
}

function runMode(run) {
  return JSON.parse(fs.readFileSync(run.path, 'utf8')).mode;
}

function reservedCount(ledger, role, round, panel) {
  return (ledger.initiative_reservations || []).filter((r) => r.role === role && r.round === round && (panel === undefined || r.panel === panel)).reduce((sum, r) => sum + r.count, 0);
}

// Rejects evidence lacking a matching reservation and fails the keyed run
// closed. `needs` is [{ role, present, panel? }]: how many artifacts of that
// role exist on disk for the active round.
const launchKey = (role, round, panel) => `${role}|${round}|${panel || ''}`;
function launchedBefore(ledger, role, round, panel) {
  return ledger.initiative_launched?.[launchKey(role, round, panel)] || 0;
}
function withSupersededLaunch(ledger, role, round, panel) {
  const key = launchKey(role, round, panel);
  return { ...ledger, initiative_launched: { ...ledger.initiative_launched, [key]: launchedBefore(ledger, role, round, panel) + 1 } };
}

// Exclusive lock on the target ledger (same mkdir style as the initiative
// ledger lock) with bounded retry, so parallel `reserve` calls serialize.
// The holder writes its pid into the lock directory. It is shown when the lock
// cannot be taken. A live owner is never offered for removal. A stuck lock
// is not reclaimed automatically: an operator may confirm removal only when
// no live owner is established, otherwise the caller waits for the owner.
function lockOwner(lock) {
  let pid;
  try { pid = Number.parseInt(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 10); } catch (e) { return 'owner unknown'; }
  if (!Number.isInteger(pid) || pid < 1) return 'owner unknown';
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
  return `owner pid ${pid} (${alive ? 'still running' : 'not running'})`;
}

function promptRemoveLock(question) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  process.stderr.write(`${question} [y/N] `);
  const buffer = Buffer.alloc(64);
  let read = 0;
  try { read = fs.readSync(0, buffer, 0, buffer.length, null); } catch (e) { return false; }
  return /^y(es)?$/i.test(buffer.toString('utf8', 0, read).trim());
}

function withTargetLock(ledgerFile, fn, { confirm = promptRemoveLock, waitMs = 10000 } = {}) {
  const lock = `${ledgerFile}.lock`;
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  let offered = false;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (process.env.CONCORD_UNTRUSTED_ARTIFACTS === '1') throw new Error('harness-failure: review target lock is occupied');
      if (Date.now() > deadline) {
        const held = `target ledger lock is held: ${lock} (${lockOwner(lock)})`;
        const ownerPid = targetOwnerPid(lock);
        if (ownerPid && pidRunning(ownerPid)) throw new Error(`${held}; wait for the owner to finish and retry; do not remove a live lock`);
        if (!offered && confirm && confirm(`${held}. Remove it and continue?`)) {
          offered = true;
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
        throw new Error(`${held}; if no review-cli process is running, remove it with: rm -r "${lock}"`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`); } catch (e) { /* informational only */ }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function requireReservations(run, ledger, needs, what) {
  if (!run) return;
  const fail = (message) => {
    // The harness-failure error wins: a render or index failure while finalising must not replace it.
    let finalised = false;
    try { finalised = finaliseInitiativeRun(run, 'unreserved-evidence'); } catch (renderError) {
      // Only a render failure after the run went terminal is swallowed; a lock or ledger error leaves the run active.
      if (!String(renderError?.message).startsWith('initiative report:')) throw renderError;
      finalised = true;
    }
    if (!finalised) throw new Error(`harness-failure: ${what}: ${message}; could not finalise the keyed initiative run (lock contended), it is still active`);
    throw new Error(`harness-failure: ${what}: ${message}; the keyed initiative run is failed closed`);
  };
  if (JSON.parse(fs.readFileSync(run.path, 'utf8')).status !== 'active') throw new Error(`harness-failure: ${what}: the keyed initiative run is not active`);
  for (const { role, present: files, panel } of needs) {
    // A superseded attempt (retry, failed launch) overwrote the same artifact
    // path but consumed a launch, so it counts against the reservation too.
    const present = files > 0 ? files + launchedBefore(ledger, role, ledger.round, panel) : 0;
    if (present > reservedCount(ledger, role, ledger.round, panel)) fail(`evidence for "${role}" has no matching launch reservation for round ${ledger.round}`);
  }
}


// Publish an immutable private evidence archive before rerun replaces or
// removes anything. A failed publication leaves the active run intact; retries
// verify and reuse the same content-addressed archive without overwriting it.
function archiveReviewRun(stateDir, slug, prior) {
  const root = path.resolve(stateDir);
  const targetRef = prior.target?.ref;
  const telemetryFiles = new Set(reviewTelemetry.listTelemetryFiles(root, targetRef, slug));
  const names = fs.readdirSync(root).filter(name => {
    const round = /^round-(\d+)-/.exec(name);
    if (round && Number(round[1]) <= (prior.round || 0)) return true;
    if (name === `intent-${slug}.md` || telemetryFiles.has(path.join(root, name))) return true;
    return false;
  }).sort();
  const files = names.map(name => {
    const originalPath = path.join(root, name);
    if (!fs.lstatSync(originalPath).isFile()) throw new Error(`review-cli rerun: archive source is not a regular file: ${name}`);
    const bytes = fs.readFileSync(originalPath);
    return { name, originalPath, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const ledgerBytes = Buffer.from(JSON.stringify(prior));
  const storedPath = ledgerPath(root, slug), storedBytes = fs.readFileSync(storedPath);
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const id = digest(JSON.stringify({ ledger: digest(ledgerBytes), storedLedger: digest(storedBytes), files: files.map(({ name, sha256 }) => ({ name, sha256 })) }));
  const directory = path.join(root, 'review-archives', slug, id);
  const manifest = {
    schema: 1, targetRef, run: (prior.runs || []).length + 1,
    ledger: { path: path.join(directory, 'ledger.json'), originalPath: storedPath, sha256: digest(ledgerBytes) },
    storedLedger: { path: path.join(directory, 'stored-ledger.json'), originalPath: storedPath, sha256: digest(storedBytes) },
    artifacts: files.map(({ name, originalPath, sha256 }) => ({ path: path.join(directory, name), originalPath, sha256 })),
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(directory, 'manifest.json');
  const verify = () => {
    if (fs.readFileSync(manifestPath, 'utf8') !== manifestBytes) throw new Error('review-cli rerun: archived manifest read-back failed');
    for (const entry of [manifest.ledger, manifest.storedLedger, ...manifest.artifacts]) {
      if (digest(fs.readFileSync(entry.path)) !== entry.sha256) throw new Error('review-cli rerun: archived evidence read-back failed');
    }
  };
  if (fs.existsSync(directory)) verify();
  else {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    const staging = `${directory}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      for (const [name, bytes] of [['ledger.json', ledgerBytes], ['stored-ledger.json', storedBytes], ...files.map(file => [file.name, file.bytes]), ['manifest.json', manifestBytes]]) {
        const destination = path.join(staging, name);
        writeFileAtomic(destination, bytes, { mode: 0o600 });
        if (digest(fs.readFileSync(destination)) !== digest(bytes)) throw new Error('review-cli rerun: staged archive read-back failed');
      }
      for (const file of files) if (digest(fs.readFileSync(file.originalPath)) !== file.sha256) throw new Error('review-cli rerun: source evidence changed during archival');
      if (digest(fs.readFileSync(storedPath)) !== digest(storedBytes)) throw new Error('review-cli rerun: source ledger changed during archival');
      publishDirectoryAtomic(staging, directory);
      verify();
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return { manifestPath, sha256: digest(manifestBytes) };
}

// The fresh ledger publishes this archive pointer before cleanup begins. Its
// manifest remains the exact cleanup list even if a crash removes a tool record
// before the associated untagged agent record. Only authorized mutations under
// the target lock finish cleanup; show renders the fresh ledger without folding
// files from the archived run while this transition is pending.
function finishRerunCleanup(stateDir, slug, ledger) {
  if (!ledger?.rerun_cleanup) return;
  const pointer = ledger.rerun_cleanup;
  const bytes = fs.readFileSync(pointer.manifestPath);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  if (digest(bytes) !== pointer.sha256) throw new Error('review-cli rerun: cleanup archive manifest changed');
  const manifest = JSON.parse(bytes);
  for (const entry of manifest.artifacts) {
    if (path.basename(entry.originalPath) === `intent-${slug}.md`) continue;
    if (digest(fs.readFileSync(entry.path)) !== entry.sha256) throw new Error('review-cli rerun: cleanup archived evidence changed');
    try {
      if (digest(fs.readFileSync(entry.originalPath)) !== entry.sha256) throw new Error('review-cli rerun: cleanup source evidence changed');
      fs.unlinkSync(entry.originalPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const { rerun_cleanup, ...clean } = ledger;
  persistLedger(stateDir, slug, clean);
}

function roundFiles(stateDir, n, pattern) {
  try { return fs.readdirSync(stateDir).filter((f) => pattern.test(f)).length; } catch (e) { return 0; }
}

function gatesNeeds(stateDir, n) {
  return Object.entries(ARTIFACT_RESERVE_ROLE).map(([name, role]) => ({ role, present: fs.existsSync(path.join(stateDir, `round-${n}-${name}.json`)) ? 1 : 0 }));
}

// Moves a target whose shared budget was blocked mid-round (`initiative_blocked`,
// written by `reserve`'s budget-exhausted denial) onto a new run key, under the
// target lock. Human/reconciliation step only: the round's completed artifacts
// are reused, the new key is charged only for launches it makes itself, and the
// old run keeps the round's history as a terminal `carried` disposition. See
// docs/design/initiative-review-runs.md.
function carryBudgetBlockedTarget({ stateDir, slug, ref, initiative, fromRunKey, repoRoot, writeLedger }) {
  const fail = (message) => { throw new Error(`review-cli carry: ${message}`); };
  if (fromRunKey === initiative.key) fail('--from-run-key must differ from --initiative-run-key');
  const newStateDir = canonicalPath(initiative.stateDir);

  // Step 1: the target itself.
  const ledger = readLedger(stateDir, slug);
  if (!ledger) fail(`no review ledger for ref "${ref}" ${stateDirHint(stateDir)}`);
  if (!ledger.initiative_binding) fail('the target is unbound, or has legacy initiative reservations with no binding; carry requires an existing binding to --from-run-key');
  if (ledger.initiative_binding.key !== fromRunKey || ledger.initiative_binding.stateDir !== newStateDir) fail('the target is not bound to --from-run-key under this initiative state directory');
  const panelPending = ledger.phase === 'done' && ledger.status === 'gate-panel-pending';
  if (!['gates', 'fixes'].includes(ledger.phase) && !panelPending) fail(`the target is not in an active review phase (phase "${ledger.phase}")`);
  if (ledger.reconciliation) fail('the target is parked for reconciliation');
  const marker = ledger.initiative_blocked;
  if (!marker) fail('no budget-exhausted marker for this target; nothing to carry');
  if (marker.key !== fromRunKey || marker.stateDir !== newStateDir) fail('the budget-exhausted marker does not name --from-run-key');
  if (marker.round !== ledger.round || marker.attemptId !== ledger.attemptId) fail('the budget-exhausted marker is for a different round or attempt');
  const isFileTarget = ledger.target?.type === 'file';
  const revision = { ref: ledger.target?.ref || ref, ...(ledger.target?.base ? { base: resolveBaseCommit(repoRoot, ledger.target.base) } : {}), ...(ledger.target?.head_sha ? { head_sha: ledger.target.head_sha } : {}) };
  if (!marker.revision?.head_sha || marker.revision.head_sha !== revision.head_sha || (marker.revision.base || null) !== (revision.base || null)) fail('the budget-exhausted marker is for a different revision pair');
  const liveHead = isFileTarget ? acquireTarget(ledger.target.spec, repoRoot).identity : gitHeadSha(repoRoot);
  if (liveHead !== ledger.target?.head_sha) fail('the live HEAD has moved since the budget-exhausted round; this is no longer the blocked revision pair');

  const oldRun = { path: runPath(newStateDir, fromRunKey) };
  let oldLedger;
  try { oldLedger = JSON.parse(fs.readFileSync(oldRun.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!oldLedger) fail('no initiative run for --from-run-key');
  // Legacy callers did not carry an initiative ID. Preserve the old run's
  // effective identity instead of silently turning a rollover into a new one.
  initiative = { ...initiative, initiativeId: initiative.initiativeId || oldLedger.initiativeId || fromRunKey };
  // A pre-ID ledger that already launched a broad role has irrevocably spent
  // its sweep. Materialize that conservative history before opening a new key.
  if (!oldLedger.initiativeId && (oldLedger.launches || []).some((launch) => /^gate-(review|verify)$/.test(launch.role))) {
    claimBroadSweep(openInitiativeRun({ stateDir: newStateDir, key: fromRunKey, initiativeId: fromRunKey, repository: repoRoot, maxLaunches: oldLedger.budget.maxLaunches, maxRounds: oldLedger.budget.maxRounds, allowTerminal: true, mode: oldLedger.mode }), { target: ref, attemptId: ledger.attemptId });
  }

  // Step 2: the mode check only -- it needs no new-run object, so it runs
  // before anything that would open the new run's ledger file (defaulting
  // mode to 'base' when the caller omitted --initiative-mode); checking
  // afterward can permanently create the wrong-mode ledger before ever
  // reporting the mismatch, leaving the key unusable.
  if ((initiative.mode || 'base') !== oldLedger.mode) fail('the new run mode differs from the old run; carry never changes mode');
  if ((oldLedger.initiativeId || fromRunKey) !== initiative.initiativeId) fail('the new initiative ID differs from the old run; carry preserves initiative identity');

  // Step 3: every old-run check that needs no new-run object runs first --
  // active, same repository, genuinely blocked here, its round's evidence
  // reservable -- so a refused carry never opens (and so never leaves behind)
  // the new key's run ledger. Only the new-run readiness probe below needs
  // that ledger open; it runs as late as the remaining steps allow, still
  // before requireReservations/recordDisposition touch the old run for real.
  // A prior crash between recording that disposition and step 4's target-ledger
  // write is resumed here instead of refused: the same carry retried finds its
  // own disposition and proceeds; a DIFFERENT new key is refused.
  const carriedToSameTarget = (entry) => entry?.reason === 'carried' && entry.packet?.carriedTo?.key === initiative.key && entry.packet?.carriedTo?.stateDir === newStateDir;
  // Checked against the already-loaded ledger, not terminalTarget: terminalTarget
  // only looks at an active run, but a reconciliation step can finalise the old
  // run between recording this very disposition and this carry's own step 4 --
  // the retry must still find its own disposition even though the run is no
  // longer active.
  const existingTerminal = terminalDispositionInLedger(oldLedger, revision.ref, revision, ['terminal']);
  if (existingTerminal && !carriedToSameTarget(existingTerminal)) {
    fail(existingTerminal.reason === 'carried' ? 'this target was already carried to a different run key' : `the old run already holds a terminal disposition ("${existingTerminal.reason}") for this pair`);
  }
  // The new run must be ready to take this pair, for the whole blocked batch
  // (the marker's own role and count), not a single generic launch. A key with
  // no ledger yet is probed against its would-be budget without creating the
  // file, so no refusal leaves a new-key ledger behind; an existing ledger is
  // opened (which validates its immutable options) and probed as `reserve`
  // would. Runs after the old run's reservations are validated, on both the
  // fresh-attempt and resumed-retry paths.
  const checkNewRunReady = () => {
    if (!fs.existsSync(runPath(newStateDir, initiative.key)) && marker.count > Number(initiative.maxLaunches)) fail('the new run refuses this pair (budget-exhausted)');
    const newRun = openKeyedRun(initiative);
    const readinessCheck = { role: marker.role, round: ledger.round, target: revision.ref, revision, attemptId: ledger.attemptId };
    const newRefusal = denialReason(newRun, readinessCheck, marker.count);
    if (newRefusal) fail(`the new run refuses this pair (${newRefusal})`);
  };
  if (!existingTerminal) {
    if (oldLedger.status !== 'active') fail('the old run is not active');
    if (oldLedger.repository !== repositoryIdentity(repoRoot)) fail('the old run is for a different repository');
    const oldReason = denialReason(oldRun, { role: marker.role, round: marker.round, attemptId: marker.attemptId, target: revision.ref, revision }, marker.count);
    if (oldReason !== 'budget-exhausted') fail(`the old run's blocked batch is no longer budget-exhausted (${oldReason || 'it would now be accepted'})`);
    const carryNeeds = [
      ...gatesNeeds(stateDir, ledger.round),
      { role: 'fix', present: roundFiles(stateDir, ledger.round, new RegExp(`^round-${ledger.round}-fix-.*\\.json$`)) },
      { role: 'certify', present: roundFiles(stateDir, ledger.round, new RegExp(`^round-${ledger.round}-certify-.*\\.json$`)) },
    ];
    if (panelPending) {
      // Same lens/vote coverage gate-panel-round-record applies to the pending
      // panel round -- carry must fail the old run closed on unreserved panel
      // evidence exactly like recording that round would.
      const gp = ledger.gate_panel || gatePanelLib.emptyGatePanel();
      const m = (gp.round || 0) + 1;
      carryNeeds.push(
        { role: 'lens', present: GATE_PANEL_LENSES.filter((lens) => fs.existsSync(path.join(stateDir, `round-${ledger.round}-gate-panel-${m}-${lens}.json`))).length, panel: m },
        { role: 'vote', present: roundFiles(stateDir, ledger.round, new RegExp(`^round-${ledger.round}-gate-panel-${m}-vote-.*\\.json$`)), panel: m },
      );
    }

    requireReservations(oldRun, ledger, carryNeeds, 'carry');
    checkNewRunReady();
    const carried = recordDisposition(oldRun, { target: revision.ref, revision, result: { status: 'carried' }, packet: { nextAction: 'carried', carriedTo: { key: initiative.key, stateDir: newStateDir } } });
    if (!carried) {
      let retryLedger;
      try { retryLedger = JSON.parse(fs.readFileSync(oldRun.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const retryMatch = retryLedger && terminalDispositionInLedger(retryLedger, revision.ref, revision, ['terminal']);
      if (!carriedToSameTarget(retryMatch)) {
        if (retryLedger && retryLedger.status !== 'active') fail('the old run is not active');
        fail(lockDiagnosis(oldRun) || 'the old run disposition write was contended; retry');
      }
    }
  } else {
    // existingTerminal && carriedToSameTarget: resuming a crash-interrupted
    // retry. The new run must still exist and be ready, same as the first
    // attempt, before step 4 repeats the target-ledger write.
    checkNewRunReady();
  }

  // The broad pair is one claimed unit. A carried round that has not yet
  // produced gate-verify must retain its own claim under the replacement key.
  if (ledger.gateApplied && ledger.gateMode === 'pair' && !fs.existsSync(path.join(stateDir, `round-${ledger.round}-gate-verify.json`))) {
    claimBroadSweep(openKeyedRun(initiative), { target: ref, attemptId: ledger.attemptId }, true);
  }

  // Step 4: one atomic target-ledger write -- bind to the new key, append
  // provenance, drop the marker. Reservations, launched and fix-used counts
  // stay as they are: only later launches are reserved under the new key.
  const { initiative_blocked: _marker, ...withoutMarker } = ledger;
  writeLedger(stateDir, slug, { ...withoutMarker, initiative_carries: [...(ledger.initiative_carries || []), { from: fromRunKey, to: initiative.key, stateDir: newStateDir, round: ledger.round, at: new Date().toISOString() }] });
  return { status: 'carried', from: fromRunKey, to: initiative.key, round: ledger.round };
}

// The verified fold of one gates-phase round: correctness candidates the
// verifier did not kill, intent findings on changed files, and the gate
// findings gate-verify did not reject. plan-fixes routes it into fixes;
// findings reports it as-is for a review that never edits. Reads only.
function verifiedRound(ref, stateDir, run, what) {
  const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
  const gc = require('./gate-contract');
  const slug = targetSlug(ref);
  const ledger = readLedger(stateDir, slug);
  if (!ledger || ledger.phase !== 'gates') throw new Error(`${what}: expected phase "gates", got "${ledger && ledger.phase}" ${stateDirHint(stateDir)}`);
  // Read round-start's decision from the ledger, not a fresh
  // review.config.json read: gateApplied may have come from the --broad
  // flag, which leaves no trace in the config file. Re-deriving from
  // loadGateConfig here would silently miss a flag-enabled round and
  // discard that round's gate-review/gate-verify findings.
  const gateApplied = !!ledger.gateApplied;
  const n = ledger.round;
  requireReservations(run, ledger, gatesNeeds(stateDir, n), what);
  requireVerifierOrder(stateDir, n, ledger.gateApplied, ledger.gateMode);
  const cJson = readArtifact(stateDir, n, 'correctness');
  const vJson = readArtifact(stateDir, n, 'verify');
  const candidates = roundCandidates(gc, cJson, vJson);
  // Symmetric guard: an intent-prefixed id must never come from the
  // correctness (auto-fixing) gate -- only the intent detector may mint
  // "intent:" ids. Catching this here (not just on the intent side) keeps
  // the fold below trustworthy even if a gate misbehaves or is spoofed.
  for (const c of candidates) {
    if (c.id.startsWith('intent:')) {
      throw new Error(`harness-failure: intent-prefixed id "${c.id}" in the correctness or verify artifact -- intent findings must come from the intent detector, never the auto-fixing gate`);
    }
    if (c.id.startsWith('gate:')) {
      throw new Error(`harness-failure: gate-prefixed id "${c.id}" in the correctness or verify artifact -- gate findings must come from the gate reviewer, never the auto-fixing gate`);
    }
  }
  // Coverage: every changed file must be in examined. This is a Git manifest
  // check, so both the
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
    // Use the changed-path manifest saved with this round's diff. Do not
    // re-run git against a mutable ref while folding reviewer evidence.
    changed = readChangedPaths(stateDir, ledger, ref, n);
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
    const text = readReviewSource(repoRoot, file);
    return text === null || text.includes(span);
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
  const isReplay = (f) => (ledger.journal || []).some((j) => (j.findingIds || []).includes(f.id) || j.id === f.id
    || (j.resolutions || []).some((r) => r.id === f.id && r.file === f.file && r.span === f.span)) && !spanPresent(f.file, f.span);
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
  // A round the pair did NOT fire in (every round after the front pass) has no
  // gate artifact to fold and no verdict on the standing set -- carry it
  // forward untouched. Recomputing from an absent artifact would read as "the
  // gate reported nothing" and silently erase findings the front pass raised,
  // letting the run converge clean over them.
  let gateOpen = ledger.gate_open || [];
  if (gateApplied) { // the fold below replaces gateOpen wholesale
    const gJson = readArtifact(stateDir, n, 'gate'); // fail-closed
    let gFindings;
    try { gFindings = gc.parseGateFindings(JSON.stringify(gJson.findings || [])); }
    catch (e) { throw new Error(`harness-failure: gate artifact invalid: ${e.message}`); }
    for (const f of gFindings) {
      if (!f.id.startsWith('gate:')) throw new Error(`harness-failure: non-gate id "${f.id}" in the gate artifact`);
      if (ledger.gateMode === 'design-conformance' && !f.id.startsWith('gate:design-conformance:')) throw new Error(`harness-failure: lite gate accepts only gate:design-conformance findings, got "${f.id}"`);
    }
    let gvRaw;
    let verifyFindings = [];
    if (ledger.gateMode !== 'design-conformance') {
      gvRaw = readArtifact(stateDir, n, 'gate-verify'); // fail-closed and normalized before classification
      verifyFindings = gc.parseGateFindings(JSON.stringify(gvRaw.findings));
    }
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
    // A gate duplicate of a correctness finding drops out only while that
    // correctness finding survives its own verifier; otherwise it stands.
    const survivingCorrectness = new Set(candidates.filter((f) => !killed.has(f.id)).map((f) => f.id));
    const duplicateIds = ((gvRaw && gvRaw.duplicates) || []).filter((d) => survivingCorrectness.has(d.of)).map((d) => d.id);
    const rejected = (gvRaw ? gc.parseVerifyVerdict(JSON.stringify({ rejected: gvRaw.rejected }), mergedGateFindings).rejectedIds : []).concat(duplicateIds);
    // gate-verify's `blocking` ids override a finder's follow-up claim (fail closed).
    const blockingReasons = new Map();
    for (const b of (gvRaw && gvRaw.blocking) || []) {
      if (!byId.has(b.id)) throw new Error(`harness-failure: gate-verify blocking id "${b.id}" is not a gate candidate`);
      blockingReasons.set(b.id, b.reason);
    }
    const thisRound = gateLib.foldGateFindings({ gateFindings: mergedGateFindings, verifyRejectedIds: rejected, dismissedIds: ledger.gate_dismissed || [] })
      .map((f) => (blockingReasons.has(f.id) ? { ...f, blockingReason: blockingReasons.get(f.id) } : f));
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
  return { repoRoot, slug, ledger, n, isGit, changed, fixes, resolvedAbsent, intentParked, gateOpen, gateApplied };
}

// Every mutating target verb takes the same lock, including an unkeyed call
// racing the target's first initiative binding. `show` only reads.
function main(resolveFromCwd) {
  const { args, initiative } = extractInitiative(process.argv.slice(2));
  if (args[0] === 'feedback') {
    if (initiative) throw new Error('feedback: use the project store without initiative mutation flags');
    const result = require('./review-feedback').runFeedback(args.slice(1), process.env.REVIEW_REPO_ROOT || process.cwd());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!args[1] || args[0] === 'show' || RUN_VERBS.has(args[0])) return runVerb(resolveFromCwd, args, initiative);
  const stateDir = resolveStateDir(resolveFromCwd);
  const slug = targetSlug(args[1]);
  // Unreadable state cannot prove a standalone identity or an absent binding.
  // Preserve the original bytes until its ledger and binding are restored.
  const readPrior = () => readLedger(stateDir, slug);
  const isBound = (ledger) => !!ledger?.initiative_binding || !!ledger?.initiative_reservations?.length;
  const dispatch = () => {
    const prior = readPrior();
    if (!initiative && isBound(prior)) throw new Error('review-cli: this target belongs to an initiative; every mutating verb requires the complete initiative run flags');
    // carry's whole point is binding the target to a DIFFERENT key than its
    // current one -- the generic same-binding check would refuse every real
    // call. carryBudgetBlockedTarget does its own, narrower identity checks
    // against the supplied --from-run-key instead.
    if (initiative && isBound(prior) && args[0] !== 'carry') {
      // Legacy reservation tokens contain no run key or state directory, so
      // supplied flags cannot establish their original budget's identity.
      if (!prior.initiative_binding) throw new Error('review-cli: legacy initiative reservations have no binding; preserve the original ledgers and reconcile their identity and spent budget before restoring the original binding');
      if (prior.initiative_binding.key !== initiative.key || prior.initiative_binding.stateDir !== canonicalPath(initiative.stateDir)) {
        throw new Error('review-cli: different initiative binding; retain the original run flags, or after reconciliation use a separate target review state directory');
      }
    }
    if (args[0] === 'carry' && !initiative) throw new Error('review-cli carry: requires the new key\'s initiative run flags (--initiative-run-key, --initiative-state-dir, --initiative-max-launches, --initiative-max-rounds)');
    // A wrong --from-run-key or state dir must be refused HERE, before any
    // rerun_cleanup side effect below (openKeyedRun creating the new run,
    // finishRerunCleanup deleting archived evidence) runs. carryBudgetBlockedTarget
    // repeats this exact check, but only after rerun_cleanup already happened.
    if (args[0] === 'carry') {
      const { fromRunKey } = carryOptions(args.slice(2));
      if (!prior?.initiative_binding) throw new Error('review-cli carry: the target is unbound, or has legacy initiative reservations with no binding; carry requires an existing binding to --from-run-key');
      if (prior.initiative_binding.key !== fromRunKey || prior.initiative_binding.stateDir !== canonicalPath(initiative.stateDir)) {
        throw new Error('review-cli carry: the target is not bound to --from-run-key under this initiative state directory');
      }
      // A pending rerun cleanup means the target was rerun, so its fresh ledger
      // holds no budget-exhausted marker and carry cannot succeed. Refuse before
      // the cleanup below deletes evidence or any destination run is touched.
      if (prior.rerun_cleanup) throw new Error('review-cli carry: the target has an interrupted rerun pending cleanup; complete it with the original run flags first, there is no blocked round to carry');
    }
    if (args[0] === 'reset' && initiative) throw new Error('review-cli reset: cannot discard an initiative target; use rerun with the same initiative run flags to retain history and spent budget');
    if (prior?.rerun_cleanup) {
      // Cleanup is a mutation: reject invalid calls and immutable run option
      // mismatches before deleting any evidence or clearing the pending marker.
      if (!CLI_VERBS.includes(args[0])) throw unknownVerb(args[0]);
      if (args[0] === 'reserve') reserveOptions(args.slice(2));
      if (args[0] === 'rerun') rerunOptions(args.slice(2));
      const run = initiative && openKeyedRun(initiative);
      if (args[0] === 'round-start') requireRoundStartMode(run, args.slice(2));
    }
    finishRerunCleanup(stateDir, slug, prior);
    // Reservation binding is published only by the validated charge path;
    // a normal denial must leave a standalone target unbound.
    // carry already performs its own single atomic target-ledger write
    // (bind + provenance + drop the marker); the generic rebind below would
    // be a redundant second write.
    if (args[0] === 'reserve' || args[0] === 'carry') return runVerb(resolveFromCwd, args, initiative);
    runVerb(resolveFromCwd, args, initiative);
    if (initiative) {
      const ledger = readLedger(stateDir, slug);
      if (ledger) persistLedger(stateDir, slug, { ...ledger, initiative_binding: { key: initiative.key, stateDir: canonicalPath(initiative.stateDir) } });
    }
  };
  // Serialize even initially unbound calls: otherwise an older unkeyed write
  // can erase a first binding that a keyed call just persisted.
  return withTargetLock(ledgerPath(stateDir, slug), dispatch);
}

// Run-level verbs act on the initiative run, not on a target ledger, so they take no target lock.
function runLevelVerb(verb, arg, initiative, rest = []) {
  if (!initiative) throw new Error(`review-cli ${verb}: requires the initiative run flags (--initiative-run-key, --initiative-state-dir, --initiative-max-launches, --initiative-max-rounds)`);
  if (verb === 'session-checkpoint') {
    if (rest.length && (rest.length !== 2 || rest[0] !== '--session-handoff')) throw new Error('session handoff: use session-checkpoint <absolute-packet.json> [--session-handoff <off|suggest|stop-at-checkpoint>]');
    const result = require('./session-handoff').createSessionHandoff({ packetPath: arg, mode: rest.length ? rest[1] : 'suggest', initiative, repository: process.env.REVIEW_REPO_ROOT || process.cwd() });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const stateDir = canonicalPath(initiative.stateDir);
  const repository = canonicalPath(process.env.REVIEW_REPO_ROOT || process.cwd());
  if (verb === 'escalate') {
    escalateInitiativeRun({ stateDir, key: initiative.key, initiativeId: initiative.initiativeId, repository, trigger: arg, maxLaunches: Number(initiative.maxLaunches), maxRounds: Number(initiative.maxRounds) });
    process.stdout.write(`${JSON.stringify({ status: 'escalated', mode: 'base', trigger: arg })}\n`);
    return;
  }
  const run = openKeyedRun(initiative);
  if (verb === 'finalise') {
    if (!finaliseInitiativeRun(run, 'finalised')) throw new Error(lockDiagnosis(run) || 'review-cli finalise: initiative run is contended; retry');
    process.stdout.write(`${JSON.stringify({ status: 'finalised' })}\n`);
    return;
  }
  if (!arg) throw new Error('review-cli consume: requires a delivery claim');
  if (!consumeDispositionDelivery(run, arg)) throw new Error('review-cli consume: no unconsumed delivery for this claim in the initiative run');
  process.stdout.write(`${JSON.stringify({ status: 'consumed' })}\n`);
}

function runVerb(resolveFromCwd, args, initiative) {
  // Every intermediate publication is already bound, including the first
  // keyed operation and writes whose caller never reaches main's return path.
  const binding = initiative && { key: initiative.key, stateDir: canonicalPath(initiative.stateDir) };
  const writeLedger = (directory, slug, ledger) => persistLedger(directory, slug, binding ? { ...ledger, initiative_binding: binding } : ledger);
  const [verb, ref, ...rest] = args;
  const stateDir = resolveStateDir(resolveFromCwd);
  // `reserve` and `carry` open their run(s) themselves, inside the target-ledger
  // lock main() holds, so parallel first calls (and the old-then-new run order
  // carry needs) serialize correctly.
  if (RUN_VERBS.has(verb)) return runLevelVerb(verb, ref, initiative, rest);
  const run = initiative && verb !== 'reserve' && verb !== 'carry' && verb !== 'show' ? openKeyedRun(initiative) : null;

  if (verb === 'reserve') {
    requireRef(ref, 'reserve');
    const { role, count } = reserveOptions(rest);
    if (!initiative) { process.stdout.write(`${JSON.stringify({ status: 'granted', keyed: false, role, count })}\n`); return; }
    const slug = targetSlug(ref);
    const result = (() => {
      const run = openKeyedRun(initiative);
      const ledger = readLedger(stateDir, slug);
      const panelPending = ledger?.phase === 'done' && ledger.status === 'gate-panel-pending';
      if (!ledger || (!['gates', 'fixes'].includes(ledger.phase) && !panelPending)) throw new Error(`reserve: no active review work for ref "${ref}" ${stateDirHint(stateDir)}`);
      // plan-fixes already parked this round for reconciliation (a confirmed
      // contract/architecture finding emptied `planned`) -- a `fix` launch
      // would have nothing legitimate to fix and must not be granted or
      // charged. The run-level reconciliation refusal in launchRefusal only
      // engages after `record` folds this into the initiative run, which is
      // too late to stop a `fix` reservation made between plan-fixes and
      // record. Check the target ledger directly, same reason/shape as the
      // run-level denial above.
      if (role === 'fix' && ledger.reconciliation) return { status: 'reconciliation-required', role, count, round: ledger.round };
      const target = ledger.target?.ref || ref;
      const revision = { ref: target, ...(ledger.target?.base ? { base: resolveBaseCommit(process.env.REVIEW_REPO_ROOT || process.cwd(), ledger.target.base) } : {}), ...(ledger.target?.head_sha ? { head_sha: ledger.target.head_sha } : {}) };
      const launch = { role, round: ledger.round, target, revision, attemptId: ledger.attemptId, broad: ledger.gateMode === 'pair' && /^gate-/.test(role) };
      if (!reserveLaunchBatch(run, launch, count, () => {
        // Called under the run lock only after phase and budget validation.
        // Publish identity before charging so interruption cannot free the target.
        if (ledger.initiative_binding) return;
        writeLedger(stateDir, slug, ledger);
        return () => persistLedger(stateDir, slug, ledger);
      })) {
        const reason = denialReason(run, launch, count);
        const diagnosis = reason ? null : lockDiagnosis(run);
        // A bound target blocked on budget-exhausted stays recoverable: persist
        // the marker `carry` checks against so a human can move it to a new run
        // key without losing the round's completed artifacts. An unbound target
        // (ledger.initiative_binding unset -- this is its first reservation
        // attempt) stays unbound: there is nothing yet to carry.
        if (reason === 'budget-exhausted' && ledger.initiative_binding) {
          writeLedger(stateDir, slug, { ...ledger, initiative_blocked: { key: initiative.key, stateDir: canonicalPath(initiative.stateDir), round: ledger.round, attemptId: ledger.attemptId, role, count, revision } });
        }
        return reason === 'reconciliation-required' ? { status: reason, role, count, round: ledger.round } : { status: 'denied', role, count, round: ledger.round, ...(reason ? { reason } : {}), ...(diagnosis ? { lockDiagnosis: diagnosis } : {}) };
      }
      const token = crypto.randomBytes(16).toString('hex');
      const artifact = Object.entries(ARTIFACT_RESERVE_ROLE).find(([, mapped]) => mapped === role)?.[0];
      if (artifact) {
        const repairPath = path.join(stateDir, `round-${ledger.round}-${artifact}.repair.json`);
        try {
          const repair = JSON.parse(readReviewArtifact(repairPath, stateDir, 'utf8'));
          if (repair.state === 'prepared' && repair.target?.ref === ref && repair.round === ledger.round) fs.writeFileSync(repairPath, JSON.stringify({ ...repair, state: 'reserved', reservationToken: token }) + '\n');
        } catch (_) { /* ordinary reviewer reservation */ }
      }
      const panel = role === 'lens' || role === 'vote' ? (ledger.gate_panel?.round || 0) + 1 : undefined;
      writeLedger(stateDir, slug, { ...ledger, initiative_reservations: [...(ledger.initiative_reservations || []), { token, role, round: ledger.round, ...(panel ? { panel } : {}), count }] });
      return { status: 'granted', role, count, round: ledger.round, token };
    })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (verb === 'carry') {
    requireRef(ref, 'carry');
    if (!initiative) throw new Error('review-cli carry: requires the new key\'s initiative run flags (--initiative-run-key, --initiative-state-dir, --initiative-max-launches, --initiative-max-rounds)');
    const { fromRunKey } = carryOptions(rest);
    const slug = targetSlug(ref);
    const result = carryBudgetBlockedTarget({ stateDir, slug, ref, initiative, fromRunKey, repoRoot: process.env.REVIEW_REPO_ROOT || process.cwd(), writeLedger });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (verb === 'telemetry-slot') {
    requireRef(ref, 'telemetry-slot');
    const artifactPath = path.resolve(String(rest[0] || ''));
    const engine = rest[1] === '--engine' ? rest[2] : null;
    const providers = { 'claude-code': 'anthropic', codex: 'openai' };
    if (rest.length !== 3 || !Object.hasOwn(providers, engine)) throw new Error('telemetry-slot: requires --engine claude-code|codex');
    const provider = providers[engine];
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    const panelPending = ledger?.phase === 'done' && ledger.status === 'gate-panel-pending';
    if (!ledger || (!['gates', 'fixes'].includes(ledger.phase) && !panelPending)) throw new Error(`telemetry-slot: no active review work for ref "${ref}" ${stateDirHint(stateDir)}`);
    if (path.dirname(artifactPath) !== path.resolve(stateDir)) throw new Error('telemetry-slot: artifact destination must be directly inside the state directory');
    const match = new RegExp(`^round-${ledger.round}-([A-Za-z0-9:._-]+)\\.json$`).exec(path.basename(artifactPath));
    if (!match) throw new Error(`telemetry-slot: destination does not belong to active round ${ledger.round}`);
    const suffix = match[1];
    const role = reviewTelemetry.roleFromArtifactSuffix(suffix);
    const slots = Array.isArray(ledger.telemetrySlots) ? ledger.telemetrySlots : [];
    const attempt = slots.filter((slot) => slot.engine === engine && slot.artifactPath === artifactPath).length + 1;
    const slot = { engine, provider, artifactPath, attempt, role, round: ledger.round };
    writeLedger(stateDir, slug, { ...ledger, telemetrySlots: [...slots, slot] });
    process.stdout.write(`${JSON.stringify(slot)}\n`);
    return;
  }

  if (verb === 'artifact-normalize') {
    requireRef(ref, 'artifact-normalize');
    // The argument is the artifact ROLE, but the driver doc's `<artifact-name>`
    // reads as the on-disk file name to more than one operator -- and passing
    // `round-1-correctness.json` failed as a TERMINAL harness-failure on a
    // working setup. Accept both forms rather than making a naming ambiguity
    // stop a run, and name the valid roles when it is neither.
    const rawName = rest[0];
    const candidateArg = rest[1] === '--candidate' ? rest[2] : null;
    if (rest.length !== 1 && (!candidateArg || rest.length !== 3)) throw new Error('artifact-normalize: expected <role> [--candidate <path>]');
    const name = String(rawName == null ? '' : rawName).replace(/^round-\d+-/, '').replace(/\.json$/, '');
    if (!artifactContract.ARTIFACT_ROLES.includes(name)) {
      throw new Error(`harness-failure: artifact-normalize: unknown artifact "${rawName}" (expected one of ${artifactContract.ARTIFACT_ROLES.join(' | ')}, or the matching round-<n>-<role>.json file name)`);
    }
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    const n = ledger && ledger.round;
    if (name === 'plan' && ledger?.execution?.planRetry?.state === 'exhausted') throw new Error(`harness-failure: ${ledger.execution.planRetry.message}`);
    if (!n) throw new Error(`harness-failure: artifact-normalize: no active round for ref "${ref}" ${stateDirHint(stateDir)} -- run this verb from the same directory as round-start, or set REVIEW_STATE_DIR`);
    if (name === 'plan') requireReservations(run, ledger, [{ role: 'plan', present: 1 }], 'artifact-normalize');
    const p = path.join(stateDir, `round-${n}-${name}.json`);
    const retryPath = path.join(stateDir, `round-${n}-${name}.retry`);
    const snapshotPath = path.join(stateDir, `round-${n}-${name}.original`);
    const repairPath = path.join(stateDir, `round-${n}-${name}.repair.json`);
    let raw;
    try { raw = readReviewArtifact(candidateArg || p, stateDir, 'utf8'); } catch (e) { throw new Error(`harness-failure: missing or unsafe ${candidateArg ? 'repair candidate' : 'gate artifact'} ${name} for round ${n}`); }
    try {
      if (fs.existsSync(repairPath)) {
        const repair = JSON.parse(readReviewArtifact(repairPath, stateDir, 'utf8'));
        const original = readReviewArtifact(snapshotPath, stateDir);
        if (contentHash(original) !== repair.originalHash) throw new Error(`${name} repair snapshot hash changed`);
        if (!candidateArg) throw new Error(`${name} repair requires a separate candidate`);
        if (path.resolve(candidateArg) !== path.resolve(repair.candidatePath)) throw new Error(`${name} repair candidate path changed`);
        if (!artifactContract.preservesArtifact(name, original.toString('utf8'), JSON.parse(raw))) throw new Error(`${name} repair candidate does not preserve the original evidence`);
      }
      const canonical = artifactContract.normalizeArtifact(name, raw);
      // Correctness coverage is part of the artifact contract for git targets:
      // retry the reviewer while its original artifact is still intact rather
      // than canonicalizing an incomplete examined list and discovering the
      // problem only after verify has already run. File targets hold document
      // contents, not a unified diff, so their examined list stays advisory.
      if (name === 'correctness' && (!ledger.target || ledger.target.type === 'git')) {
        const changed = readChangedPaths(stateDir, ledger, ref, n);
        const examined = new Set(canonical.examined);
        const missing = changed.filter((file) => !examined.has(file));
        if (missing.length) {
          const error = new artifactContract.ArtifactError('retry', `correctness coverage is incomplete; missing changed file(s): ${missing.join(', ')}`);
          error.coveragePaths = changed;
          throw error;
        }
      }
      const canonicalText = JSON.stringify(canonical) + '\n';
      // Only a candidate that passed preservation and strict normalization is
      // published. Invalid repair bytes never replace the original artifact.
      writeReviewArtifact(p, canonicalText);
      if (ledger.execution && ledger.execution.round === n) {
        // Normalization seals evidence; only plan-fixes accepts its classification.
        const completed = name === 'plan' ? (ledger.execution.completed || []).filter((role) => role !== 'plan')
          : Array.from(new Set([...(ledger.execution.completed || []), name]));
        const artifactHashes = { ...(ledger.execution.artifactHashes || {}), [name]: contentHash(canonicalText) };
        const retryArtifacts = retryArtifactMap(ledger.execution);
        delete retryArtifacts[name];
        const pending = name === 'plan'
          ? Array.from(new Set([...(ledger.execution.pending || []), 'plan']))
          : (ledger.execution.pending || []).filter((role) => role !== name);
        writeLedger(stateDir, slug, { ...ledger, execution: { ...ledger.execution, completed, artifactHashes, pending,
          ...(name === 'plan' ? { normalizedPlan: contentHash(canonicalText) } : {}), retryArtifacts, retryArtifact: firstRetryArtifact(retryArtifacts) } });
      }
      try { fs.unlinkSync(retryPath); } catch (e) { /* no prior retry */ }
      process.stdout.write(JSON.stringify({ status: 'ok', artifact: name }) + '\n');
      return;
    } catch (e) {
      if (e instanceof artifactContract.ArtifactError && e.kind === 'retry') {
        // Repair may only change a known status spelling, or remove foreign
        // dispositions while retaining complete role-owned evidence.
        let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        const statusSpelling = parsed && typeof parsed.status === 'string' && ['ok', 'findings', 'clean'].includes(parsed.status.toLowerCase()) && parsed.status !== parsed.status.toLowerCase();
        const prefixes = artifactContract.allowedFindingPrefixes(name);
        const items = parsed && artifactContract.ARTIFACT_ROLES.includes(name)
          ? ['rejected', 'findings', 'groups'].flatMap((key) => Array.isArray(parsed[key]) ? parsed[key] : [])
          : [];
        const idOf = (item) => typeof item === 'string' ? item : item && (item.id || item.findingIds);
        const mixedNamespaces = /invalid id/.test(e.message)
          && items.flatMap(idOf).some((id) => typeof id === 'string' && prefixes.some((prefix) => id.startsWith(prefix)))
          && items.flatMap(idOf).some((id) => typeof id === 'string' && !prefixes.some((prefix) => id.startsWith(prefix)));
        if (!statusSpelling && !mixedNamespaces) throw new Error(`harness-failure: ${e.message}`);
        const retryArtifacts = retryArtifactMap(ledger.execution);
        // The pending semantic prompt requests a new plan, not a representation
        // repair. Durable repair bindings still bound that replacement to one repair.
        const semanticReplacement = name === 'plan' && ledger.execution?.round === n && ledger.execution.planRetry?.state === 'pending';
        const alreadyRetried = fs.existsSync(repairPath) || fs.existsSync(retryPath) || (!!retryArtifacts[name] && !semanticReplacement);
        if (!alreadyRetried) {
          if (ledger.execution && ledger.execution.round === n) {
            if (!semanticReplacement) delete retryArtifacts[name];
            writeLedger(stateDir, slug, { ...ledger, execution: { ...ledger.execution, retryArtifacts, retryArtifact: firstRetryArtifact(retryArtifacts),
              // From this point resume must retain the replacement's repair.
              ...(semanticReplacement ? { planRetry: { ...ledger.execution.planRetry, discardRepair: false } } : {}) } });
          }
          const bytes = Buffer.from(raw);
          fs.writeFileSync(snapshotPath, bytes, { flag: 'wx' });
          const candidatePath = path.join(stateDir, `round-${n}-${name}.candidate.json`);
          const packetPath = path.join(stateDir, `round-${n}-${name}.packet.json`);
          const packet = artifactContract.repairPacket(name, e.message, raw);
          fs.writeFileSync(packetPath, JSON.stringify(packet) + '\n', { flag: 'wx', mode: 0o600 });
          const repair = { target: ledger.target || { ref }, role: name, round: n, diffHash: contentHash(readReviewArtifact(path.join(stateDir, `round-${n}-diff.txt`), stateDir, 'utf8')), originalHash: contentHash(bytes), error: e.message, snapshotPath, packetPath, packetHash: contentHash(readReviewArtifact(packetPath, stateDir)), candidatePath, candidateHash: null, state: 'prepared' };
          fs.writeFileSync(repairPath, JSON.stringify(repair) + '\n', { flag: 'wx' });
          // A retry is a new launch: it must be reserved again before its evidence is accepted.
          if (run && ARTIFACT_RESERVE_ROLE[name]) writeLedger(stateDir, slug, withSupersededLaunch(readLedger(stateDir, slug), ARTIFACT_RESERVE_ROLE[name], n));
          process.stdout.write(JSON.stringify({ status: 'repair', artifact: name, repair }) + '\n');
          return;
        }
      }
      throw new Error(`harness-failure: ${e.message}`);
    }
  }

  if (verb === 'artifact-repair-dispatch') {
    requireRef(ref, 'artifact-repair-dispatch');
    const name = String(rest[0] || '');
    const slug = targetSlug(ref); const ledger = readLedger(stateDir, slug); const n = ledger?.round;
    if (!n || !artifactContract.ARTIFACT_ROLES.includes(name)) throw new Error('artifact-repair-dispatch: requires active <role>');
    const repairPath = path.join(stateDir, `round-${n}-${name}.repair.json`);
    const repair = JSON.parse(readReviewArtifact(repairPath, stateDir, 'utf8'));
    if (repair.state === 'dispatched') { process.stdout.write(JSON.stringify(repair) + '\n'); return; }
    if (!['prepared', 'reserved'].includes(repair.state) || repair.target?.ref !== ref || repair.round !== n) throw new Error(`${name} repair binding changed`);
    const dispatched = { ...repair, state: 'dispatched' };
    writeReviewArtifact(repairPath, JSON.stringify(dispatched) + '\n');
    process.stdout.write(JSON.stringify(dispatched) + '\n');
    return;
  }

  if (verb === 'artifact-repair-candidate') {
    requireRef(ref, 'artifact-repair-candidate');
    const name = String(rest[0] || ''); const slug = targetSlug(ref); const ledger = readLedger(stateDir, slug); const n = ledger?.round;
    if (!n || !artifactContract.ARTIFACT_ROLES.includes(name)) throw new Error('artifact-repair-candidate: requires active <role>');
    const repairPath = path.join(stateDir, `round-${n}-${name}.repair.json`); const repair = JSON.parse(readReviewArtifact(repairPath, stateDir, 'utf8'));
    if (repair.state !== 'dispatched') throw new Error(`${name} repair was not dispatched`);
    const candidateHash = contentHash(readReviewArtifact(repair.candidatePath, stateDir));
    const completed = { ...repair, candidateHash, state: 'candidate-ready' };
    writeReviewArtifact(repairPath, JSON.stringify(completed) + '\n');
    process.stdout.write(JSON.stringify(completed) + '\n');
    return;
  }

  if (verb === 'plan-dispatch') {
    requireRef(ref, 'plan-dispatch');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger || ledger.phase !== 'gates') throw new Error('plan-dispatch: no active planning work');
    const retry = ledger.execution?.planRetry;
    if (retry && retry.state !== 'accepted') {
      if (retry.launched || retry.state === 'exhausted') throw new Error(`harness-failure: planner retry exhausted for this round; ${retry.message}`);
      requireReservations(run, ledger, [{ role: 'plan', present: 1 }], 'plan-dispatch');
      writeLedger(stateDir, slug, { ...ledger, execution: { ...ledger.execution, planRetry: { ...retry, launched: true } } });
    }
    process.stdout.write(JSON.stringify({ status: 'granted' }) + '\n');
    return;
  }

  if (verb === 'round-failure') {
    requireRef(ref, 'round-failure');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger || !['gates', 'fixes'].includes(ledger.phase)) throw new Error(`round-failure: no active review work for ref "${ref}" ${stateDirHint(stateDir)}`);
    let failure;
    try { failure = JSON.parse(rest[0]); } catch (_) { throw new Error('round-failure: expected one JSON failure record'); }
    if (!failure || typeof failure.role !== 'string' || typeof failure.kind !== 'string' || typeof failure.message !== 'string') throw new Error('round-failure: failure requires role, kind, and message strings');
    const execution = ledger.execution || { round: ledger.round, completed: [], pending: [] };
    const entry = { role: failure.role, kind: failure.kind, message: failure.message, ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}), ...(failure.signal ? { signal: failure.signal } : {}), at: new Date().toISOString() };
    const failed = { ...ledger, execution: { ...execution, ...(failure.role === 'plan' && execution.planRetry?.launched ? { planRetry: { ...execution.planRetry, state: 'exhausted', message: `planner retry exhausted for this round; ${failure.message}` } } : {}), failures: [...(execution.failures || []), entry].slice(-5), failure: entry } };
    writeLedger(stateDir, slug, run && ARTIFACT_RESERVE_ROLE[failure.role] ? withSupersededLaunch(failed, ARTIFACT_RESERVE_ROLE[failure.role], ledger.round) : failed);
    process.stdout.write(JSON.stringify({ status: 'recorded', round: ledger.round, retryable: true }) + '\n');
    return;
  }

  if (verb === 'show') {
    requireRef(ref, 'show');
    const slug = targetSlug(ref);
    const stored = readLedger(stateDir, slug);
    const ledger = (stored?.rerun_cleanup ? stored : reviewTelemetry.foldTelemetry(stateDir, stored, slug)) || emptyLedger({ kind: 'local', ref });
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
    if (!ledger) throw new Error(`harness-failure: gate-panel-round-start: no ledger for ref "${ref}" ${stateDirHint(stateDir)}`);
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
    if (!ledger) throw new Error(`harness-failure: gate-panel-round-record: no ledger for ref "${ref}" ${stateDirHint(stateDir)}`);
    const gp = ledger.gate_panel || gatePanelLib.emptyGatePanel();
    if (gp.status === 'done') throw new Error('harness-failure: gate-panel-round-record: the panel already finished this convergence attempt');
    const n = ledger.round;
    const m = (gp.round || 0) + 1;
    requireReservations(run, ledger, [
      { role: 'lens', present: GATE_PANEL_LENSES.filter((lens) => fs.existsSync(path.join(stateDir, `round-${n}-gate-panel-${m}-${lens}.json`))).length, panel: m },
      { role: 'vote', present: roundFiles(stateDir, n, new RegExp(`^round-${n}-gate-panel-${m}-vote-.*\\.json$`)), panel: m },
    ], 'gate-panel-round-record');

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
      requireNotBlocked(`gate-panel round ${m} "${lens}" lens`, raw);
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
    let vRaw;
    try {
      vRaw = JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-gate-panel-${m}-verify.json`), 'utf8'));
    } catch (e) {
      vRaw = null; // missing or unparseable -- lenient, nothing survives below
    }
    requireNotBlocked(`gate-panel round ${m} verify`, vRaw);
    try {
      if (!vRaw || vRaw.status !== 'ok' || !Array.isArray(vRaw.rejected)) {
        throw new Error('malformed verify artifact shape');
      }
      // Entries are `{ id, reason }` or (legacy) a bare id -- this artifact is
      // deliberately outside the normalize path, so it accepts both.
      const rejected = new Set(vRaw.rejected.map((entry) => (typeof entry === 'string' ? entry : entry && entry.id)));
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
    // "resume" is a review-until-green wrapper concept (bin/review-until-green.js
    // parses `resume <ref>` and forwards just `<ref>` to round-start -- see
    // codex-review-runner.js's `startArgs = ['round-start', ref]`). round-start
    // itself has no such keyword; resuming an interrupted round is auto-detected
    // from ledger.phase, and continuing after unpark is an ordinary round-start
    // call. Passing the wrapper's `resume <ref>` syntax straight to round-start
    // makes `ref` the literal string "resume" and shifts the real ref into the
    // base slot, silently creating an unrelated ledger and never touching the
    // real one. Fail fast instead of letting that surface several steps later
    // as a confusing `expected phase "gates", got "done"` in plan-fixes.
    if (ref === 'resume') {
      throw new Error('review-cli round-start: "resume" is not a valid ref -- round-start auto-detects resume from ledger state; call `round-start <ref>` directly, or use the review-until-green wrapper\'s `resume <ref>` syntax, which forwards correctly');
    }
    // Rejected before any state is written: the intent-review and gate-pending resets below delete the cached intent.
    requireRoundStartMode(run, rest);
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug) || emptyLedger({ kind: 'local', ref });
    const ROUTING_FLAGS = new Map([
      ['--reviewer', 'reviewer'],
      ['--reviewer-model', 'reviewerModel'],
      ['--fixer', 'fixer'],
      ['--fixer-model', 'fixerModel'],
    ]);
    const routingIndexes = new Set();
    const requestedRouting = {};
    for (let index = 0; index < rest.length; index++) {
      const field = ROUTING_FLAGS.get(rest[index]);
      if (!field) continue;
      const value = rest[index + 1];
      if (!value || value.startsWith('--') || Object.hasOwn(requestedRouting, field)) {
        throw new Error(`review-cli round-start: ${rest[index]} requires exactly one value`);
      }
      requestedRouting[field] = value;
      routingIndexes.add(index);
      routingIndexes.add(index + 1);
      index++;
    }
    for (const field of ['reviewer', 'fixer']) {
      if (requestedRouting[field] && !['claude', 'codex', 'copilot'].includes(requestedRouting[field])) {
        throw new Error(`review-cli round-start: --${field} must be claude, codex, or copilot`);
      }
    }
    if (ledger.reviewRouting) {
      for (const [field, value] of Object.entries(requestedRouting)) {
        if (ledger.reviewRouting[field] !== value) {
          throw new Error(run ? 'review-cli round-start: routing differs from the active run; for this initiative target, rerun with the original initiative flags before changing provider or model, retaining history and spent budget' : 'review-cli round-start: routing differs from the active run; for this standalone target, reset or rerun before changing provider or model');
        }
      }
    }
    const reviewRouting = ledger.reviewRouting || (Object.keys(requestedRouting).length ? requestedRouting : null);

    // Captured before the clearing paths below wipe intent_parked. Handed to the
    // intent detector so the SAME objection keeps the SAME id across rounds --
    // nothing dedupes intent findings by id; the id is how a human re-reading the
    // handoff recognises an objection they already saw. A re-slugged repeat reads
    // as a new problem.
    const priorIntentIds = (ledger.intent_parked || []).map((f) => f.id);

    // intent-review is a re-runnable stop state: a fresh round-start clears it,
    // nulls diff_content_hash so beginRound advances a real round, and clears
    // intentHash + deletes the cached artifact so intent RE-FETCHES -- picking up
    // a correction the human made to the design source to retire a false positive.
    if (ledger.status === 'intent-review') {
      ledger = clearIntentForFreshLook(stateDir, slug, ledger);
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, intent_parked: [], gate_panel: gatePanelLib.emptyGatePanel(), gate_rounds: [] };
    }

    // gate-pending, like intent-review, is a re-runnable stop state: a fresh
    // round-start clears the reported gate findings and nulls the diff hash so a
    // real round advances and the gate re-evaluates. gate_dismissed is preserved
    // (a finding the human retired stays retired across re-runs). gate_panel also
    // resets -- the panel must re-run fresh on every convergence attempt (design
    // decision 4: "exactly once per convergence attempt", not once per ledger
    // lifetime), otherwise stale confirmed findings from the prior panel run would
    // keep resurfacing in gate_open even after being fixed or dismissed.
    // gate_rounds resets for the same reason -- it is what makes the front pass
    // fire, and a new convergence attempt that cleared gate_open without it
    // would erase the standing broad findings and never re-derive them, then
    // report clean. Both re-runnable stop states above clear it; the
    // gate-panel-pending reset below deliberately does NOT, because that is an
    // interrupted panel resuming WITHIN the same attempt, not a new one.
    // Intent is
    // cleared for the same reason intent-review clears it: the documented remedy
    // includes editing the design source, so a re-run is a NEW run against
    // possibly-new requirements and must re-fetch rather than trip the drift check.
    if (ledger.status === 'gate-pending') {
      ledger = clearIntentForFreshLook(stateDir, slug, ledger);
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, gate_open: [], gate_panel: gatePanelLib.emptyGatePanel(), gate_rounds: [] };
    }

    // gate-panel-pending is also re-runnable: a session may have crashed or been
    // interrupted mid-panel (between record() first returning panelPending and the
    // panel loop completing). A fresh round-start here resets gate_panel so the
    // panel restarts cleanly from round 1 rather than leaving a half-finished panel
    // stranded with no way to resume.
    if (ledger.status === 'gate-panel-pending') {
      ledger = { ...ledger, status: 'converging', diff_content_hash: null, gate_panel: gatePanelLib.emptyGatePanel() };
    }

    // A final DoD failure is re-runnable after the caller fixes it. Preserve the
    // completed broad pass: the next round reviews only the changed diff, then
    // attempts the final DoD again if review converges.
    const retryingDod = ledger.status === 'dod-failed';
    if (retryingDod) {
      ledger = { ...ledger, status: 'converging', diff_content_hash: null };
    }

    // Broad review is ARMED BY DEFAULT; these flags are the per-invocation
    // overrides. --broad/--gate re-arm a ledger that opted out; --no-broad opts
    // out. Both live among round-start's trailing arguments, order-independent
    // against the optional `base` token below. Any other "--"-prefixed token is
    // a usage error rather than silently falling through to `base` (which would
    // produce a confusing downstream git error against a nonsense ref).
    const BROAD_FLAGS = new Set(['--broad', '--gate']);
    const broadFlagPassed = rest.some((a) => BROAD_FLAGS.has(a));
    const NO_BROAD_FLAGS = new Set(['--no-broad']);
    const noBroadFlagPassed = rest.some((a) => NO_BROAD_FLAGS.has(a));
    const lite = !!run && runMode(run) === 'lite';
    // Executable-DoD opt-out (--no-dod): the same deferral `"dod": null` in
    // review.config.json declares, asked for per-run instead. It exists for a
    // repo that HAS a config with real `dod` commands but wants the executable
    // gate skipped for this run (a config-less repo already defers on its own).
    // The review gates still run; the DoD is reported deferred and never faked
    // to a pass.
    const NO_DOD_FLAGS = new Set(['--no-dod']);
    const noDodFlagPassed = rest.some((a) => NO_DOD_FLAGS.has(a));
    // --intent-file <path>: the caller supplies the intent text directly and the
    // repository's configured intent command, if any, is not run.
    // --no-intent-command: the checkout is untrusted, so its configured intent
    // command is not run; only an --intent-file supplies intent.
    const noIntentCommand = rest.includes('--no-intent-command');
    const intentFileAt = rest.indexOf('--intent-file');
    const intentFile = intentFileAt === -1 ? null : rest[intentFileAt + 1];
    if (intentFileAt !== -1 && (!intentFile || intentFile.startsWith('--') || rest.indexOf('--intent-file', intentFileAt + 1) !== -1)) {
      throw new Error('review-cli round-start: --intent-file requires exactly one value');
    }
    const positional = rest.filter((a, index) => !BROAD_FLAGS.has(a) && !NO_BROAD_FLAGS.has(a) && !NO_DOD_FLAGS.has(a) && a !== '--no-intent-command' && !routingIndexes.has(index)
      && (intentFileAt === -1 || (index !== intentFileAt && index !== intentFileAt + 1)));
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
    const baseSha = !isFileTarget && base ? sh('git', ['rev-parse', base], { cwd: repoRoot }).trim() : null;
    if (retryingDod && ledger.target?.base_sha !== baseSha) {
      ledger = { ...ledger, retry_diff_base: null, broad_reuse: null, gate_open: [], gate_rounds: [], gate_reviewed_head_sha: null };
    }

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
    // round artifacts (and, for a file target, a stale fix-<safe-id>.json that has no
    // git journal to override it), so BOTH target types must purge them and
    // reset the round's planned/absent/intent arrays before re-driving. Only the
    // git-specific working-tree discard (gitCheckoutTree) is gated on git; a file
    // target has no working tree to check out. Before this, a resumed file target
    // took the file-acquisition branch first and skipped all of it, so a stale
    // edited:true fix artifact could false-signal in record. (finding #3)
    const isGit = !isFileTarget;
    if (resumed && isGit) gitCheckoutTree(repoRoot); // git-only: keep journaled commits, discard uncommitted

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
    let snapshot;
    let acquiredTarget;
    if (isFileTarget) {
      acquiredTarget = acquireTarget(fileSpec, repoRoot);
      headSha = acquiredTarget.identity; // content hash, not a sha; field name reused for compat
      diff = acquiredTarget.reviewText;
    } else if (resumed) {
      headSha = gitHeadSha(repoRoot); // no dirty-check on resume
      snapshot = gitReviewSnapshot(repoRoot, baseSha, headSha);
      diff = snapshot.reviewText;
    } else {
      const target = acquireTarget({ ref, base, baseCommit: baseSha, reviewLock: `${ledgerPath(stateDir, slug)}.lock` }, repoRoot); // ignore only our own untracked lock
      acquiredTarget = target;
      headSha = target.identity;
      diff = target.reviewText;
      snapshot = target.snapshot;
    }
    // Reachability check and resetUnreachable are git-ledger-only operations:
    // a file target carries no head_sha ref and git must not be invoked.
    if (!isFileTarget && ledger.target && ledger.target.head_sha && !gitIsReachable(repoRoot, ledger.target.head_sha)) {
      ledger = resetUnreachable(ledger);
    }
    const intentCfg = intentFile ? { file: path.resolve(intentFile) } : noIntentCommand ? null : intentLib.loadIntentConfig(repoRoot);
    const fetchIntentNow = () => (intentCfg.file ? intentLib.readIntentFile(intentCfg.file) : intentLib.fetchIntent({ command: intentCfg.command, cwd: repoRoot, ref, base }));
    const broadReuse = ledger.broad_reuse;
    const reuseFrontPass = !!broadReuse && !broadFlagPassed && !noBroadFlagPassed && !isFileTarget && !intentCfg && !broadReuse.intentHash
      && broadReuse.base_sha === baseSha
      && gitIsReachable(repoRoot, broadReuse.head_sha);
    const retryDiffBase = !isFileTarget && ledger.target?.base_sha === baseSha && ledger.retry_diff_base && gitIsReachable(repoRoot, ledger.retry_diff_base) ? ledger.retry_diff_base : null;
    if (retryDiffBase || (reuseFrontPass && broadReuse.head_sha !== headSha)) {
      snapshot = gitReviewSnapshot(repoRoot, retryDiffBase || broadReuse.head_sha, headSha);
      diff = snapshot.reviewText;
    }
    const diffHash = contentHash(diff);

    let resumedCompletedArtifacts = [];
    let resumedNormalizedPlan = null;
    if (resumed) {
      const priorManifest = isGit && ledger.execution?.changeManifest ? readChangeManifest(stateDir, ledger, ref, resumeRound) : null;
      const preserveScope = !isGit || !!(priorManifest && priorManifest.target.headSha === headSha
        && priorManifest.target.baseSha === snapshot.leftSha
        && JSON.stringify(priorManifest.paths) === JSON.stringify(snapshot.paths));
      const preserveArtifacts = ledger.execution && ledger.execution.round === resumeRound && ledger.execution.diffHash === diffHash
        && preserveScope;
      if (preserveArtifacts && ledger.execution.planRetry?.state === 'exhausted') throw new Error(`harness-failure: ${ledger.execution.planRetry.message}`);
      const completed = preserveArtifacts
        ? (ledger.execution.completed || []).filter((role) => ['correctness', 'verify', 'plan', 'intent', 'gate', 'gate-verify'].includes(role))
        : [];
      const preserved = new Set(completed.filter((role) => {
        const name = `round-${resumeRound}-${role}.json`;
        try { return ledger.execution.artifactHashes && ledger.execution.artifactHashes[role] === contentHash(fs.readFileSync(path.join(stateDir, name), 'utf8')); } catch (_) { return false; }
      }).map((role) => `round-${resumeRound}-${role}.json`));
      if (preserveArtifacts && ledger.execution.normalizedPlan) {
        try {
          if (ledger.execution.normalizedPlan === contentHash(readReviewArtifact(path.join(stateDir, `round-${resumeRound}-plan.json`), stateDir, 'utf8'))) {
            preserved.add(`round-${resumeRound}-plan.json`);
            resumedNormalizedPlan = ledger.execution.normalizedPlan;
          }
        } catch (_) { /* invalid evidence is not reusable */ }
      }
      // A pending repair is durable round evidence, not stale output. Keep
      // every bound input/output record so resume can verify it or fail closed.
      for (const role of preserveScope ? artifactContract.ARTIFACT_ROLES : []) {
        // A semantic replacement must not consume the rejected attempt's repair.
        if (role === 'plan' && (ledger.execution?.planRetry?.discardRepair || (ledger.intentHash && !preserved.has(`round-${resumeRound}-intent.json`)))) continue;
        const repairName = `round-${resumeRound}-${role}.repair.json`;
        const repairFile = path.join(stateDir, repairName);
        if (!fs.existsSync(repairFile)) continue;
        try {
          const repair = JSON.parse(fs.readFileSync(repairFile, 'utf8'));
          if (repair.round !== resumeRound || repair.target?.ref !== ref || repair.diffHash !== diffHash || !repair.snapshotPath || !repair.packetPath || !repair.candidatePath
            || contentHash(readReviewArtifact(repair.snapshotPath, stateDir)) !== repair.originalHash
            || contentHash(readReviewArtifact(repair.packetPath, stateDir)) !== repair.packetHash
            || (repair.candidateHash && contentHash(readReviewArtifact(repair.candidatePath, stateDir)) !== repair.candidateHash)) throw new Error('repair binding invalid');
          for (const p of [repair.snapshotPath, repair.packetPath, repair.candidatePath, repairFile]) {
            if (fs.existsSync(p)) preserved.add(path.basename(p));
          }
        } catch (_) { throw new Error(`harness-failure: ${role} pending repair evidence is corrupt`); }
      }
      if (ledger.gateApplied && ledger.gateMode !== 'design-conformance') {
        if (['correctness', 'gate'].some((role) => !preserved.has(`round-${resumeRound}-${role}.json`))) {
          preserved.delete(`round-${resumeRound}-verify.json`);
          preserved.delete(`round-${resumeRound}-gate-verify.json`);
        }
      } else {
        for (const [producer, verifier] of [['correctness', 'verify'], ['gate', 'gate-verify']]) {
          if (!preserved.has(`round-${resumeRound}-${producer}.json`)) preserved.delete(`round-${resumeRound}-${verifier}.json`);
        }
      }
      // A plan depends on the unchanged round intent detector, as well as verify.
      if (ledger.intentHash && !preserved.has(`round-${resumeRound}-intent.json`)) {
        if (run) {
          // All prior grants belong to the invalidated dependency generation,
          // including an interrupted repair; none can authorize fresh evidence.
          const launched = { ...ledger.initiative_launched };
          for (const role of ['intent', 'plan']) launched[launchKey(role, resumeRound)] = Math.max(launchedBefore(ledger, role, resumeRound), reservedCount(ledger, role, resumeRound));
          ledger = { ...ledger, initiative_launched: launched };
        }
        for (const name of [...preserved]) if (name.startsWith(`round-${resumeRound}-plan.`)) preserved.delete(name);
      }
      if (!preserved.has(`round-${resumeRound}-verify.json`)) preserved.delete(`round-${resumeRound}-plan.json`);
      if (!preserved.has(`round-${resumeRound}-plan.json`)) resumedNormalizedPlan = null;
      if (preserveArtifacts && ledger.execution.planRetry?.launched && !resumedNormalizedPlan
        && !preserved.has(`round-${resumeRound}-plan.json`) && !preserved.has(`round-${resumeRound}-plan.repair.json`)) {
        throw new Error(`harness-failure: planner retry exhausted for this round; ${ledger.execution.planRetry.message}`);
      }
      resumedCompletedArtifacts = completed.filter((role) => preserved.has(`round-${resumeRound}-${role}.json`));
      deleteRoundArtifacts(stateDir, resumeRound, preserved);
      // Resume re-drives round N at zero budget by pinning round/diff_content_hash
      // directly, bypassing beginRound. This is a real work round: it proceeds to
      // DoD + phase='gates' below, without advancing round or charging budget.
      ledger = { ...ledger, diff_content_hash: diffHash, round: resumeRound, phase: 'idle', planned: [], resolved_absent: [], intent_parked: [], execution: preserveArtifacts ? ledger.execution : null };
    } else {
      deleteRoundArtifacts(stateDir, ledger.round + 1); // stale artifacts for the round about to run
      const { ledger: begun, noOp, terminal } = beginRound(ledger, diffHash, { reReviewOnStableContent: isFileTarget });
      ledger = begun;
      if (terminal) {
        writeLedger(stateDir, slug, ledger);
        process.stdout.write(JSON.stringify({ decision: 'terminal', status: ledger.status, round: ledger.round, base: ledger.target?.base, head: ledger.target?.head_sha, stateDir }) + '\n');
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
    let changeManifestHash = null;
    if (isGit) {
      const manifest = { version: 1, round: ledger.round, target: { type: 'git', ref, headSha, baseSha: snapshot.leftSha }, diffHash, paths: snapshot.paths };
      const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      fs.writeFileSync(path.join(stateDir, `round-${ledger.round}-changes.json`), bytes);
      changeManifestHash = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    fs.writeFileSync(path.join(stateDir, `round-${ledger.round}-history.json`), JSON.stringify({
      groups: ledger.review_history || [],
      fixed: (ledger.findings || []).filter((finding) => finding.status === 'fixed').map((finding) => ({
        id: finding.id, file: finding.file, summary: finding.summary, fixCommit: finding.fix_commit || null,
      })),
    }) + '\n');

    // ARMED (does this run do broad review at all) vs FIRED (does the gate pair
    // run THIS round) are two different questions -- keep them apart.
    //
    // Armed is sticky and defaults to true, so round 2 need not repeat a flag
    // and an opt-out survives the rest of the run: --no-broad disarms, and
    // --broad/--gate re-arm a ledger that disarmed earlier.
    // Precedence: this invocation's flag, then the ledger's sticky answer, then
    // the target-type default. A file target defaults to DISARMED -- the gate
    // pair's prompt is written against a git diff ("an unchanged file whose
    // invariant a CHANGED LINE breaks") and it sweeps the repository, which a
    // doc review in a directory that is not even a git repo has no use for --
    // but that is a DEFAULT, not an override: reading it ahead of the sticky
    // field would re-disarm a file run that armed with `--broad`, and the next
    // plan-fixes would drop that round's gate findings on the floor.
    // A ledger written before gateArmed existed has no boolean here and falls
    // through to the target-type default, which is what it ran under.
    const reusedGateChangedPaths = reuseFrontPass
      ? broadReuse.head_sha === headSha ? [] : gitReviewSnapshot(repoRoot, broadReuse.head_sha, headSha).paths
      : [];
    const reusedGateOpen = reuseFrontPass ? gateLib.carryForwardGateFindings({
      priorGateOpen: broadReuse.gate_open || [],
      thisRoundIds: [],
      verifyRejectedIds: [],
      dismissedIds: ledger.gate_dismissed || [],
      changedFiles: reusedGateChangedPaths,
    }) : ledger.gate_open;
    let gateArmed = lite ? true : broadFlagPassed ? true
      : noBroadFlagPassed ? false
      : reuseFrontPass ? false
      : typeof ledger.gateArmed === 'boolean' ? ledger.gateArmed
      : !isFileTarget;
    const gateDisarmedBy = gateArmed ? null : (noBroadFlagPassed ? '--no-broad' : reuseFrontPass ? 'prior-front-pass' : isFileTarget ? 'file-target' : ledger.gateDisarmedBy || '--no-broad');
    // Fired only on the FIRST armed round. The pair reads the whole repository,
    // and the defects it is built for -- cross-context violations, design
    // conformance, latent gaps -- live in a tree that does not change round to
    // round, so re-reading it every round pays repo-wide cost N times for a
    // finding set that cannot move. Catching them in round 1 also means they
    // are fixed in the same edit that caused them, not six rounds later.
    // The tail -- defects THIS loop's own fixes introduce -- is the holistic
    // panel's job (`gate.panel`), which fires once the diff-local loop
    // converges. Front pass and panel deliberately cover different halves; a
    // repo with the panel off gets the front half only, and the handoff says so.
    // A mid-round resume re-drives the SAME round and must still report the pair
    // as this round's work -- plan-fixes reads gateApplied to decide the gate
    // artifact is mandatory, so flipping it off on a resume would silently
    // discard the round's broad findings.
    const gateRounds = Array.isArray(ledger.gate_rounds) ? ledger.gate_rounds : [];
    // Per-round, not sticky: plan-fixes reads this ledger field to decide the
    // round's gate artifact is mandatory, and round-start rewrites it below
    // before plan-fixes runs. Re-deriving from review.config.json there would
    // silently miss a flag-enabled round and discard its findings.
    let gateApplied = gateArmed && (gateRounds.length === 0 || gateRounds.includes(ledger.round));
    if (run && gateApplied && !lite && !claimBroadSweep(run, { target: ref, attemptId: ledger.attemptId })) {
      gateArmed = false;
      gateApplied = false;
    }
    const expectedArtifacts = ['correctness', 'verify', 'plan'].concat(intentCfg ? ['intent'] : [], gateApplied ? (lite ? ['gate'] : ['gate', 'gate-verify']) : []);
    const completedArtifacts = resumed && ledger.execution
      ? resumedCompletedArtifacts.filter((role) => expectedArtifacts.includes(role))
      : [];
    const normalizedArtifacts = resumedNormalizedPlan && !completedArtifacts.includes('plan') ? ['plan'] : [];
    const retryArtifacts = resumed && ledger.execution
      ? Object.fromEntries(Object.entries(retryArtifactMap(ledger.execution)).filter(([role, prompt]) => !completedArtifacts.includes(role) && expectedArtifacts.includes(role) && typeof prompt === 'string'))
      : {};
    const retryArtifact = firstRetryArtifact(retryArtifacts);
    const repairArtifacts = resumed
      ? Object.fromEntries(artifactContract.ARTIFACT_ROLES.flatMap((role) => {
        try { return [[role, JSON.parse(fs.readFileSync(path.join(stateDir, `round-${ledger.round}-${role}.repair.json`), 'utf8'))]]; } catch (_) { return []; }
      }))
      : {};
    // Sticky for the same reason gateApplied is: once a run has opted out of the
    // executable gate, round 2's round-start must not have to repeat --no-dod
    // (without stickiness a repo that DOES have `dod` commands would run the
    // gate the caller asked to skip).
    const dodDeferred = noDodFlagPassed || !!ledger.dodDeferred;
    if (intentCfg) {
      const intentPath = path.join(stateDir, `intent-${slug}.md`);
      if (!ledger.intentHash) {
        const { text, sha, bytes } = fetchIntentNow();
        writeFileAtomic(intentPath, text); // atomic: never leave a partial file a later step trusts
        ledger = { ...ledger, intentHash: sha, intentBytes: bytes };
      } else {
        let cached;
        try { cached = fs.readFileSync(intentPath, 'utf8'); } catch (e) {
          throw new Error(`harness-failure: intent artifact intent-${slug}.md missing on re-hash`);
        }
        const sha = contentHash(cached);
        if (sha !== ledger.intentHash) throw new Error('harness-failure: intent artifact changed mid-drive (hash mismatch)');
        // Drift check. The cache stays authoritative for the run -- that is what
        // makes "this review ran against THESE requirements" mean anything -- but
        // a SILENT stale cache makes the detector re-report a contradiction the
        // human already fixed at the source, with no way to notice. So re-fetch
        // every round and compare hashes only; a change stops the round and the
        // human resets. Never adopt the new text mid-run: that is the mid-swap
        // this cache exists to prevent.
        let fresh;
        try {
          fresh = fetchIntentNow();
        } catch (e) {
          const why = String((e && e.message) || e).replace(/^harness-failure:\s*/, '');
          throw new Error(`harness-failure: intent drift-check fetch failed (the cached intent is intact; this is a fetch failure, not a changed source): ${why}`);
        }
        if (fresh.sha !== ledger.intentHash) {
          throw new Error(`harness-failure: intent source changed since this run began (run has ${ledger.intentHash.slice(0, 12)}, source now ${fresh.sha.slice(0, 12)}); this run keeps reviewing against the intent it started with -- reconcile the changed source before adopting it, then run review-cli.js rerun ${ref} with the original initiative flags when bound`);
        }
      }
    }

    // DoD is a git-target concept (a CI command the code must pass before
    // review-until-green can declare done). File targets carry hasDoD:false
    // and skip the DoD entirely -- a file/doc review must not run the repo's
    // build/test commands, which say nothing about the reviewed file.
    // `deferredBy` discriminates WHY, so the handoff never claims (falsely) that
    // the repo declared it had no gate: '--no-dod' for the flag path, 'no-config'
    // for an absent review.config.json (set by loadDodConfig) -- both have their
    // own DOD_DEFERRAL_LINES wording. The file-target and `"dod": null` paths set
    // no deferredBy and keep the generic wording.
    // runDod must not be CALLED at all on the flag path -- the flag says "skip
    // whatever is configured", so reading the config would be pointless work.
    const dod = isFileTarget
      ? { passed: true, deferred: true, results: [] }
      : dodDeferred
        ? { passed: true, deferred: true, deferredBy: '--no-dod', results: [] }
        : pendingDod(repoRoot);
    // An absent config no longer blocks the run, but it must not pass quietly
    // either: warn every round, and the handoff repeats it at the end.
    if (dod.deferredBy === 'no-config') {
      process.stderr.write(`review-cli: warning: no ${dodExec.CONFIG_FILENAME} at the repo root -- reviewing without an executable DoD gate (reported as DEFERRED, never as passed)\n`);
    }
    // Persist the extended target object. For file targets, add type/hasDoD/spec
    // so later verbs (record, decideTermination) can branch on target type without
    // re-parsing the ref. For git targets, the existing ref/base/head_sha fields
    // are preserved; type/hasDoD are added for consistency.
    const targetType = isFileTarget ? 'file' : 'git';
    const baseTarget = ledger.target || { kind: 'local', ref };
    const targetUpdate = isFileTarget
      ? { ...baseTarget, type: 'file', hasDoD: false, spec: fileSpec, head_sha: headSha }
      : { ...baseTarget, type: 'git', hasDoD: true, spec: { ref, base }, base, base_sha: baseSha, head_sha: headSha };
    ledger = {
      ...ledger,
      dod,
      phase: 'gates',
      gateArmed,
      gateDisarmedBy,
      broad_reuse: reuseFrontPass ? broadReuse : null,
      gate_open: reusedGateOpen,
      gateApplied,
      gateMode: lite ? 'design-conformance' : 'pair',
      gate_rounds: gateApplied && !gateRounds.includes(ledger.round) ? [...gateRounds, ledger.round] : gateRounds,
      gate_reviewed_head_sha: gateApplied && isGit ? headSha : ledger.gate_reviewed_head_sha,
      dodDeferred,
      reviewRouting,
      execution: {
        round: ledger.round,
        diffHash,
        ...(isGit ? { changeManifest: { version: 1, sha256: changeManifestHash } } : {}),
        completed: completedArtifacts,
        normalizedPlan: resumedNormalizedPlan,
        planRetry: resumed && ledger.execution?.planRetry ? { ...ledger.execution.planRetry, discardRepair: false } : null,
        artifactHashes: Object.fromEntries([...completedArtifacts, ...normalizedArtifacts].map((role) => [role, ledger.execution && ledger.execution.artifactHashes && ledger.execution.artifactHashes[role]]).filter(([, hash]) => typeof hash === 'string')),
        pending: expectedArtifacts.filter((role) => !completedArtifacts.includes(role)),
        retryArtifacts,
        retryArtifact,
        failures: resumed && ledger.execution ? (ledger.execution.failures || []) : [],
        failure: null,
      },
      target: targetUpdate,
    };
    writeLedger(stateDir, slug, ledger);
    // The three fields are mutually descriptive: pending is the normal configured
    // gate waiting for convergence, deferred means no gate will run, and passed is
    // retained for file/no-op compatibility. Callers must not infer one from another.
    process.stdout.write(JSON.stringify({ decision: 'work', mode: run ? runMode(run) : undefined, gateMode: lite ? 'design-conformance' : 'pair', ref: targetUpdate.ref, base: targetUpdate.base, head: targetUpdate.head_sha, attemptId: ledger.attemptId, round: ledger.round, budget: ledger.budget, dodPassed: dod.deferredBy === 'pending-final' ? false : dod.passed, dodDeferred: !!dod.deferred && dod.deferredBy !== 'pending-final', dodPending: dod.deferredBy === 'pending-final', intentApplied: !!intentCfg, intentHash: ledger.intentHash || null, priorIntentIds, gateApplied, targetType, reviewRouting, stateDir, completedArtifacts, normalizedArtifacts, planRetry: ledger.execution?.planRetry || null, retryArtifacts, retryArtifact, repairArtifacts }) + '\n');
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
      let initiativeClaim;
      if (run && !ledger._lastDecision?.continue && !ledger._lastDecision?.panelPending) {
        const disposition = require('./initiative-review-run').normalizeDisposition({ decision: ledger._lastDecision || { continue: false }, reconciliation: ledger.reconciliationPacket });
        const target = ledger.target?.ref || ref;
        // Use the reviewed head and durable claim, never the post-fix live head.
        // Legacy done ledgers can recover only an unambiguous original entry.
        const entries = (JSON.parse(fs.readFileSync(run.path, 'utf8')).dispositions || []).filter(d =>
          d.target === target && d.revision?.head_sha === ledger.target?.head_sha && d.kind === disposition.kind && d.reason === disposition.reason
          && (!ledger._lastInitiativeClaim || d.packet?.delivery?.claim === ledger._lastInitiativeClaim));
        if (entries.length !== 1 || !entries[0].packet?.delivery?.claim) throw new Error('harness-failure: record: original initiative claim is missing or ambiguous; reconcile the existing ledgers');
        initiativeClaim = entries[0].packet.delivery.claim;
      }
      if (R.TERMINAL_STATUSES.has(ledger.status) || (run && ledger._lastDecision && !ledger._lastDecision.continue && !ledger._lastDecision.panelPending)) reviewTelemetry.deleteTelemetry(stateDir, ledger.target?.ref || ref, slug);
      process.stdout.write(
        JSON.stringify({ decision: ledger._lastDecision || { continue: false }, handoff: renderHandoff({ ledger }), telemetry: ledger.telemetry || null, reconciliation: ledger.reconciliationPacket || undefined, checks: ledger.finalChecks || undefined, initiative: initiativeClaim ? { claim: initiativeClaim } : undefined }) + '\n'
      );
      return;
    }
    ledger = reviewTelemetry.foldTelemetry(stateDir, ledger, slug);
    if (!ledger || ledger.phase !== 'fixes') throw new Error(`record: expected phase "fixes", got "${ledger && ledger.phase}" ${stateDirHint(stateDir)}`);
    requireReservations(run, ledger, [
      ...gatesNeeds(stateDir, n),
      { role: 'fix', present: roundFiles(stateDir, n, new RegExp(`^round-${n}-fix-.*\\.json$`)) },
      { role: 'certify', present: roundFiles(stateDir, n, new RegExp(`^round-${n}-certify-.*\\.json$`)) },
    ], 'record');

    // Per-finding fix artifacts (round-<n>-fix-<safe-id>.json) stay lenient: a
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
    const candidates = roundCandidates(gc, cJson, vJson);
    const killedIds = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates).rejectedIds;
    // Carry each rejection's stated basis into the ledger so the handoff can
    // show WHY a finding was killed. Without it the handoff reports only a
    // count, and a rejection backed by a real measurement is indistinguishable
    // from one backed by a guess unless someone reads the reviewer's log.
    const rejectionReasons = new Map((vJson.rejected || []).map((r) => (typeof r === 'string' ? [r, ''] : [r.id, r.reason || ''])));

    // Holistic GATE panel:
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
    const journaled = ledger.journal || [];
    const journalEntryFor = (finding) => journaled.find((j) => (j.findingIds || []).includes(finding.id))
      || journaled.find((j) => j.id === finding.id)
      || journaled.find((j) => (j.resolutions || []).some((r) => r.id === finding.id && r.file === finding.file && r.span === finding.span)
        && finding.span && gitWorktreeFileLacksSpan(repoRoot, finding.file, finding.span));
    const fixedIds = [];
    const parkedIds = [];
    const fixCommits = {};
    const parkReasons = {};
    for (const id of ledger.planned || []) {
      const group = ledger.fix_plan?.groups?.find((candidate) => candidate.findingIds.includes(id));
      const fx = readJson(`fix-${safeIdForFilename(group?.groupId || id)}`);
      const cert = group && readJson(`certify-${safeIdForFilename(group.groupId)}`);
      const finding = candidates.find((f) => f.id === id);
      const fixedByGit = isGit && finding && journalEntryFor(finding);
      const fixedByReport = !isGit && fx && fx.edited === true && cert?.status === 'ok' && cert.groupId === group?.groupId
        && Array.isArray(cert.resolvedFindingIds) && cert.resolvedFindingIds.length === group.findingIds.length && group.findingIds.every((findingId) => cert.resolvedFindingIds.includes(findingId))
        && Array.isArray(cert.files) && Array.isArray(fx.files) && cert.files.length === fx.files.length && fx.files.every((file) => cert.files.includes(file))
        && cert.fileHashes && cert.files.every((file) => {
          const absolute = path.join(repoRoot, file);
          const actual = fs.existsSync(absolute) ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null;
          return cert.fileHashes[file] === actual;
        }) && Array.isArray(cert.evidence) && cert.evidence.length > 0;
      if (fixedByGit) {
        fixedIds.push(id);
        fixCommits[id] = journalEntryFor(finding).sha;
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
      const finding = candidates.find((f) => f.id === id);
      const journal = finding && journalEntryFor(finding);
      if (journal && finding.span && gitWorktreeFileLacksSpan(repoRoot, finding.file, finding.span)) {
        fixedIds.push(id);
        fixCommits[id] = journal.sha;
      } else {
        parkedIds.push(id);
        parkReasons[id] = gc.validateParkReason({ kind: 'needs-decision', text: 'a previously absent span returned before record' });
      }
    }
    // Re-read a file target only when this round could otherwise converge.
    // Determine open work after seen-finding suppression; raw candidate counts
    // cannot distinguish a previously killed re-report from a live finding.
    const concludedIds = new Set([...fixedIds, ...parkedIds, ...killedIds]);
    const hasOpenCandidate = R.dedupeAgainstSeen(candidates, ledger.seen).some((f) => !concludedIds.has(f.id));
    const targetUnchanged = isGit || fixedIds.length > 0 || parkedIds.length > 0 || hasOpenCandidate
      || acquireTarget(ledger.target.spec, repoRoot).identity === ledger.target.head_sha;
    const outcome = {
      dodPassed: !!(ledger.dod && ledger.dod.passed), dodDeferred: !!(ledger.dod && ledger.dod.deferred), findings: candidates, fixedIds, parkedIds, killedIds, specDoubtScope: 'none', fixCommits, parkReasons,
      targetUnchanged,
      intentReviewCount: (ledger.intent_parked || []).length,
      ...R.splitGateOpen(gateOpen),
      // --no-broad opts the run out of broad review, and the panel IS broad
      // review's other half -- running it anyway would hand the opt-out run the
      // most expensive half of what it declined. (Before broad review became
      // the default this could not happen: a gate.panel block implied a gate
      // config, which is what armed the gate in the first place.)
      //
      // Keyed on the REASON, not on gateArmed: a file target is disarmed by the
      // CLI's own default, because the gate PAIR's prompt is git-diff-shaped --
      // that says nothing about the panel, whose lenses read the review text and
      // the intent doc and worked for file targets before this change. Only the
      // user's explicit opt-out declines the panel.
      // Legacy panel evidence remains readable, but it is no longer a release
      // gate. The bounded, explicit replacement is the deep-review skill.
      panelConfigured: false,
      panelDone: !!(ledger.gate_panel && ledger.gate_panel.status === 'done'),
    };
    let { ledger: applied, decision } = R.applyRoundOutcome(ledger, outcome);
    // Material design/AC findings are reconciliation work, never a reason to
    // launch ordinary fixers or to spend another round. Derive this here from
    // the persisted state so panel-confirmed findings take the same path.
    const material = [...(ledger.intent_parked || []), ...gateOpen.filter((f) => /^gate:(?:design-conformance|ac-coverage):/.test(f.id) && !gateFollowUpEligible(f))];
    const groupReconciliation = ledger.reconciliation?.trigger === 'group-reconcile' ? ledger.reconciliation : null;
    const reconciliation = groupReconciliation || material.length && {
      trigger: 'material-finding', finding: material[0].id, stage: 'record', avoidedLaunches: ledger.reconciliation?.avoidedLaunches || 0, findings: material.reduce((counts, finding) => {
        const kind = finding.id.startsWith('gate:design-conformance:') ? 'design-conformance' : finding.id.startsWith('gate:ac-coverage:') ? 'ac-coverage' : finding.id.split(':', 1)[0];
        return { ...counts, [kind]: (counts[kind] || 0) + 1 };
      }, {}),
    };
    if (reconciliation) {
      const intentReview = (ledger.intent_parked || []).length > 0;
      const groupReconcile = reconciliation.trigger === 'group-reconcile';
      decision = { continue: false, converged: false, parked: false, abandoned: false, ...(intentReview ? { intentReview: true } : { gatePending: true }), reconciliation: true, reason: intentReview ? 'open intent finding(s) require reconciliation' : groupReconcile ? 'finding group requires a human decision before editing' : 'open design/AC GATE finding(s) require reconciliation' };
      applied = { ...applied, status: intentReview ? 'intent-review' : 'gate-pending' };
    }
    if (isGit && decision.converged && !ledger.dodDeferred) {
      gitCheckoutTree(repoRoot);
      if (gitIsDirty(repoRoot, stateDir)) throw new Error('harness-failure: review work left untracked files in the repository; final DoD was not run against an uncommitted worktree');
      const finalDodHead = gitHeadSha(repoRoot);
      const finalDod = runDod(repoRoot);
      if (gitHeadSha(repoRoot) !== finalDodHead) throw new Error('harness-failure: final DoD moved HEAD; its result does not apply to the reviewed revision');
      if (gitIsDirty(repoRoot, stateDir)) {
        gitCheckoutTree(repoRoot);
        throw new Error('harness-failure: final DoD modified the repository; its result does not apply to committed HEAD');
      }
      applied = { ...applied, dod: finalDod };
      if (!finalDod.deferred && !finalDod.passed) {
        decision = { continue: false, converged: false, parked: false, abandoned: false, dodFailed: true, reason: 'final DoD failed after review convergence; fix the failure, then review the changed diff before retrying DoD' };
        applied = { ...applied, status: 'dod-failed', retry_diff_base: gitHeadSha(repoRoot) };
      } else {
        decision = {
          ...decision,
          reason: finalDod.deferred
            ? 'DoD-exec deferred (no executable gate ran), zero open findings, and no fixes this round (stable)'
            : 'final DoD ran and passed after review convergence',
        };
      }
    }
    // Persisted so renderHandoff can tell "the panel is off in this repo" from
    // "the panel is on and still ahead of this run" -- it only receives the
    // ledger, and telling someone to enable a panel they already enabled sends
    // them editing a config that is already correct.
    ledger = { ...applied, gate_panel_configured: false };
    // Deduped by id: a re-driven round (resume) records the same kills again.
    const priorKilled = new Set((ledger.killed_digest || []).map((k) => k.id));
    ledger = {
      ...ledger,
      killed_digest: (ledger.killed_digest || []).concat(
        killedIds.filter((id) => !priorKilled.has(id)).map((id) => ({ id, round: n, reason: rejectionReasons.get(id) || '' })),
      ),
    };
    // Park-budget override BEFORE the charge below, so a forced terminus doesn't burn a round.
    if (R.parkBudgetExceeded(ledger, REVIEW_PARK_BUDGET_DEFAULT)) {
      // converged/parked must move together with continue here -- a stale
      // converged:true would mislead a consumer that reads decision.converged
      // without also checking continue. Likewise clear intentReview and
      // gatePending: without this a park-budget terminus on an intent-review
      // or gate-pending decision would still print "resolve and re-run"
      // guidance for that stale state while the ledger status is truthfully
      // "parked" (which refuses to resume until `unpark`).
      decision = { ...decision, continue: false, converged: false, parked: true, dodFailed: false, intentReview: false, gatePending: false };
      ledger = { ...ledger, status: 'parked' };
    }
    const retryDisposition = decision.dodFailed || decision.gatePending || decision.intentReview;
    if (decision.continue || retryDisposition) {
      const spent = ledger.budget.spent + 1;
      ledger = { ...ledger, budget: { ...ledger.budget, spent } };
      if (retryDisposition && spent >= ledger.budget.max_rounds) {
        const reason = decision.dodFailed
          ? 'round budget exhausted after repeated final DoD failures'
          : 'round budget exhausted after repeated reconciliation stops';
        decision = { ...decision, dodFailed: false, gatePending: false, intentReview: false, parked: true, reason };
        ledger = { ...ledger, status: 'parked' };
      }
    }
    // Git only: clean any leftover uncommitted edit from a rejected/parked fixer.
    // File targets have no working tree to discard.
    if (isGit) gitCheckoutTree(repoRoot);
    const finalChecks = [{ name: 'definition-of-done', status: ledger.dod?.deferredBy === 'pending-final' ? 'not-run' : ledger.dod?.deferred ? 'deferred' : ledger.dod?.passed ? 'passed' : 'failed' }];
    const priorHistoryKeys = new Set((ledger.review_history || []).map((entry) => `${entry.planId}:${entry.groupId}`));
    const newHistory = (ledger.fix_plan?.groups || []).filter((group) => !priorHistoryKeys.has(`${ledger.fix_plan.planId}:${group.groupId}`)).map((group) => {
      const journal = (ledger.journal || []).find((entry) => (entry.groupIds || []).includes(group.groupId));
      return { run: (ledger.runs || []).length + 1, round: n, planId: ledger.fix_plan.planId, transactionScope: ledger.fix_plan.transactionScope, ...group, outcome: journal ? 'fixed' : reconciliation ? 'reconcile' : 'unresolved', fixCommit: journal?.sha || null };
    });
    ledger = { ...ledger, review_history: [...(ledger.review_history || []), ...newHistory], phase: 'done', last_recorded_round: n, _lastDecision: decision, reconciliationPacket: reconciliation || null, finalChecks, ...(run ? { _lastInitiativeClaim: null } : {}) };
    let entry;
    let recordedNow = false;
    if (run && !decision.continue && !decision.panelPending) {
      // Same disposition path, packet shape, and privacy contract as the Codex
      // runner: raw ref/SHA stay in the local ledger; no artifact path is stored.
      const target = ledger.target?.ref || ref;
      // The pair reserve opened and the reviewers saw: the head stored at round-start, not the live head,
      // which a commit landing mid-round (or a fix) may have moved.
      const head_sha = ledger.target?.head_sha || (isGit ? gitHeadSha(repoRoot) : undefined);
      const revision = { ref: target, ...(ledger.target?.base ? { base: resolveBaseCommit(repoRoot, ledger.target.base) } : {}), head_sha };
      const disposition = require('./initiative-review-run').normalizeDisposition({ decision, reconciliation });
      const escaped = disposition.kind === 'escape';
      // Forward each invocation once: the folded entries are cumulative in the target ledger, so the keys already
      // forwarded by an earlier disposition of this target are skipped.
      const forwarded = new Set(ledger.telemetryForwarded || []);
      const telemetryKey = (item) => item.invocationId || `${item.status}:${item.artifactPath || `${item.role}:${item.round}`}`;
      const pending = (ledger.telemetry?.entries || []).filter((item) => !forwarded.has(telemetryKey(item)));
      const recorded = recordDisposition(run, {
        target, revision, result: { decision, reconciliation },
        packet: { trigger: escaped ? 'escape' : 'terminal', exit: { code: 0, signal: null }, dod: { status: finalChecks[0].status === 'passed' ? 'passed' : finalChecks[0].status }, telemetry: { complete: false }, nextAction: escaped ? 'resume' : 'replay', handoff: renderHandoff({ ledger }) },
        finding: reconciliation?.finding || null, stage: reconciliation?.stage || null, avoidedLaunches: reconciliation?.avoidedLaunches || 0, findings: reconciliation?.findings || {}, checks: finalChecks,
        telemetry: pending.map(({ role, round, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }) => ({ role, stage: 'review', revision, round, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens })),
      });
      // Match by target + revision + kind, and reason for an escape (as the Codex runner does), and fail without
      // marking the target ledger done so a re-run of `record` can still record it.
      const kind = escaped ? 'escape' : 'terminal';
      entry = (JSON.parse(fs.readFileSync(run.path, 'utf8')).dispositions || []).findLast((d) => d.target === target && JSON.stringify(d.revision) === JSON.stringify(revision) && d.kind === kind && (!escaped || d.reason === disposition.reason));
      if (!entry || (!recorded && kind === 'escape' && entry.packet?.delivery?.consumed !== false)) throw new Error('harness-failure: record: initiative target disposition recording was contended; re-run record');
      // A duplicate disposition recorded nothing, so its telemetry stays pending and the cache stays.
      recordedNow = recorded;
      if (!entry.packet?.delivery?.claim) throw new Error('harness-failure: record: original initiative claim is missing; reconcile the existing ledgers');
      ledger = { ...ledger, _lastInitiativeClaim: entry.packet.delivery.claim };
      if (recorded) ledger = { ...ledger, telemetryForwarded: [...forwarded, ...pending.map(telemetryKey)] };
    }
    writeLedger(stateDir, slug, ledger);
    // The cache is cleared by what was recorded, as the Codex runner does: any disposition now holds the
    // telemetry durably, so a later disposition must not re-read it. Without a run only a terminal status clears it.
    if (recordedNow || R.TERMINAL_STATUSES.has(ledger.status)) reviewTelemetry.deleteTelemetry(stateDir, ledger.target?.ref || ref, slug);
    process.stdout.write(JSON.stringify({ decision, handoff: renderHandoff({ ledger }), telemetry: ledger.telemetry || null, reconciliation: ledger.reconciliationPacket || undefined, checks: finalChecks, initiative: entry?.packet?.delivery?.claim ? { claim: entry.packet.delivery.claim } : undefined }) + '\n');
    return;
  }

  if (verb === 'findings') {
    requireRef(ref, 'findings');
    const { repoRoot, fixes, intentParked, gateOpen } = verifiedRound(ref, stateDir, run, 'findings');
    // The file name comes from a reviewer, so it is read only when its real
    // path stays inside the checkout: a line number for a file elsewhere would
    // tell whoever reads the review whether a guessed span is in that file.
    const lineOf = (file, span) => {
      if (!span) return null;
      try {
        const text = readReviewSource(repoRoot, file);
        if (text === null) return null;
        // A span that occurs more than once does not say which occurrence the
        // reviewer meant, so it gets no line rather than a guessed one.
        const at = text.indexOf(span);
        if (at === -1 || text.indexOf(span, at + 1) !== -1) return null;
        return text.slice(0, at).split('\n').length;
      } catch (_) { return null; }
    };
    // Gate findings carry their span as `evidence` and their lens as `class`.
    const findings = [...fixes, ...intentParked, ...gateOpen].map((f) => {
      const span = f.span ?? f.evidence ?? '';
      return { id: f.id, category: f.class || f.id.split(':', 1)[0], file: f.file, line: lineOf(f.file, span), span, summary: f.summary, requirement: f.requirement || '' };
    });
    process.stdout.write(JSON.stringify({ findings }) + '\n');
    return;
  }

  if (verb === 'plan-fixes') {
    requireRef(ref, 'plan-fixes');
    // The rejected bytes are retained until resume schedules their replacement.
    // Re-reading them must not look like unreserved evidence from a new launch.
    const priorLedger = readLedger(stateDir, targetSlug(ref));
    const priorExecution = priorLedger?.execution;
    const priorRejection = priorExecution?.planRetry;
    const priorPlan = path.join(stateDir, `round-${priorLedger?.round}-plan.json`);
    if (priorRejection && priorExecution.round === priorLedger.round && !priorExecution.normalizedPlan
      && !(priorExecution.completed || []).includes('plan') && fs.existsSync(priorPlan)
      && contentHash(readReviewArtifact(priorPlan, stateDir, 'utf8')) === priorRejection.rejectedHash) {
      throw new Error(`harness-failure: ${priorRejection.message}`);
    }
    const { repoRoot, slug, ledger, n, isGit, fixes, resolvedAbsent, intentParked, gateOpen } = verifiedRound(ref, stateDir, run, 'plan-fixes');
    if (ledger.execution?.planRetry?.state === 'exhausted') throw new Error(`harness-failure: ${ledger.execution.planRetry.message}`);
    const fixById = new Map(fixes.map((finding) => [finding.id, finding]));
    const groupedIds = new Set();
    let planArtifact = { status: 'ok', protocolVersion: 2, groups: [] };
    let consumedPlanHash = ledger.execution?.normalizedPlan || ledger.execution?.artifactHashes?.plan;
    if (fixes.length) {
      let rawPlan;
      try { rawPlan = fs.readFileSync(path.join(stateDir, `round-${n}-plan.json`), 'utf8'); }
      catch (_) { throw new Error('harness-failure: v2 classification plan is required before editing; legacy or unclassified findings cannot authorize fixes'); }
      const seal = ledger.execution?.normalizedPlan || ((ledger.execution?.completed || []).includes('plan') ? ledger.execution.artifactHashes?.plan : null);
      consumedPlanHash = contentHash(rawPlan);
      if (seal && consumedPlanHash !== seal) throw new Error('harness-failure: sealed plan hash changed before acceptance');
      try { planArtifact = artifactContract.normalizeArtifact('plan', rawPlan); }
      catch (error) { throw new Error(`harness-failure: invalid v2 classification plan: ${error.message}`); }
      requireArtifactAfter(stateDir, n, 'verify', 'plan');
      if (ledger.intentHash) requireArtifactAfter(stateDir, n, 'intent', 'plan');
    }
    const fixGroups = planArtifact.groups.map((group, index) => {
      for (const id of group.findingIds) {
        if (!fixById.has(id)) throw new Error(`harness-failure: plan group[${index}] references finding "${id}" that is rejected, replayed, concluded, or absent`);
        if (groupedIds.has(id)) throw new Error(`harness-failure: plan finding "${id}" appears in more than one root-cause group`);
        groupedIds.add(id);
      }
      if (group.changeClass === 'structural' && group.action === 'fix'
        && (!ledger.intentHash || group.designEvidence?.sourceHash !== ledger.intentHash)) {
        throw new Error(`harness-failure: plan group[${index}] structural fix is not bound to this run's approved design hash`);
      }
      return { ...group, findings: group.findingIds.map((id) => fixById.get(id)) };
    });
    const unclassified = fixes.filter((finding) => !groupedIds.has(finding.id)).map((finding) => finding.id);
    if (unclassified.length) {
      const execution = ledger.execution || { round: n, completed: [], pending: [] };
      const rejectedHash = consumedPlanHash;
      const prior = execution.planRetry;
      // Re-reading the rejected bytes is not another launch or retry attempt.
      if (prior?.rejectedHash === rejectedHash && !execution.normalizedPlan && !(execution.completed || []).includes('plan')) throw new Error(`harness-failure: ${prior.message}`);
      const exhausted = !!prior;
      const message = `v2 classification is incomplete for finding(s): ${unclassified.join(', ')}${exhausted ? '; planner retry exhausted for this round; reconcile the failed plan before continuing' : ''}`;
      const retryArtifacts = retryArtifactMap(execution);
      if (exhausted) delete retryArtifacts.plan;
      else retryArtifacts.plan = `The previous normalized plan omitted surviving finding(s): ${unclassified.join(', ')}. Classify every surviving finding exactly once using the sealed correctness and verify evidence. Do not rerun reviewers or invent findings.`;
      const artifactHashes = { ...(execution.artifactHashes || {}) };
      delete artifactHashes.plan;
      const repairArtifacts = { ...(execution.repairArtifacts || {}) };
      delete repairArtifacts.plan;
      const failure = { role: 'plan', kind: 'incomplete-classification', message, at: new Date().toISOString() };
      const rejected = { ...ledger, execution: { ...execution, completed: (execution.completed || []).filter((role) => role !== 'plan'), artifactHashes,
        normalizedPlan: null, pending: Array.from(new Set([...(execution.pending || []), 'plan'])), retryArtifacts, retryArtifact: firstRetryArtifact(retryArtifacts),
        ...(execution.repairArtifacts ? { repairArtifacts } : {}),
        planRetry: { state: exhausted ? 'exhausted' : 'pending', missingIds: unclassified, rejectedHash, message, discardRepair: true },
        failures: [...(execution.failures || []), failure].slice(-5), failure } };
      writeLedger(stateDir, slug, run ? withSupersededLaunch(rejected, 'plan', n) : rejected);
      // Publish semantic accounting before discarding only the rejected plan's
      // representation bindings. discardRepair covers interruption during cleanup.
      for (const suffix of ['repair.json', 'original', 'packet.json', 'candidate.json', 'retry']) {
        try { fs.unlinkSync(path.join(stateDir, `round-${n}-plan.${suffix}`)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      throw new Error(`harness-failure: ${message}`);
    }
    const blockedGroups = fixGroups.filter((group) => group.action === 'reconcile');
    const structuralGroups = fixGroups.filter((group) => group.changeClass === 'structural' && group.action === 'fix');
    const invariantOwners = new Map();
    let transactionScope = 'group';
    for (const group of structuralGroups) for (const invariant of group.invariants) {
      const key = invariant.trim().toLowerCase();
      if (invariantOwners.has(key) && invariantOwners.get(key) !== group.groupId) transactionScope = 'round';
      else invariantOwners.set(key, group.groupId);
    }
    const material = [...intentParked, ...gateOpen.filter((f) => /^gate:(?:design-conformance|ac-coverage):/.test(f.id) && !gateFollowUpEligible(f))];
    const reconciliationPacket = blockedGroups.length ? {
      trigger: 'group-reconcile', finding: blockedGroups[0].findingIds[0], stage: 'plan-fixes', avoidedLaunches: fixes.length,
      findings: blockedGroups.reduce((counts, group) => ({ ...counts, [group.changeClass]: (counts[group.changeClass] || 0) + group.findingIds.length }), {}),
      reason: 'one or more groups require a human decision before editing',
      groups: blockedGroups.map(({ groupId, findingIds, rootCause, invariants, structuralEffects, reason }) => ({ groupId, findingIds, rootCause, invariants, structuralEffects, reason })),
    } : material.length ? { avoidedLaunches: fixes.length } : null;
    const reconciliation = !!reconciliationPacket;
    const planId = contentHash(JSON.stringify({ protocolVersion: 2, round: n, diff: ledger.diff_content_hash, groups: planArtifact.groups, transactionScope }));
    const fixPlan = {
      protocolVersion: 2,
      planId,
      transactionScope,
      expectedHead: isGit ? gitHeadSha(repoRoot) : null,
      groups: fixGroups.map(({ findings, ...group }) => group),
    };
    const execution = ledger.execution ? { ...ledger.execution,
      completed: Array.from(new Set([...(ledger.execution.completed || []), 'plan'])),
      pending: (ledger.execution.pending || []).filter((role) => role !== 'plan'), normalizedPlan: null,
      artifactHashes: { ...(ledger.execution.artifactHashes || {}), ...(consumedPlanHash ? { plan: consumedPlanHash } : {}) },
      planRetry: ledger.execution.planRetry ? { ...ledger.execution.planRetry, state: 'accepted', discardRepair: false } : null,
    } : ledger.execution;
    const next = { ...ledger, execution, planned: reconciliation ? [] : fixes.map((f) => f.id), fix_plan: fixPlan, resolved_absent: resolvedAbsent, intent_parked: intentParked, gate_open: gateOpen, reconciliation: reconciliationPacket, reconciliationPacket, phase: 'fixes' };
    writeLedger(stateDir, slug, next);
    process.stdout.write(JSON.stringify({ protocolVersion: 2, planId, transactionScope, fixes: reconciliation ? [] : fixes, fixGroups: reconciliation ? [] : fixGroups, avoidedLaunches: reconciliation ? fixes.length : 0, reconciliation: blockedGroups.length ? reconciliationPacket : reconciliation && { trigger: 'material-finding', finding: material[0].id, stage: 'plan-fixes', findings: material.reduce((counts, finding) => {
      const kind = finding.id.startsWith('gate:design-conformance:') ? 'design-conformance' : finding.id.startsWith('gate:ac-coverage:') ? 'ac-coverage' : finding.id.split(':', 1)[0];
      return { ...counts, [kind]: (counts[kind] || 0) + 1 };
    }, {}) } }) + '\n');
    return;
  }

  if (verb === 'unpark') {
    requireRef(ref, 'unpark');
    const findingId = rest[0];
    if (!findingId) throw new Error('review-cli unpark: missing required <findingId> argument');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`review-cli unpark: no ledger for ref "${ref}" ${stateDirHint(stateDir)}`);
    // `unpark` is the ONLY re-entry out of a parked ledger (round-start treats
    // 'parked' as terminal), so the fresh-look clearing belongs here rather than
    // in a third round-start branch: by the time round-start sees it, the ledger
    // is plain 'converging' and indistinguishable from a mid-round resume.
    // intent_parked is deliberately left alone -- round-start reads it for
    // priorIntentIds so a repeated objection keeps its id.
    const next = clearIntentForFreshLook(stateDir, slug, unparkFinding(ledger, findingId));
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
    if (!ledger) throw new Error(`review-cli dismiss: no ledger for ref "${ref}" ${stateDirHint(stateDir)}`);
    const dismissed = Array.from(new Set([...(ledger.gate_dismissed || []), gateId]));
    const gateOpen = (ledger.gate_open || []).filter((f) => f.id !== gateId);
    writeLedger(stateDir, slug, { ...ledger, gate_dismissed: dismissed, gate_open: gateOpen });
    process.stdout.write(`dismissed ${gateId}; it will no longer surface or block for ref "${ref}".\n`);
    return;
  }

  // Discards a readable standalone ledger so round-start begins a fresh run.
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
    if (prior.status === 'clean' || (prior.last_recorded_round !== null && prior.last_recorded_round !== undefined) || (prior.runs || []).length) {
      throw new Error('review-cli reset: cannot discard cumulative run history; cannot discard a completed run; preserve the ledger and split scope or reconcile the remaining verification');
    }
    deleteLedger(stateDir, slug);
    reviewTelemetry.deleteTelemetry(stateDir, prior.target?.ref || ref, slug);
    for (let n = 1; n <= (prior.round || 0); n++) deleteRoundArtifacts(stateDir, n);
    process.stdout.write(
      `reset ref "${ref}" (was "${prior.status}"); cleared ${prior.round || 0} round(s) of artifacts. The next round-start begins a fresh run.\n`,
    );
    return;
  }

  // Second opinion on an already-converged ref. `round-start` on a `clean`
  // ledger is terminal forever, and the only prior lever was `reset` -- which
  // discards the finished run's rounds, fix digest, and kill rationales. A
  // cross-engine re-review is exactly the case that must NOT pay that price:
  // `rerun` archives a compact summary of the finished run into `runs[]` and
  // re-arms the ledger. The new run starts BLIND (no findings carried forward)
  // -- the value of a second engine is uncorrelated eyes, and seeding it with
  // the first run's conclusions is the one thing that destroys that.
  // `gate_dismissed` is the exception: a finding a human retired stays retired,
  // same as it does across a gate-pending re-run.
  if (verb === 'rerun') {
    requireRef(ref, 'rerun');
    const { engine } = rerunOptions(rest);
    const slug = targetSlug(ref);
    const stored = readLedger(stateDir, slug);
    const prior = reviewTelemetry.foldTelemetry(stateDir, stored, slug);
    if (!prior) throw new Error(`review-cli rerun: no ledger for ref "${ref}" ${stateDirHint(stateDir)} -- there is no run to re-run; just start a normal run.`);
    const maxRuns = prior.run_budget?.max_runs ?? REVIEW_MAX_RUNS_DEFAULT;
    const completedAndActiveRuns = (prior.runs || []).length + 1;
    if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error('review-cli rerun: invalid cumulative run budget; preserve the ledger and reconcile it before mutation');
    if (completedAndActiveRuns >= maxRuns) {
      throw new Error(`review-cli rerun: cumulative run budget exhausted (${completedAndActiveRuns}/${maxRuns} full runs); ledger and evidence are unchanged. Inspect show ${ref}, preserve unresolved findings, and split scope or reconcile the remaining verification before any additional independent review`);
    }
    const archive = archiveReviewRun(stateDir, slug, prior);
    const recordedRounds = new Set((prior.history || []).map((entry) => entry.round));
    const completedFrontPass = (prior.gate_rounds || []).some((round) => recordedRounds.has(round));
    const runs = (prior.runs || []).concat([{
      run: (prior.runs || []).length + 1,
      engine: prior.engine || null,
      reviewRouting: prior.reviewRouting || null,
      status: prior.status,
      rounds: prior.round || 0,
      fixed: (prior.findings || []).filter((f) => f.status === 'fixed').map((f) => ({ id: f.id, summary: f.summary, fix_commit: f.fix_commit })),
      parked: (prior.findings || []).filter((f) => f.status === 'parked').map((f) => f.id),
      killed: prior.killed_digest || [],
      gate_open: (prior.gate_open || []).map((f) => f.id),
      telemetry: prior.telemetry || null,
      archive,
    }]);
    const fresh = {
      ...emptyLedger(prior.target || { kind: 'local', ref }),
      runs,
      review_history: prior.review_history || [],
      run_budget: { max_runs: maxRuns },
      engine,
      gate_dismissed: prior.gate_dismissed || [],
      ...(completedFrontPass && !prior.intentHash && prior.target?.base_sha && prior.gate_reviewed_head_sha ? {
        broad_reuse: { run: runs.length, base_sha: prior.target.base_sha, head_sha: prior.gate_reviewed_head_sha, intentHash: null, gate_open: prior.gate_open || [] },
      } : {}),
      ...(prior.initiative_binding || initiative ? { initiative_binding: prior.initiative_binding || { key: initiative.key, stateDir: canonicalPath(initiative.stateDir) } } : {}),
    };
    // Binding and archive pointer must be in the first durable fresh ledger,
    // including when interruption prevents main() from doing its final write.
    writeLedger(stateDir, slug, { ...fresh, rerun_cleanup: archive });
    finishRerunCleanup(stateDir, slug, readLedger(stateDir, slug));
    process.stdout.write(JSON.stringify({ status: 'ok', run: runs.length + 1, engine, archived: runs[runs.length - 1] }) + '\n');
    return;
  }

  if (verb === 'commit-fix') {
    requireRef(ref, 'commit-fix');
    const transactionId = rest[0];
    if (!transactionId) throw new Error('commit-fix: missing <groupId|planId>');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug);
    if (!ledger || ledger.phase !== 'fixes') throw new Error(`commit-fix: expected phase "fixes", got "${ledger && ledger.phase}" ${stateDirHint(stateDir)}`);
    const n = ledger.round;
    if ((ledger.journal || []).some((j) => j.transactionId === transactionId || j.groupId === transactionId)) { process.stdout.write(JSON.stringify({ committed: false, reason: 'already journaled' }) + '\n'); return; }
    const plan = ledger.fix_plan;
    if (!plan || plan.protocolVersion !== 2) throw new Error('harness-failure: commit-fix: review protocol v2 plan is required; legacy per-finding commits are refused');
    const groups = plan.transactionScope === 'round' && transactionId === plan.planId
      ? plan.groups
      : plan.groups.filter((group) => group.groupId === transactionId);
    if (!groups.length || (plan.transactionScope === 'round' && transactionId !== plan.planId)) {
      throw new Error(`harness-failure: commit-fix: transaction "${transactionId}" is not authorized by plan ${plan.planId}`);
    }
    if (plan.expectedHead && gitHeadSha(repoRoot) !== plan.expectedHead) {
      throw new Error('harness-failure: commit-fix: planned predecessor no longer matches; HEAD moved after classification');
    }
    const findingIds = groups.flatMap((group) => group.findingIds);
    if (findingIds.some((id) => !(ledger.planned || []).includes(id))) throw new Error('harness-failure: commit-fix: transaction membership differs from the planned findings');
    if (run) {
      requireReservations(run, ledger, [
        { role: 'fix', present: roundFiles(stateDir, n, new RegExp(`^round-${n}-fix-.*\\.json$`)) },
        { role: 'certify', present: roundFiles(stateDir, n, new RegExp(`^round-${n}-certify-.*\\.json$`)) },
      ], 'commit-fix');
    }
    const fixArtifacts = groups.map((group) => {
      try { return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-fix-${safeIdForFilename(group.groupId)}.json`), 'utf8')); }
      catch (_) { return null; }
    });
    if (fixArtifacts.some((artifact, index) => !artifact || artifact.status !== 'ok' || artifact.edited !== true || artifact.groupId !== groups[index].groupId || !Array.isArray(artifact.files) || !artifact.files.length)) {
      throw new Error('harness-failure: commit-fix: every authorized group requires one edited fix artifact');
    }
    const files = Array.from(new Set(fixArtifacts.flatMap((artifact) => artifact.files)));
    validateFixFiles(repoRoot, stateDir, files);
    const cert = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-certify-${safeIdForFilename(transactionId)}.json`), 'utf8')); } catch (_) { return null; } })();
    const invariants = Array.from(new Set(groups.flatMap((group) => group.invariants || [])));
    const sameSet = (left, right) => Array.isArray(left) && left.length === right.length && left.every((item) => right.includes(item));
    if (!cert || cert.status !== 'ok' || cert.groupId !== transactionId
      || !sameSet(cert.resolvedFindingIds, findingIds) || !sameSet(cert.invariants, invariants)
      || !sameSet(cert.files, files) || !Array.isArray(cert.evidence) || !cert.evidence.length
      || !cert.fileHashes || typeof cert.fileHashes !== 'object') {
      throw new Error('harness-failure: commit-fix: complete group certification is required before commit');
    }
    for (const file of files) {
      const absolute = path.join(repoRoot, file);
      const actual = fs.existsSync(absolute) ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null;
      if (cert.fileHashes[file] !== actual) throw new Error(`harness-failure: commit-fix: certified content changed for "${file}"`);
    }
    const readRound = (role) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-${role}.json`), 'utf8')); } catch (e) { return { findings: [] }; } };
    const candidates = roundCandidates(require('./gate-contract'), readRound('correctness'), readRound('verify'));
    const resolvedFindings = findingIds.map((id) => candidates.find((finding) => finding.id === id)).filter(Boolean);
    if (resolvedFindings.length !== findingIds.length || !files.some((file) => gitIsDirtyForFile(repoRoot, file))) {
      throw new Error('harness-failure: commit-fix: certified transaction has no matching dirty candidate');
    }
    {
      const sha = gitCommitFix(repoRoot, transactionId, groups.map((group) => group.rootCause).join('; '), files);
      ledger = {
        ...ledger,
        fix_plan: { ...plan, expectedHead: sha },
        journal: [...(ledger.journal || []), { id: findingIds[0], transactionId, groupIds: groups.map((group) => group.groupId), findingIds, sha, files, certificate: `round-${n}-certify-${safeIdForFilename(transactionId)}.json` }],
      };
      if (run) ledger = { ...ledger, initiative_fix_used: { ...ledger.initiative_fix_used, [n]: (ledger.initiative_fix_used?.[n] || 0) + 1 } };
      writeLedger(stateDir, slug, ledger);
      process.stdout.write(JSON.stringify({ committed: true, sha, groupIds: groups.map((group) => group.groupId), resolvedFindingIds: findingIds }) + '\n');
    }
    return;
  }

  throw unknownVerb(verb);
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

module.exports = { renderHandoff, gitDiff, gitCommitFix, gitIsReachable, gitIsDirty, gitIsDirtyForFile, gitCheckoutTree, runDod, main, runMain, withTargetLock };
