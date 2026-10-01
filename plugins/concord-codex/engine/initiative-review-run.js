'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { same } = require('./review-eval');
const { writeFileAtomic } = require('./atomic-write');

function canonicalPath(value) {
  const resolved = path.resolve(value);
  let ancestor = resolved;
  const tail = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...tail);
}

function repositoryIdentity(repository) {
  const root = canonicalPath(repository);
  try {
    const commonDir = require('node:child_process').execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return fs.realpathSync(path.resolve(root, commonDir));
  } catch (_) {
    return root;
  }
}

function runPath(stateDir, key) {
  if (!path.isAbsolute(stateDir)) throw new Error('initiative review state directory must be absolute');
  return path.join(canonicalPath(stateDir), `initiative-review-${crypto.createHash('sha256').update(key).digest('hex')}.json`);
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

const ESCALATION_TRIGGERS = ['public-api', 'schema', 'security', 'cross-package', 'migration'];
const MODES = ['base', 'lite'];
const { lockOwner, pidRunning, reclaimStaleLock } = require('./run-lock');

// Why the run lock is held, or null when it is not. Names the lock and how to clear it.
function lockDiagnosis(run) {
  const lock = `${run.path}.lock`;
  if (!fs.existsSync(lock)) return null;
  const pid = lockOwner(lock);
  const owner = pid ? `owner pid ${pid} (${pidRunning(pid) ? 'still running' : 'not running'})` : 'owner unknown';
  return `initiative run lock ${lock} is held, ${owner}; if no review is running, remove it with: rm -r ${lock}`;
}

function locked(run, update) {
  const lock = `${run.path}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reclaimStaleLock(lock)) return false;
    try { fs.mkdirSync(lock); } catch (retry) { if (retry.code === 'EEXIST') return false; throw retry; }
  }
  try {
    try { fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`); } catch (error) { fs.rmSync(lock, { recursive: true, force: true }); throw error; } // no owner recorded yet, so the release below would skip it
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = update(ledger);
    if (next) write(run.path, next);
    return next === undefined ? true : next || false;
  } finally { if (lockOwner(lock) === process.pid) fs.rmSync(lock, { recursive: true, force: true }); }
}

function assertVersion(ledger) {
  if (ledger.version !== 5) throw new Error('initiative review run schemaVersion must be 5: this ledger predates delivery modes and is not migrated; start a new run key, `rerun` each ref, and remap the skill\'s source index to the new key');
}

function hint(trigger, finding = null, stage = null, avoidedLaunches = 0) {
  return { trigger, firstMaterialFinding: finding, stage, avoidedLaunches, preflight: ['confirm target revisions', 'confirm checks', 'choose resume, revise, or split'], options: ['resume', 'revise', 'split'] };
}

function normalizeDisposition(result = {}) {
  // The reason is part of recordDisposition's content-dedup key (same
  // target+revision+kind+reason is treated as a repeat of the same outcome,
  // not a new disposition). A fixed 'runner-error' reason for every Error
  // would make two DISTINCT failures at an unchanged revision collide and
  // silently drop the newer one's detail; hashing the message keeps retries
  // of the identical failure idempotent while still recording a genuinely
  // different failure as its own disposition.
  if (result instanceof Error) return { kind: 'error', reason: `runner-error:${crypto.createHash('sha256').update(result.message || '').digest('hex').slice(0, 12)}` };
  if (result.decision === 'escape') return { kind: 'escape', reason: 'escape' };
  const decision = result.decision || {};
  if (['parked', 'abandoned'].includes(result.status) || decision.parked || decision.abandoned || result.reconciliation || result.status || decision.converged) {
    const reason = ['parked', 'abandoned'].includes(result.status) ? result.status
      : decision.parked ? 'parked' : decision.abandoned ? 'abandoned'
        : result.reconciliation ? 'reconciliation-required'
          : result.status || 'clean';
    return { kind: 'terminal', reason };
  }
  // gate-pending and intent-review are round-start's own re-runnable stop
  // states (a fresh round-start clears the reported findings and resets
  // status once the human dismisses/resolves them) -- classify them as
  // 'escape', not 'terminal', so terminalTarget's same-revision replay only
  // blocks a retry while the packet is unconsumed, instead of permanently
  // sealing the target the way a genuine terminal disposition does.
  if (decision.intentReview) return { kind: 'escape', reason: 'intent-review' };
  if (decision.gatePending) return { kind: 'escape', reason: 'gate-pending' };
  return { kind: 'terminal', reason: 'target-terminal' };
}

function openInitiativeRun({ stateDir, key, repository, maxLaunches, maxRounds, allowTerminal = false, mode = 'base' }) {
  if (!MODES.includes(mode)) throw new Error('initiative review mode must be base or lite');
  if (!stateDir || !key || !repository) throw new Error('initiative review requires a run key, repository identity, and canonical state directory');
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const run = { path: runPath(stateDir, key), repository: repositoryIdentity(repository) };
  const initialize = (ledger) => {
    if (!ledger) return { version: 5, mode, repository: run.repository, status: 'active', budget: { maxLaunches, maxRounds }, launches: [], rounds: [], targets: [], findings: {}, checks: [], telemetry: [], terminal: null, dispositions: [], reconciliation: null };
    assertVersion(ledger);
    if (ledger.repository !== run.repository || (!allowTerminal && ledger.status === 'terminal') || ledger.budget?.maxLaunches !== maxLaunches || ledger.budget?.maxRounds !== maxRounds) throw new Error('initiative review run has a different repository, is terminal, or has immutable configured budgets');
  };
  if (!locked(run, initialize)) {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!ledger) throw new Error('initiative review run initialization was contended');
    initialize(ledger);
  }
  return run;
}

// Escalates a lite run to base. Allowed only before the first launch, so one run
// never mixes two reviewer sets under one budget. The caller supplies the base budgets.
function escalateInitiativeRun({ stateDir, key, repository, trigger, maxLaunches, maxRounds }) {
  if (!ESCALATION_TRIGGERS.includes(trigger)) throw new Error(`initiative escalation trigger must be one of ${ESCALATION_TRIGGERS.join(', ')}`);
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const run = { path: runPath(stateDir, key), repository: repositoryIdentity(repository) };
  const done = locked(run, (ledger) => {
    if (!ledger) throw new Error('no initiative review run for this key');
    assertVersion(ledger);
    if (ledger.repository !== run.repository || ledger.status !== 'active') throw new Error('initiative review run has a different repository or is terminal');
    if (ledger.mode !== 'lite') throw new Error('initiative review run is not a lite run');
    if ((ledger.launches || []).length) throw new Error('initiative escalation is refused after the first launch; start a new run key in base mode');
    return { ...ledger, mode: 'base', escalation: { from: 'lite', to: 'base', trigger }, budget: { maxLaunches, maxRounds } };
  });
  if (!done) throw new Error(lockDiagnosis(run) || 'initiative review run escalation was contended');
  return run;
}

function launchRevision(launch, target) {
  const revision = launch.revision;
  return revision && { ref: revision.ref || target, ...(revision.base ? { base: revision.base } : {}), ...((revision.head_sha || revision.head) ? { head_sha: revision.head_sha || revision.head } : {}) };
}

// A target is identified by its revision pair (ref, base, head). A revision
// with no head cannot be told apart from a recorded pair, so it matches every
// pair of its ref and stays refused after any terminal disposition.
function samePair(recorded, revision) {
  return !revision?.head_sha || (recorded?.head_sha === revision.head_sha && (recorded?.base || null) === (revision.base || null));
}

// A run parked for reconciliation opens no new revision pair; pairs it already
// holds keep working.
function parkedRefusal(ledger, target, revision) {
  return ledger.reconciliation?.hint?.trigger === 'reconciliation-required' && !(ledger.targets || []).some((item) => same(item, revision || { ref: target }));
}

// Runner preflight: whether an active run parked for reconciliation refuses this
// revision pair, before any review work starts.
function pairRefusal(run, target, revision) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return ledger?.status === 'active' && parkedRefusal(ledger, target, revision) ? 'reconciliation-required' : null;
}

// The immutable commit a base name points at right now. A base that does not
// resolve is kept as given.
function resolveBaseCommit(repoRoot, base) {
  try {
    return require('node:child_process').execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || base;
  } catch (_) {
    return base;
  }
}

// Why the run cannot take this launch, or null when it can.
function launchRefusal(ledger, launch, count) {
  if (!ledger || ledger.status !== 'active' || !Number.isInteger(launch.round) || !Number.isInteger(count) || count < 1) return 'inactive';
  const target = launch.target || launch.revision?.ref || 'unknown';
  const revision = launchRevision(launch, target);
  if (parkedRefusal(ledger, target, revision)) return 'reconciliation-required';
  if ((ledger.dispositions || []).some((disposition) => disposition.target === target && disposition.kind === 'terminal' && samePair(disposition.revision, revision))) return 'target-terminal';
  if (ledger.launches.length + count > ledger.budget.maxLaunches) return 'budget-exhausted';
  const round = `${target}\u0000${typeof launch.attemptId === 'string' ? launch.attemptId : 'legacy'}\u0000${launch.round}`;
  if (!(ledger.rounds || []).includes(round) && (ledger.rounds || []).length >= ledger.budget.maxRounds) return 'budget-exhausted';
  return null;
}

// Reserves `count` launches of one role as a unit under a single lock: either
// every launch is recorded or none is. reserveLaunch is the count === 1 case.
function reserveLaunchBatch(run, launch, count = 1) {
  return Boolean(locked(run, (ledger) => {
    if (ledger) assertVersion(ledger);
    if (launchRefusal(ledger, launch, count)) return null;
    const target = launch.target || launch.revision?.ref || 'unknown';
    const round = `${target}\u0000${typeof launch.attemptId === 'string' ? launch.attemptId : 'legacy'}\u0000${launch.round}`;
    const rounds = ledger.rounds || [];
    const revision = launchRevision(launch, target);
    const targets = revision && !(ledger.targets || []).some((item) => same(item, revision)) ? [...(ledger.targets || []), revision] : (ledger.targets || []);
    const entry = { role: launch.role, round: launch.round, ...(target === 'unknown' ? {} : { target }) };
    return { ...ledger, rounds: rounds.includes(round) ? rounds : [...rounds, round], targets, launches: [...ledger.launches, ...Array.from({ length: count }, () => ({ ...entry }))] };
  }));
}

// Names the refusal after reserveLaunchBatch returned false. Returns null when
// the launch would now be accepted, which means the refusal was lock contention.
function denialReason(run, launch, count = 1) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return launchRefusal(ledger, launch, count);
}

function reserveLaunch(run, launch) {
  return reserveLaunchBatch(run, launch, 1);
}

function recordDisposition(run, { target, revision, result, packet = {}, finding = null, stage = null, avoidedLaunches = 0, findings = {}, checks = [], telemetry = [] }) {
  const safeTelemetry = telemetry.map(({ role, stage: telemetryStage, revision, round, count, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }) => ({ role, ...(telemetryStage ? { stage: telemetryStage } : {}), ...(revision ? { revision } : {}), ...(Number.isInteger(round) ? { round } : {}), ...(Number.isInteger(count) ? { count } : {}), elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }));
  return Boolean(locked(run, (ledger) => {
    if (!ledger || ledger.version !== 5 || ledger.status !== 'active') return null;
    const disposition = normalizeDisposition(result);
    if (disposition.kind === 'terminal' && (ledger.dispositions || []).some((item) => item.target === target && item.kind === 'terminal' && samePair(item.revision, launchRevision({ revision }, target) || { head_sha: null }))) return null;
    // For 'escape', only dedupe against a still-unconsumed match: once a
    // target's escape is consumed, terminalTarget lets a fresh round start
    // at the same revision (see terminalTarget's consumed-vs-unconsumed
    // branch), and a second escape there is a NEW occurrence, not a repeat
    // of the settled one -- matching it to the stale consumed entry would
    // silently drop it and hand back a packet already marked delivered.
    // 'error' keeps matching regardless of consumption: a retry producing
    // the identical error message is intentionally treated as the same
    // outcome (see normalizeDisposition's per-message error reason).
    if ((ledger.dispositions || []).some((item) => item.target === target && same(item.revision, revision) && item.kind === disposition.kind && item.reason === disposition.reason && (disposition.kind !== 'escape' || item.packet?.delivery?.consumed === false))) return null;
    const terminalRevision = launchRevision({ revision }, target);
    const targets = terminalRevision && !(ledger.targets || []).some((item) => same(item, terminalRevision)) ? [...(ledger.targets || []), terminalRevision] : (ledger.targets || []);
    if (!terminalRevision?.head_sha) throw new Error('initiative review terminal target requires a stored revision');
    const sequence = (ledger.dispositions || []).length + 1;
    const continuation = packet.nextAction || (disposition.kind === 'terminal' ? 'replay' : 'resume');
    const durablePacket = { ...packet, outcome: { kind: disposition.kind, reason: disposition.reason }, ledger: { version: ledger.version, status: ledger.status }, budget: { maxLaunches: ledger.budget.maxLaunches, maxRounds: ledger.budget.maxRounds, launches: ledger.launches.length, rounds: ledger.rounds.length }, delivery: { claim: `${target}:${sequence}`, continuation, consumed: false } };
    const entry = { target, revision: terminalRevision, ...disposition, sequence, packet: durablePacket };
    const previous = ledger.reconciliation || {};
    const reconciliationHint = previous.hint && previous.hint.trigger === 'reconciliation-required'
      ? previous.hint
      : disposition.reason === 'reconciliation-required' ? hint(disposition.reason, finding, stage, avoidedLaunches) : previous.hint || hint(disposition.reason, finding, stage, avoidedLaunches);
    const terminals = disposition.kind === 'terminal' ? [...(previous.terminals || []), { target, reason: disposition.reason, revision: terminalRevision }] : (previous.terminals || []);
    return { ...ledger, targets, findings: { ...(ledger.findings || {}), ...Object.fromEntries(Object.entries(findings).map(([kind, count]) => [kind, (ledger.findings?.[kind] || 0) + count])) }, checks: [...(ledger.checks || []), ...checks], telemetry: [...(ledger.telemetry || []), ...safeTelemetry], dispositions: [...(ledger.dispositions || []), entry], reconciliation: { terminals, hint: reconciliationHint } };
  }));
}

function consumeDispositionDelivery(run, claim) {
  return Boolean(locked(run, (ledger) => {
    if (!ledger || ledger.version !== 5) return null;
    const index = (ledger.dispositions || []).findIndex((item) => item.packet?.delivery?.claim === claim && item.packet.delivery.consumed === false);
    if (index === -1) return null;
    const dispositions = ledger.dispositions.slice();
    dispositions[index] = { ...dispositions[index], packet: { ...dispositions[index].packet, delivery: { ...dispositions[index].packet.delivery, consumed: true } } };
    return { ...ledger, dispositions };
  }));
}

function publicInitiativeSummary(run) {
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  return {
    targetIds: [...new Set((ledger.targets || []).map((target) => crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex')))],
    counts: {
      targets: (ledger.targets || []).length,
      launches: (ledger.launches || []).length,
      rounds: (ledger.rounds || []).length,
      findings: ledger.findings || {},
      checks: (ledger.checks || []).length,
      telemetry: (ledger.telemetry || []).length,
    },
  };
}

function dispositionCandidates(run, target, kinds) {
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assertVersion(ledger);
  if (ledger.status !== 'active') return [];
  return (ledger.dispositions || []).filter((item) => item.target === target && kinds.includes(item.kind));
}

// Whether the active run holds any disposition of these kinds for the target,
// whatever its revision. Lets a caller skip identity work when nothing can match.
function hasDisposition(run, target, kinds = ['terminal']) {
  return dispositionCandidates(run, target, kinds).length > 0;
}

function terminalTarget(run, target, revision, kinds = ['terminal']) {
  // Identity is the revision pair: a disposition on another head or base is a
  // different target and never blocks this one. A candidate with no stored head
  // (or, for a git ref, no stored base) cannot match and is skipped.
  const matches = dispositionCandidates(run, target, kinds).filter((item) => item.revision?.head_sha
    && (target.startsWith('file:') || item.revision.base)
    && item.target === revision.ref && same(item.revision, revision));
  // A terminal disposition replays whatever its delivery state; an escape
  // replays only while its packet is unconsumed, so a consumed one lets a fresh
  // round start at the same revision.
  return matches.find((item) => item.kind === 'terminal') || matches.reverse().find((item) => item.packet?.delivery?.consumed === false) || false;
}

function finaliseInitiativeRun(run, reason = 'finalised') {
  return Boolean(locked(run, (ledger) => ledger?.status === 'terminal' ? undefined : (ledger?.status === 'active' && { ...ledger, status: 'terminal', terminal: { reason }, reconciliation: ledger.reconciliation || { terminals: [], hint: hint(reason) } })));
}

module.exports = { lockDiagnosis, escalateInitiativeRun, canonicalPath, runPath, repositoryIdentity, openInitiativeRun, reserveLaunch, reserveLaunchBatch, denialReason, pairRefusal, resolveBaseCommit, normalizeDisposition, recordDisposition, consumeDispositionDelivery, terminalTarget, hasDisposition, publicInitiativeSummary, finaliseInitiativeRun, finishInitiativeRun: finaliseInitiativeRun };
