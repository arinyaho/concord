'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REVIEW_MAX_ROUNDS_DEFAULT } = require('./config');

// Pure, unit-testable core for review-until-green. No LLM calls, no process
// spawning, no network -- the "CLI enforces, the agent drives" model: this module
// is the deterministic authority on ledger state, dedupe, and termination; the
// agent supplies judgment (what a finding means, whether a fix is correct).

// ---------------------------------------------------------------------------
// Ledger path + read/write
// ---------------------------------------------------------------------------

function ledgerPath(stateDir, slug) {
  return path.join(stateDir, `review-${slug}.json`);
}

// Returns the parsed ledger, or null if absent or corrupt (mirrors charter.js's
// readNorthStar: a missing/broken durable file degrades to "nothing yet", it
// never throws and blocks the caller).
function readLedger(stateDir, slug) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(stateDir, slug), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeLedger(stateDir, slug, ledger) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(ledgerPath(stateDir, slug), JSON.stringify(ledger));
}

function emptyLedger(target) {
  return {
    target,
    status: 'converging',
    round: 0,
    budget: { max_rounds: REVIEW_MAX_ROUNDS_DEFAULT, spent: 0 },
    diff_content_hash: null,
    gates: {},
    findings: [],
    seen: [],
    history: [],
    phase: 'idle',
    dod: null,
    planned: [],
    journal: [],
    last_recorded_round: null,
  };
}

// ---------------------------------------------------------------------------
// Target ref slug (ledger filename component)
// ---------------------------------------------------------------------------

// Slug rule: replace every run of characters outside [A-Za-z0-9._-] with a single
// '-' (this folds branch-name '/' the same way resolveStateDirFromCwd folds cwd's
// '/' and '.'), then trim leading/trailing '-'. Falls back to 'unknown' for an
// empty/absent ref so the ledger filename is never degenerate.
function targetSlug(ref) {
  const slug = String(ref || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

// ---------------------------------------------------------------------------
// Content hashing + seen-dedupe
// ---------------------------------------------------------------------------

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

// Normalize for hashing: case/whitespace-insensitive, matching state.js's
// normalizeText intent (a finding restated with different casing/spacing is the
// same finding).
function normalizeText(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// LINE-NUMBER-INDEPENDENT content hash for a finding -- a SECONDARY signal.
// Deliberately built from (gate, file, normalized span, normalized summary) --
// never `line` -- so a fix elsewhere in the diff that shifts line numbers cannot
// change it. Historically this was also the PRIMARY dedupe key, but hashing
// summary *prose* mints a phantom "new" finding whenever an LLM rephrases the
// same bug between rounds (found by the engine spike). Identity is now the
// gate-emitted stable `finding.id` (see dedupeAgainstSeen); this hash survives
// only as a secondary signal to tell a byte-identical revert apart from a
// same-id recurrence with different content.
function seenHash(finding) {
  const parts = [finding.gate, finding.file, normalizeText(finding.span), normalizeText(finding.summary)];
  return contentHash(parts.join('␟'));
}

// Filter raw findings against the ledger's seen set. PRIMARY identity is
// `finding.id` -- a stable slug the gate emits as part of its output contract
// (e.g. "correctness:assignment-in-condition"), NOT a hash of prose that
// reflows every time the LLM rephrases the same bug. `seen` entries carry both
// `id` (primary) and `hash` (secondary, line-independent content signature).
//   - id matches a "killed" or "parked" seen entry -> suppressed (dropped);
//     adjudicated, and an id match is definitive regardless of minor content
//     drift around it (renumbered lines, nearby edits).
//   - id matches a "fixed" seen entry -> NOT suppressed; the same finding
//     recurred after being marked fixed (an external revert, or a fix that
//     didn't actually hold) -> `reopened: true`. `contentChanged` (derived from
//     the secondary hash) tells the caller whether this is a byte-identical
//     revert (`false`) or a recurrence with different content (`true`) --
//     diagnostic only, it does not change the reopen verdict.
//   - no id match -> passes through unchanged (fresh finding).
function dedupeAgainstSeen(findings, seen) {
  const byId = new Map();
  for (const s of seen || []) byId.set(s.id, s);
  const survivors = [];
  for (const f of findings) {
    const entry = byId.get(f.id);
    if (!entry) {
      survivors.push(f);
      continue;
    }
    if (entry.status === 'killed' || entry.status === 'parked') continue;
    if (entry.status === 'fixed') {
      survivors.push(Object.assign({}, f, { reopened: true, contentChanged: entry.hash !== seenHash(f) }));
      continue;
    }
    survivors.push(f);
  }
  return survivors;
}

// ---------------------------------------------------------------------------
// Termination state machine
// ---------------------------------------------------------------------------

// roundOutcome: { dodPassed, openFindingsCount, specDoubtScope, noProgress,
//                 budgetSpent, maxRounds }
//
// Mapping (checked in this order -- spec-doubt is an exception that overrides
// everything else, per the design spec's termination section):
//   1. specDoubtScope === 'whole-diff' -> abandoned. The plan/AC itself is
//      wrong for the whole diff; continuing to fix on top of a bad foundation
//      is worse than stopping.
//   2. dodPassed && openFindingsCount === 0 && fixedCount === 0 -> converged
//      ("clean"). Clean is defined as the executable gate having run-and-passed,
//      zero confirmed reviewer findings, AND zero fixes applied this round --
//      a round that just applied fixes cannot be the clean round itself: the
//      fixes need one more (free, no-fix) confirmation round to prove they
//      actually hold. Reviewer silence alone (dodPassed false) is deliberately
//      NOT enough either; see the next branch.
//   3. budgetSpent >= maxRounds -> parked. Round budget exhausted.
//   4. noProgress (zero fixes this round and the same findings persist) ->
//      parked. Do not keep burning rounds once nothing is moving.
//   5. otherwise -> continue (status stays "converging").
// Oscillation detection (a finding toggling fixed -> reopened -> fixed) is
// deliberately out of scope for this shell (deferred per the plan).
function decideTermination(roundOutcome) {
  const { dodPassed, openFindingsCount, specDoubtScope, noProgress, budgetSpent, maxRounds, fixedCount = 0 } = roundOutcome;

  if (specDoubtScope === 'whole-diff') {
    return { continue: false, converged: false, parked: false, abandoned: true, reason: 'spec-doubt invalidates the whole diff' };
  }
  if (dodPassed && openFindingsCount === 0 && fixedCount === 0) {
    return { continue: false, converged: true, parked: false, abandoned: false, reason: 'DoD-exec ran and passed, zero open findings, and no fixes this round (stable)' };
  }
  if (budgetSpent >= maxRounds) {
    return { continue: false, converged: false, parked: true, abandoned: false, reason: 'round budget exhausted' };
  }
  if (noProgress) {
    return { continue: false, converged: false, parked: true, abandoned: false, reason: 'no progress: zero fixes and findings unchanged' };
  }
  return { continue: true, converged: false, parked: false, abandoned: false, reason: 'round produced progress or findings remain' };
}

// ---------------------------------------------------------------------------
// Round accounting
// ---------------------------------------------------------------------------

// A ledger in one of these statuses has already concluded; the loop is over.
const TERMINAL_STATUSES = new Set(['clean', 'parked', 'abandoned']);

// Starts a new round against `diffContentHash`. Returns a NEW ledger object
// (does not mutate the input) plus three flags for the caller:
//   - `terminal`: the ledger was ALREADY in a concluded status (clean/parked/
//     abandoned) before this call. Round/budget are left untouched and the
//     input ledger is returned as-is. This is the fix for the spike's
//     off-by-one: its outer loop incremented a round counter on the very
//     iteration that only discovered "already converged, stop" -- a
//     terminal-state check is not a round of work and must not be counted as
//     one. Callers should treat `terminal: true` as "stop the loop now."
//   - `noOp`: `diffContentHash` is identical to the ledger's last-seen diff
//     hash (nothing changed since the last round ran) -- must NOT consume
//     budget or advance the round counter, otherwise an idle resume (agent
//     calls round-start before re-diffing) would burn the budget for free.
//   - `workHappened`: true exactly when this call started a REAL round (not
//     terminal, not a no-op) -- i.e. a round in which the engine is expected to
//     actually run the gates. Exposed separately from the `round` counter
//     itself so a caller can distinguish "the round number advanced" from "the
//     harness is about to do work this iteration" without re-deriving it from
//     `noOp`/`terminal`.
function beginRound(ledger, diffContentHash) {
  if (TERMINAL_STATUSES.has(ledger.status)) {
    return { ledger, noOp: true, workHappened: false, terminal: true };
  }
  const noOp = ledger.diff_content_hash !== null && ledger.diff_content_hash === diffContentHash;
  const next = {
    ...ledger,
    round: noOp ? ledger.round : ledger.round + 1,
    budget: { ...ledger.budget }, // spent is charged in record now, not here
    diff_content_hash: diffContentHash,
  };
  return { ledger: next, noOp, workHappened: !noOp, terminal: false };
}

// ---------------------------------------------------------------------------
// Idempotent-fixer support
// ---------------------------------------------------------------------------

// True only if the ledger currently records this finding id as status 'open'.
// The fixer calls this before touching a file: if a prior attempt crashed AFTER
// committing the fix but BEFORE the ledger write, the ledger still says 'open'
// (a fast-path false positive) -- the fixer is expected to also re-check the
// finding's actual span content before acting, so a replay that already landed
// the fix is a no-op edit rather than a double-fix. This function guards the
// cheap, common case: a finding already marked fixed/parked/killed, or unknown
// to this ledger, is never re-attempted.
function findingStillOpen(ledger, findingId) {
  const f = (ledger.findings || []).find((x) => x.id === findingId);
  return !!f && f.status === 'open';
}

// ---------------------------------------------------------------------------
// Apply a round's outcome (post round-start; does not touch round/budget)
// ---------------------------------------------------------------------------

// outcome: { dodPassed, findings, fixedIds, parkedIds, killedIds, specDoubtScope,
//            fixCommits?, parkReasons? }
//   findings: this round's raw candidate findings (gate + escalate-tiers output,
//             pre-dedupe), each { id, gate, file, span, summary, status }.
//   fixedIds/parkedIds/killedIds: finding ids whose lifecycle concluded this
//             round with that outcome.
//
// Returns { ledger: newLedger, decision } where decision is decideTermination's
// result and newLedger.status is set from it (clean|parked|abandoned|converging).
function applyRoundOutcome(ledger, outcome) {
  const fixedIds = new Set(outcome.fixedIds || []);
  const parkedIds = new Set(outcome.parkedIds || []);
  const killedIds = new Set(outcome.killedIds || []);
  const fixCommits = outcome.fixCommits || {};
  const parkReasons = outcome.parkReasons || {};

  const survivors = dedupeAgainstSeen(outcome.findings || [], ledger.seen);

  const priorOpenIds = new Set((ledger.findings || []).filter((f) => f.status === 'open').map((f) => f.id));

  const byId = new Map((ledger.findings || []).map((f) => [f.id, f]));
  const newSeenEntries = [];

  for (const f of survivors) {
    let status = 'open';
    if (fixedIds.has(f.id)) status = 'fixed';
    else if (parkedIds.has(f.id)) status = 'parked';
    else if (killedIds.has(f.id)) status = 'killed';

    const merged = {
      id: f.id,
      gate: f.gate,
      file: f.file,
      line: f.line,
      summary: f.summary,
      status,
      fix_commit: status === 'fixed' ? fixCommits[f.id] || null : null,
      park_reason: status === 'parked' ? parkReasons[f.id] || null : null,
    };
    byId.set(f.id, merged);

    if (status === 'fixed' || status === 'parked' || status === 'killed') {
      newSeenEntries.push({ id: f.id, hash: seenHash(f), status });
    }
  }

  const findings = Array.from(byId.values());
  const openFindingsCount = findings.filter((f) => f.status === 'open').length;
  const currentOpenIds = new Set(findings.filter((f) => f.status === 'open').map((f) => f.id));

  const sameOpenSet =
    priorOpenIds.size === currentOpenIds.size && Array.from(priorOpenIds).every((id) => currentOpenIds.has(id));
  const noProgress = fixedIds.size === 0 && sameOpenSet;

  const decision = decideTermination({
    dodPassed: !!outcome.dodPassed,
    openFindingsCount,
    specDoubtScope: outcome.specDoubtScope || 'none',
    noProgress,
    budgetSpent: ledger.budget.spent,
    maxRounds: ledger.budget.max_rounds,
    fixedCount: (outcome.fixedIds || []).length, // COUNT, not the in-scope Set named fixedIds
  });

  const status = decision.converged ? 'clean' : decision.parked ? 'parked' : decision.abandoned ? 'abandoned' : 'converging';

  const history = (ledger.history || []).concat([
    {
      round: ledger.round,
      fixes: fixedIds.size,
      new: survivors.filter((f) => !priorOpenIds.has(f.id) && !f.reopened).length,
      killed: killedIds.size,
    },
  ]);

  const next = {
    ...ledger,
    status,
    findings,
    seen: (ledger.seen || []).concat(newSeenEntries),
    history,
  };

  return { ledger: next, decision };
}

// ---------------------------------------------------------------------------
// Un-park: feeds a human decision back in (parked is not resumed automatically)
// ---------------------------------------------------------------------------

function unparkFinding(ledger, findingId) {
  const idx = (ledger.findings || []).findIndex((f) => f.id === findingId);
  if (idx === -1) throw new Error(`unparkFinding: no such finding id "${findingId}"`);
  const findings = ledger.findings.slice();
  findings[idx] = { ...findings[idx], status: 'open', park_reason: null };
  return { ...ledger, findings, status: 'converging' };
}

// ---------------------------------------------------------------------------
// Injector support: scan + render in-flight ledgers
// ---------------------------------------------------------------------------

function listLedgers(stateDir) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = /^review-(.+)\.json$/.exec(n);
    if (!m) continue;
    const ledger = readLedger(stateDir, m[1]);
    if (ledger) out.push({ slug: m[1], ledger });
  }
  return out;
}

// One line per in-flight (converging|parked) ledger. `clean`/`abandoned` are
// terminal-and-resolved and deliberately not surfaced every session start.
// `converging` gets a resume invitation; `parked` is report-only -- resuming a
// parked run automatically would defeat the point of parking it for a human
// decision (fix batch: "parked is not terminal if the injector resumes it").
function renderReviewReport(ledgers) {
  const lines = [];
  for (const { ledger } of ledgers || []) {
    const ref = ledger.target && ledger.target.ref;
    const open = (ledger.findings || []).filter((f) => f.status === 'open').length;
    const roundInfo = `round ${ledger.round}/${ledger.budget.max_rounds}`;
    if (ledger.status === 'converging') {
      lines.push(`review-until-green [${ref}]: ${roundInfo}, ${open} open finding(s) -- converging; resume with \`/review-until-green resume ${ref}\`.`);
    } else if (ledger.status === 'parked') {
      lines.push(`review-until-green [${ref}]: ${roundInfo}, ${open} open finding(s) -- parked, needs a human decision; see \`review-cli.js show ${ref}\` (unpark a finding with \`review-cli.js unpark ${ref} <findingId>\`).`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  TERMINAL_STATUSES,
  ledgerPath,
  readLedger,
  writeLedger,
  emptyLedger,
  targetSlug,
  contentHash,
  seenHash,
  dedupeAgainstSeen,
  decideTermination,
  beginRound,
  findingStillOpen,
  applyRoundOutcome,
  unparkFinding,
  listLedgers,
  renderReviewReport,
};
