'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { same } = require('./review-eval');
const { writeFileAtomic } = require('./atomic-write');
const { crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');

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
    const gitArgs = ['rev-parse', '--git-common-dir'];
    const commonDir = execFileSync(
      crossPlatformCommand('git', root),
      crossPlatformArgs(gitArgs, needsDoubleEscape('git', root)),
      crossPlatformOpts({ cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    ).trim();
    return fs.realpathSync(path.resolve(root, commonDir));
  } catch (_) {
    return root;
  }
}

function runPath(stateDir, key) {
  if (!path.isAbsolute(stateDir)) throw new Error('initiative review state directory must be absolute');
  return path.join(canonicalPath(stateDir), `initiative-review-${crypto.createHash('sha256').update(key).digest('hex')}.json`);
}

function broadClaimPath(stateDir, repository, initiativeId) {
  const identity = `${repository}\0${initiativeId}`;
  return path.join(canonicalPath(stateDir), `initiative-broad-${crypto.createHash('sha256').update(identity).digest('hex')}.json`);
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

// Code-generated stamp for ledger writes; never taken from a caller or a reviewer.
const now = () => new Date().toISOString();

// One trigger per SKILL.md lite-exclusion condition (see "Lite is eligible
// only when..."): public-api covers both the public-API and the
// deployment-boundary exclusion; cross-repository covers both the
// single-repository and the no-cross-repository-integration exclusions;
// multi-outcome and unsettled-contract cover the single-outcome and
// settled-contract exclusions; legal covers the legal/regulatory/
// external-data-rights exclusion, split out from security rather than folded
// into it. schema and cross-package predate that one-to-one mapping and are
// kept for narrower scope creep (an in-flight schema change, or cross-package
// coordination within one repository) that the exclusion list does not name
// on its own.
const ESCALATION_TRIGGERS = ['public-api', 'schema', 'security', 'cross-package', 'migration', 'multi-outcome', 'unsettled-contract', 'cross-repository', 'legal'];
const MODES = ['base', 'lite'];
const { lockOwner, pidRunning, reclaimStaleLock } = require('./run-lock');

// Why the run lock is held, or null when it is not. Names the lock and how to clear it.
function lockDiagnosis(run) {
  const lock = `${run.path}.lock`;
  if (!fs.existsSync(lock)) return null;
  const pid = lockOwner(lock);
  const owner = pid ? `owner pid ${pid} (${pidRunning(pid) ? 'still running' : 'not running'})` : 'owner unknown';
  return `initiative run lock ${lock} is held, ${owner}; if no review is running, remove it with: rm -r "${lock}"`;
}

function locked(run, update, beforeWrite) {
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
    if (next) {
      const before = beforeWrite && fs.readFileSync(run.path, 'utf8');
      const rollback = beforeWrite && beforeWrite();
      try { write(run.path, next); } catch (error) {
        // Only undo preparation when the original run proves no charge landed.
        // Unreadable or changed run state must retain the fail-closed binding.
        let unchanged = false;
        try { unchanged = beforeWrite && fs.readFileSync(run.path, 'utf8') === before; } catch (_) {}
        if (unchanged && rollback) rollback();
        throw error;
      }
    }
    return next === undefined ? true : next || false;
  } finally { if (lockOwner(lock) === process.pid) fs.rmSync(lock, { recursive: true, force: true }); }
}

function assertVersion(ledger) {
  if (ledger.version !== 5) throw new Error('initiative review run schemaVersion must be 5: this ledger predates delivery modes and is not migrated; preserve the original initiative and target ledgers, reconcile their history and spent budgets, then start a new run key in a separate target review state directory and remap the skill\'s source index to that key');
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
  if (['parked', 'abandoned'].includes(result.status) || decision.parked || decision.abandoned || result.reconciliation || result.status || decision.converged || decision.reviewedWithFollowUps) {
    const reason = ['parked', 'abandoned'].includes(result.status) ? result.status
      : decision.parked ? 'parked' : decision.abandoned ? 'abandoned'
        : result.reconciliation ? 'reconciliation-required'
          : decision.reviewedWithFollowUps ? 'reviewed-with-followups'
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
  if (decision.dodFailed) return { kind: 'escape', reason: 'dod-failed' };
  return { kind: 'terminal', reason: 'target-terminal' };
}

function openInitiativeRun({ stateDir, key, initiativeId = key, repository, maxLaunches, maxRounds, allowTerminal = false, mode = 'base' }) {
  if (!MODES.includes(mode)) throw new Error('initiative review mode must be base or lite');
  if (!stateDir || !key || !initiativeId || !repository) throw new Error('initiative review requires a run key, initiative identity, repository identity, and canonical state directory');
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const run = { path: runPath(stateDir, key), key, initiativeId, stateDir: canonicalPath(stateDir), repository: repositoryIdentity(repository) };
  const initialize = (ledger) => {
    if (!ledger) return { version: 5, mode, initiativeId, openedAt: now(), repository: run.repository, status: 'active', budget: { maxLaunches, maxRounds }, launches: [], rounds: [], targets: [], findings: {}, checks: [], telemetry: [], terminal: null, dispositions: [], reconciliation: null };
    assertVersion(ledger);
    if (ledger.repository !== run.repository || (ledger.initiativeId || key) !== initiativeId || (!allowTerminal && ledger.status === 'terminal') || ledger.budget?.maxLaunches !== maxLaunches || ledger.budget?.maxRounds !== maxRounds) throw new Error('initiative review run has a different repository, initiative identity, is terminal, or has immutable configured budgets');
  };
  if (!locked(run, initialize)) {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!ledger) throw new Error('initiative review run initialization was contended');
    initialize(ledger);
  }
  return run;
}

function claimBroadSweep(run, claimant, reclaim = false) {
  const claim = broadClaimPath(run.stateDir, run.repository, run.initiativeId);
  const lock = `${claim}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reclaimStaleLock(lock)) throw new Error(`initiative broad-sweep claim is contended: ${lock}`);
    fs.mkdirSync(lock);
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
    try {
      const prior = JSON.parse(fs.readFileSync(claim, 'utf8'));
      if (prior.repository === run.repository && prior.initiativeId === run.initiativeId
        && prior.target === claimant.target && prior.attemptId === claimant.attemptId) {
        if (reclaim && prior.key !== run.key) writeFileAtomic(claim, `${JSON.stringify({ ...prior, key: run.key })}\n`, { mode: 0o600 });
        return prior.key === run.key || reclaim;
      }
      if (prior.repository === run.repository && prior.initiativeId === run.initiativeId
        && prior.target === claimant.target && prior.attemptId !== claimant.attemptId) {
        throw new Error('initiative broad-sweep is owned by a prior attempt of this target; completion is not established for this attempt. Preserve the claim, archived evidence and spent budgets; reconcile the prior attempt before continuing');
      }
      return false;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeFileAtomic(claim, `${JSON.stringify({ repository: run.repository, initiativeId: run.initiativeId, key: run.key, target: claimant.target, attemptId: claimant.attemptId, claimedAt: now() })}\n`, { mode: 0o600 });
    return true;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function hasBroadSweepClaim(run, claimant) {
  try {
    const claim = JSON.parse(fs.readFileSync(broadClaimPath(run.stateDir, run.repository, run.initiativeId), 'utf8'));
    return claim.repository === run.repository && claim.initiativeId === run.initiativeId && claim.key === run.key
      && claim.target === claimant?.target && claim.attemptId === claimant?.attemptId;
  } catch (_) { return false; }
}

// Escalates a lite run to base. Allowed only before the first launch, so one run
// never mixes two reviewer sets under one budget. The caller supplies the base budgets.
function escalateInitiativeRun({ stateDir, key, initiativeId, repository, trigger, maxLaunches, maxRounds }) {
  if (!ESCALATION_TRIGGERS.includes(trigger)) throw new Error(`initiative escalation trigger must be one of ${ESCALATION_TRIGGERS.join(', ')}`);
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('initiative review budgets must be positive integers');
  const run = { path: runPath(stateDir, key), repository: repositoryIdentity(repository) };
  const done = locked(run, (ledger) => {
    if (!ledger) throw new Error('no initiative review run for this key');
    assertVersion(ledger);
    if (ledger.repository !== run.repository || (ledger.initiativeId || key) !== (initiativeId || key) || ledger.status !== 'active') throw new Error('initiative review run has a different repository, initiative identity, or is terminal');
    if (ledger.mode !== 'lite') throw new Error('initiative review run is not a lite run');
    if ((ledger.launches || []).length) throw new Error('initiative escalation is refused after the first launch; preserve the original initiative and target ledgers and reconcile the lite contract and spent budgets; only after reconciliation start a new run key in base mode in a separate target review state directory, retaining the old target ledger as evidence');
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

function normalizedInitiativePlan(plan) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!object(plan) || plan.version !== 1 || Object.keys(plan).some(k => !['version', 'targets'].includes(k)) || !Array.isArray(plan.targets) || !plan.targets.length) throw new Error('initiative plan requires version 1 and explicit targets');
  const refs = new Set();
  const targets = plan.targets.map(node => {
    if (!object(node) || !text(node.ref) || Object.keys(node).some(k => !['ref', 'dependsOn'].includes(k)) || !Array.isArray(node.dependsOn) || node.dependsOn.some(dep => !text(dep)) || new Set(node.dependsOn).size !== node.dependsOn.length || refs.has(node.ref)) throw new Error('initiative plan targets require unique refs and explicit unique dependencies');
    refs.add(node.ref);
    return { ref: node.ref, dependsOn: [...node.dependsOn].sort() };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  const nodes = new Map(targets.map(node => [node.ref, node.dependsOn]));
  const visited = new Set(), visiting = new Set();
  function visit(ref) {
    if (visiting.has(ref)) throw new Error('initiative plan dependency cycle');
    if (visited.has(ref)) return;
    if (!nodes.has(ref)) throw new Error('initiative plan dependency is unknown');
    visiting.add(ref);
    for (const dep of nodes.get(ref)) visit(dep);
    visiting.delete(ref); visited.add(ref);
  }
  for (const ref of refs) visit(ref);
  return { version: 1, targets };
}

function setInitiativePlan(run, input) {
  const plan = normalizedInitiativePlan(input);
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return Boolean(locked(run, ledger => {
    if (!ledger) throw new Error('initiative plan requires an existing run');
    assertVersion(ledger);
    if (ledger.status !== 'active') throw new Error('initiative plan requires an active run');
    if (ledger.dependencyPlan) {
      if (ledger.dependencyPlan.sha256 !== sha256) throw new Error('initiative dependency plan is immutable');
      return undefined;
    }
    if ((ledger.launches || []).length) throw new Error('initiative plan must be registered before the first launch');
    return { ...ledger, dependencyPlan: { ...plan, sha256 } };
  }));
}

function reconciledDisposition(ledger, entry) {
  return entry.reason === 'reconciliation-required' && !!entry.packet?.delivery?.claim
    && (ledger.reconciliationDecisions || []).some(decision => decision.claim === entry.packet.delivery.claim && decision.target === entry.target);
}

function pendingReconciliations(ledger) {
  return (ledger.dispositions || []).filter(entry => entry.reason === 'reconciliation-required' && !reconciledDisposition(ledger, entry));
}

function reconcileInitiativeRun(run, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ['target', 'claim', 'by', 'decision'].some(key => typeof input[key] !== 'string' || !input[key].trim())
    || input.contract !== 'unchanged' || Object.keys(input).some(key => !['target', 'claim', 'by', 'decision', 'contract'].includes(key))) throw new Error('initiative reconcile requires a target, exact claim, human identity, decision text and unchanged contract');
  // An absent run is not a new run authorization; do not create its directory.
  if (!fs.existsSync(run.path)) throw new Error('initiative reconcile requires an existing run');
  return Boolean(locked(run, ledger => {
    if (!ledger) throw new Error('initiative reconcile requires an existing run');
    assertVersion(ledger);
    if (ledger.status !== 'active') throw new Error('initiative reconcile requires an active run');
    const matches = pendingReconciliations(ledger).filter(entry => entry.target === input.target && entry.packet?.delivery?.claim === input.claim);
    if (matches.length !== 1) throw new Error('initiative reconcile requires one matching pending reconciliation claim');
    const reconciliationDecisions = [...(ledger.reconciliationDecisions || []), { ...input, at: now() }];
    const next = { ...ledger, reconciliationDecisions };
    const remaining = pendingReconciliations(next);
    return { ...next, reconciliation: { ...ledger.reconciliation, hint: remaining.length ? hint('reconciliation-required', remaining[0].packet?.reconciliation?.finding || null) : null } };
  }));
}

// Planned holds block every future dependent reservation. Legacy runs without
// a plan retain their circuit breaker for revision pairs not already opened.
function parkedRefusal(ledger, target, revision) {
  const pending = pendingReconciliations(ledger);
  if (ledger.dependencyPlan && pending.length) {
    const plan = normalizedInitiativePlan({ version: ledger.dependencyPlan.version, targets: ledger.dependencyPlan.targets });
    const sha256 = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    if (sha256 !== ledger.dependencyPlan.sha256) throw new Error('initiative dependency plan hash mismatch');
    const nodes = new Map(plan.targets.map(node => [node.ref, node.dependsOn]));
    if (!nodes.has(target) || pending.some(entry => !nodes.has(entry.target))) return true;
    const closure = new Set();
    const visit = ref => { if (closure.has(ref)) return; closure.add(ref); for (const dep of nodes.get(ref)) visit(dep); };
    visit(target);
    return pending.some(entry => closure.has(entry.target));
  }
  return ledger.reconciliation?.hint?.trigger === 'reconciliation-required' && !(ledger.targets || []).some((item) => same(item, revision || { ref: target }));
}

// Runner preflight: whether an active run parked for reconciliation refuses this
// revision pair, before any review work starts.
function pairRefusal(run, target, revision) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (ledger?.status === 'active' && ledger.launchRefunds?.limitReached) return 'environment-failure-limit';
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

// Receipts describe driver-observed transport lifecycle, never reviewer assertions.
const ENVIRONMENT_FAILURES = new Set(['spawn-enoent', 'spawn-eacces', 'spawn-eperm', 'unsupported-model', 'sandbox-denied', 'unusable-executable']);
const MAX_CONSECUTIVE_REFUNDS = 3;
const RESERVATION_ID = /^[0-9a-f]{32}:\d+$/;

function launchAccounting(ledger) {
  const launches = ledger.launches || [];
  const outcomes = ledger.launchOutcomes || [];
  if (!Array.isArray(outcomes)) throw new Error('initiative launch outcomes must be an array');
  const seen = new Set(), refunded = new Set();
  let environmentFailures = 0, started = 0;
  for (const outcome of outcomes) {
    const launch = launches.find((entry) => entry.reservationId === outcome.reservationId);
    if (!launch || seen.has(outcome.reservationId)) throw new Error('initiative launch outcome has an invalid reservation identity');
    seen.add(outcome.reservationId);
    if (outcome.failed && ENVIRONMENT_FAILURES.has(outcome.reason)) environmentFailures++;
    if (outcome.lifecycle === 'started') started++;
    if (outcome.refunded) {
      if (outcome.lifecycle !== 'not-started' || !outcome.failed || !ENVIRONMENT_FAILURES.has(outcome.reason)) throw new Error('initiative refund lacks pre-turn environment failure evidence');
      refunded.add(outcome.reservationId);
    }
  }
  return { attempted: launches.length, charged: launches.length - refunded.size, refunded: refunded.size, environmentFailures, started };
}

function launchBudgetUsage(ledger) {
  const counts = launchAccounting(ledger);
  return { launches: counts.charged, rounds: (ledger.rounds || []).length, ...(ledger.launchOutcomes ? {
    attemptedLaunches: counts.attempted, refundedLaunches: counts.refunded, environmentFailures: counts.environmentFailures,
  } : {}) };
}

function recordLaunchOutcome(run, input) {
  if (!input || !RESERVATION_ID.test(input.reservationId || '') || !['codex', 'claude', 'copilot'].includes(input.provider)
    || !['not-started', 'started', 'unknown'].includes(input.lifecycle) || typeof input.failed !== 'boolean'
    || !['none', 'unknown', ...ENVIRONMENT_FAILURES].includes(input.reason)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.invocationId || '')) {
    throw new Error('initiative launch outcome requires a valid reservation identity and closed lifecycle evidence');
  }
  let result;
  const accepted = locked(run, (ledger) => {
    if (!ledger) throw new Error('initiative launch outcome has no reserved run');
    assertVersion(ledger);
    const launch = ledger.launches.find((entry) => entry.reservationId === input.reservationId);
    if (!launch || ['role', 'target', 'attemptId', 'round'].some((field) => input[field] !== launch[field])
      || !launch.revision || !same(launch.revision, launchRevision({ revision: input.revision }, input.target))) {
      throw new Error('initiative launch outcome identity does not match its reservation');
    }
    const receipt = { reservationId: input.reservationId, role: launch.role, target: launch.target, attemptId: launch.attemptId,
      round: launch.round, revision: launch.revision, invocationId: input.invocationId, provider: input.provider,
      lifecycle: input.lifecycle, reason: input.reason, failed: input.failed };
    const outcomes = ledger.launchOutcomes || [];
    const prior = outcomes.find((entry) => entry.reservationId === input.reservationId);
    if (prior) {
      const { at, refunded, ...recorded } = prior;
      if (!same(recorded, receipt)) throw new Error('initiative reservation already has a different outcome');
      result = { status: 'duplicate', refunded };
      return undefined;
    }
    if (ledger.status !== 'active') throw new Error('initiative launch outcome requires an active run, not a terminal run');
    if ((ledger.dispositions || []).some((entry) => entry.target === launch.target && entry.kind === 'terminal' && samePair(entry.revision, launch.revision))) throw new Error('initiative launch outcome belongs to a completed terminal target');
    if (outcomes.some((entry) => entry.invocationId === input.invocationId)) throw new Error('provider invocation already belongs to a different reservation');
    const policy = ledger.launchRefunds || { consecutive: 0, limitReached: false };
    let consecutive = policy.consecutive;
    if (!Number.isSafeInteger(consecutive) || consecutive < 0 || consecutive > MAX_CONSECUTIVE_REFUNDS) throw new Error('invalid initiative refund streak');
    const refundable = input.failed && input.lifecycle === 'not-started' && ENVIRONMENT_FAILURES.has(input.reason);
    const refunded = refundable && !policy.limitReached && consecutive < MAX_CONSECUTIVE_REFUNDS;
    if (refunded) consecutive++;
    else if (input.lifecycle === 'started' && !policy.limitReached) consecutive = 0;
    const limitReached = policy.limitReached || consecutive >= MAX_CONSECUTIVE_REFUNDS;
    result = { status: 'recorded', refunded };
    return { ...ledger, launchOutcomes: [...outcomes, { ...receipt, refunded, at: now() }], launchRefunds: { consecutive, limitReached } };
  });
  return accepted ? result : null;
}

// Why the run cannot take this launch, or null when it can.
function launchRefusal(ledger, launch, count) {
  if (!ledger || ledger.status !== 'active' || !Number.isInteger(launch.round) || !Number.isInteger(count) || count < 1) return 'inactive';
  const target = launch.target || launch.revision?.ref || 'unknown';
  const revision = launchRevision(launch, target);
  if (parkedRefusal(ledger, target, revision)) return 'reconciliation-required';
  if (launch.broad && !hasBroadSweepClaim(launch.run, launch)) return 'broad-sweep-claimed';
  if ((ledger.dispositions || []).some((disposition) => disposition.target === target && disposition.kind === 'terminal' && (!reconciledDisposition(ledger, disposition) || !disposition.occurrence) && samePair(disposition.revision, revision))) return 'target-terminal';
  if (ledger.launchRefunds?.limitReached) return 'environment-failure-limit';
  if (launchAccounting(ledger).charged + count > ledger.budget.maxLaunches) return 'budget-exhausted';
  const round = `${target}\u0000${typeof launch.attemptId === 'string' ? launch.attemptId : 'legacy'}\u0000${launch.round}`;
  if (!(ledger.rounds || []).includes(round) && (ledger.rounds || []).length >= ledger.budget.maxRounds) return 'budget-exhausted';
  return null;
}

// Reserves `count` launches of one role as a unit under a single lock: either
// every launch is recorded or none is. reserveLaunch is the count === 1 case.
function reserveLaunchBatch(run, launch, count = 1, beforeCharge) {
  return Boolean(locked(run, (ledger) => {
    if (ledger) assertVersion(ledger);
    if (launchRefusal(ledger, { ...launch, run }, count)) return null;
    const target = launch.target || launch.revision?.ref || 'unknown';
    const round = `${target}\u0000${typeof launch.attemptId === 'string' ? launch.attemptId : 'legacy'}\u0000${launch.round}`;
    const rounds = ledger.rounds || [];
    const revision = launchRevision(launch, target);
    const targets = revision && !(ledger.targets || []).some((item) => same(item, revision)) ? [...(ledger.targets || []), revision] : (ledger.targets || []);
    const ids = launch.reservationIds;
    if (ids && (!Array.isArray(ids) || ids.length !== count || new Set(ids).size !== count
      || ids.some((id) => !RESERVATION_ID.test(id) || ledger.launches.some((entry) => entry.reservationId === id)))) {
      throw new Error('initiative launch reservation identities must be unique and match the batch');
    }
    if (ids && (!launch.attemptId || !revision?.head_sha || target === 'unknown')) throw new Error('initiative launch reservation identity requires an attempt and revision');
    const entry = { role: launch.role, round: launch.round, ...(target === 'unknown' ? {} : { target }), at: now() };
    const entries = Array.from({ length: count }, (_, index) => ({ ...entry, ...(ids ? { reservationId: ids[index], attemptId: launch.attemptId, revision } : {}) }));
    return { ...ledger, rounds: rounds.includes(round) ? rounds : [...rounds, round], targets, launches: [...ledger.launches, ...entries] };
  }, beforeCharge));
}

// Names the refusal after reserveLaunchBatch returned false. Returns null when
// the launch would now be accepted, which means the refusal was lock contention.
function denialReason(run, launch, count = 1) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(run.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return launchRefusal(ledger, { ...launch, run }, count);
}

function reserveLaunch(run, launch) {
  return reserveLaunchBatch(run, launch, 1);
}

function recordDisposition(run, { target, revision, result, packet = {}, finding = null, stage = null, avoidedLaunches = 0, findings = {}, checks = [], telemetry = [], occurrence }) {
  if (occurrence !== undefined && (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence) || typeof occurrence.attemptId !== 'string' || !occurrence.attemptId.trim() || !Number.isInteger(occurrence.round) || occurrence.round < 1 || Object.keys(occurrence).some(key => !['attemptId', 'round'].includes(key)))) throw new Error('initiative disposition occurrence requires an attempt and round');
  const safeTelemetry = telemetry.map(({ role, stage: telemetryStage, revision, round, count, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }) => ({ role, ...(telemetryStage ? { stage: telemetryStage } : {}), ...(revision ? { revision } : {}), ...(Number.isInteger(round) ? { round } : {}), ...(Number.isInteger(count) ? { count } : {}), elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }));
  return Boolean(locked(run, (ledger) => {
    if (!ledger || ledger.version !== 5 || ledger.status !== 'active') return null;
    const disposition = normalizeDisposition(result);
    const sameOccurrence = item => !occurrence || !item.occurrence || (item.occurrence.attemptId === occurrence.attemptId && item.occurrence.round === occurrence.round);
    if (disposition.kind === 'terminal' && (ledger.dispositions || []).some((item) => item.target === target && item.kind === 'terminal' && samePair(item.revision, launchRevision({ revision }, target) || { head_sha: null }) && (!reconciledDisposition(ledger, item) || sameOccurrence(item)))) return null;
    // For 'escape', only dedupe against a still-unconsumed match: once a
    // target's escape is consumed, terminalTarget lets a fresh round start
    // at the same revision (see terminalTarget's consumed-vs-unconsumed
    // branch), and a second escape there is a NEW occurrence, not a repeat
    // of the settled one -- matching it to the stale consumed entry would
    // silently drop it and hand back a packet already marked delivered.
    // 'error' keeps matching regardless of consumption: a retry producing
    // the identical error message is intentionally treated as the same
    // outcome (see normalizeDisposition's per-message error reason).
    if ((ledger.dispositions || []).some((item) => item.target === target && same(item.revision, revision) && item.kind === disposition.kind && item.reason === disposition.reason && (!reconciledDisposition(ledger, item) || sameOccurrence(item)) && (disposition.kind !== 'escape' || item.packet?.delivery?.consumed === false))) return null;
    const terminalRevision = launchRevision({ revision }, target);
    const targets = terminalRevision && !(ledger.targets || []).some((item) => same(item, terminalRevision)) ? [...(ledger.targets || []), terminalRevision] : (ledger.targets || []);
    if (!terminalRevision?.head_sha) throw new Error('initiative review terminal target requires a stored revision');
    const sequence = (ledger.dispositions || []).length + 1;
    const continuation = packet.nextAction || (disposition.kind === 'terminal' ? 'replay' : 'resume');
    const durablePacket = { ...packet, outcome: { kind: disposition.kind, reason: disposition.reason }, ledger: { version: ledger.version, status: ledger.status }, budget: { maxLaunches: ledger.budget.maxLaunches, maxRounds: ledger.budget.maxRounds, ...launchBudgetUsage(ledger) }, delivery: { claim: `${target}:${sequence}`, continuation, consumed: false } };
    if (disposition.reason === 'reconciliation-required') {
      const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
      durablePacket.handoff = `${typeof packet.handoff === 'string' ? packet.handoff + '\n' : ''}Human decision required: review-cli.js reconcile ${quote(target)} --claim ${quote(durablePacket.delivery.claim)} --by <human> --decision <verbatim-human-decision> --contract unchanged <original initiative flags>. Preserve the approved contract, remaining budget and other pending holds.`;
    }
    const entry = { target, revision: terminalRevision, ...disposition, sequence, at: now(), packet: durablePacket, ...(occurrence ? { occurrence: { ...occurrence } } : {}) };
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
      ...launchBudgetUsage(ledger),
      findings: ledger.findings || {},
      checks: (ledger.checks || []).length,
      telemetry: (ledger.telemetry || []).length,
    },
  };
}

function dispositionsFromLedger(ledger, target, kinds) {
  return (ledger.dispositions || []).filter((item) => item.target === target && kinds.includes(item.kind) && (!reconciledDisposition(ledger, item) || !item.occurrence));
}

function dispositionCandidates(run, target, kinds) {
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assertVersion(ledger);
  if (ledger.status !== 'active') return [];
  return dispositionsFromLedger(ledger, target, kinds);
}

// Whether the active run holds any disposition of these kinds for the target,
// whatever its revision. Lets a caller skip identity work when nothing can match.
function hasDisposition(run, target, kinds = ['terminal']) {
  return dispositionCandidates(run, target, kinds).length > 0;
}

// Identity is the revision pair: a disposition on another head or base is a
// different target and never blocks this one. A candidate with no stored head
// (or, for a git ref, no stored base) cannot match and is skipped.
function matchingDisposition(candidates, target, revision) {
  const matches = candidates.filter((item) => item.revision?.head_sha
    && (target.startsWith('file:') || item.revision.base)
    && item.target === revision.ref && same(item.revision, revision));
  // A terminal disposition replays whatever its delivery state; an escape
  // replays only while its packet is unconsumed, so a consumed one lets a fresh
  // round start at the same revision.
  return matches.find((item) => item.kind === 'terminal') || matches.reverse().find((item) => item.packet?.delivery?.consumed === false) || false;
}

function terminalTarget(run, target, revision, kinds = ['terminal']) {
  return matchingDisposition(dispositionCandidates(run, target, kinds), target, revision);
}

// Same lookup as terminalTarget, but against an already-loaded ledger object
// and without the active-run gate dispositionCandidates applies: a retry that
// lands after the run was finalised (e.g. by a reconciliation step) between
// recording a disposition and a caller's own follow-up write must still find
// that disposition, not see an empty run.
function terminalDispositionInLedger(ledger, target, revision, kinds = ['terminal']) {
  return matchingDisposition(dispositionsFromLedger(ledger, target, kinds), target, revision);
}

// Writes the terminal status, then renders the run's reports, also when the run is
// already terminal so a crash between the two is repaired by calling finalise again.
// Returns false on lock contention or when the run is not active.
function finaliseInitiativeRun(run, reason = 'finalised') {
  const done = Boolean(locked(run, (ledger) => ledger?.status === 'terminal' ? undefined : (ledger?.status === 'active' && { ...ledger, status: 'terminal', terminal: { reason, at: now() }, reconciliation: ledger.reconciliation || { terminals: [], hint: hint(reason) } })));
  if (!done) return false;
  try { require('./initiative-report').renderInitiativeReports(run); } catch (error) {
    throw new Error(`initiative report: the run is terminal but its report was not rendered (${error.message}); resolve the cause and run finalise again`);
  }
  return true;
}

module.exports = { normalizedInitiativePlan, setInitiativePlan, reconcileInitiativeRun, pendingReconciliations, launchBudgetUsage, launchAccounting, recordLaunchOutcome, MAX_CONSECUTIVE_REFUNDS, MODES, ESCALATION_TRIGGERS, lockDiagnosis, escalateInitiativeRun, canonicalPath, runPath, repositoryIdentity, openInitiativeRun, claimBroadSweep, hasBroadSweepClaim, reserveLaunch, reserveLaunchBatch, denialReason, pairRefusal, resolveBaseCommit, normalizeDisposition, recordDisposition, consumeDispositionDelivery, terminalTarget, terminalDispositionInLedger, hasDisposition, publicInitiativeSummary, finaliseInitiativeRun, finishInitiativeRun: finaliseInitiativeRun };
