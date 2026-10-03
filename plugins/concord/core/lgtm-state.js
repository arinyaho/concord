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

function requestBudget({ stateDir, pr }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const keyPrefix = `pr-${Number(pr)}`;
  const requests = new Set();
  for (const name of names) {
    if (name.startsWith(`${keyPrefix}.request-slot-`) && name.endsWith('.json')) {
      const marker = readMarker(path.join(stateDir, name));
      requests.add(marker && FULL_SHA.test(marker.headSha) && ['initial', 'retry'].includes(marker.kind) ? `${marker.headSha.toLowerCase()}:${marker.kind}` : `slot:${name}`);
      continue;
    }
    const match = name.match(new RegExp(`^${keyPrefix}-([0-9a-f]{40}|[0-9a-f]{64})\\.(initial|retry)-request\\.json$`, 'i'));
    if (match) requests.add(`${match[1].toLowerCase()}:${match[2].toLowerCase()}`);
  }
  const spent = requests.size;
  return { max: MAX_REQUESTS_PER_PR, spent, remaining: Math.max(0, MAX_REQUESTS_PER_PR - spent) };
}

function reserveRequestSlot({ stateDir, pr, headSha }, kind, now) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const slotIdentities = new Set(names.filter((name) => name.startsWith(`pr-${pr}.request-slot-`) && name.endsWith('.json')).map((name) => {
    const marker = readMarker(path.join(stateDir, name));
    return marker && FULL_SHA.test(marker.headSha) && ['initial', 'retry'].includes(marker.kind) ? `${marker.headSha.toLowerCase()}:${marker.kind}` : `slot:${name}`;
  }));
  const legacyOnly = requestBudget({ stateDir, pr }).spent - slotIdentities.size;
  for (let slot = 1; slot <= MAX_REQUESTS_PER_PR - legacyOnly; slot += 1) {
    const file = path.join(stateDir, `pr-${pr}.request-slot-${slot}.json`);
    if (writeExclusive(file, { pr, headSha, kind, claimedAtMs: now })) return slot;
  }
  return null;
}

function fixBudget({ stateDir, pr }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const spent = names.filter((name) => name.startsWith(`pr-${Number(pr)}.fix-round-slot-`) && name.endsWith('.json')).length;
  return { max: MAX_FIX_ROUNDS_PER_PR, spent, remaining: Math.max(0, MAX_FIX_ROUNDS_PER_PR - spent) };
}

function reserveFixRound({ stateDir, pr, headSha }, now) {
  for (let round = 1; round <= MAX_FIX_ROUNDS_PER_PR; round += 1) {
    const file = path.join(stateDir, `pr-${pr}.fix-round-slot-${round}.json`);
    if (writeExclusive(file, { pr, headSha, claimedAtMs: now })) return round;
  }
  return null;
}

function fixRoundForHead({ stateDir, pr, headSha }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names.filter((name) => name.startsWith(`pr-${pr}.fix-round-slot-`) && name.endsWith('.json'))) {
    const marker = readMarker(path.join(stateDir, name));
    if (marker && marker.pr === pr && marker.headSha === headSha) return marker;
  }
  return null;
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

// ponytail: linear directory scan per read; fine at this marker-directory scale, switch to an index file if a PR head accumulates many reviews.
function reviewRecords({ stateDir, pr, headSha }) {
  const prefix = `pr-${pr}-${headSha}.review-`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((record) => record && record.pr === pr && record.headSha === headSha);
}

function compareReviewIds(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function reconciliationPacket({ stateDir, pr, headSha }) {
  const records = reviewRecords({ stateDir, pr, headSha })
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs || compareReviewIds(a.reviewId, b.reviewId));
  if (records.length === 0) return null;
  const reviews = records.map((record) => ({ id: record.reviewId, reviewer: record.reviewer, url: record.reviewUrl, findings: record.findings }));
  const findings = records.flatMap((record) => record.findings);
  const p1Count = findings.filter((finding) => finding.priority === 'P1').length;
  const p2Count = findings.filter((finding) => finding.priority === 'P2').length;
  const signals = [...new Set(findings.flatMap((finding) => finding.signals))].sort();
  const classification = (p1Count > 0 || records.length >= 2 || signals.length > 0) ? 'requires-architecture-review' : 'light-implementation-eligible';
  return { pr, headSha, reviews, batchCount: records.length, p1Count, p2Count, signals, classification, choices: ['resume', 'revise', 'split', 'defer'], requires: 'human decision or new head' };
}

function recordReview(input) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const observation = validateObservation(input.observation);
  if (observation.commitId !== key.headSha) return { outcome: 'stale', recorded: false };
  if (observation.state === 'in-progress') return { outcome: 'in-progress', recorded: false };
  if (observation.findings.length > 0) {
    const file = markerPath({ stateDir, ...key }, `review-${observation.reviewId}`);
    if (readMarker(file)) return { outcome: 'needs-reconciliation', recorded: false, duplicate: true };
    const written = writeExclusive(file, { pr: key.pr, headSha: key.headSha, reviewId: observation.reviewId, reviewer: observation.reviewer, reviewUrl: observation.reviewUrl, recordedAtMs: now, findings: observation.findings });
    if (!written) return { outcome: 'needs-reconciliation', recorded: false, duplicate: true };
    return { outcome: 'needs-reconciliation', recorded: true, duplicate: false };
  }
  if (reviewRecords({ stateDir, ...key }).length > 0) return { outcome: 'needs-reconciliation', recorded: false, duplicate: false };
  if (observation.lgtm) return { outcome: 'green', recorded: false };
  return { outcome: 'completed-without-lgtm', recorded: false };
}

function status(input) {
  const { stateDir } = input;
  const key = validate(input);
  const window = readMarker(markerPath({ stateDir, ...key }, 'window'));
  const initialClaim = readMarker(markerPath({ stateDir, ...key }, 'initial-claim'));
  const initialRecovery = latestRecoveryClaim({ stateDir, ...key }, 'initial');
  const initialRequest = readMarker(markerPath({ stateDir, ...key }, 'initial-request'));
  const observed = readMarker(markerPath({ stateDir, ...key }, 'observed'));
  if (window && (window.pr !== key.pr || window.headSha !== key.headSha || !Number.isSafeInteger(window.deadlineMs))) {
    throw new Error('review-lgtm-state: window marker does not match its PR head');
  }
  return { deadlineMs: window ? window.deadlineMs : null, requestEligibleAtMs: observed && Number.isSafeInteger(observed.eligibleAtMs) ? observed.eligibleAtMs : null, requestBudget: requestBudget({ stateDir, pr: key.pr }), fixBudget: fixBudget({ stateDir, pr: key.pr }), initialClaimed: !!initialClaim, initialClaimedAtMs: initialClaim && Number.isSafeInteger(initialClaim.claimedAtMs) ? initialClaim.claimedAtMs : null, initialRecoveryClaimed: !!initialRecovery, initialRequested: !!initialRequest, reconciliation: reconciliationPacket({ stateDir, ...key }) };
}

function claimFixRound(input) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  if (reviewRecords({ stateDir, ...key }).length === 0) return { claimed: false, reason: 'no-findings' };
  if (fixRoundForHead({ stateDir, ...key })) return { claimed: false, reason: 'already-claimed', budget: fixBudget({ stateDir, pr: key.pr }) };
  const claimFile = markerPath({ stateDir, ...key }, 'fix-round-claim');
  const claimed = writeExclusive(claimFile, { ...key, claimedAtMs: now });
  if (!claimed) {
    const claim = readMarker(claimFile);
    const recovery = latestRecoveryClaim({ stateDir, ...key }, 'fix-round');
    const claimedAtMs = Math.max(...[claim, recovery].map((marker) => marker && marker.claimedAtMs).filter(Number.isSafeInteger));
    if (!Number.isSafeInteger(claimedAtMs)) throw new Error('review-lgtm-state: fix-round claim has no valid timestamp');
    const eligibleAtMs = claimedAtMs + INITIAL_CLAIM_LEASE_MS;
    if (now < eligibleAtMs) return { claimed: false, reason: 'claim-in-progress', eligibleAtMs };
    if (!writeExclusive(markerPath({ stateDir, ...key }, `fix-round-recovery-claim-${eligibleAtMs}`), { ...key, claimedAtMs: now })) {
      const activeRecovery = latestRecoveryClaim({ stateDir, ...key }, 'fix-round');
      return { claimed: false, reason: 'claim-in-progress', eligibleAtMs: activeRecovery.claimedAtMs + INITIAL_CLAIM_LEASE_MS };
    }
  }
  const round = reserveFixRound({ stateDir, ...key }, now);
  if (!round) return { claimed: false, reason: 'fix-round-budget-exhausted', budget: fixBudget({ stateDir, pr: key.pr }) };
  return { claimed: true, round, budget: fixBudget({ stateDir, pr: key.pr }) };
}

function claimRequest(input, kind) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  if (reviewRecords({ stateDir, ...key }).length > 0) return { claimed: false, reason: 'needs-reconciliation' };
  if (kind === 'initial') {
    const observedFile = markerPath({ stateDir, ...key }, 'observed');
    if (!readMarker(observedFile)) writeExclusive(observedFile, { ...key, observedAtMs: now, eligibleAtMs: now + AUTO_REVIEW_GRACE_MS });
    const observed = readMarker(observedFile);
    if (now < observed.eligibleAtMs) return { claimed: false, reason: 'auto-review-grace', eligibleAtMs: observed.eligibleAtMs };
  }
  const claimed = writeExclusive(markerPath({ stateDir, ...key }, `${kind}-claim`), { ...key, kind, claimed: true, claimedAtMs: now });
  if (!claimed) return false;
  if (reserveRequestSlot({ stateDir, ...key }, kind, now)) return true;
  return { claimed: false, reason: 'request-budget-exhausted', budget: requestBudget({ stateDir, pr: key.pr }) };
}

function markRequest(input, kind) {
  const { stateDir } = input;
  const key = validate(input);
  return writeExclusive(markerPath({ stateDir, ...key }, `${kind}-request`), { ...key, kind, requested: true });
}

function claimInitialRequest(input) { return claimRequest(input, 'initial'); }
function markInitialRequested(input) { return markRequest(input, 'initial'); }

function recoverRequest(input, kind) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  if (reviewRecords({ stateDir, ...key }).length > 0) return { claimed: false, reason: 'needs-reconciliation' };
  const claim = readMarker(markerPath({ stateDir, ...key }, `${kind}-claim`));
  const recovery = latestRecoveryClaim({ stateDir, ...key }, kind);
  const claimedAtMs = Math.max(...[claim, recovery].map((marker) => marker && marker.claimedAtMs).filter(Number.isSafeInteger));
  if (!Number.isSafeInteger(claimedAtMs) || now < claimedAtMs + INITIAL_CLAIM_LEASE_MS) return false;
  if (readMarker(markerPath({ stateDir, ...key }, `${kind}-request`))) return false;
  const slot = (() => {
    let names;
    try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return names.filter((name) => name.startsWith(`pr-${key.pr}.request-slot-`)).map((name) => readMarker(path.join(stateDir, name)))
      .find((marker) => marker && marker.headSha === key.headSha && marker.kind === kind);
  })();
  if (!slot && !reserveRequestSlot({ stateDir, ...key }, kind, now)) {
    return { claimed: false, reason: 'request-budget-exhausted', budget: requestBudget({ stateDir, pr: key.pr }) };
  }
  return writeExclusive(markerPath({ stateDir, ...key }, `${kind}-recovery-claim-${claimedAtMs + INITIAL_CLAIM_LEASE_MS}`), { ...key, kind: `${kind}-recovery`, claimed: true, claimedAtMs: now });
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

function runMain(repoRoot = process.cwd()) {
  const [verb, pr, headSha, seconds] = process.argv.slice(2);
  const stateDir = defaultStateDir(repoRoot);
  if (verb === 'status') process.stdout.write(`${JSON.stringify(status({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'open-window') process.stdout.write(`${JSON.stringify(openWindow({ stateDir, pr, headSha, durationMs: Number(seconds) * 1000 }))}\n`);
  else if (verb === 'claim-initial-request') process.stdout.write(`${JSON.stringify(claimResult(claimInitialRequest({ stateDir, pr, headSha })))}\n`);
  else if (verb === 'recover-initial-request') process.stdout.write(`${JSON.stringify(claimResult(recoverInitialRequest({ stateDir, pr, headSha })))}\n`);
  else if (verb === 'mark-initial-requested') process.stdout.write(`${JSON.stringify({ marked: markInitialRequested({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'claim-fix-round') process.stdout.write(`${JSON.stringify(claimFixRound({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'record-review') process.stdout.write(`${JSON.stringify(recordReview({ stateDir, pr, headSha, observation: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else throw new Error('review-lgtm-state: use status, open-window, claim-initial-request, recover-initial-request, mark-initial-requested, claim-fix-round, or record-review');
}

module.exports = { defaultStateDir, markerPath, status, openWindow, claimInitialRequest, recoverInitialRequest, markInitialRequested, claimFixRound, recordReview, INITIAL_CLAIM_LEASE_MS, AUTO_REVIEW_GRACE_MS, MAX_REQUESTS_PER_PR, MAX_FIX_ROUNDS_PER_PR, runMain };
