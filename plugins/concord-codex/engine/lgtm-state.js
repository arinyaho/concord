'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('./spawn-cross-platform');

// External review requests are bounded by the same 15-minute window as review
// observation, so a recovery cannot overlap a live request invocation.
const INITIAL_CLAIM_LEASE_MS = 15 * 60 * 1000;

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
  if (typeof reviewId === 'string' && /^[0-9]+$/.test(reviewId)) return reviewId;
  if (typeof reviewId === 'number' && Number.isSafeInteger(reviewId) && reviewId > 0) return String(reviewId);
  throw new Error('review-lgtm-state: reviewId must be a positive safe integer or decimal digits');
}

function validateObservation(observation) {
  if (!observation || typeof observation !== 'object') throw new Error('review-lgtm-state: observation must be an object');
  const { reviewId, reviewUrl, commitId, state, lgtm, findings } = observation;
  const normalizedReviewId = normalizeReviewId(reviewId);
  if (typeof reviewUrl !== 'string' || !reviewUrl) throw new Error('review-lgtm-state: reviewUrl is required');
  if (typeof commitId !== 'string' || !FULL_SHA.test(commitId)) throw new Error('review-lgtm-state: commitId must be a full 40- or 64-character hexadecimal SHA (the review commit_id)');
  if (state !== 'completed' && state !== 'in-progress') throw new Error('review-lgtm-state: state must be completed or in-progress');
  if (typeof lgtm !== 'boolean') throw new Error('review-lgtm-state: lgtm is required and must be a boolean');
  if (!Array.isArray(findings)) throw new Error('review-lgtm-state: findings is required and must be an array');
  return { reviewId: normalizedReviewId, reviewUrl, commitId: commitId.toLowerCase(), state, lgtm, findings: findings.map(validateFinding) };
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
  const reviews = records.map((record) => ({ id: record.reviewId, url: record.reviewUrl, findings: record.findings }));
  const findings = records.flatMap((record) => record.findings);
  const p1Count = findings.filter((finding) => finding.priority === 'P1').length;
  const p2Count = findings.filter((finding) => finding.priority === 'P2').length;
  const signals = [...new Set(findings.flatMap((finding) => finding.signals))].sort();
  const classification = (p1Count > 0 || records.length >= 2 || signals.length > 0) ? 'requires-architecture-review' : 'light-implementation-eligible';
  return { pr, headSha, reviews, batchCount: records.length, p1Count, p2Count, signals, classification, retryEligible: false, choices: ['resume', 'revise', 'split', 'defer'], requires: 'human decision or new head' };
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
    const written = writeExclusive(file, { pr: key.pr, headSha: key.headSha, reviewId: observation.reviewId, reviewUrl: observation.reviewUrl, recordedAtMs: now, findings: observation.findings });
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
  const retryWindow = readMarker(markerPath({ stateDir, ...key }, 'retry-window'));
  const initialClaim = readMarker(markerPath({ stateDir, ...key }, 'initial-claim'));
  const initialRecovery = latestRecoveryClaim({ stateDir, ...key }, 'initial');
  const initialRequest = readMarker(markerPath({ stateDir, ...key }, 'initial-request'));
  const retry = readMarker(markerPath({ stateDir, ...key }, 'retry-claim'));
  const retryRequest = readMarker(markerPath({ stateDir, ...key }, 'retry-request'));
  if (window && (window.pr !== key.pr || window.headSha !== key.headSha || !Number.isSafeInteger(window.deadlineMs))) {
    throw new Error('review-lgtm-state: window marker does not match its PR head');
  }
  if (retryWindow && (retryWindow.pr !== key.pr || retryWindow.headSha !== key.headSha || !Number.isSafeInteger(retryWindow.deadlineMs))) {
    throw new Error('review-lgtm-state: retry window marker does not match its PR head');
  }
  return { deadlineMs: window ? window.deadlineMs : null, retryDeadlineMs: retryWindow ? retryWindow.deadlineMs : null, initialClaimed: !!initialClaim, initialClaimedAtMs: initialClaim && Number.isSafeInteger(initialClaim.claimedAtMs) ? initialClaim.claimedAtMs : null, initialRecoveryClaimed: !!initialRecovery, initialRequested: !!initialRequest, retryClaimed: !!retry, retryClaimedAtMs: retry && Number.isSafeInteger(retry.claimedAtMs) ? retry.claimedAtMs : null, retryRequested: !!retryRequest, reconciliation: reconciliationPacket({ stateDir, ...key }) };
}

function claimRequest(input, kind) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  if (reviewRecords({ stateDir, ...key }).length > 0) return { claimed: false, reason: 'needs-reconciliation' };
  return writeExclusive(markerPath({ stateDir, ...key }, `${kind}-claim`), { ...key, kind, claimed: true, claimedAtMs: now });
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
  const claimedAtMs = Math.max(claim && claim.claimedAtMs, recovery && recovery.claimedAtMs);
  if (!Number.isSafeInteger(claimedAtMs) || now < claimedAtMs + INITIAL_CLAIM_LEASE_MS) return false;
  if (readMarker(markerPath({ stateDir, ...key }, `${kind}-request`))) return false;
  return writeExclusive(markerPath({ stateDir, ...key }, `${kind}-recovery-claim-${claimedAtMs + INITIAL_CLAIM_LEASE_MS}`), { ...key, kind: `${kind}-recovery`, claimed: true, claimedAtMs: now });
}

function recoverInitialRequest(input) { return recoverRequest(input, 'initial'); }
function recoverRetryRequest(input) { return recoverRequest(input, 'retry'); }

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

function openRetryWindow(input) { return openWindow(input, 'retry-window'); }

function claimRetry(input) {
  return claimRequest(input, 'retry');
}

function markRetryRequested(input) { return markRequest(input, 'retry'); }

function claimResult(result) {
  return typeof result === 'object' ? result : { claimed: result };
}

function runMain(repoRoot = process.cwd()) {
  const [verb, pr, headSha, seconds] = process.argv.slice(2);
  const stateDir = defaultStateDir(repoRoot);
  if (verb === 'status') process.stdout.write(`${JSON.stringify(status({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'open-window') process.stdout.write(`${JSON.stringify(openWindow({ stateDir, pr, headSha, durationMs: Number(seconds) * 1000 }))}\n`);
  else if (verb === 'open-retry-window') process.stdout.write(`${JSON.stringify(openRetryWindow({ stateDir, pr, headSha, durationMs: Number(seconds) * 1000 }))}\n`);
  else if (verb === 'claim-retry') process.stdout.write(`${JSON.stringify(claimResult(claimRetry({ stateDir, pr, headSha })))}\n`);
  else if (verb === 'mark-retry-requested') process.stdout.write(`${JSON.stringify({ marked: markRetryRequested({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'claim-initial-request') process.stdout.write(`${JSON.stringify(claimResult(claimInitialRequest({ stateDir, pr, headSha })))}\n`);
  else if (verb === 'recover-initial-request') process.stdout.write(`${JSON.stringify(claimResult(recoverInitialRequest({ stateDir, pr, headSha })))}\n`);
  else if (verb === 'recover-retry-request') process.stdout.write(`${JSON.stringify(claimResult(recoverRetryRequest({ stateDir, pr, headSha })))}\n`);
  else if (verb === 'mark-initial-requested') process.stdout.write(`${JSON.stringify({ marked: markInitialRequested({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'record-review') process.stdout.write(`${JSON.stringify(recordReview({ stateDir, pr, headSha, observation: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else throw new Error('review-lgtm-state: use status, open-window, open-retry-window, claim-retry, recover-retry-request, mark-retry-requested, claim-initial-request, recover-initial-request, mark-initial-requested, or record-review');
}

module.exports = { defaultStateDir, markerPath, status, openWindow, openRetryWindow, claimInitialRequest, recoverInitialRequest, markInitialRequested, claimRetry, recoverRetryRequest, markRetryRequested, recordReview, INITIAL_CLAIM_LEASE_MS, runMain };
