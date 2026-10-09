'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('./spawn-cross-platform');

// External review requests are bounded by the same 15-minute window as review
// observation, so a recovery cannot overlap a live request invocation.
const INITIAL_CLAIM_LEASE_MS = 15 * 60 * 1000;
const AUTO_REVIEW_GRACE_MS = 2 * 60 * 1000;
const MAX_REQUESTS_PER_PR = 3;
const MAX_FIX_ROUNDS_PER_PR = 3;

const FULL_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

function normalizeProvider(provider) {
  if (provider == null || provider === '') return null;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 200) throw new Error('review-lgtm-state: provider must be a non-empty string of at most 200 characters');
  return provider.trim();
}

function requestMarkerKind(kind, provider) {
  return provider ? `${kind}-${crypto.createHash('sha256').update(provider).digest('hex').slice(0, 16)}` : kind;
}

function requestIdentity({ headSha, kind, provider }) {
  return FULL_SHA.test(String(headSha)) && ['initial', 'retry'].includes(kind) ? `${String(headSha).toLowerCase()}:${kind}:${provider || ''}` : null;
}

function validate({ pr, headSha }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  if (!FULL_SHA.test(String(headSha))) throw new Error('review-lgtm-state: head SHA must be a full 40- or 64-character hexadecimal SHA (the PR headRefOid)');
  return { pr: Number(pr), headSha: String(headSha).toLowerCase() };
}

// Closed set of escalation signals an agent may tag on a finding. Any value
// outside this set, or a value on a finding that omits the field entirely,
// is rejected rather than defaulted.
const SIGNALS = new Set(['lifecycle', 'ledger', 'audit-privacy', 'provider-parity', 'ac-conflict', 'unsupported-test']);
const PRIORITIES = new Set(['P1', 'P2', null]);

function validateFinding(finding) {
  if (!finding || typeof finding !== 'object') throw new Error('review-lgtm-state: finding must be an object');
  if (typeof finding.url !== 'string' || !finding.url) throw new Error('review-lgtm-state: finding url is required');
  if (!('priority' in finding)) throw new Error('review-lgtm-state: finding priority is required and must be P1, P2, or null');
  if (!PRIORITIES.has(finding.priority)) throw new Error('review-lgtm-state: finding priority must be P1, P2, or null');
  if (!Array.isArray(finding.signals)) throw new Error('review-lgtm-state: finding signals is required and must be an array');
  for (const signal of finding.signals) {
    if (!SIGNALS.has(signal)) throw new Error(`review-lgtm-state: unknown signal ${JSON.stringify(signal)}`);
  }
  return { url: finding.url, priority: finding.priority ?? null, signals: [...finding.signals] };
}

// GitHub's API returns a review id as a JSON number; the CLI's own hook entry
// point also passes one through verbatim from stdin JSON. Accept either that
// number or a decimal-digit string and normalize to the decimal string,
// since the id becomes part of a file name.
function normalizeReviewId(reviewId) {
  if (typeof reviewId === 'string' && /^[0-9]+$/.test(reviewId)) {
    const canonical = BigInt(reviewId).toString();
    if (canonical === '0') throw new Error('review-lgtm-state: reviewId must be a positive safe integer or decimal digits');
    return canonical;
  }
  if (typeof reviewId === 'number' && Number.isSafeInteger(reviewId) && reviewId > 0) return String(reviewId);
  throw new Error('review-lgtm-state: reviewId must be a positive safe integer or decimal digits');
}

function validateObservation(observation) {
  if (!observation || typeof observation !== 'object') throw new Error('review-lgtm-state: observation must be an object');
  const { reviewId, reviewer, reviewUrl, commitId, state, lgtm, findings } = observation;
  const normalizedReviewId = normalizeReviewId(reviewId);
  if (typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('review-lgtm-state: reviewer is required');
  if (typeof reviewUrl !== 'string' || !reviewUrl) throw new Error('review-lgtm-state: reviewUrl is required');
  if (typeof commitId !== 'string' || !FULL_SHA.test(commitId)) throw new Error('review-lgtm-state: commitId must be a full 40- or 64-character hexadecimal SHA (the review commit_id)');
  if (state !== 'completed' && state !== 'in-progress') throw new Error('review-lgtm-state: state must be completed or in-progress');
  if (typeof lgtm !== 'boolean') throw new Error('review-lgtm-state: lgtm is required and must be a boolean');
  if (!Array.isArray(findings)) throw new Error('review-lgtm-state: findings is required and must be an array');
  return { reviewId: normalizedReviewId, reviewer: reviewer.trim(), reviewUrl, commitId: commitId.toLowerCase(), state, lgtm, findings: findings.map(validateFinding) };
}

function defaultStateDir(repoRoot = process.cwd()) {
  if (process.env.REVIEW_LGTM_STATE_DIR) return process.env.REVIEW_LGTM_STATE_DIR;
  const git = crossPlatformCommand('git', repoRoot);
  const commonDir = execFileSync(git, crossPlatformArgs(['rev-parse', '--git-common-dir'], needsDoubleEscape('git', repoRoot)), crossPlatformOpts({ cwd: repoRoot, encoding: 'utf8' })).trim();
  return path.join(fs.realpathSync(path.resolve(repoRoot, commonDir)), 'concord', 'review-until-lgtm');
}

function markerPath({ stateDir, pr, headSha }, kind) {
  const key = validate({ pr, headSha });
  return path.join(stateDir, `pr-${key.pr}-${key.headSha}.${kind}.json`);
}

function requestUsage({ stateDir, pr, coveredIdentity = null, coveredRecoveryIdentity = null }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const keyPrefix = `pr-${Number(pr)}`;
  const slots = [];
  const attempts = new Map();
  const attempt = (identity) => {
    if (!attempts.has(identity)) attempts.set(identity, { base: false, recoveries: 0, originalSlots: 0, recoverySlots: 0, legacySlots: 0 });
    return attempts.get(identity);
  };
  for (const name of names) {
    if (name.startsWith(`${keyPrefix}.request-slot-`) && name.endsWith('.json')) {
      const marker = readMarker(path.join(stateDir, name));
      slots.push(name);
      const identity = marker && requestIdentity(marker);
      if (identity) {
        if (marker.coversClaim === true) attempt(identity).originalSlots += 1;
        else if (marker.coversClaim === false) attempt(identity).recoverySlots += 1;
        else attempt(identity).legacySlots += 1;
      }
      continue;
    }
    const base = name.match(new RegExp(`^${keyPrefix}-([0-9a-f]{40}|[0-9a-f]{64})\\.(initial|retry)(?:-[0-9a-f]{16})?-(?:claim|request)\\.json$`, 'i'));
    const recovery = name.match(new RegExp(`^${keyPrefix}-([0-9a-f]{40}|[0-9a-f]{64})\\.(initial|retry)(?:-[0-9a-f]{16})?-recovery-claim(?:-.*)?\\.json$`, 'i'));
    if (base || recovery) {
      const marker = readMarker(path.join(stateDir, name));
      const match = base || recovery;
      const entry = attempt(`${match[1].toLowerCase()}:${match[2].toLowerCase()}:${marker && marker.provider || ''}`);
      if (base) entry.base = true;
      else entry.recoveries += 1;
    }
  }
  let orphanAttempts = 0;
  for (const [identity, entry] of attempts) {
    let legacySlots = entry.legacySlots;
    const uncoveredBase = entry.base && identity !== coveredIdentity && entry.originalSlots === 0;
    if (uncoveredBase && legacySlots > 0) legacySlots -= 1;
    else if (uncoveredBase) orphanAttempts += 1;
    const recoveries = entry.recoveries - (identity === coveredRecoveryIdentity ? 1 : 0);
    orphanAttempts += Math.max(0, recoveries - entry.recoverySlots - legacySlots);
  }
  return { spent: slots.length + orphanAttempts, slotCapacity: MAX_REQUESTS_PER_PR - orphanAttempts };
}

function requestBudget(input) {
  const { spent } = requestUsage(input);
  return { max: MAX_REQUESTS_PER_PR, spent, remaining: Math.max(0, MAX_REQUESTS_PER_PR - spent) };
}

function reserveRequestSlot({ stateDir, pr, headSha }, kind, now, provider = null, coverClaim = false) {
  const identity = requestIdentity({ headSha, kind, provider });
  const { slotCapacity } = requestUsage({ stateDir, pr, coveredIdentity: coverClaim ? identity : null, coveredRecoveryIdentity: coverClaim ? null : identity });
  for (let slot = 1; slot <= slotCapacity; slot += 1) {
    const file = path.join(stateDir, `pr-${pr}.request-slot-${slot}.json`);
    if (writeExclusive(file, { pr, headSha, kind, provider, coversClaim: coverClaim, claimedAtMs: now })) return slot;
  }
  return null;
}

function fixWaivers({ stateDir, pr }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  return names.filter((name) => name.startsWith(`pr-${Number(pr)}.fix-waiver-`) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((marker) => marker && typeof marker.person === 'string' && Number.isSafeInteger(marker.count) && Number.isSafeInteger(marker.atMs))
    .map(({ person, count, atMs }) => ({ person, count, atMs }))
    .sort((a, b) => a.atMs - b.atMs || a.person.localeCompare(b.person) || a.count - b.count);
}

function fixBudget({ stateDir, pr }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const spent = names.filter((name) => name.startsWith(`pr-${Number(pr)}.fix-round-slot-`) && name.endsWith('.json')).length;
  const max = MAX_FIX_ROUNDS_PER_PR + fixWaivers({ stateDir, pr }).reduce((sum, waiver) => sum + waiver.count, 0);
  return { max, spent, remaining: Math.max(0, max - spent) };
}

// A human's waiver raises the per-PR fix-round cap by `count`. The cap stays a hard stop for
// automation; the waiver is the recorded decision that changes who may continue.
function waiveFixBudget({ stateDir, pr, person, count, now = Date.now() }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  if (typeof person !== 'string' || !person.trim() || person.length > 200) throw new Error('review-lgtm-state: waiver person must be a non-empty string of at most 200 characters');
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('review-lgtm-state: waiver count must be a positive integer');
  const who = person.trim();
  const id = crypto.createHash('sha256').update(`${who}\0${count}`).digest('hex').slice(0, 16);
  const file = path.join(stateDir, `pr-${Number(pr)}.fix-waiver-${id}.json`);
  const created = writeExclusive(file, { pr: Number(pr), person: who, count, atMs: now });
  const waiver = fixWaivers({ stateDir, pr }).find((entry) => entry.person === who && entry.count === count);
  return { waived: true, ...(created ? {} : { existing: true }), waiver };
}

function reserveFixRound({ stateDir, pr, headSha }, now, owner) {
  const { max } = fixBudget({ stateDir, pr });
  for (let round = 1; round <= max; round += 1) {
    const file = path.join(stateDir, `pr-${pr}.fix-round-slot-${round}.json`);
    if (writeExclusive(file, { pr, headSha, owner, claimedAtMs: now })) return round;
  }
  return null;
}

function fixRoundForHead({ stateDir, pr, headSha }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names.filter((name) => name.startsWith(`pr-${pr}.fix-round-slot-`) && name.endsWith('.json'))) {
    const marker = readMarker(path.join(stateDir, name));
    if (marker && marker.pr === pr && marker.headSha === headSha) return { ...marker, round: Number(name.match(/slot-(\d+)\.json$/)[1]) };
  }
  return null;
}

function latestFixOwnership({ stateDir, pr, headSha }, slot) {
  const prefix = `pr-${pr}-${headSha}.fix-round-owner-`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const events = names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => ({ ...readMarker(path.join(stateDir, name)), name }));
  events.push({ ...slot, name: 'slot' });
  return events.filter((event) => Number.isSafeInteger(event.claimedAtMs))
    .sort((a, b) => b.claimedAtMs - a.claimedAtMs || b.name.localeCompare(a.name))[0];
}

function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`review-lgtm-state: unreadable marker ${path.basename(file)}`);
  }
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`);
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function withTransitionLock({ stateDir, pr }, fn, busy = { claimed: false, reason: 'transition-busy' }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, `pr-${pr}.transition.lock`);
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') return busy;
    throw error;
  }
  try { return fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function latestRecoveryClaim({ stateDir, pr, headSha }, kind) {
  // ponytail: crash-only recovery markers are scanned per PR head; prune them on request if a long-lived state directory grows large.
  const prefix = `pr-${pr}-${headSha}.${kind}-recovery-claim`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return names.filter((name) => name === `${prefix}.json` || name.startsWith(`${prefix}-`))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((marker) => marker && marker.pr === pr && marker.headSha === headSha && Number.isSafeInteger(marker.claimedAtMs))
    .sort((a, b) => b.claimedAtMs - a.claimedAtMs)[0] || null;
}

function requestMarkers({ stateDir, pr, headSha }, kind, stage) {
  const prefix = `pr-${pr}-${headSha}.${kind}`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const pattern = new RegExp(`^${prefix}(?:-[0-9a-f]{16})?-${stage}(?:-.*)?\\.json$`, 'i');
  return names.filter((name) => pattern.test(name))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((marker) => marker && marker.pr === pr && marker.headSha === headSha);
}

// ponytail: linear directory scan per read; fine at this marker-directory scale, switch to an index file if a PR head accumulates many reviews.
function reviewRecords({ stateDir, pr, headSha }) {
  const prefix = `pr-${pr}-${headSha}.review-`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((record) => record && record.pr === pr && record.headSha === headSha);
}

function rejectedReviewIds({ stateDir, pr, headSha }) {
  const prefix = `pr-${pr}-${headSha}.disposition-`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  return new Set(names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .flatMap((name) => readMarker(path.join(stateDir, name))?.reviewIds || []));
}

function activeReviewRecords(input) {
  const rejected = rejectedReviewIds(input);
  return reviewRecords(input).filter((record) => !rejected.has(record.reviewId));
}

function compareReviewIds(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function reconciliationPacket({ stateDir, pr, headSha }) {
  const records = activeReviewRecords({ stateDir, pr, headSha })
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs || compareReviewIds(a.reviewId, b.reviewId));
  const delivered = !fixRoundForHead({ stateDir, pr, headSha }) && deliveryTerminal({ stateDir, pr, headSha });
  if (delivered) return { pr, headSha, reviews: records.map((record) => ({ id: record.reviewId, reviewer: record.reviewer || 'legacy/unknown', url: record.reviewUrl, findings: record.findings })), batchCount: records.length, classification: 'delivery-terminal', action: 'report-delivery', humanRequired: false, requires: `report the recorded ${delivered.classification} delivery disposition` };
  if (records.length === 0) return null;
  const reviews = records.map((record) => ({ id: record.reviewId, reviewer: record.reviewer || 'legacy/unknown', url: record.reviewUrl, findings: record.findings }));
  const findings = records.flatMap((record) => record.findings);
  const p1Count = findings.filter((finding) => finding.priority === 'P1').length;
  const p2Count = findings.filter((finding) => finding.priority === 'P2').length;
  const signals = [...new Set(findings.flatMap((finding) => finding.signals))].sort();
  const classification = (p1Count > 0 || records.length >= 2 || signals.length > 0) ? 'requires-architecture-review' : 'light-implementation-eligible';
  const claimed = !!fixRoundForHead({ stateDir, pr, headSha });
  const abandoned = !claimed && !!readMarker(markerPath({ stateDir, pr, headSha }, 'fix-round-claim'));
  const exhausted = !claimed && fixBudget({ stateDir, pr }).remaining === 0;
  const humanRequired = abandoned || exhausted;
  const action = claimed ? 'complete-claimed-fix-round' : humanRequired ? 'human-reconciliation' : 'verify-and-fix';
  const requires = claimed ? 'complete the claimed fix round' : abandoned ? 'human decision: abandoned fix-round claim' : exhausted ? 'human decision: fix-round budget exhausted' : 'verify the batch and claim a fix round';
  return { pr, headSha, reviews, batchCount: records.length, p1Count, p2Count, signals, classification, action, humanRequired, requires };
}

function recordReview(input) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const observation = validateObservation(input.observation);
  if (observation.commitId !== key.headSha) return { outcome: 'stale', recorded: false };
  if (observation.state === 'in-progress') return { outcome: 'in-progress', recorded: false };
  if (observation.findings.length > 0) {
    const file = markerPath({ stateDir, ...key }, `review-${observation.reviewId}`);
    if (readMarker(file)) {
      const outcome = rejectedReviewIds({ stateDir, ...key }).has(observation.reviewId) ? 'rejected' : 'needs-reconciliation';
      return { outcome, recorded: false, duplicate: true };
    }
    const written = writeExclusive(file, { pr: key.pr, headSha: key.headSha, reviewId: observation.reviewId, reviewer: observation.reviewer, reviewUrl: observation.reviewUrl, recordedAtMs: now, findings: observation.findings });
    if (!written) return { outcome: 'needs-reconciliation', recorded: false, duplicate: true };
    return { outcome: 'needs-reconciliation', recorded: true, duplicate: false };
  }
  if (activeReviewRecords({ stateDir, ...key }).length > 0) return { outcome: 'needs-reconciliation', recorded: false, duplicate: false };
  if (observation.lgtm) return { outcome: 'green', recorded: false };
  return { outcome: 'completed-without-lgtm', recorded: false };
}

function rejectReviewBatch(input) {
  const { stateDir, now = Date.now(), reason } = input;
  const key = validate(input);
  if (!Array.isArray(input.reviewIds) || input.reviewIds.length === 0) throw new Error('review-lgtm-state: reject-review-batch requires reviewIds');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('review-lgtm-state: rejection reason must be a non-empty string of at most 2000 characters');
  const reviewIds = [...new Set(input.reviewIds.map(normalizeReviewId))].sort(compareReviewIds);
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    const activeIds = activeReviewRecords({ stateDir, ...key }).map((record) => record.reviewId).sort(compareReviewIds);
    if (reviewIds.length !== activeIds.length || reviewIds.some((id, index) => id !== activeIds[index])) {
      throw new Error('review-lgtm-state: rejected reviewIds must exactly match the active review batch');
    }
    const slot = fixRoundForHead({ stateDir, ...key });
    if (slot) return { rejected: false, reason: 'fix-round-claimed', humanRequired: true, owner: latestFixOwnership({ stateDir, ...key }, slot).owner };
    if (readMarker(markerPath({ stateDir, ...key }, 'fix-round-claim'))) return { rejected: false, reason: 'abandoned-fix-claim', humanRequired: true };
    const digest = crypto.createHash('sha256').update(reviewIds.join(',')).digest('hex').slice(0, 16);
    writeExclusive(markerPath({ stateDir, ...key }, `disposition-${digest}`), { ...key, reviewIds, reason: reason.trim(), rejectedAtMs: now });
    return { rejected: true, reviewIds };
  }, { rejected: false, reason: 'transition-busy' });
}

function status(input) {
  const { stateDir } = input;
  const key = validate(input);
  const window = readMarker(markerPath({ stateDir, ...key }, 'window'));
  const retryWindow = readMarker(markerPath({ stateDir, ...key }, 'retry-window'));
  const initialClaim = requestMarkers({ stateDir, ...key }, 'initial', 'claim').sort((a, b) => (b.claimedAtMs || 0) - (a.claimedAtMs || 0))[0] || null;
  const initialRecovery = requestMarkers({ stateDir, ...key }, 'initial', 'recovery-claim')[0] || null;
  const initialRequested = requestMarkers({ stateDir, ...key }, 'initial', 'request').length > 0 || requestMarkers({ stateDir, ...key }, 'retry', 'request').length > 0;
  const observed = readMarker(markerPath({ stateDir, ...key }, 'observed'));
  for (const [kind, marker] of [['window', window], ['retry-window', retryWindow]]) {
    if (marker && (marker.pr !== key.pr || marker.headSha !== key.headSha || !Number.isSafeInteger(marker.deadlineMs))) {
      throw new Error(`review-lgtm-state: ${kind} marker does not match its PR head`);
    }
  }
  const deadlines = [window, retryWindow].filter(Boolean).map((marker) => marker.deadlineMs);
  return { deadlineMs: deadlines.length > 0 ? Math.max(...deadlines) : null, requestEligibleAtMs: observed && Number.isSafeInteger(observed.eligibleAtMs) ? observed.eligibleAtMs : null, requestBudget: requestBudget({ stateDir, pr: key.pr }), fixBudget: fixBudget({ stateDir, pr: key.pr }), waivers: fixWaivers({ stateDir, pr: key.pr }), initialClaimed: !!initialClaim, initialClaimedAtMs: initialClaim && Number.isSafeInteger(initialClaim.claimedAtMs) ? initialClaim.claimedAtMs : null, initialRecoveryClaimed: !!initialRecovery, initialRequested, reconciliation: reconciliationPacket({ stateDir, ...key }), delivery: deliveryStatus({ stateDir, ...key }) };
}

function claimFixRound(input) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const owner = input.owner || crypto.randomUUID();
  if (typeof owner !== 'string' || !owner || owner.length > 200) throw new Error('review-lgtm-state: fix-round owner must be a non-empty string of at most 200 characters');
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    const terminal = deliveryTerminal({ stateDir, ...key });
    if (terminal) return terminal;
    if (activeReviewRecords({ stateDir, ...key }).length === 0) return { claimed: false, reason: 'no-findings' };
    const slot = fixRoundForHead({ stateDir, ...key });
    if (slot) {
      const active = latestFixOwnership({ stateDir, ...key }, slot);
      if (active.owner === owner) return { claimed: true, resumed: true, owner, round: slot.round, budget: fixBudget({ stateDir, pr: key.pr }) };
      return { claimed: false, reason: 'fix-round-owned', humanRequired: true, owner: active.owner };
    }
    const budget = fixBudget({ stateDir, pr: key.pr });
    if (budget.remaining === 0) return { claimed: false, reason: 'fix-round-budget-exhausted', budget };
    const claimFile = markerPath({ stateDir, ...key }, 'fix-round-claim');
    if (!writeExclusive(claimFile, { ...key, owner, claimedAtMs: now })) return { claimed: false, reason: 'abandoned-fix-claim', humanRequired: true };
    const round = reserveFixRound({ stateDir, ...key }, now, owner);
    if (!round) return { claimed: false, reason: 'fix-round-budget-exhausted', budget: fixBudget({ stateDir, pr: key.pr }) };
    return { claimed: true, owner, round, budget: fixBudget({ stateDir, pr: key.pr }) };
  });
}

function renewFixRound(input) {
  const { stateDir, owner } = input;
  const key = validate(input);
  if (typeof owner !== 'string' || !owner) throw new Error('review-lgtm-state: renew-fix-round requires its claim owner');
  const slot = fixRoundForHead({ stateDir, ...key });
  if (!slot) return { renewed: false, reason: 'no-fix-round' };
  const active = latestFixOwnership({ stateDir, ...key }, slot);
  if (active.owner !== owner) return { renewed: false, reason: 'owner-mismatch' };
  return { renewed: true };
}

function claimRequest(input, kind) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const provider = normalizeProvider(input.provider);
  const markerKind = requestMarkerKind(kind, provider);
  const terminal = deliveryTerminal({ stateDir, ...key });
  if (terminal) return terminal;
  const currentBudget = requestBudget({ stateDir, pr: key.pr });
  if (currentBudget.remaining === 0) return { claimed: false, reason: 'request-budget-exhausted', budget: currentBudget };
  if (kind === 'initial') {
    const observedFile = markerPath({ stateDir, ...key }, 'observed');
    if (!readMarker(observedFile)) writeExclusive(observedFile, { ...key, observedAtMs: now, eligibleAtMs: now + AUTO_REVIEW_GRACE_MS });
    const observed = readMarker(observedFile);
    if (now < observed.eligibleAtMs) return { claimed: false, reason: 'auto-review-grace', eligibleAtMs: observed.eligibleAtMs };
  }
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    const lockedTerminal = deliveryTerminal({ stateDir, ...key });
    if (lockedTerminal) return lockedTerminal;
    const budget = requestBudget({ stateDir, pr: key.pr });
    if (budget.remaining === 0) return { claimed: false, reason: 'request-budget-exhausted', budget };
    const claimed = writeExclusive(markerPath({ stateDir, ...key }, `${markerKind}-claim`), { ...key, kind, provider, claimed: true, claimedAtMs: now });
    if (!claimed) return false;
    if (reserveRequestSlot({ stateDir, ...key }, kind, now, provider, true)) return true;
    return { claimed: false, reason: 'request-budget-exhausted', budget: requestBudget({ stateDir, pr: key.pr }) };
  });
}

function markRequest(input, kind) {
  const { stateDir } = input;
  const key = validate(input);
  const provider = normalizeProvider(input.provider);
  return writeExclusive(markerPath({ stateDir, ...key }, `${requestMarkerKind(kind, provider)}-request`), { ...key, kind, provider, requested: true });
}

function claimInitialRequest(input) { return claimRequest(input, 'initial'); }
function markInitialRequested(input) { return markRequest(input, 'initial'); }

function recoverRequest(input, kind) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const provider = normalizeProvider(input.provider);
  const markerKind = requestMarkerKind(kind, provider);
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    const terminal = deliveryTerminal({ stateDir, ...key });
    if (terminal) return terminal;
    const claim = readMarker(markerPath({ stateDir, ...key }, `${markerKind}-claim`));
    const recovery = latestRecoveryClaim({ stateDir, ...key }, markerKind);
    const claimedAtMs = Math.max(...[claim, recovery].map((marker) => marker && marker.claimedAtMs).filter(Number.isSafeInteger));
    if (!Number.isSafeInteger(claimedAtMs) || now < claimedAtMs + INITIAL_CLAIM_LEASE_MS) return false;
    if (readMarker(markerPath({ stateDir, ...key }, `${markerKind}-request`))) return false;
    const budget = requestBudget({ stateDir, pr: key.pr });
    if (budget.remaining === 0) return { claimed: false, reason: 'request-budget-exhausted', budget };
    const recoveryFile = markerPath({ stateDir, ...key }, `${markerKind}-recovery-claim-${claimedAtMs + INITIAL_CLAIM_LEASE_MS}`);
    if (!writeExclusive(recoveryFile, { ...key, kind: `${kind}-recovery`, provider, claimed: true, claimedAtMs: now })) return false;
    if (reserveRequestSlot({ stateDir, ...key }, kind, now, provider)) return true;
    return { claimed: false, reason: 'request-budget-exhausted', budget: requestBudget({ stateDir, pr: key.pr }) };
  });
}

function recoverInitialRequest(input) { return recoverRequest(input, 'initial'); }

function openWindow(input, kind = 'window') {
  const { stateDir, now = Date.now(), durationMs } = input;
  const key = validate(input);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('review-lgtm-state: duration must be a positive integer in milliseconds');
  const file = markerPath({ stateDir, ...key }, kind);
  const deadlineMs = now + durationMs;
  if (writeExclusive(file, { ...key, deadlineMs })) return { created: true, deadlineMs };
  const existing = readMarker(file);
  if (!existing || existing.pr !== key.pr || existing.headSha !== key.headSha || !Number.isSafeInteger(existing.deadlineMs)) throw new Error(`review-lgtm-state: ${kind} marker disappeared while opening`);
  return { created: false, deadlineMs: existing.deadlineMs };
}

function claimResult(result) {
  return typeof result === 'object' ? result : { claimed: result };
}

// Delivery disposition: one classification of an exact PR revision pair once
// review collection is terminal (docs/design/delivery-disposition.md).
const RELEASE_BLOCKING = new Set(['acceptance-criterion', 'required-check', 'correctness', 'security', 'data-integrity', 'contract-choice', 'compatibility', 'contradictory-docs', 'unproven-premise', 'stage-exit']);
const DISPOSITIONS = new Set(['fixed', 'follow-up', 'accepted', 'blocking']);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function validatePacket(packet) {
  if (!packet || typeof packet !== 'object') throw new Error('review-lgtm-state: delivery packet must be an object');
  if (!FULL_SHA.test(String(packet.baseSha))) throw new Error('review-lgtm-state: delivery baseSha must be a full SHA');
  if (!/^[0-9a-f]{64}$/i.test(String(packet.contractDigest))) throw new Error('review-lgtm-state: delivery contractDigest must be a SHA-256 hex digest');
  for (const field of ['reviewIds', 'acceptance', 'requiredChecks', 'openChoices', 'findings', 'tickets']) {
    if (!Array.isArray(packet[field])) throw new Error(`review-lgtm-state: delivery ${field} must be an array`);
  }
  if (typeof packet.reviewsTerminal !== 'boolean') throw new Error('review-lgtm-state: delivery reviewsTerminal must be a boolean');
  const unique = (entries, field, label) => {
    const seen = new Set();
    for (const entry of entries) {
      const value = text(entry?.[field]);
      if (!value) throw new Error(`review-lgtm-state: delivery ${label} needs ${field}`);
      if (seen.has(value)) throw new Error(`review-lgtm-state: duplicate ${label} ${field} ${value}`);
      seen.add(value);
    }
  };
  unique(packet.acceptance, 'id', 'acceptance');
  unique(packet.requiredChecks, 'name', 'required check');
  for (const check of packet.requiredChecks) if (!text(check.conclusion)) throw new Error(`review-lgtm-state: delivery required check ${text(check.name)} needs conclusion`);
  for (const choice of packet.openChoices) if (!text(choice)) throw new Error('review-lgtm-state: delivery openChoices entries must be non-empty strings');
  unique(packet.findings, 'id', 'finding');
  unique(packet.tickets, 'rootCause', 'ticket');
  if (!packet.reviewIds.every((id) => /^[0-9]+$/.test(String(id)))) throw new Error('review-lgtm-state: delivery reviewIds must be review ids');
  for (const finding of packet.findings) {
    if (finding.releaseBlocking != null && !Array.isArray(finding.releaseBlocking)) throw new Error(`review-lgtm-state: delivery finding ${text(finding.id)} releaseBlocking must be an array`);
    if (!text(finding.url)) throw new Error('review-lgtm-state: delivery finding needs id and url');
    if (finding.disposition != null && !DISPOSITIONS.has(finding.disposition)) throw new Error(`review-lgtm-state: unknown disposition ${JSON.stringify(finding.disposition)}`);
    for (const category of finding.releaseBlocking || []) {
      if (!RELEASE_BLOCKING.has(category)) throw new Error(`review-lgtm-state: unknown release-blocking category ${JSON.stringify(category)}`);
    }
  }
}

function classifyDelivery(raw) {
  const key = validate(raw);
  validatePacket(raw);
  const input = canonicalPacket(raw);
  const reasons = [];
  if (input.acceptance.length === 0) reasons.push('acceptance-missing');
  for (const ac of input.acceptance) if (ac.met !== true) reasons.push(`acceptance-unmet:${ac.id}`);
  for (const check of input.requiredChecks) if (check.conclusion !== 'success') reasons.push(`required-check:${check.name}:${check.conclusion}`);
  if (!input.reviewsTerminal) reasons.push('reviews-not-terminal');
  for (const choice of input.openChoices) reasons.push(`open-choice:${choice}`);

  const followUps = new Map();
  for (const finding of input.findings) {
    const { id, disposition } = finding;
    if (!disposition || (disposition === 'accepted' && !text(finding.acceptedBy))) reasons.push(`unowned:${id}`);
    else if (disposition === 'blocking') reasons.push(`blocking:${id}`);
    if (disposition !== 'fixed') for (const category of finding.releaseBlocking || []) reasons.push(`release-blocker:${id}:${category}`);
    if (disposition !== 'follow-up') continue;
    const rootCause = text(finding.rootCause);
    if (!rootCause) { reasons.push(`unowned:${id}`); continue; }
    if (!text(finding.rationale)) reasons.push(`no-rationale:${id}`);
    if (!followUps.has(rootCause)) followUps.set(rootCause, []);
    followUps.get(rootCause).push(finding);
  }

  const tickets = new Map();
  const owners = new Map();
  for (const ticket of input.tickets) {
    const rootCause = text(ticket?.rootCause);
    if (!text(ticket.url)) throw new Error('review-lgtm-state: delivery tickets need one rootCause and url each');
    tickets.set(rootCause, ticket);
    if (!followUps.has(rootCause)) reasons.push(`ticket-without-findings:${rootCause}`);
    if (owners.has(ticket.url)) reasons.push(`ticket-shared:${ticket.url}`);
    owners.set(ticket.url, rootCause);
  }

  const groups = [];
  const pending = [];
  for (const [rootCause, members] of followUps) {
    const ticket = tickets.get(rootCause);
    const findingIds = members.map((finding) => finding.id);
    groups.push({ rootCause, ticket: ticket ? ticket.url : null, findingIds });
    if (!ticket) {
      reasons.push(`rollover-pending:${rootCause}`);
      pending.push({ rootCause, findingIds, urls: members.map((finding) => finding.url), rationales: members.map((finding) => text(finding.rationale)) });
      continue;
    }
    if (ticket.readBack !== true) reasons.push(`ticket-unread:${rootCause}`);
    if (ticket.reused && !text(ticket.duplicateCheck)) reasons.push(`duplicate-unchecked:${rootCause}`);
  }

  const residual = input.findings.some((finding) => finding.disposition !== 'fixed');
  const classification = reasons.length > 0 ? 'blocked' : residual ? 'mergeable-with-follow-ups' : 'mergeable-clean';
  const findings = input.findings.map((finding) => ({
    id: finding.id, url: finding.url, disposition: finding.disposition || null,
    rootCause: finding.rootCause || null, releaseBlocking: finding.releaseBlocking, rationale: finding.rationale || null, acceptedBy: finding.acceptedBy || null,
    ticket: finding.disposition === 'follow-up' ? tickets.get(text(finding.rootCause))?.url || null : null,
  }));
  return { pr: key.pr, headSha: key.headSha, baseSha: String(input.baseSha).toLowerCase(), contractDigest: String(input.contractDigest).toLowerCase(), classification, reasons, findings, groups, pending, requiredChecks: input.requiredChecks.map(({ name, conclusion }) => ({ name, conclusion })) };
}

// The digest covers only the fields the contract defines, in a fixed key
// order, so key order, extra fields, SHA case and padding do not change it.
function canonicalPacket(packet) {
  return {
    baseSha: String(packet.baseSha).toLowerCase(),
    contractDigest: String(packet.contractDigest).toLowerCase(),
    reviewIds: [...new Set(packet.reviewIds.map(normalizeReviewId))].sort(compareReviewIds),
    acceptance: packet.acceptance.map((ac) => ({ id: text(ac.id), met: ac.met === true })),
    requiredChecks: packet.requiredChecks.map((check) => ({ name: text(check.name), conclusion: text(check.conclusion) })),
    reviewsTerminal: packet.reviewsTerminal,
    openChoices: packet.openChoices.map(text),
    findings: packet.findings.map((f) => ({ id: text(f.id), url: text(f.url), disposition: f.disposition || null, rootCause: text(f.rootCause), releaseBlocking: [...(f.releaseBlocking || [])].sort(), rationale: text(f.rationale), acceptedBy: text(f.acceptedBy) })),
    tickets: packet.tickets.map((t) => ({ rootCause: text(t.rootCause), url: text(t.url), readBack: t.readBack === true, reused: !!t.reused, duplicateCheck: text(t.duplicateCheck) })),
  };
}

// Records are ordered by a sequence number assigned under the PR transition
// lock, not by wall-clock time.
function deliveryRecords({ stateDir, pr, headSha }) {
  const prefix = `pr-${pr}-${headSha}.delivery-`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((record) => record && record.pr === pr && record.headSha === headSha && Number.isSafeInteger(record.sequence))
    .sort((a, b) => a.sequence - b.sequence);
}

function deliveryStatus(input) {
  const latest = latestDelivery(input);
  return latest && { ...latest, current: deliveryCurrent(input, latest) };
}

function latestDelivery(input) {
  return deliveryRecords(input).at(-1) || null;
}

function activeReviewIds(input) {
  return activeReviewRecords(input).map((record) => record.reviewId).sort(compareReviewIds);
}

// A record covers only the review batch active when it was written; a review
// recorded or rejected later is new evidence and lifts the terminal state.
function deliveryCurrent(input, record) {
  return !!record && JSON.stringify(record.reviewIds) === JSON.stringify(activeReviewIds(input));
}

function deliveryTerminal(input) {
  const latest = latestDelivery(input);
  return latest && latest.classification !== 'blocked' && deliveryCurrent(input, latest) ? { claimed: false, reason: 'delivery-terminal', classification: latest.classification } : null;
}

function recordDelivery(input) {
  const { stateDir, now = Date.now(), packet } = input;
  const key = validate(input);
  const classified = classifyDelivery({ ...packet, ...key });
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonicalPacket(packet))).digest('hex');
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    if (fixRoundForHead({ stateDir, ...key })) return { recorded: false, reason: 'fix-round-open' };
    const records = deliveryRecords({ stateDir, ...key });
    const latest = records.at(-1);
    const reviewIds = activeReviewIds({ stateDir, ...key });
    const observed = canonicalPacket(packet).reviewIds;
    if (JSON.stringify(observed) !== JSON.stringify(reviewIds)) return { recorded: false, reason: 'review-batch-changed', reviewIds };
    if (latest && latest.digest === digest && deliveryCurrent({ stateDir, ...key }, latest)) return latest;
    const sequence = (latest ? latest.sequence : 0) + 1;
    const record = { ...classified, reviewIds, digest, sequence, recordedAtMs: now, budgets: { request: requestBudget({ stateDir, pr: key.pr }), fix: fixBudget({ stateDir, pr: key.pr }) } };
    if (!writeExclusive(markerPath({ stateDir, ...key }, `delivery-${String(sequence).padStart(6, '0')}`), record)) throw new Error('review-lgtm-state: delivery record collided; retry');
    return record;
  }, { recorded: false, reason: 'transition-busy' });
}

// Answers whether the fix commit(s) between the head of the latest earlier fix round and `headSha`
// added lines that overlap [start, end] of `file`. Uses only the path and line numbers, never the review text.
function selfFeeding({ repoRoot, stateDir, pr, headSha, file, start, end }) {
  const key = validate({ pr, headSha });
  if (typeof file !== 'string' || !file || file.startsWith('-') || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('review-lgtm-state: file must be a relative path inside the repository');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('review-lgtm-state: line range must be positive integers with start <= end');
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const git = crossPlatformCommand('git', repoRoot);
  const run = (args) => execFileSync(git, crossPlatformArgs(['--literal-pathspecs', ...args], needsDoubleEscape('git', repoRoot)), crossPlatformOpts({ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const isAncestor = (sha) => { try { run(['merge-base', '--is-ancestor', sha, key.headSha]); return true; } catch (_) { return false; } };
  const previous = names.filter((name) => name.startsWith(`pr-${key.pr}.fix-round-slot-`) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((marker) => marker && FULL_SHA.test(String(marker.headSha)) && marker.headSha !== key.headSha)
    .sort((a, b) => (b.claimedAtMs || 0) - (a.claimedAtMs || 0))
    .find((marker) => isAncestor(marker.headSha));
  if (!previous) return { selfFeeding: false, previousFixHead: null };
  const diff = run(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', `${previous.headSha}..${key.headSha}`, '--', file]);
  const overlaps = diff.split('\n').some((line) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) return false;
    const first = Number(hunk[1]);
    const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    return length > 0 && first <= end && first + length - 1 >= start;
  });
  return { selfFeeding: overlaps, previousFixHead: previous.headSha };
}

function runMain(repoRoot = process.cwd()) {
  const [verb, pr, headSha, argument] = process.argv.slice(2);
  const stateDir = defaultStateDir(repoRoot);
  if (verb === 'status') process.stdout.write(`${JSON.stringify(status({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'open-window') process.stdout.write(`${JSON.stringify(openWindow({ stateDir, pr, headSha, durationMs: Number(argument) * 1000 }))}\n`);
  else if (verb === 'claim-initial-request') process.stdout.write(`${JSON.stringify(claimResult(claimInitialRequest({ stateDir, pr, headSha, provider: argument })))}\n`);
  else if (verb === 'recover-initial-request') process.stdout.write(`${JSON.stringify(claimResult(recoverInitialRequest({ stateDir, pr, headSha, provider: argument })))}\n`);
  else if (verb === 'mark-initial-requested') process.stdout.write(`${JSON.stringify({ marked: markInitialRequested({ stateDir, pr, headSha, provider: argument }) })}\n`);
  else if (verb === 'claim-fix-round') process.stdout.write(`${JSON.stringify(claimFixRound({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'renew-fix-round') process.stdout.write(`${JSON.stringify(renewFixRound({ stateDir, pr, headSha, owner: argument }))}\n`);
  else if (verb === 'waive-fix-budget') process.stdout.write(`${JSON.stringify(waiveFixBudget({ stateDir, pr, person: headSha, count: Number(argument) }))}\n`);
  else if (verb === 'self-feeding') { const [start, end] = process.argv.slice(6); process.stdout.write(`${JSON.stringify(selfFeeding({ repoRoot, stateDir, pr, headSha, file: argument, start: Number(start), end: Number(end === undefined ? start : end) }))}\n`); }
  else if (verb === 'record-review') process.stdout.write(`${JSON.stringify(recordReview({ stateDir, pr, headSha, observation: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'record-delivery') process.stdout.write(`${JSON.stringify(recordDelivery({ stateDir, pr, headSha, packet: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'reject-review-batch') process.stdout.write(`${JSON.stringify(rejectReviewBatch({ stateDir, pr, headSha, ...JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else throw new Error('review-lgtm-state: use status, open-window, claim-initial-request, recover-initial-request, mark-initial-requested, claim-fix-round, renew-fix-round, waive-fix-budget, self-feeding, record-review, reject-review-batch, or record-delivery');
}

module.exports = { defaultStateDir, markerPath, status, openWindow, claimInitialRequest, recoverInitialRequest, markInitialRequested, claimFixRound, renewFixRound, waiveFixBudget, selfFeeding, recordReview, rejectReviewBatch, classifyDelivery, recordDelivery, INITIAL_CLAIM_LEASE_MS, AUTO_REVIEW_GRACE_MS, MAX_REQUESTS_PER_PR, MAX_FIX_ROUNDS_PER_PR, runMain };
