'use strict';
const review = require('./review');
const { REVIEW_PARK_BUDGET_DEFAULT } = require('./config');

// The engine: "the agent drives, the CLI enforces" (design §4). This module
// orchestrates one round and the full loop on top of the deterministic core in
// review.js. It is unit-testable end to end: every side-effecting call --
// the LLM (`runGate`), DoD-exec, and git -- is an injected dependency. No
// module-level require of child_process/claude here; the real implementations
// live in review-engine.js, the thin entry that wires them.
//
// Injected deps shape (all may be async or sync; every call is awaited):
//   runGate(prompt, opts) -> { text, costUsd }
//     opts: { mode: 'review'|'verify'|'fix', permissionMode?, addDir? }
//   runDodExec() -> { passed, results: [{ cmd, passed, exitCode, output }] }
//   gitOps: {
//     diff() -> string
//     commitFix(findingId, summary) -> sha string
//     isReachable(sha) -> boolean
//   }
//   spanStillPresent(file, span) -> boolean   (idempotent-replay content check)
//   repoRoot: string
//   stateDir: string                          (ledger read/write location)

// ---------------------------------------------------------------------------
// Fail-closed signaling
// ---------------------------------------------------------------------------

// A gate/tool that CANNOT RUN (auth failure, process error, unparsable
// output) -- fail-closed per design §9: this is not automatable right now and
// must abort the run immediately rather than being silently treated as "no
// findings" (which would recreate the green-but-wrong outcome the loop exists
// to prevent). Distinct from a `needs-decision` park, which is a normal,
// expected outcome (the fixer tried and a human call is needed).
class HarnessFailureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessFailureError';
  }
}

// ---------------------------------------------------------------------------
// Park-reason taxonomy (design §6/§8)
// ---------------------------------------------------------------------------

const PARK_KINDS = new Set(['needs-decision', 'harness-failure']);

function validateParkReason(reason) {
  if (!reason || typeof reason !== 'object') {
    throw new Error('park reason must be an object with { kind, text }');
  }
  if (!PARK_KINDS.has(reason.kind)) {
    throw new Error(`park reason kind must be one of ${Array.from(PARK_KINDS).join('|')}, got "${reason.kind}"`);
  }
  if (typeof reason.text !== 'string' || !reason.text.trim()) {
    throw new Error('park reason text must be a non-empty string');
  }
  return { kind: reason.kind, text: reason.text };
}

function countNeedsDecisionParks(ledger) {
  return (ledger.findings || []).filter((f) => f.status === 'parked' && f.park_reason && f.park_reason.kind === 'needs-decision').length;
}

// The park-budget circuit breaker (§8): needs-decision parks accumulate into
// the terminal batch, but if their count crosses a threshold the run should
// stop early rather than grinding the full round budget to produce a wall of
// packets. harness-failure parks do NOT count here -- they abort immediately
// via HarnessFailureError, they never accumulate.
function parkBudgetExceeded(ledger, threshold) {
  return countNeedsDecisionParks(ledger) >= (threshold || REVIEW_PARK_BUDGET_DEFAULT);
}

// ---------------------------------------------------------------------------
// Cost aggregation (owned by Node, not bash -- the spike lost it in subshells)
// ---------------------------------------------------------------------------

function createCostAccumulator() {
  let totalUsd = 0;
  let calls = 0;
  return {
    add(costUsd) {
      totalUsd += Number(costUsd) || 0;
      calls += 1;
    },
    totalUsd() {
      return totalUsd;
    },
    calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// Gate output contract: parse + validate
// ---------------------------------------------------------------------------

// "gate:stable-slug" -- lowercase, hyphen-separated, two colon-joined parts.
const FINDING_ID_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

function isValidFindingId(id) {
  return typeof id === 'string' && FINDING_ID_RE.test(id);
}

function stripFences(text) {
  const s = String(text == null ? '' : text).trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  return m ? m[1].trim() : s;
}

// Parses the correctness gate's raw text output into validated findings. The
// gate output CONTRACT (design §6/§7) requires each finding to carry a stable
// `id` of shape "gate:slug" -- this is the finding-identity correction's other
// half: review.js's dedupe only works if the gate actually emits a stable id,
// so a malformed/missing id is a hard parse failure (harness-failure), not a
// silently-dropped finding.
function parseGateFindings(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch (e) {
    throw new Error(`correctness gate did not return valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('correctness gate output must be a JSON array of findings');
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`finding[${i}] is not an object`);
    if (!isValidFindingId(f.id)) {
      throw new Error(`finding[${i}].id "${f.id}" is not a stable "gate:slug" id (contract violation)`);
    }
    if (typeof f.file !== 'string' || !f.file) throw new Error(`finding[${i}] (${f.id}) is missing "file"`);
    if (typeof f.summary !== 'string' || !f.summary) throw new Error(`finding[${i}] (${f.id}) is missing "summary"`);
    return {
      id: f.id,
      gate: typeof f.gate === 'string' && f.gate ? f.gate : f.id.split(':')[0],
      file: f.file,
      span: typeof f.span === 'string' ? f.span : '',
      summary: f.summary,
      status: 'confirmed',
    };
  });
}

function parseVerifyVerdict(rawText, candidateFindings) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch (e) {
    throw new Error(`verify gate did not return valid JSON: ${e.message}`);
  }
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected.filter((id) => typeof id === 'string') : [];
  const validIds = new Set((candidateFindings || []).map((f) => f.id));
  return { rejectedIds: rejected.filter((id) => validIds.has(id)) };
}

// ---------------------------------------------------------------------------
// Prompt builders (§5: distrust-green folded in)
// ---------------------------------------------------------------------------

function renderDodOutput(dod) {
  if (!dod || !dod.results || !dod.results.length) return '(not run / not available)';
  return dod.results.map((r) => `$ ${r.cmd}\nexit=${r.exitCode}\n${r.output}`).join('\n\n');
}

function buildCorrectnessPrompt({ diff, dod }) {
  return [
    'You are the correctness reviewer in an automated review-until-green loop.',
    'Review the diff below for: correctness bugs, reuse opportunities, simplification, and efficiency issues.',
    '',
    'Do NOT accept "it passes" at face value -- distrust a green run. Specifically check whether the',
    'assertion/test actually exercises the real postcondition (not a dead-code matcher), look for',
    'count/index mismatches (off-by-one, wrong bound, wrong length), and look for resource/lock leaks',
    'across pooled sessions or iterations.',
    '',
    'Reply with ONLY a JSON array of findings (no markdown fences, no prose). Each element:',
    '  { "id": "<gate>:<stable-slug>", "gate": "correctness", "file": "<path>", "span": "<exact offending text>", "summary": "<one sentence>" }',
    'The "id" MUST be a STABLE slug for this specific bug/location: if you report the SAME bug again in a',
    'later round -- even with different wording in "summary" -- reuse the SAME id. It is the loop\'s dedupe key.',
    'If there is nothing to report, reply with an empty JSON array: []',
    '',
    '--- DoD-exec output ---',
    renderDodOutput(dod),
    '',
    '--- diff ---',
    diff || '(empty diff)',
  ].join('\n');
}

function buildVerifyPrompt({ diff, findings }) {
  const list = (findings || [])
    .map((f) => `- id: ${f.id}\n  file: ${f.file}\n  span: ${JSON.stringify(f.span)}\n  summary: ${f.summary}`)
    .join('\n');
  return [
    'Re-review the candidate findings below against the diff. For each, decide REAL (confirmed) or FALSE POSITIVE.',
    'Reply with ONLY { "rejected": ["<id>", ...] } listing the ids you judge false positives (empty array if all real).',
    'No prose, no markdown fences.',
    '',
    '--- candidate findings ---',
    list || '(none)',
    '',
    '--- diff ---',
    diff || '(empty diff)',
  ].join('\n');
}

function buildFixPrompt(finding, repoRoot) {
  return [
    `In the repo at ${repoRoot}, apply the minimal correct fix for this confirmed finding:`,
    `  id: ${finding.id}`,
    `  file: ${finding.file}`,
    `  issue: ${finding.summary}`,
    finding.span ? `  offending text: ${JSON.stringify(finding.span)}` : '',
    '',
    'Edit the file directly using your Edit tool -- do not just describe the fix.',
    'Reply with ONLY {"edited": true} when done.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Resume git-reachability (§7): lives here, not in the pure core, because it
// calls git.
// ---------------------------------------------------------------------------

// If the ledger's recorded head_sha is no longer reachable from the current
// branch (rebase/amend/force-push), the recorded fixed/parked lifecycle is
// suspect -- stored commit SHAs are not trusted. Re-derive by resetting those
// findings back to open and dropping their `seen` entries, so the next round's
// gate re-detects the ledger's true state fresh against the CURRENT tree
// instead of trusting stale bookkeeping.
async function checkResumeReachability(ledger, gitOps) {
  const headSha = ledger.target && ledger.target.head_sha;
  if (!headSha) return { ledger, reachable: true, suspect: false };
  const reachable = await gitOps.isReachable(headSha);
  if (reachable) return { ledger, reachable: true, suspect: false };

  const resetIds = new Set((ledger.findings || []).filter((f) => f.status === 'fixed' || f.status === 'parked').map((f) => f.id));
  const findings = (ledger.findings || []).map((f) => (resetIds.has(f.id) ? { ...f, status: 'open', fix_commit: null, park_reason: null } : f));
  const seen = (ledger.seen || []).filter((s) => !resetIds.has(s.id));
  const next = { ...ledger, findings, seen, status: 'converging' };
  return { ledger: next, reachable: false, suspect: true };
}

// ---------------------------------------------------------------------------
// One round: DoD-exec + correctness gate + re-review verification + fixer
// ---------------------------------------------------------------------------

async function callGate(deps, prompt, opts, label) {
  let result;
  try {
    result = await deps.runGate(prompt, opts);
  } catch (e) {
    // Fail-closed: the gate could not run at all (auth/tool/process error).
    throw new HarnessFailureError(`${label} gate call failed: ${e && e.message ? e.message : e}`);
  }
  deps.costAcc.add(result && result.costUsd);
  return result;
}

// Runs one round against `ledger` (already begun via review.beginRound) and
// returns an outcome object shaped for review.applyRoundOutcome.
async function runRound(deps, ledger, ctx) {
  let dod;
  try {
    dod = await deps.runDodExec();
  } catch (e) {
    throw new HarnessFailureError(`DoD-exec could not run: ${e && e.message ? e.message : e}`);
  }

  const reviewResult = await callGate(deps, buildCorrectnessPrompt({ diff: ctx.diff, dod }), { mode: 'review', addDir: deps.repoRoot }, 'correctness');
  let candidateFindings;
  try {
    candidateFindings = parseGateFindings(reviewResult.text);
  } catch (e) {
    // A malformed gate contract violation cannot be treated as "no findings"
    // -- that would be the exact green-but-wrong failure mode the loop exists
    // to prevent. Fail-closed.
    throw new HarnessFailureError(e.message);
  }

  let killedIds = [];
  if (candidateFindings.length) {
    const verifyResult = await callGate(
      deps,
      buildVerifyPrompt({ diff: ctx.diff, findings: candidateFindings }),
      { mode: 'verify', addDir: deps.repoRoot },
      'verify'
    );
    let verdict;
    try {
      verdict = parseVerifyVerdict(verifyResult.text, candidateFindings);
    } catch (e) {
      throw new HarnessFailureError(e.message);
    }
    killedIds = verdict.rejectedIds;
  }

  const confirmed = candidateFindings.filter((f) => !killedIds.includes(f.id));

  const fixedIds = [];
  const fixCommits = {};
  const parkedIds = [];
  const parkReasons = {};

  for (const f of confirmed) {
    const alreadyKnown = (ledger.findings || []).some((x) => x.id === f.id);
    // Guarded by findingStillOpen: a finding this ledger already concluded
    // (fixed/parked/killed) in a PRIOR round is not re-attempted here --
    // review.applyRoundOutcome's dedupe will drop it against `seen` anyway,
    // but skipping the (costly) fix attempt here avoids wasted LLM calls.
    // Brand-new findings (not yet known to the ledger at all) are exempt from
    // this check -- there is nothing to replay for them.
    if (alreadyKnown && !review.findingStillOpen(ledger, f.id)) continue;

    // Idempotent-replay content guard (review.js's own contract on
    // findingStillOpen): a prior round may have crashed AFTER committing a fix
    // but BEFORE the ledger write landed, in which case the ledger still says
    // "open" (or doesn't know the finding at all) even though the code is
    // already fixed. Re-check the actual file content before acting so a
    // replay is a no-op rather than a double-fix.
    let stillPresent = true;
    try {
      stillPresent = await deps.spanStillPresent(f.file, f.span);
    } catch (e) {
      stillPresent = true; // cannot verify -- proceed as if it needs fixing
    }
    if (!stillPresent) {
      const prior = (ledger.findings || []).find((x) => x.id === f.id);
      fixedIds.push(f.id);
      fixCommits[f.id] = (prior && prior.fix_commit) || 'unknown (idempotent replay: span already absent)';
      continue;
    }

    try {
      const fixResult = await deps.runGate(buildFixPrompt(f, deps.repoRoot), { mode: 'fix', permissionMode: 'acceptEdits', addDir: deps.repoRoot });
      deps.costAcc.add(fixResult && fixResult.costUsd);
      const sha = await deps.gitOps.commitFix(f.id, f.summary);
      fixedIds.push(f.id);
      fixCommits[f.id] = sha;
    } catch (e) {
      // A single finding's fix attempt failing is a normal, expected outcome
      // (not a harness-failure) -- park it for a human decision.
      parkedIds.push(f.id);
      parkReasons[f.id] = validateParkReason({ kind: 'needs-decision', text: `auto-fix failed: ${e && e.message ? e.message : e}` });
    }
  }

  return {
    dodPassed: dod.passed,
    findings: candidateFindings,
    fixedIds,
    parkedIds,
    killedIds,
    specDoubtScope: 'none',
    fixCommits,
    parkReasons,
    dodResults: dod.results,
  };
}

// ---------------------------------------------------------------------------
// The full loop
// ---------------------------------------------------------------------------

// Runs rounds until the CLI-equivalent core (review.js) says converge/park/
// abandon, or the park-budget circuit breaker trips, or a gate fails closed.
// deps additionally needs: stateDir, costAcc (optional; created if absent).
async function runLoop(deps, target, opts = {}) {
  const stateDir = deps.stateDir;
  const slug = review.targetSlug(target.ref);
  const parkBudget = opts.parkBudget || REVIEW_PARK_BUDGET_DEFAULT;
  const costAcc = deps.costAcc || createCostAccumulator();
  const rounds = [];
  let aborted = null;
  let ledger = review.readLedger(stateDir, slug) || review.emptyLedger(target);

  for (;;) {
    const reach = await checkResumeReachability(ledger, deps.gitOps);
    ledger = reach.ledger;
    let mutated = reach.suspect;

    // Refresh the ledger's recorded target to THIS invocation's target (in
    // particular head_sha) once the reachability check has run against
    // whatever was previously recorded. Without this, a stale head_sha would
    // re-trigger the same reachability check (and, if still unreachable, the
    // same reset) on every subsequent round forever.
    if (target && target.head_sha && (!ledger.target || ledger.target.head_sha !== target.head_sha)) {
      ledger = { ...ledger, target: { ...(ledger.target || {}), ...target } };
      mutated = true;
    }
    if (mutated) review.writeLedger(stateDir, slug, ledger);

    const diff = await deps.gitOps.diff();
    const diffHash = review.contentHash(diff);
    const begun = review.beginRound(ledger, diffHash);
    ledger = begun.ledger;
    review.writeLedger(stateDir, slug, ledger);

    if (begun.terminal || !begun.workHappened) break; // nothing to do this iteration

    let outcome;
    try {
      outcome = await runRound({ ...deps, costAcc }, ledger, { diff });
    } catch (e) {
      if (e instanceof HarnessFailureError) {
        aborted = { kind: 'harness-failure', message: e.message };
        break;
      }
      throw e;
    }

    const recorded = review.applyRoundOutcome(ledger, outcome);
    ledger = recorded.ledger;
    review.writeLedger(stateDir, slug, ledger);
    rounds.push({ round: begun.ledger.round, decision: recorded.decision });

    if (parkBudgetExceeded(ledger, parkBudget)) {
      aborted = { kind: 'park-budget', message: `needs-decision parks reached the budget (${parkBudget}); stopping early rather than grinding the full round budget.` };
      break;
    }
    if (!recorded.decision.continue) break;
  }

  return { ledger, rounds, aborted, cost: { totalUsd: costAcc.totalUsd(), calls: costAcc.calls() } };
}

module.exports = {
  HarnessFailureError,
  validateParkReason,
  countNeedsDecisionParks,
  parkBudgetExceeded,
  createCostAccumulator,
  isValidFindingId,
  parseGateFindings,
  parseVerifyVerdict,
  buildCorrectnessPrompt,
  buildVerifyPrompt,
  buildFixPrompt,
  checkResumeReachability,
  runRound,
  runLoop,
};
