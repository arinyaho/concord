'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function validate({ pr, headSha }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  if (!/^[0-9a-f]{7,64}$/i.test(String(headSha))) throw new Error('review-lgtm-state: head SHA must be 7-64 hexadecimal characters');
  return { pr: Number(pr), headSha: String(headSha).toLowerCase() };
}

function defaultStateDir(repoRoot = process.cwd()) {
  if (process.env.REVIEW_LGTM_STATE_DIR) return process.env.REVIEW_LGTM_STATE_DIR;
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  return path.resolve(repoRoot, gitDir, 'concord', 'review-until-lgtm');
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

function status(input) {
  const { stateDir } = input;
  const key = validate(input);
  const window = readMarker(markerPath({ stateDir, ...key }, 'window'));
  const initialClaim = readMarker(markerPath({ stateDir, ...key }, 'initial-claim'));
  const initialRequest = readMarker(markerPath({ stateDir, ...key }, 'initial-request'));
  const retry = readMarker(markerPath({ stateDir, ...key }, 'retry-claim'));
  const retryRequest = readMarker(markerPath({ stateDir, ...key }, 'retry-request'));
  if (window && (window.pr !== key.pr || window.headSha !== key.headSha || !Number.isSafeInteger(window.deadlineMs))) {
    throw new Error('review-lgtm-state: window marker does not match its PR head');
  }
  return { deadlineMs: window ? window.deadlineMs : null, initialClaimed: !!initialClaim, initialRequested: !!initialRequest, retryClaimed: !!retry, retryRequested: !!retryRequest };
}

function claimRequest(input, kind) {
  const { stateDir } = input;
  const key = validate(input);
  return writeExclusive(markerPath({ stateDir, ...key }, `${kind}-claim`), { ...key, kind, claimed: true });
}

function markRequest(input, kind) {
  const { stateDir } = input;
  const key = validate(input);
  return writeExclusive(markerPath({ stateDir, ...key }, `${kind}-request`), { ...key, kind, requested: true });
}

function claimInitialRequest(input) { return claimRequest(input, 'initial'); }
function markInitialRequested(input) { return markRequest(input, 'initial'); }

function openWindow(input) {
  const { stateDir, now = Date.now(), durationMs } = input;
  const key = validate(input);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('review-lgtm-state: duration must be a positive integer in milliseconds');
  const file = markerPath({ stateDir, ...key }, 'window');
  const deadlineMs = now + durationMs;
  if (writeExclusive(file, { ...key, deadlineMs })) return { created: true, deadlineMs };
  const existing = status({ stateDir, ...key });
  if (existing.deadlineMs === null) throw new Error('review-lgtm-state: window marker disappeared while opening');
  return { created: false, deadlineMs: existing.deadlineMs };
}

function claimRetry(input) {
  return claimRequest(input, 'retry');
}

function markRetryRequested(input) { return markRequest(input, 'retry'); }

function runMain(repoRoot = process.cwd()) {
  const [verb, pr, headSha, seconds] = process.argv.slice(2);
  const stateDir = defaultStateDir(repoRoot);
  if (verb === 'status') process.stdout.write(`${JSON.stringify(status({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'open-window') process.stdout.write(`${JSON.stringify(openWindow({ stateDir, pr, headSha, durationMs: Number(seconds) * 1000 }))}\n`);
  else if (verb === 'claim-retry') process.stdout.write(`${JSON.stringify({ claimed: claimRetry({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'mark-retry-requested') process.stdout.write(`${JSON.stringify({ marked: markRetryRequested({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'claim-initial-request') process.stdout.write(`${JSON.stringify({ claimed: claimInitialRequest({ stateDir, pr, headSha }) })}\n`);
  else if (verb === 'mark-initial-requested') process.stdout.write(`${JSON.stringify({ marked: markInitialRequested({ stateDir, pr, headSha }) })}\n`);
  else throw new Error('review-lgtm-state: use status, open-window, claim-retry, mark-retry-requested, claim-initial-request, or mark-initial-requested');
}

module.exports = { defaultStateDir, markerPath, status, openWindow, claimInitialRequest, markInitialRequested, claimRetry, markRetryRequested, runMain };
