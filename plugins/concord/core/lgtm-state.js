'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('./spawn-cross-platform');

// External review requests are bounded by the same 15-minute window as review
// observation, so a recovery cannot overlap a live request invocation.
const INITIAL_CLAIM_LEASE_MS = 15 * 60 * 1000;

function validate({ pr, headSha }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  if (!/^[0-9a-f]{7,64}$/i.test(String(headSha))) throw new Error('review-lgtm-state: head SHA must be 7-64 hexadecimal characters');
  return { pr: Number(pr), headSha: String(headSha).toLowerCase() };
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
  return { deadlineMs: window ? window.deadlineMs : null, retryDeadlineMs: retryWindow ? retryWindow.deadlineMs : null, initialClaimed: !!initialClaim, initialClaimedAtMs: initialClaim && Number.isSafeInteger(initialClaim.claimedAtMs) ? initialClaim.claimedAtMs : null, initialRecoveryClaimed: !!initialRecovery, initialRequested: !!initialRequest, retryClaimed: !!retry, retryClaimedAtMs: retry && Number.isSafeInteger(retry.claimedAtMs) ? retry.claimedAtMs : null, retryRequested: !!retryRequest };
}

function claimRequest(input, kind) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
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

function runMain(repoRoot = process.cwd()) {
  const [verb, pr, headSha, seconds] = process.argv.slice(2);
  const stateDir = defaultStateDir(repoRoot);
  if (verb === 'status') process.stdout.write(`${JSON.stringify(status({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'open-window') process.stdout.write(`${JSON.stringify(openWindow({ stateDir, pr, headSha, durationMs: Number(seconds) * 1000 }))}\n`);
  else if (verb === 'open-retry-window') process.stdout.write(`${JSON.stringify(openRetryWindow({ stateDir, pr, headSha, durationMs: Number(seconds) * 1000 }))}\n`);
  else if (verb === 'claim-retry') process.stdout.write(`${JSON.stringify({ claimed: claimRetry({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'mark-retry-requested') process.stdout.write(`${JSON.stringify({ marked: markRetryRequested({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'claim-initial-request') process.stdout.write(`${JSON.stringify({ claimed: claimInitialRequest({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'recover-initial-request') process.stdout.write(`${JSON.stringify({ claimed: recoverInitialRequest({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'recover-retry-request') process.stdout.write(`${JSON.stringify({ claimed: recoverRetryRequest({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'mark-initial-requested') process.stdout.write(`${JSON.stringify({ marked: markInitialRequested({ stateDir, pr, headSha }) })}\n`);
  else throw new Error('review-lgtm-state: use status, open-window, open-retry-window, claim-retry, recover-retry-request, mark-retry-requested, claim-initial-request, recover-initial-request, or mark-initial-requested');
}

module.exports = { defaultStateDir, markerPath, status, openWindow, openRetryWindow, claimInitialRequest, recoverInitialRequest, markInitialRequested, claimRetry, recoverRetryRequest, markRetryRequested, INITIAL_CLAIM_LEASE_MS, runMain };
