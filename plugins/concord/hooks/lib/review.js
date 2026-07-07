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

// LINE-NUMBER-INDEPENDENT identity+content hash for a finding. Deliberately built
// from (gate, file, normalized span, normalized summary) -- never `line` -- so a
// fix elsewhere in the diff that shifts line numbers cannot change a killed
// finding's hash (the whole convergence guarantee depends on this).
//
// Because `finding.span` is always the CURRENT text at that location (the caller
// re-extracts it fresh every round), this hash inherently combines the finding's
// conceptual identity (gate/file/summary) with the span's current content: fixing
// the code changes the span text, which changes this hash: the pre-fix hash is
// left behind in `seen` tagged status "fixed". If an external change later
// reverts the span back to the exact pre-fix content, recomputing this hash
// reproduces that same pre-fix hash again -- dedupeAgainstSeen treats a "fixed"
// match as a reopen rather than a permanent suppression (see below), so the
// regression resurfaces instead of being silently swallowed.
function seenHash(finding) {
  const parts = [finding.gate, finding.file, normalizeText(finding.span), normalizeText(finding.summary)];
  return contentHash(parts.join('␟'));
}

// Filter raw findings against the ledger's seen set.
//   - matches a "killed" or "parked" seen entry (adjudicated, content unchanged)
//     -> suppressed (dropped).
//   - matches a "fixed" seen entry -> content reverted to a previously-fixed
//     state -> NOT suppressed; marked `reopened: true` so callers/tests can tell
//     this apart from a first-time finding.
//   - no match -> passes through unchanged (fresh finding).
function dedupeAgainstSeen(findings, seen) {
  const bySig = new Map();
  for (const s of seen || []) bySig.set(s.hash, s.status);
  const survivors = [];
  for (const f of findings) {
    const status = bySig.get(seenHash(f));
    if (status === 'killed' || status === 'parked') continue;
    if (status === 'fixed') {
      survivors.push(Object.assign({}, f, { reopened: true }));
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
//   2. dodPassed && openFindingsCount === 0 -> converged ("clean"). Clean is
//      defined as the executable gate having run-and-passed AND zero confirmed
//      reviewer findings -- reviewer silence alone (dodPassed false) is
//      deliberately NOT enough; see the next branch.
//   3. budgetSpent >= maxRounds -> parked. Round budget exhausted.
//   4. noProgress (zero fixes this round and the same findings persist) ->
//      parked. Do not keep burning rounds once nothing is moving.
//   5. otherwise -> continue (status stays "converging").
// Oscillation detection (a finding toggling fixed -> reopened -> fixed) is
// deliberately out of scope for this shell (deferred per the plan).
function decideTermination(roundOutcome) {
  const { dodPassed, openFindingsCount, specDoubtScope, noProgress, budgetSpent, maxRounds } = roundOutcome;

  if (specDoubtScope === 'whole-diff') {
    return { continue: false, converged: false, parked: false, abandoned: true, reason: 'spec-doubt invalidates the whole diff' };
  }
  if (dodPassed && openFindingsCount === 0) {
    return { continue: false, converged: true, parked: false, abandoned: false, reason: 'DoD-exec ran and passed with zero confirmed findings' };
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

// Starts a new round against `diffContentHash`. If it is identical to the
// ledger's last-seen diff hash, this is a no-op round (nothing changed since the
// last round ran) and must NOT consume budget or advance the round counter --
// otherwise an idle resume (agent calls round-start before re-diffing) would
// burn the budget for free. Returns a NEW ledger object (does not mutate the
// input) plus a `noOp` flag for the caller.
function beginRound(ledger, diffContentHash) {
  const noOp = ledger.diff_content_hash !== null && ledger.diff_content_hash === diffContentHash;
  const next = {
    ...ledger,
    round: noOp ? ledger.round : ledger.round + 1,
    budget: { ...ledger.budget, spent: noOp ? ledger.budget.spent : ledger.budget.spent + 1 },
    diff_content_hash: diffContentHash,
  };
  return { ledger: next, noOp };
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
      newSeenEntries.push({ hash: seenHash(f), status });
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
