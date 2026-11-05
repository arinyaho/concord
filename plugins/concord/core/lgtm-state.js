'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const collector = require('./review-collector');
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('./spawn-cross-platform');

// External review requests are bounded by the same 15-minute window as review
// observation, so a recovery cannot overlap a live request invocation.
const INITIAL_CLAIM_LEASE_MS = 15 * 60 * 1000;
const AUTO_REVIEW_GRACE_MS = 2 * 60 * 1000;
const MAX_REQUESTS_PER_PR = 3;
const MAX_FIX_ROUNDS_PER_PR = 3;
const MAX_HUMAN_FIX_ROUNDS_PER_PR = 5;

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
  const out = { url: finding.url, priority: finding.priority ?? null, signals: [...finding.signals] };
  // Human-feedback provenance is optional and never carries the body; a bot finding keeps its three-field shape.
  if (finding.itemId !== undefined) {
    if (typeof finding.itemId !== 'string' || !finding.itemId || finding.itemId.length > 300) throw new Error('review-lgtm-state: finding itemId must be a string of at most 300 characters');
    out.itemId = finding.itemId;
  }
  if (finding.kind !== undefined) {
    if (!FEEDBACK_KINDS.has(finding.kind)) throw new Error('review-lgtm-state: finding kind must be review-body, inline, reply or comment');
    out.kind = finding.kind;
  }
  if (finding.author !== undefined) {
    const a = finding.author;
    if (!a || typeof a.login !== 'string' || !a.login || !(a.id === null || Number.isSafeInteger(a.id)) || !ACCOUNT_TYPES.has(a.type)) throw new Error('review-lgtm-state: finding author must be {login, id, type}');
    out.author = { login: a.login, id: a.id, type: a.type };
  }
  if (finding.originalCommitId !== undefined) out.originalCommitId = optionalSha(finding.originalCommitId, 'finding originalCommitId');
  return out;
}

const FEEDBACK_KINDS = new Set(['review-body', 'inline', 'reply', 'comment']);
const ACCOUNT_TYPES = new Set(['User', 'Bot']);
function optionalSha(value, name) {
  if (value === null) return null;
  if (typeof value !== 'string' || !FULL_SHA.test(value)) throw new Error(`review-lgtm-state: ${name} must be a full hexadecimal SHA or null`);
  return value.toLowerCase();
}

// GitHub's API returns a review id as a JSON number; the CLI's own hook entry
// point also passes one through verbatim from stdin JSON. Accept either that
// number or a decimal-digit string and normalize to the decimal string,
// since the id becomes part of a file name.
// A revision record of an edited item on the same head carries `~<16 hex>` after its id; an observation takes one only when its findings carry item ids.
const REVISION = /~[0-9a-f]{16}$/;
function normalizeReviewId(reviewId, revision = true) {
  const suffix = revision && typeof reviewId === 'string' && REVISION.exec(reviewId);
  if (suffix) return `${normalizeReviewId(reviewId.slice(0, suffix.index), false)}${suffix[0]}`;
  // A conversation comment and a thread comment without a review each have an id space of their own, apart from reviews'.
  const prefixed = typeof reviewId === 'string' && /^(comment|thread)-([0-9]+)$/.exec(reviewId);
  if (prefixed) return `${prefixed[1]}-${normalizeReviewId(prefixed[2])}`;
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
  const normalizedReviewId = normalizeReviewId(reviewId, Array.isArray(findings) && findings.length > 0 && findings.every((finding) => finding && finding.itemId !== undefined));
  if (typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('review-lgtm-state: reviewer is required');
  if (typeof reviewUrl !== 'string' || !reviewUrl) throw new Error('review-lgtm-state: reviewUrl is required');
  if (typeof commitId !== 'string' || !FULL_SHA.test(commitId)) throw new Error('review-lgtm-state: commitId must be a full 40- or 64-character hexadecimal SHA (the review commit_id)');
  if (state !== 'completed' && state !== 'in-progress') throw new Error('review-lgtm-state: state must be completed or in-progress');
  if (typeof lgtm !== 'boolean') throw new Error('review-lgtm-state: lgtm is required and must be a boolean');
  if (!Array.isArray(findings)) throw new Error('review-lgtm-state: findings is required and must be an array');
  const out = { reviewId: normalizedReviewId, reviewer: reviewer.trim(), reviewUrl, commitId: commitId.toLowerCase(), state, lgtm, findings: findings.map(validateFinding) };
  if (observation.reviewerId !== undefined) {
    if (!(observation.reviewerId === null || Number.isSafeInteger(observation.reviewerId))) throw new Error('review-lgtm-state: reviewerId must be a safe integer or null');
    out.reviewerId = observation.reviewerId;
  }
  if (observation.reviewerType !== undefined) {
    if (!ACCOUNT_TYPES.has(observation.reviewerType)) throw new Error('review-lgtm-state: reviewerType must be User or Bot');
    out.reviewerType = observation.reviewerType;
  }
  if (observation.reviewCommitId !== undefined) out.reviewCommitId = optionalSha(observation.reviewCommitId, 'reviewCommitId');
  if (observation.submittedAt !== undefined) {
    if (observation.submittedAt !== null && (typeof observation.submittedAt !== 'string' || !observation.submittedAt)) throw new Error('review-lgtm-state: submittedAt must be a string or null');
    out.submittedAt = observation.submittedAt;
  }
  return out;
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

function fixWaivers({ stateDir, pr }, human = false) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  return names.filter((name) => name.startsWith(`pr-${Number(pr)}.fix-waiver-`) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((marker) => marker && typeof marker.person === 'string' && Number.isSafeInteger(marker.count) && Number.isSafeInteger(marker.atMs) && (marker.kind === 'human') === human)
    .map(({ person, count, atMs }) => ({ person, count, atMs }))
    .sort((a, b) => a.atMs - b.atMs || a.person.localeCompare(b.person) || a.count - b.count);
}

const fixSlotPrefix = (pr, human) => `pr-${Number(pr)}.${human ? 'human-' : ''}fix-round-slot-`;

// A round whose plan holds a human item spends the human cap; any other round the PR-wide bot cap.
function fixBudget({ stateDir, pr }, human = false) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const spent = names.filter((name) => name.startsWith(fixSlotPrefix(pr, human)) && name.endsWith('.json')).length;
  const max = (human ? MAX_HUMAN_FIX_ROUNDS_PER_PR : MAX_FIX_ROUNDS_PER_PR) + fixWaivers({ stateDir, pr }, human).reduce((sum, waiver) => sum + waiver.count, 0);
  return { max, spent, remaining: Math.max(0, max - spent) };
}

function humanFixBudget(input) { return fixBudget(input, true); }

// A human's waiver raises the per-PR fix-round cap by `count`. The cap stays a hard stop for
// automation; the waiver is the recorded decision that changes who may continue.
function waiveFixBudget({ stateDir, pr, person, count, human = false, now = Date.now() }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  if (typeof person !== 'string' || !person.trim() || person.length > 200) throw new Error('review-lgtm-state: waiver person must be a non-empty string of at most 200 characters');
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('review-lgtm-state: waiver count must be a positive integer');
  const who = person.trim();
  const id = crypto.createHash('sha256').update(human ? `${who}\0${count}\0human` : `${who}\0${count}`).digest('hex').slice(0, 16);
  const file = path.join(stateDir, `pr-${Number(pr)}.fix-waiver-${id}.json`);
  const created = writeExclusive(file, { pr: Number(pr), person: who, count, ...(human ? { kind: 'human' } : {}), atMs: now });
  const waiver = fixWaivers({ stateDir, pr }, human).find((entry) => entry.person === who && entry.count === count);
  return { waived: true, ...(created ? {} : { existing: true }), waiver, budget: fixBudget({ stateDir, pr }, human) };
}

function collectedMinors({ stateDir, pr }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  return names.filter((name) => name.startsWith(`pr-${Number(pr)}.minor-`) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((marker) => marker && typeof marker.id === 'string' && Number.isSafeInteger(marker.atMs))
    .map(({ id, url, reason, headSha, atMs }) => ({ id, url, reason, headSha, atMs }))
    .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

// A finding classified minor is recorded, never fixed; the pre-merge triage turns the PR-wide list into follow-up tickets.
function collectMinor({ stateDir, pr, headSha, id, url, reason, now = Date.now() }) {
  const key = validate({ pr, headSha });
  const entry = { id: text(id), url: text(url), reason: text(reason) };
  if (!entry.id || !entry.url || !entry.reason || entry.id.length > 200 || entry.url.length > 500 || entry.reason.length > 500) throw new Error('review-lgtm-state: a collected minor finding needs an id, a url and a one-line reason of at most 500 characters');
  const hash = crypto.createHash('sha256').update(entry.id).digest('hex').slice(0, 16);
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    const created = writeExclusive(path.join(stateDir, `pr-${key.pr}.minor-${hash}.json`), { pr: key.pr, headSha: key.headSha, ...entry, atMs: now });
    const minor = collectedMinors({ stateDir, pr: key.pr }).find((item) => item.id === entry.id);
    if (!created && minor.url !== entry.url) throw new Error(`review-lgtm-state: minor finding ${entry.id} is already collected with a different url`);
    return { collected: true, ...(created ? {} : { existing: true }), minor };
  }, { collected: false, reason: 'transition-busy' });
}

// The merge gate of an AI agent merging at the user's explicit request. Live facts (CI, reviewer completion, LGTM)
// arrive as evidence from the caller; the delivery record is read from the state. Every reason is reported.
function mergeReady({ stateDir, pr, headSha, evidence }) {
  const key = validate({ pr, headSha });
  const list = (value, label) => { if (!Array.isArray(value)) throw new Error(`review-lgtm-state: merge-ready evidence ${label} must be an array`); return value; };
  if (!evidence || typeof evidence !== 'object') throw new Error('review-lgtm-state: merge-ready evidence must be an object');
  const checks = list(evidence.checks, 'checks');
  const reviewers = list(evidence.reviewers, 'reviewers');
  const expected = list(evidence.expectedReviewers, 'expectedReviewers').map(text);
  if (reviewers.some((reviewer) => !text(reviewer?.reviewer))) throw new Error('review-lgtm-state: merge-ready reviewers need a reviewer identity each');
  const reasons = [];
  const lower = (value) => String(value || '').trim().toLowerCase();
  const live = lower(evidence.headSha);
  if (live !== key.headSha) reasons.push(`head-mismatch:${live}`);
  for (const check of checks) if (text(check?.conclusion) !== 'success') reasons.push(`check:${text(check?.name)}:${text(check?.conclusion)}`);
  const delivery = deliveryStatus({ stateDir, ...key });
  // A declared-unavailable reviewer covers the configured ones; the agent merges only at the user's explicit request.
  const declared = delivery?.classification === 'mergeable-without-review';
  if (declared || (reviewers.length === 0 && expected.length === 0)) reasons.push('no-automated-review');
  for (const name of declared ? [] : expected) if (!reviewers.some((reviewer) => text(reviewer.reviewer) === name)) reasons.push(`reviewer-missing:${name}`);
  for (const reviewer of reviewers) {
    const name = text(reviewer?.reviewer);
    if (text(reviewer?.failure)) reasons.push(`reviewer-failure:${name}:${text(reviewer.failure)}`);
    else if (reviewer?.terminal !== true) reasons.push(`reviewer-pending:${name}`);
    else if (reviewer.lgtm !== true) reasons.push(`no-lgtm:${name}`);
  }
  if (!delivery) reasons.push('no-delivery');
  else if (!delivery.current) reasons.push('delivery-stale');
  else if (delivery.classification === 'blocked') reasons.push('delivery-blocked');
  if (delivery) {
    if (lower(evidence.baseSha) !== delivery.baseSha) reasons.push('base-changed');
    if (lower(evidence.contractDigest) !== delivery.contractDigest) reasons.push('contract-changed');
    for (const { name } of delivery.requiredChecks || []) if (!checks.some((check) => text(check?.name) === name)) reasons.push(`check-missing:${name}`);
  }
  if (fixRoundForHead({ stateDir, ...key }) || readMarker(markerPath({ stateDir, ...key }, 'fix-round-claim'))) reasons.push('fix-round-open');
  return { result: reasons.length === 0 ? 'ready' : 'blocked', reasons };
}

function reserveFixRound({ stateDir, pr, headSha }, now, owner, human = false) {
  const { max } = fixBudget({ stateDir, pr }, human);
  for (let round = 1; round <= max; round += 1) {
    const file = path.join(stateDir, `${fixSlotPrefix(pr, human)}${round}.json`);
    if (writeExclusive(file, { pr, headSha, owner, claimedAtMs: now })) return round;
  }
  return null;
}

function fixRoundForHead({ stateDir, pr, headSha }) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names) {
    const slot = new RegExp(`^pr-${pr}\\.(human-)?fix-round-slot-(\\d+)\\.json$`).exec(name);
    const marker = slot && readMarker(path.join(stateDir, name));
    if (marker && marker.pr === pr && marker.headSha === headSha) return { ...marker, round: Number(slot[2]), kind: slot[1] ? 'human' : 'bot' };
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

const ITEM_ID = /^[^@\s]{1,200}@[0-9T:.Z-]{10,40}$/;
const REPLY_URL_DISPOSITIONS = ['blocker', 'minor', 'rejected', 'clarify', 'approve-intent'];
const REPLY_DISPOSITIONS = [...REPLY_URL_DISPOSITIONS, 'author-answered', 'no-action'];
const sha16 = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const itemFileKey = (itemId) => sha16(itemId);
const accountFileKey = (id) => { if (!Number.isSafeInteger(id) || id < 1) throw new Error('review-lgtm-state: reviewerId must be a positive account id'); return sha16(String(id)); };

function prNumber(pr) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  return Number(pr);
}

function validItem(itemId) {
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) throw new Error('review-lgtm-state: an item id is <node id>@<revision timestamp>');
  return itemId;
}

function prFileNames(stateDir, test) {
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  return names.filter(test).map((name) => path.join(stateDir, name));
}

// Heads whose fix round reserved a slot (bot or human); a claim on any other head is abandoned.
function slotHeads({ stateDir, pr }) {
  const n = Number(pr);
  return new Set(prFileNames(stateDir, (name) => new RegExp(`^pr-${n}\\.(?:human-)?fix-round-slot-\\d+\\.json$`).test(name)).map((file) => readMarker(file)?.headSha));
}

const pushedFile = ({ stateDir, pr, headSha }) => path.join(stateDir, `pr-${pr}-${headSha}.fix-round-pushed.json`);

// An item is answered on a head once it has a handled record, a reply claim (a session is replying) or a place in the itemIds of a fix-round claim
// that is the head's own slotted round, or of any head whose round pushed its fix: an unpushed round on an earlier head fixed nothing.
function answeredParts({ stateDir, pr, headSha = null }) {
  const n = Number(pr);
  const ids = (test, pick) => prFileNames(stateDir, test).flatMap((file) => pick(readMarker(file)) || []);
  const slotted = slotHeads({ stateDir, pr: n });
  const head = headSha && String(headSha).toLowerCase();
  const counts = (claim) => (claim.headSha === head && slotted.has(claim.headSha)) || !!readMarker(pushedFile({ stateDir, pr: n, headSha: claim.headSha }));
  return {
    feedback: ids((name) => name.startsWith(`pr-${n}.feedback-`) && name.endsWith('.json'), (marker) => marker && marker.itemId),
    claims: ids((name) => name.startsWith(`pr-${n}.reply-`) && name.endsWith('-claim.json'), (marker) => marker && marker.itemId),
    fixed: ids((name) => name.startsWith(`pr-${n}-`) && name.endsWith('.fix-round-claim.json'), (marker) => marker && Array.isArray(marker.itemIds) && typeof marker.headSha === 'string' && counts(marker) && marker.itemIds),
  };
}

function answeredItemIds(input) { return new Set(Object.values(answeredParts(input)).flat()); }

function claimReply({ stateDir, pr, itemId, now = Date.now() }) {
  const id = validItem(itemId);
  const n = prNumber(pr);
  return withTransitionLock({ stateDir, pr: n }, () => {
    // A fix round's itemIds keep an item out of the next batch but still owe its reply, so only a handled record refuses the claim.
    if (answeredParts({ stateDir, pr: n }).feedback.includes(id)) return { claimed: false, reason: 'answered' };
    return writeExclusive(path.join(stateDir, `pr-${n}.reply-${itemFileKey(id)}-claim.json`), { pr: n, itemId: id, claimedAtMs: now }) ? { claimed: true } : { claimed: false, reason: 'reply-claimed' };
  });
}

function validReply(record) {
  const r = record || {};
  const { disposition } = r;
  if (!REPLY_DISPOSITIONS.includes(disposition)) throw new Error(`review-lgtm-state: a reply disposition is one of ${REPLY_DISPOSITIONS.join(', ')}`);
  // A deleted account's item carries the collector's ghost author, whose id is null.
  if (!text(r.kind) || !text(r.url) || r.url.length > 500 || !r.author || !text(r.author.login) || !(r.author.id === null || Number.isSafeInteger(r.author.id)) || !text(r.author.type)) throw new Error('review-lgtm-state: a handled reply needs kind, a url of at most 500 characters and the author login, id and type');
  if (typeof r.reason !== 'string' || r.reason.trim().length < 1 || r.reason.length > 500) throw new Error('review-lgtm-state: a handled reply needs a reason of 1 to 500 characters');
  const link = (name, needed) => {
    if (needed !== (r[name] != null)) throw new Error(`review-lgtm-state: ${disposition} ${needed ? `needs ${name === 'answerUrl' ? 'an' : 'a'} ${name}` : `takes no ${name}`}`);
    if (needed && (!text(r[name]) || r[name].length > 500)) throw new Error(`review-lgtm-state: ${name} must be a non-empty string of at most 500 characters`);
    return needed ? { [name]: text(r[name]) } : {};
  };
  const replyUrl = link('replyUrl', REPLY_URL_DISPOSITIONS.includes(disposition));
  const answerUrl = link('answerUrl', disposition === 'author-answered');
  const fixable = disposition === 'blocker' || (disposition === 'minor' && r.author.type === 'User');
  // A conceded item whose fix a stop rule holds back is answered without a fix commit and goes to the delivery disposition.
  if (r.withheld != null && (typeof r.withheld !== 'boolean' || !fixable)) throw new Error('review-lgtm-state: withheld is a boolean, only for a blocker or a person\'s minor');
  if ((fixable && !r.withheld) !== (r.fixCommit != null)) throw new Error(`review-lgtm-state: ${disposition}${r.withheld ? ' withheld' : ''} ${r.fixCommit != null ? 'takes no fixCommit' : 'needs a fixCommit'}`);
  if (r.fixCommit != null && (typeof r.fixCommit !== 'string' || !FULL_SHA.test(r.fixCommit))) throw new Error('review-lgtm-state: fixCommit is a full commit SHA');
  return { kind: r.kind, url: r.url, author: { login: r.author.login, id: r.author.id, type: r.author.type }, originalCommitId: r.originalCommitId ?? null, disposition, reason: r.reason, ...replyUrl, ...answerUrl, ...(r.fixCommit != null ? { fixCommit: r.fixCommit.toLowerCase() } : {}), ...(r.withheld ? { withheld: true } : {}) };
}

// Write-once per item revision: the handled record is what the next collection reads as answered.
function recordReply({ stateDir, pr, itemId, record, now = Date.now() }) {
  const id = validItem(itemId);
  const n = prNumber(pr);
  const entry = validReply(record);
  const file = path.join(stateDir, `pr-${n}.feedback-${itemFileKey(id)}.json`);
  return withTransitionLock({ stateDir, pr: n }, () => {
    const created = writeExclusive(file, { ...entry, pr: n, itemId: id, revision: id.slice(id.lastIndexOf('@') + 1), recordedAtMs: now });
    return { recorded: true, ...(created ? {} : { existing: true }), feedback: readMarker(file) };
  }, { recorded: false, reason: 'transition-busy' });
}

const approvePromptFile = ({ stateDir, pr, headSha }, reviewerId) => path.join(stateDir, `pr-${pr}-${headSha}.approve-prompt-${accountFileKey(reviewerId)}.json`);

// The comment-only LGTM Approve prompt is sent at most once per reviewer and head, and only to a selected person. The claim keeps the item
// it answers, so a session that crashed before posting resumes that item's reply; another item gets no second prompt.
function claimApprovePrompt({ stateDir, pr, headSha, reviewerId, itemId, now = Date.now() }) {
  const key = validate({ pr, headSha });
  const file = approvePromptFile({ stateDir, ...key }, reviewerId);
  const id = validItem(itemId);
  if (!(latestSelection({ stateDir, pr: key.pr })?.reviewers || []).some((reviewer) => reviewer.id === reviewerId && reviewer.type === 'User' && !reviewer.gone)) return { claimed: false, reason: 'not-selected' };
  if (writeExclusive(file, { ...key, reviewerId, itemId: id, claimedAtMs: now })) return { claimed: true };
  return readMarker(file).itemId === id ? { claimed: true, resumed: true } : { claimed: false, reason: 'approve-prompt-sent' };
}

// Reply claims whose handled record is not written yet: a session started replying and did not finish.
function claimedReplies({ stateDir, pr }) {
  const { feedback, claims } = answeredParts({ stateDir, pr });
  return [...new Set(claims)].filter((id) => !feedback.includes(id)).sort();
}

// Items of a fix round that pushed its fix and that no handled record answers yet: each reply is owed and names the pushed fix commit.
function owedReplies({ stateDir, pr }) {
  const n = Number(pr);
  const { feedback } = answeredParts({ stateDir, pr: n });
  const owed = new Map();
  for (const file of prFileNames(stateDir, (name) => name.startsWith(`pr-${n}-`) && name.endsWith('.fix-round-pushed.json'))) {
    const pushed = readMarker(file);
    const claim = pushed && FULL_SHA.test(String(pushed.headSha)) ? readMarker(markerPath({ stateDir, pr: n, headSha: pushed.headSha }, 'fix-round-claim')) : null;
    if (!claim || !Array.isArray(claim.itemIds)) continue;
    for (const itemId of claim.itemIds) if (!feedback.includes(itemId) && !owed.has(itemId)) owed.set(itemId, { itemId, headSha: pushed.headSha, fixCommit: pushed.fixCommit });
  }
  return [...owed.values()].sort((a, b) => a.itemId.localeCompare(b.itemId));
}

// Slotted fix rounds of other heads with no pushed marker: a crash after the push leaves one, and its items must not be fixed by a second round.
function unpushedRounds({ stateDir, pr, headSha }) {
  const n = Number(pr);
  const head = headSha && String(headSha).toLowerCase();
  return prFileNames(stateDir, (name) => new RegExp(`^pr-${n}\\.(?:human-)?fix-round-slot-\\d+\\.json$`).test(name))
    .map((file) => readMarker(file))
    .filter((slot) => slot && typeof slot.headSha === 'string' && FULL_SHA.test(slot.headSha) && slot.headSha !== head && !readMarker(pushedFile({ stateDir, pr: n, headSha: slot.headSha })))
    .sort((a, b) => (a.claimedAtMs || 0) - (b.claimedAtMs || 0) || a.headSha.localeCompare(b.headSha))
    .map((slot) => ({ headSha: slot.headSha, owner: latestFixOwnership({ stateDir, pr: n, headSha: slot.headSha }, slot).owner }));
}

// Written once the round's certified commit is pushed: from then on its items are answered on every head and their replies are owed.
function markFixPushed({ stateDir, pr, headSha, fixCommit, owner, now = Date.now() }) {
  const key = validate({ pr, headSha });
  if (typeof fixCommit !== 'string' || !FULL_SHA.test(fixCommit)) throw new Error('review-lgtm-state: fixCommit is a full commit SHA');
  if (typeof owner !== 'string' || !owner) throw new Error('review-lgtm-state: mark-fix-pushed requires its claim owner');
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    const slot = fixRoundForHead({ stateDir, ...key });
    if (!slot) return { marked: false, reason: 'no-fix-round' };
    if (latestFixOwnership({ stateDir, ...key }, slot).owner !== owner) return { marked: false, reason: 'owner-mismatch' };
    const file = pushedFile({ stateDir, ...key });
    const created = writeExclusive(file, { ...key, fixCommit: fixCommit.toLowerCase(), owner, pushedAtMs: now });
    return { marked: true, ...(created ? {} : { existing: true }), pushed: readMarker(file) };
  }, { marked: false, reason: 'transition-busy' });
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
  const prefix = `pr-${pr}-${headSha}.`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(prefix) && /^(?:review|comment|thread)-/.test(name.slice(prefix.length)) && name.endsWith('.json'))
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

// The head's unanswered feedback items: the exact set claimFixRound requires. An item's earlier revision on the head is superseded by its later one, the only revision the collector shows.
function unansweredFindings(records, answered) {
  const items = records.flatMap((record) => record.findings).filter((finding) => finding.itemId !== undefined);
  const at = (id) => id.lastIndexOf('@');
  const superseded = (id) => items.some(({ itemId }) => itemId.slice(0, at(itemId)) === id.slice(0, at(id)) && Date.parse(itemId.slice(at(itemId) + 1)) > Date.parse(id.slice(at(id) + 1)));
  return [...new Map(items.filter((finding) => !answered.has(finding.itemId) && !superseded(finding.itemId)).map((finding) => [finding.itemId, finding])).values()];
}

function reconciliationPacket({ stateDir, pr, headSha }) {
  const records = activeReviewRecords({ stateDir, pr, headSha })
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs || compareReviewIds(a.reviewId, b.reviewId));
  // The cap is chosen as claimFixRound chooses it: the claim lists exactly the unanswered items, and one from a person takes the human cap.
  const unanswered = unansweredFindings(records, answeredItemIds({ stateDir, pr, headSha }));
  const human = unanswered.some((finding) => finding.author?.type === 'User');
  const delivered = !fixRoundForHead({ stateDir, pr, headSha }) && deliveryTerminal({ stateDir, pr, headSha }, { fixCap: human ? 'human' : 'bot' });
  if (delivered) return { pr, headSha, reviews: records.map((record) => ({ id: record.reviewId, reviewer: record.reviewer || 'legacy/unknown', url: record.reviewUrl, findings: record.findings })), batchCount: records.length, classification: 'delivery-terminal', action: 'report-delivery', humanRequired: false, requires: `report the recorded ${delivered.classification} delivery disposition` };
  if (records.length === 0) return null;
  const reviews = records.map((record) => ({ id: record.reviewId, reviewer: record.reviewer || 'legacy/unknown', url: record.reviewUrl, findings: record.findings }));
  const findings = records.flatMap((record) => record.findings);
  const p1Count = findings.filter((finding) => finding.priority === 'P1').length;
  const p2Count = findings.filter((finding) => finding.priority === 'P2').length;
  const signals = [...new Set(findings.flatMap((finding) => finding.signals))].sort();
  // A bot review counts once with its revision records; all human records are one batch.
  const botRecords = new Set(records.filter((record) => record.reviewerType !== 'User').map((record) => String(record.reviewId).replace(REVISION, ''))).size;
  const classification = (p1Count > 0 || botRecords + (records.some((record) => record.reviewerType === 'User') ? 1 : 0) >= 2 || signals.length > 0) ? 'requires-architecture-review' : 'light-implementation-eligible';
  const claimed = !!fixRoundForHead({ stateDir, pr, headSha });
  const abandoned = !claimed && !!readMarker(markerPath({ stateDir, pr, headSha }, 'fix-round-claim'));
  const exhausted = !claimed && fixBudget({ stateDir, pr }, human).remaining === 0;
  const humanRequired = abandoned || exhausted;
  const action = claimed ? 'complete-claimed-fix-round' : humanRequired ? 'human-reconciliation' : 'verify-and-fix';
  const requires = claimed ? 'complete the claimed fix round' : abandoned ? 'human decision: abandoned fix-round claim' : exhausted ? `human decision: ${human ? 'human ' : ''}fix-round budget exhausted` : 'verify the batch and claim a fix round';
  return { pr, headSha, reviews, batchCount: records.length, unansweredItemIds: unanswered.map((finding) => finding.itemId).sort(), p1Count, p2Count, signals, classification, action, humanRequired, requires };
}

function recordReview(input) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const observation = validateObservation(input.observation);
  if (observation.commitId !== key.headSha) return { outcome: 'stale', recorded: false };
  if (observation.state === 'in-progress') return { outcome: 'in-progress', recorded: false };
  if (observation.findings.length > 0) {
    const fileOf = (id) => markerPath({ stateDir, ...key }, /^[0-9]/.test(id) ? `review-${id}` : id);
    let file = fileOf(observation.reviewId);
    let { reviewId, findings } = observation;
    if (readMarker(file)) {
      // A record is write-once per head, so an item edited on the same head is stored as a revision record of the items no record of this observation holds yet.
      const base = reviewId.replace(REVISION, '');
      const own = reviewRecords({ stateDir, ...key }).filter((record) => String(record.reviewId).replace(REVISION, '') === base);
      const recorded = new Set(own.flatMap((record) => record.findings.map((finding) => finding.itemId)));
      findings = findings.every((finding) => finding.itemId !== undefined) ? findings.filter((finding) => !recorded.has(finding.itemId)) : [];
      if (findings.length === 0) {
        const rejected = rejectedReviewIds({ stateDir, ...key });
        return { outcome: own.every((record) => rejected.has(record.reviewId)) ? 'rejected' : 'needs-reconciliation', recorded: false, duplicate: true };
      }
      reviewId = `${base}~${sha16(findings.map((finding) => finding.itemId).sort().join(','))}`;
      file = fileOf(reviewId);
    }
    const written = writeExclusive(file, { pr: key.pr, headSha: key.headSha, reviewId, reviewer: observation.reviewer, reviewUrl: observation.reviewUrl, recordedAtMs: now, findings, ...Object.fromEntries(['reviewerId', 'reviewerType', 'reviewCommitId', 'submittedAt'].filter((k) => k in observation).map((k) => [k, observation[k]])) });
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
  const reviewIds = [...new Set(input.reviewIds.map((id) => normalizeReviewId(id)))].sort(compareReviewIds);
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
  return { deadlineMs: deadlines.length > 0 ? Math.max(...deadlines) : null, requestEligibleAtMs: observed && Number.isSafeInteger(observed.eligibleAtMs) ? observed.eligibleAtMs : null, requestBudget: requestBudget({ stateDir, pr: key.pr }), fixBudget: fixBudget({ stateDir, pr: key.pr }), waivers: fixWaivers({ stateDir, pr: key.pr }), humanFixBudget: humanFixBudget({ stateDir, pr: key.pr }), humanWaivers: fixWaivers({ stateDir, pr: key.pr }, true), minors: collectedMinors({ stateDir, pr: key.pr }), claimedReplies: claimedReplies({ stateDir, pr: key.pr }), owedReplies: owedReplies({ stateDir, pr: key.pr }), unpushedRounds: unpushedRounds({ stateDir, ...key }), reviewers: (latestSelection({ stateDir, pr: key.pr })?.reviewers || []).map(({ login, id, type, gone }) => ({ login, id, type, ...(gone ? { gone: true } : {}), approvePrompted: !!readMarker(approvePromptFile({ stateDir, ...key }, id)) })), initialClaimed: !!initialClaim, initialClaimedAtMs: initialClaim && Number.isSafeInteger(initialClaim.claimedAtMs) ? initialClaim.claimedAtMs : null, initialRecoveryClaimed: !!initialRecovery, initialRequested, reconciliation: reconciliationPacket({ stateDir, ...key }), delivery: deliveryStatus({ stateDir, ...key }) };
}

function claimFixRound(input) {
  const { stateDir, now = Date.now() } = input;
  const key = validate(input);
  const owner = input.owner || crypto.randomUUID();
  if (typeof owner !== 'string' || !owner || owner.length > 200) throw new Error('review-lgtm-state: fix-round owner must be a non-empty string of at most 200 characters');
  const { itemIds = [] } = input;
  if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== 'string')) throw new Error('review-lgtm-state: itemIds must be an array of item ids');
  const ids = [...new Set(itemIds)];
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    // A slotted round is resumed or refused before anything else: a resume lists no item ids, and a delivery its own claim lifted does not end it.
    const slot = fixRoundForHead({ stateDir, ...key });
    if (slot) {
      const active = latestFixOwnership({ stateDir, ...key }, slot);
      if (active.owner === owner) return { claimed: true, resumed: true, owner, round: slot.round, kind: slot.kind, budget: fixBudget({ stateDir, pr: key.pr }, slot.kind === 'human') };
      return { claimed: false, reason: 'fix-round-owned', humanRequired: true, owner: active.owner };
    }
    const unpushed = unpushedRounds({ stateDir, ...key });
    if (unpushed.length > 0) return { claimed: false, reason: 'unpushed-fix-round', humanRequired: true, unpushedRounds: unpushed };
    const records = activeReviewRecords({ stateDir, ...key });
    const findings = new Map(records.flatMap((record) => record.findings).filter((finding) => finding.itemId !== undefined).map((finding) => [finding.itemId, finding]));
    const human = ids.some((id) => findings.get(id)?.author?.type === 'User');
    const terminal = deliveryTerminal({ stateDir, ...key }, { fixCap: human ? 'human' : 'bot' });
    if (terminal) return terminal;
    if (records.length === 0) return { claimed: false, reason: 'no-findings' };
    // The round takes every unanswered item, so its cap is the one reconciliationPacket reports and no item is left without a round or a reply.
    const unanswered = unansweredFindings(records, answeredItemIds({ stateDir, ...key })).map((finding) => finding.itemId).sort();
    if (ids.length !== unanswered.length || unanswered.some((id) => !ids.includes(id))) return { claimed: false, reason: 'item-ids-mismatch', expected: unanswered };
    const kind = human ? 'human' : 'bot';
    const exhausted = human ? 'human-fix-round-budget-exhausted' : 'fix-round-budget-exhausted';
    const budget = fixBudget({ stateDir, pr: key.pr }, human);
    if (budget.remaining === 0) return { claimed: false, reason: exhausted, budget };
    const claimFile = markerPath({ stateDir, ...key }, 'fix-round-claim');
    if (!writeExclusive(claimFile, { ...key, owner, itemIds: ids, claimedAtMs: now })) return { claimed: false, reason: 'abandoned-fix-claim', humanRequired: true };
    const round = reserveFixRound({ stateDir, ...key }, now, owner, human);
    if (!round) return { claimed: false, reason: exhausted, budget: fixBudget({ stateDir, pr: key.pr }, human) };
    return { claimed: true, owner, round, kind, budget: fixBudget({ stateDir, pr: key.pr }, human) };
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
const RELEASE_BLOCKING = new Set(['acceptance-criterion', 'required-check', 'serious-bug', 'security', 'data-integrity', 'contract-choice', 'compatibility', 'contradictory-docs', 'unproven-premise', 'stage-exit']);
const DISPOSITIONS = new Set(['fixed', 'follow-up', 'accepted', 'blocking']);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function validatePacket(packet) {
  if (!packet || typeof packet !== 'object') throw new Error('review-lgtm-state: delivery packet must be an object');
  if (!FULL_SHA.test(String(packet.baseSha))) throw new Error('review-lgtm-state: delivery baseSha must be a full SHA');
  if (!/^[0-9a-f]{64}$/i.test(String(packet.contractDigest))) throw new Error('review-lgtm-state: delivery contractDigest must be a SHA-256 hex digest');
  for (const field of ['reviewIds', 'acceptance', 'requiredChecks', 'openChoices', 'findings', 'droppedMinors', 'tickets']) {
    if (!Array.isArray(packet[field])) throw new Error(`review-lgtm-state: delivery ${field} must be an array`);
  }
  if (typeof packet.reviewsTerminal !== 'boolean') throw new Error('review-lgtm-state: delivery reviewsTerminal must be a boolean');
  if (packet.reviewerUnavailable != null && typeof packet.reviewerUnavailable !== 'boolean') throw new Error('review-lgtm-state: delivery reviewerUnavailable must be a boolean');
  if (packet.reviewerUnavailable === true && packet.reviewIds.length > 0) throw new Error('review-lgtm-state: delivery reviewerUnavailable needs empty reviewIds; a recorded review means the reviewer is available');
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
  unique(packet.droppedMinors, 'id', 'dropped minor');
  for (const dropped of packet.droppedMinors) {
    if (!text(dropped.reason)) throw new Error(`review-lgtm-state: delivery dropped minor ${text(dropped.id)} needs a reason`);
    if (packet.findings.some((finding) => text(finding.id) === text(dropped.id))) throw new Error(`review-lgtm-state: minor ${text(dropped.id)} is both a finding and a dropped minor`);
  }
  unique(packet.tickets, 'rootCause', 'ticket');
  if (!packet.reviewIds.every((id) => /^(?:[0-9]+|(?:comment|thread)-[0-9]+)(?:~[0-9a-f]{16})?$/.test(String(id)))) throw new Error('review-lgtm-state: delivery reviewIds must be review ids');
  for (const finding of packet.findings) {
    if (finding.releaseBlocking != null && !Array.isArray(finding.releaseBlocking)) throw new Error(`review-lgtm-state: delivery finding ${text(finding.id)} releaseBlocking must be an array`);
    const id = text(finding.id);
    if (!id) throw new Error('review-lgtm-state: delivery finding needs an id');
    if (!!text(finding.url) === (finding.local != null)) throw new Error(`review-lgtm-state: delivery finding ${id} needs exactly one of url or local`);
    if (finding.local != null) {
      const file = text(finding.local.file);
      if (!file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error(`review-lgtm-state: delivery finding ${id} local needs a relative file`);
      if (typeof finding.local.span !== 'string') throw new Error(`review-lgtm-state: delivery finding ${id} local span must be a string`);
    }
    if (finding.disposition != null && !DISPOSITIONS.has(finding.disposition)) throw new Error(`review-lgtm-state: unknown disposition ${JSON.stringify(finding.disposition)}`);
    for (const category of finding.releaseBlocking || []) {
      if (!RELEASE_BLOCKING.has(category)) throw new Error(`review-lgtm-state: unknown release-blocking category ${JSON.stringify(category)}`);
    }
  }
}

// `minorIds` are the minors collected for the PR; each must be a follow-up finding under its own id or a dropped minor.
function classifyDelivery(raw, minorIds = []) {
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
    // An acceptance never clears a release-blocking category; the reason only says the head waits on a person, not on work.
    if (disposition !== 'fixed') for (const category of finding.releaseBlocking || []) reasons.push(`${disposition === 'accepted' && text(finding.acceptedBy) ? 'accepted-' : ''}release-blocker:${id}:${category}`);
    if (disposition !== 'follow-up') continue;
    const rootCause = text(finding.rootCause);
    if (!rootCause) { reasons.push(`unowned:${id}`); continue; }
    if (!text(finding.rationale)) reasons.push(`no-rationale:${id}`);
    if (!followUps.has(rootCause)) followUps.set(rootCause, []);
    followUps.get(rootCause).push(finding);
  }

  for (const id of minorIds) {
    if (!input.findings.some((finding) => finding.id === id && finding.disposition === 'follow-up') && !input.droppedMinors.some((dropped) => dropped.id === id)) reasons.push(`minor-unaccounted:${id}`);
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
      pending.push({ rootCause, findingIds, refs: members.map((finding) => (finding.url ? { url: finding.url } : { local: finding.local })), rationales: members.map((finding) => text(finding.rationale)) });
      continue;
    }
    if (ticket.readBack !== true) reasons.push(`ticket-unread:${rootCause}`);
    if (ticket.reused && !text(ticket.duplicateCheck)) reasons.push(`duplicate-unchecked:${rootCause}`);
  }

  const residual = input.findings.some((finding) => finding.disposition !== 'fixed');
  const classification = reasons.length > 0 ? 'blocked' : input.reviewerUnavailable ? 'mergeable-without-review' : residual ? 'mergeable-with-follow-ups' : 'mergeable-clean';
  const findings = input.findings.map((finding) => ({
    id: finding.id, url: finding.url, local: finding.local, disposition: finding.disposition || null,
    rootCause: finding.rootCause || null, releaseBlocking: finding.releaseBlocking, rationale: finding.rationale || null, acceptedBy: finding.acceptedBy || null,
    ticket: finding.disposition === 'follow-up' ? tickets.get(text(finding.rootCause))?.url || null : null,
  }));
  return { pr: key.pr, headSha: key.headSha, baseSha: String(input.baseSha).toLowerCase(), contractDigest: String(input.contractDigest).toLowerCase(), classification, reasons, findings, droppedMinors: input.droppedMinors, groups, pending, requiredChecks: input.requiredChecks.map(({ name, conclusion }) => ({ name, conclusion })) };
}

// The digest covers only the fields the contract defines, in a fixed key
// order, so key order, extra fields, SHA case and padding do not change it.
function canonicalPacket(packet) {
  return {
    baseSha: String(packet.baseSha).toLowerCase(),
    contractDigest: String(packet.contractDigest).toLowerCase(),
    reviewIds: [...new Set(packet.reviewIds.map((id) => normalizeReviewId(id)))].sort(compareReviewIds),
    acceptance: packet.acceptance.map((ac) => ({ id: text(ac.id), met: ac.met === true })),
    requiredChecks: packet.requiredChecks.map((check) => ({ name: text(check.name), conclusion: text(check.conclusion) })),
    reviewsTerminal: packet.reviewsTerminal,
    openChoices: packet.openChoices.map(text),
    // Present only when declared, so the digest of a packet without the declaration is unchanged.
    ...(packet.reviewerUnavailable === true ? { reviewerUnavailable: true } : {}),
    findings: packet.findings.map((f) => ({ id: text(f.id), url: text(f.url) || null, local: f.local ? { file: text(f.local.file), span: f.local.span.trim() } : null, disposition: f.disposition || null, rootCause: text(f.rootCause), releaseBlocking: [...(f.releaseBlocking || [])].sort(), rationale: text(f.rationale), acceptedBy: text(f.acceptedBy) })),
    droppedMinors: packet.droppedMinors.map((d) => ({ id: text(d.id), reason: text(d.reason) })),
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

function collectedMinorIds(input) {
  return collectedMinors(input).map((minor) => minor.id).sort();
}

// A record covers the review batch active when it was written; a review recorded or rejected later is new evidence
// and lifts the terminal state.
function deliveryBatchCurrent(input, record) {
  return !!record && JSON.stringify(record.reviewIds) === JSON.stringify(activeReviewIds(input));
}

// A merge also needs the record to cover the minors collected when it was written; a minor collected later only
// blocks the merge until the delivery is recorded again, and leaves request and fix claims terminal.
function deliveryCurrent(input, record) {
  return deliveryBatchCurrent(input, record) && JSON.stringify(record.minorIds) === JSON.stringify(collectedMinorIds(input));
}

// A fix claim also finds the delivery stale when a waiver changed the cap it would spend (`fixCap` 'bot' or 'human')
// since the record was written; review-request claims depend on the review batch alone.
function deliveryTerminal(input, { fixCap = null } = {}) {
  const latest = latestDelivery(input);
  if (!latest || latest.classification === 'blocked' || !deliveryBatchCurrent(input, latest)) return null;
  if (fixCap && latest.budgets?.[fixCap === 'human' ? 'humanFix' : 'fix']?.max !== fixBudget(input, fixCap === 'human').max) return null;
  return { claimed: false, reason: 'delivery-terminal', classification: latest.classification };
}

function recordDelivery(input) {
  const { stateDir, now = Date.now(), packet } = input;
  const key = validate(input);
  classifyDelivery({ ...packet, ...key }); // a malformed packet throws before the lock
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonicalPacket(packet))).digest('hex');
  return withTransitionLock({ stateDir, pr: key.pr }, () => {
    if (fixRoundForHead({ stateDir, ...key })) return { recorded: false, reason: 'fix-round-open' };
    const minorIds = collectedMinorIds({ stateDir, pr: key.pr });
    const classified = classifyDelivery({ ...packet, ...key }, minorIds);
    const records = deliveryRecords({ stateDir, ...key });
    const latest = records.at(-1);
    const reviewIds = activeReviewIds({ stateDir, ...key });
    const observed = canonicalPacket(packet).reviewIds;
    if (JSON.stringify(observed) !== JSON.stringify(reviewIds)) return { recorded: false, reason: 'review-batch-changed', reviewIds };
    if (latest && latest.digest === digest && deliveryCurrent({ stateDir, ...key }, latest)) return latest;
    const sequence = (latest ? latest.sequence : 0) + 1;
    const record = { ...classified, reviewIds, minorIds, digest, sequence, recordedAtMs: now, budgets: { request: requestBudget({ stateDir, pr: key.pr }), fix: fixBudget({ stateDir, pr: key.pr }), humanFix: humanFixBudget({ stateDir, pr: key.pr }) } };
    if (!writeExclusive(markerPath({ stateDir, ...key }, `delivery-${String(sequence).padStart(6, '0')}`), record)) throw new Error('review-lgtm-state: delivery record collided; retry');
    return record;
  }, { recorded: false, reason: 'transition-busy' });
}

// The reviewer selection is an append-only series of records; the highest sequence is current.
function selectionRecords({ stateDir, pr }) {
  const prefix = `pr-${pr}.reviewers-`;
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => readMarker(path.join(stateDir, name)))
    .filter((record) => record && record.pr === Number(pr) && Number.isSafeInteger(record.sequence))
    .sort((a, b) => a.sequence - b.sequence);
}

function latestSelection({ stateDir, pr }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  const latest = selectionRecords({ stateDir, pr }).at(-1);
  return latest ? { sequence: latest.sequence, reviewers: latest.reviewers, recordedAtMs: latest.recordedAtMs } : null;
}

// A bot is stored under the lowercased slug the collector and --reviewer use (logins are case-insensitive); GitHub's REST login for it can differ (Copilot's is `Copilot`), so only a person's login comes from the API.
const accountOf = ({ login, id, type }, slug) => ({ login: type === 'Bot' ? slug.toLowerCase() : login, id, type });

// Resolves typed logins to accounts, or names each login it refuses.
function accountsOf(logins, github, authorId) {
  const refused = [];
  const selection = [];
  for (const raw of logins) {
    const login = raw.replace(/^@/, '');
    // Fail closed: a typed [bot] login names only a Bot, and a bare login that is both a person's and a bot's account names neither. An app's bare login is an Organization on GitHub, so an Organization next to a Bot selects the Bot.
    const asBot = (found) => (found && found.type === 'Bot' ? found : null);
    let user;
    if (/\[bot\]$/.test(login)) user = asBot(github.userByLogin(login));
    else {
      const plain = github.userByLogin(login);
      const bot = asBot(github.userByLogin(`${login}[bot]`));
      if (plain?.type === 'User' && bot) { refused.push({ login, why: 'ambiguous' }); continue; }
      user = (plain?.type === 'Organization' && bot) || plain || bot;
    }
    if (!user) refused.push({ login, why: 'not-found' });
    else if (user.type === 'Organization') refused.push({ login, why: 'organization' });
    else if (user.id === authorId) refused.push({ login, why: 'pr-author' });
    else if (!selection.some((account) => account.id === user.id)) selection.push(accountOf(user, login.replace(/\[bot\]$/, '')));
  }
  return { selection, refused };
}

// GitHub lookups are slow and can stall, so they run before the transition lock; the lock only re-checks that no other selection landed meanwhile and writes.
function selectReviewers({ stateDir, pr, logins, none = false, github, now = Date.now() }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw new Error('review-lgtm-state: PR number must be a positive integer');
  const number = Number(pr);
  const latest = selectionRecords({ stateDir, pr: number }).at(-1);
  let selection;
  let gone = [];
  if (none) {
    if (logins && logins.length > 0) throw new Error('review-lgtm-state: --none cannot be combined with --reviewer');
    // Observing every account is the empty selection; one already in force needs no record.
    selection = [];
    if (!latest || latest.reviewers.length === 0) return { selected: true, recorded: false, selection, gone };
  } else if (logins && logins.length > 0) {
    let refused;
    ({ selection, refused } = accountsOf(logins, github, github.prAuthorId(number)));
    if (refused.length > 0) return { selected: false, reason: 'refused', refused };
    // Every collect and watch repeats --reviewer; an unchanged selection writes nothing and needs no lock.
    if (latest && JSON.stringify(selection) === JSON.stringify(latest.reviewers)) return { selected: true, recorded: false, selection, gone };
  } else {
    // Resume: re-resolve the stored accounts by id so a rename follows the account and a deleted account stays recorded as gone.
    selection = (latest?.reviewers || []).map((reviewer) => {
      const user = github.userById(reviewer.id);
      return user ? accountOf(user, reviewer.login) : { ...reviewer, gone: true };
    });
    gone = selection.filter((reviewer) => reviewer.gone).map((reviewer) => reviewer.id);
    if (!latest || JSON.stringify(selection) === JSON.stringify(latest.reviewers)) return { selected: true, recorded: false, selection, gone };
  }
  return withTransitionLock({ stateDir, pr: number }, () => {
    if ((selectionRecords({ stateDir, pr: number }).at(-1)?.sequence ?? 0) !== (latest?.sequence ?? 0)) return { selected: false, reason: 'transition-busy' };
    const sequence = (latest ? latest.sequence : 0) + 1;
    if (!writeExclusive(path.join(stateDir, `pr-${number}.reviewers-${String(sequence).padStart(6, '0')}.json`), { pr: number, sequence, reviewers: selection, recordedAtMs: now })) throw new Error('review-lgtm-state: reviewer record collided; retry');
    return { selected: true, recorded: true, selection, gone };
  }, { selected: false, reason: 'transition-busy' });
}

// The selection collect and watch use: named reviewers replace the stored selection, and a stored selection is refreshed by id.
// With neither, the selection is empty and every account is observed; nothing is written.
function reviewerSelection({ stateDir, pr, logins, github, now = Date.now() }) {
  return selectReviewers({ stateDir, pr, logins: logins.length > 0 ? logins : null, github, now });
}

// gh answers HTTP 404 for an unknown or deleted account; that is a null, every other failure is the caller's.
const GH_TIMEOUT_MS = 30000;
function ghUsers(repoRoot, exec = execFileSync) {
  const gh = crossPlatformCommand('gh', repoRoot);
  const api = (...args) => {
    try { return exec(gh, crossPlatformArgs(['api', ...args], needsDoubleEscape('gh', repoRoot)), crossPlatformOpts({ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GH_TIMEOUT_MS })); }
    catch (error) {
      if (/HTTP 404/.test(String(error.stderr || ''))) return null;
      throw error;
    }
  };
  const user = (endpoint) => { const out = api(endpoint); if (out === null) return null; const { login, id, type } = JSON.parse(out); return { login, id, type }; };
  return {
    userByLogin: (login) => user(`users/${encodeURIComponent(login)}`),
    userById: (id) => user(`user/${Number(id)}`),
    prAuthorId: (pr) => { const out = api(`repos/{owner}/{repo}/pulls/${Number(pr)}`, '--jq', '.user.id'); if (out === null) throw new Error(`review-lgtm-state: PR ${Number(pr)} not found`); return Number(out); },
  };
}

// Answers whether the fix commit(s) between the head of the latest earlier fix round and `headSha`
// wrote any line in [start, end] of `file` as it stands at `headSha`. Uses only the path and line numbers, never the review text.
function selfFeeding({ repoRoot, stateDir, pr, headSha, file, start, end }) {
  const key = validate({ pr, headSha });
  if (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file) || file.split(path.sep === '\\' ? /[\\/]/ : '/').includes('..')) throw new Error('review-lgtm-state: file must be a relative path inside the repository');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('review-lgtm-state: line range must be positive integers with start <= end');
  let names;
  try { names = fs.readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const git = crossPlatformCommand('git', repoRoot);
  const run = (args) => execFileSync(git, crossPlatformArgs(['--literal-pathspecs', ...args], needsDoubleEscape('git', repoRoot)), crossPlatformOpts({ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));
  // The fix round is measured along the first-parent history, so the earlier fix head must sit on it; a head
  // that history does not list (rebased away, or absent from a shallow clone) counts as absent.
  let firstParent = null;
  const onFirstParent = (sha) => {
    firstParent = firstParent || new Set(run(['rev-list', '--first-parent', key.headSha]).split('\n').filter(Boolean));
    return firstParent.has(sha);
  };
  // Bot and human rounds share one history, ordered by when each was claimed.
  const previous = names.map((name) => ({ slot: /^pr-(\d+)\.(?:human-)?fix-round-slot-\d+\.json$/.exec(name), name }))
    .filter(({ slot }) => slot && Number(slot[1]) === key.pr)
    .map(({ name }) => ({ name, marker: readMarker(path.join(stateDir, name)) }))
    .filter(({ marker }) => marker && FULL_SHA.test(String(marker.headSha)) && marker.headSha !== key.headSha)
    .sort((a, b) => (b.marker.claimedAtMs || 0) - (a.marker.claimedAtMs || 0) || b.name.localeCompare(a.name))
    .map(({ marker }) => marker)
    .find((marker) => onFirstParent(marker.headSha));
  if (!previous) return { selfFeeding: false, previousFixHead: null };
  // A line is self-feeding when blame at the head attributes it to a commit made since the previous fix head.
  // Blame follows renames itself; -C attributes lines copied or moved by the fix to their origin, and textconv and configured
  // ignore lists are switched off so line numbers and attribution are those of the file at the head. git fails for a file missing at the head or a range starting past its end;
  // a range ending past the end is clamped by git to the last line.
  const fixCommits = new Set(run(['rev-list', '--first-parent', `${previous.headSha}..${key.headSha}`]).split('\n').filter(Boolean));
  const blamed = run(['blame', '-C', '-C', '--no-textconv', '--no-ignore-revs-file', '--porcelain', '-L', `${start},${end}`, key.headSha, '--', file]).split('\n')
    .map((line) => /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+/.exec(line)).filter(Boolean).map((match) => match[1]);
  return { selfFeeding: blamed.some((sha) => fixCommits.has(sha)), previousFixHead: previous.headSha };
}

// The finding's file is repository-relative, so git must run from the work tree root, not the caller's subdirectory.
function worktreeRoot(cwd) {
  const git = crossPlatformCommand('git', cwd);
  try {
    return execFileSync(git, crossPlatformArgs(['rev-parse', '--show-toplevel'], needsDoubleEscape('git', cwd)), crossPlatformOpts({ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch (error) {
    if (error.status === 128) return cwd; // a bare repository has no work tree; blame runs from where it is
    throw error;
  }
}

function fail(error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function runMain(repoRoot = process.cwd()) {
  const [verb, pr, headSha, argument] = process.argv.slice(2);
  const stateDir = defaultStateDir(repoRoot);
  if (verb === 'status') process.stdout.write(`${JSON.stringify(status({ stateDir, pr, headSha }))}\n`);
  else if (verb === 'open-window') process.stdout.write(`${JSON.stringify(openWindow({ stateDir, pr, headSha, durationMs: Number(argument) * 1000 }))}\n`);
  else if (verb === 'claim-initial-request') process.stdout.write(`${JSON.stringify(claimResult(claimInitialRequest({ stateDir, pr, headSha, provider: argument })))}\n`);
  else if (verb === 'recover-initial-request') process.stdout.write(`${JSON.stringify(claimResult(recoverInitialRequest({ stateDir, pr, headSha, provider: argument })))}\n`);
  else if (verb === 'mark-initial-requested') process.stdout.write(`${JSON.stringify({ marked: markInitialRequested({ stateDir, pr, headSha, provider: argument }) })}\n`);
  else if (verb === 'claim-fix-round') {
    // Empty stdin (or a terminal) takes no item ids.
    const raw = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
    const body = raw.trim() ? JSON.parse(raw) : { itemIds: [] };
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('review-lgtm-state: claim-fix-round reads {"itemIds":[...]} on stdin');
    process.stdout.write(`${JSON.stringify(claimFixRound({ stateDir, pr, headSha, itemIds: body.itemIds }))}\n`);
  }
  else if (verb === 'mark-fix-pushed') process.stdout.write(`${JSON.stringify(markFixPushed({ stateDir, pr, headSha, fixCommit: argument, owner: process.argv[6] }))}\n`);
  else if (verb === 'renew-fix-round') process.stdout.write(`${JSON.stringify(renewFixRound({ stateDir, pr, headSha, owner: argument }))}\n`);
  else if (verb === 'waive-fix-budget') {
    const flags = process.argv.slice(6);
    if (flags.length > 1 || (flags.length === 1 && flags[0] !== '--human')) throw new Error('review-lgtm-state: waive-fix-budget takes <pr> <person> <n> [--human]');
    process.stdout.write(`${JSON.stringify(waiveFixBudget({ stateDir, pr, person: headSha, count: Number(argument), human: flags[0] === '--human' }))}\n`);
  }
  else if (verb === 'collect-minor') process.stdout.write(`${JSON.stringify(collectMinor({ stateDir, pr, headSha, ...JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'claim-reply') process.stdout.write(`${JSON.stringify(claimReply({ stateDir, pr, itemId: headSha }))}\n`);
  else if (verb === 'record-reply') process.stdout.write(`${JSON.stringify(recordReply({ stateDir, pr, itemId: headSha, record: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'claim-approve-prompt') process.stdout.write(`${JSON.stringify(claimApprovePrompt({ stateDir, pr, headSha, reviewerId: Number(argument), itemId: process.argv[6] }))}\n`);
  else if (verb === 'find-reply') collector.findReply({ pr: prNumber(pr), itemId: validItem(headSha), graphql: collector.ghGraphql(repoRoot) }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), fail);
  else if (verb === 'merge-ready') process.stdout.write(`${JSON.stringify(mergeReady({ stateDir, pr, headSha, evidence: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'self-feeding') { const [start, end] = process.argv.slice(6); process.stdout.write(`${JSON.stringify(selfFeeding({ repoRoot: worktreeRoot(repoRoot), stateDir, pr, headSha, file: argument, start: Number(start), end: Number(end === undefined ? start : end) }))}\n`); }
  else if (verb === 'record-review') process.stdout.write(`${JSON.stringify(recordReview({ stateDir, pr, headSha, observation: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'record-delivery') process.stdout.write(`${JSON.stringify(recordDelivery({ stateDir, pr, headSha, packet: JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'reject-review-batch') process.stdout.write(`${JSON.stringify(rejectReviewBatch({ stateDir, pr, headSha, ...JSON.parse(fs.readFileSync(0, 'utf8')) }))}\n`);
  else if (verb === 'select-reviewers') process.stdout.write(`${JSON.stringify(selectReviewers({ stateDir, pr, logins: collector.reviewersFrom(process.argv.slice(4)), none: process.argv.slice(4).includes('--none'), github: ghUsers(repoRoot) }))}\n`);
  else if (verb === 'collect' || verb === 'watch') {
    // The selection is resolved once per run; a refusal or a busy selection prints its result and collects nothing.
    const resolved = reviewerSelection({ stateDir, pr, logins: collector.reviewersFrom(process.argv.slice(verb === 'collect' ? 5 : 4)), github: ghUsers(repoRoot) });
    if (!resolved.selected) { process.stdout.write(`${JSON.stringify(resolved)}\n`); process.exitCode = 1; return; }
    const { selection } = resolved;
    const graphql = collector.ghGraphql(repoRoot);
    if (verb === 'collect') collector.collect({ pr, head: headSha, graphql, selection, answered: answeredItemIds({ stateDir, pr, headSha }) }).then((packet) => process.stdout.write(`${collector.formatPacketLine(packet)}\n`), fail);
    else {
      const state = { status: (head) => status({ stateDir, pr, headSha: head }), openWindow: (head) => openWindow({ stateDir, pr, headSha: head, durationMs: collector.WINDOW_SECONDS * 1000 }), answered: (head) => answeredItemIds({ stateDir, pr, headSha: head }) };
      collector.watch({ pr, graphql, state, selection, write: (line) => process.stdout.write(`${line}\n`) }).catch(fail);
    }
  }
  else throw new Error('review-lgtm-state: use status, open-window, claim-initial-request, recover-initial-request, mark-initial-requested, claim-fix-round, renew-fix-round, mark-fix-pushed, waive-fix-budget, collect-minor, claim-reply, record-reply, find-reply, claim-approve-prompt, self-feeding, merge-ready, select-reviewers, collect, watch, record-review, reject-review-batch, or record-delivery');
}

module.exports = { defaultStateDir, markerPath, status, openWindow, claimInitialRequest, recoverInitialRequest, markInitialRequested, claimFixRound, renewFixRound, markFixPushed, waiveFixBudget, collectMinor, itemFileKey, accountFileKey, claimReply, recordReply, claimApprovePrompt, answeredItemIds, mergeReady, selfFeeding, recordReview, rejectReviewBatch, classifyDelivery, recordDelivery, selectReviewers, reviewerSelection, latestSelection, ghUsers, INITIAL_CLAIM_LEASE_MS, AUTO_REVIEW_GRACE_MS, MAX_REQUESTS_PER_PR, MAX_FIX_ROUNDS_PER_PR, MAX_HUMAN_FIX_ROUNDS_PER_PR, humanFixBudget, runMain };
