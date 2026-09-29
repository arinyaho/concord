'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { same } = require('./review-eval');

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
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function locked(run, update) {
  const lock = `${run.path}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = update(ledger);
    if (next) write(run.path, next);
    return next === undefined ? true : next || false;
  } finally { fs.rmdirSync(lock); }
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

function openInitiativeRun({ stateDir, key, repository, maxLaunches, maxRounds, allowTerminal = false }) {
  if (!stateDir || !key || !repository) throw new Error('initiative review requires a run key, repository identity, and canonical state directory');
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const run = { path: runPath(stateDir, key), repository: repositoryIdentity(repository) };
  const initialize = (ledger) => {
    if (!ledger) return { version: 3, repository: run.repository, status: 'active', budget: { maxLaunches, maxRounds }, launches: [], rounds: [], targets: [], findings: {}, checks: [], telemetry: [], terminal: null, dispositions: [], reconciliation: null };
    if (ledger.version !== 3) throw new Error('initiative review run schemaVersion must be 3');
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

// Reserves `count` launches of one role as a unit under a single lock: either
// every launch is recorded or none is. reserveLaunch is the count === 1 case.
function reserveLaunchBatch(run, launch, count = 1) {
  return Boolean(locked(run, (ledger) => {
    if (!ledger || ledger.status !== 'active' || !Number.isInteger(launch.round) || !Number.isInteger(count) || count < 1 || ledger.launches.length + count > ledger.budget.maxLaunches) return null;
    const target = launch.target || launch.revision?.ref || 'unknown';
    if ((ledger.dispositions || []).some((disposition) => disposition.target === target && disposition.kind === 'terminal')) return null;
    const round = `${target}\u0000${typeof launch.attemptId === 'string' ? launch.attemptId : 'legacy'}\u0000${launch.round}`;
    const rounds = ledger.rounds || [];
    if (!rounds.includes(round) && rounds.length >= ledger.budget.maxRounds) return null;
    const revision = launch.revision && { ref: launch.revision.ref || target, ...(launch.revision.base ? { base: launch.revision.base } : {}), ...((launch.revision.head_sha || launch.revision.head) ? { head_sha: launch.revision.head_sha || launch.revision.head } : {}) };
    const targets = revision && !(ledger.targets || []).some((item) => same(item, revision)) ? [...(ledger.targets || []), revision] : (ledger.targets || []);
    const entry = { role: launch.role, round: launch.round, ...(target === 'unknown' ? {} : { target }) };
    return { ...ledger, rounds: rounds.includes(round) ? rounds : [...rounds, round], targets, launches: [...ledger.launches, ...Array.from({ length: count }, () => ({ ...entry }))] };
  }));
}

function reserveLaunch(run, launch) {
  return reserveLaunchBatch(run, launch, 1);
}

function recordDisposition(run, { target, revision, result, packet = {}, finding = null, stage = null, avoidedLaunches = 0, findings = {}, checks = [], telemetry = [] }) {
  const safeTelemetry = telemetry.map(({ role, stage: telemetryStage, revision, round, count, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }) => ({ role, ...(telemetryStage ? { stage: telemetryStage } : {}), ...(revision ? { revision } : {}), ...(Number.isInteger(round) ? { round } : {}), ...(Number.isInteger(count) ? { count } : {}), elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }));
  return Boolean(locked(run, (ledger) => {
    if (!ledger || ledger.version !== 3 || ledger.status !== 'active') return null;
    const disposition = normalizeDisposition(result);
    if (disposition.kind === 'terminal' && (ledger.dispositions || []).some((item) => item.target === target && item.kind === 'terminal')) return null;
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
    const targetRevision = revision && { ref: revision.ref || target, ...(revision.base ? { base: revision.base } : {}), ...((revision.head_sha || revision.head) ? { head_sha: revision.head_sha || revision.head } : {}) };
    const targets = targetRevision && !(ledger.targets || []).some((item) => same(item, targetRevision)) ? [...(ledger.targets || []), targetRevision] : (ledger.targets || []);
    const terminalRevision = revision && { ref: revision.ref || target, ...(revision.base ? { base: revision.base } : {}), ...((revision.head_sha || revision.head) ? { head_sha: revision.head_sha || revision.head } : {}) };
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
    if (!ledger || ledger.version !== 3) return null;
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

// A target has at most one 'terminal' disposition (recordDisposition's dedup
// guard enforces that), so when kinds includes 'terminal' it must win over any
// 'escape'/'error' entry regardless of write order -- a terminal disposition
// is the sole replay/identity authority per docs/design/2026-09-28-terminal-disposition-journal.md.
// Only when no terminal entry is present does the most-recently-written match apply.
function selectDisposition(dispositions, target, kinds) {
  const matches = (dispositions || []).filter((item) => item.target === target && kinds.includes(item.kind));
  return matches.find((item) => item.kind === 'terminal') || matches[matches.length - 1];
}

// terminalTarget's own throws are identity-validation failures on an
// already-terminal target's replay path, not review-execution failures --
// tagged so the caller's catch (which records genuine failures as error
// dispositions) rethrows them unrecorded instead of polluting the ledger.
function replayIdentityError(message) {
  const error = new Error(message);
  error.notAReviewFailure = true;
  return error;
}

function terminalTarget(run, target, revision, kinds = ['terminal']) {
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  if (ledger.version !== 3) throw new Error('initiative review run schemaVersion must be 3');
  const terminal = selectDisposition(ledger.dispositions, target, kinds);
  if (ledger.status !== 'active' || !terminal) return false;
  if (!terminal.revision?.head_sha) throw replayIdentityError('initiative review terminal target has no stored revision');
  if (!target.startsWith('file:') && !terminal.revision.base) throw replayIdentityError('initiative review terminal target has no stored base');
  revision = typeof revision === 'function' ? revision(terminal.revision) : revision;
  if (terminal.target !== revision.ref) return false;
  if (same(terminal.revision, revision)) {
    if (terminal.kind === 'escape' && terminal.packet?.delivery?.consumed !== false) return false;
    return terminal;
  }
  if (terminal.kind === 'escape') {
    // selectDisposition picked the most-recently-written escape, which
    // doesn't match the queried revision -- but an OLDER, still-pending
    // escape might (e.g. the working tree reverted to an earlier commit
    // that already has its own unconsumed escape entry). Prefer replaying
    // that one over launching a redundant round.
    const olderMatch = (ledger.dispositions || []).find((item) => item.target === target && kinds.includes(item.kind) && item !== terminal && same(item.revision, revision) && item.packet?.delivery?.consumed === false);
    return olderMatch || false;
  }
  throw replayIdentityError('initiative review terminal target revision changed');
}

function finaliseInitiativeRun(run, reason = 'finalised') {
  return Boolean(locked(run, (ledger) => ledger?.status === 'terminal' ? undefined : (ledger?.status === 'active' && { ...ledger, status: 'terminal', terminal: { reason }, reconciliation: ledger.reconciliation || { terminals: [], hint: hint(reason) } })));
}

module.exports = { canonicalPath, runPath, repositoryIdentity, openInitiativeRun, reserveLaunch, reserveLaunchBatch, normalizeDisposition, recordDisposition, consumeDispositionDelivery, terminalTarget, selectDisposition, publicInitiativeSummary, finaliseInitiativeRun, finishInitiativeRun: finaliseInitiativeRun };
