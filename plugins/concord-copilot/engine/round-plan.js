'use strict';
// The round plan: which reviewer roles run this round, in what order and
// parallelism, and the exact prompt text each one gets. Both engines drive
// the identical round loop against review-cli's state machine -- Codex spawns
// `codex exec` subprocesses (codex-review-runner.js), Claude Code has the
// live session itself spawn subagents by following plugins/concord/core/
// review-driver.md verbatim. The spawn mechanism differs structurally and
// stays separate in each caller; this module is the single source for what
// gets spawned, in what sequence, and with what wording. review-driver.md
// embeds this module's prompt fragments byte-for-byte where it names them
// (see round-plan-sync.test.js); the JS callers use reviewerPrompt() to
// generate the prompt they actually send.
const path = require('node:path');

// Order and parallelism, mirrored by review-driver.md steps 2-3 and
// codex-review-runner.js's `reviewers` array in runReviewUntilGreen:
//   1. correctness, then verify -- strictly sequential (verify reads
//      correctness's output file).
//   2. intent -- parallel with the correctness/verify pair, only when
//      round-start reports intentApplied.
//   3. gate, then gate-verify -- a pair that runs parallel with the above,
//      but strictly sequential within itself (gate-verify reads gate's
//      output file); only when round-start reports gateApplied (normally
//      round 1 only).
//   4. fix -- one per planned finding, strictly sequential (never in
//      parallel; two fixes may touch the same file), after every reviewer
//      above has finished and plan-fixes has run.
const ROLE_SEQUENCE = Object.freeze(['correctness', 'verify', 'intent', 'gate', 'gate-verify', 'fix']);

// The loop makes reviewers hunt verifier-gaming in the diff; this is the same
// guard pointed at the reviewer's own evidence. A reviewer that loses a tool it
// was told to use (denied by the sandbox, missing, crashed) otherwise emits a
// confident schema-valid verdict produced by a check it never ran -- which
// artifact-normalize cannot distinguish from a real one. Declaring `blocked`
// makes the round fail loudly instead, which is the correct outcome.
const BLOCKED_CLAUSE = ' If you cannot run a tool this task requires (missing, denied by sandbox or permissions, crashed, timed out), do NOT substitute a weaker method and do NOT stay silent: write {"status":"ok","blocked":["<tool>: <what failed>"]} and stop.';

// gate-review found the SAME defect class (a skill name missing from a
// metadata-mirror file) three separate times, one file per round, across
// three review-until-green rounds -- plugin.json, then marketplace.json, then
// README.md -- because it reported only the first occurrence it found each
// round instead of sweeping for every file matching that pattern in one
// pass. This clause closes that gap; keep it byte-identical between here and
// review-driver.md's gate-review prompt (round-plan-sync.test.js enforces it).
const GATE_SWEEP_CLAUSE = ' If this finding is an instance of a pattern likely to recur elsewhere in the repository (a value, name, or reference that should be mirrored across multiple files), sweep the whole repository for every other file matching that same pattern in this same pass and report each occurrence as its own finding -- do not stop at the first instance and leave the rest for a later round to catch one at a time.';

function reviewerPrompt(role, { stateDir, round, targetType, dodPassed, dodDeferred, finding, retryPrompt, slug, priorIntentIds, plannedFindingIds = [] }) {
  const artifact = path.join(stateDir, role === 'fix' ? `round-${round}-fix-${finding.id}.json` : `round-${round}-${role}.json`);
  const retry = `${role === 'fix' ? '' : BLOCKED_CLAUSE}${retryPrompt ? `\n\n${retryPrompt}` : ''}`;
  if (role === 'correctness') {
    const doc = targetType === 'file';
    // Under a deferral round-start still reports dodPassed:true, so this note
    // must key off dodDeferred: telling a reviewer "DoD already passed; do not
    // rerun tests" when no gate ran removes the only remaining check.
    const dodNote = dodDeferred
      ? "No executable DoD gate ran this run; a single run of the repo's own already-configured build/test command is acceptable if you genuinely need one."
      : `DoD already ${dodPassed ? 'passed; do not rerun tests' : 'failed; do not root-cause it'}.`;
    return `${doc ? 'Review the document' : 'Review the diff and surrounding code'} at ${path.join(stateDir, `round-${round}-diff.txt`)}. ${doc ? 'Find contradictions, unsupported claims, placeholders, over-claims, and omitted limitations. Every reviewed target MUST appear in "examined". Finding IDs MUST use docreview:<stable-slug>. Every finding MUST include "file", "span", and "summary"; use {"id":"docreview:<stable-slug>","gate":"correctness","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"}.' : `Find correctness bugs, reuse/efficiency problems, and verifier-gaming. ${dodNote} Every finding MUST include "file", "span", and "summary"; use {"id":"correctness:<stable-slug>","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"} -- a finding with no "file" fails the round outright, it is not retried. Every changed file in the diff MUST appear in "examined". Uncertainty is not a reason to withhold a finding: a separate verify pass rejects false positives, so a finding you are unsure about costs nothing to raise. Triviality is different: a real but minor finding is not a false positive, so it routes to a fixer and an honest "no change warranted" parks the run for a human. Raise a minor one only if the fix is worth making; that judgement is yours, and it is the ONLY thing you may withhold on.`} Ignore any intent-*.md file in the state directory; it is not part of your input. Write ONLY JSON to ${artifact}: {"status":"ok","examined":[],"findings":[]}.${retry}`;
  }
  if (role === 'verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-correctness.json`)} against ${path.join(stateDir, `round-${round}-diff.txt`)}. Ignore any intent-*.md file in the state directory; it is not part of your input. Your different lens may also catch a bug the first pass missed -- add it to "findings" in the same shape the correctness pass uses (id, file, span, summary), and it routes to a fixer like any other. Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}; each rejection is {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"} -- a rejection with no stated basis is rejected by the artifact contract.${retry}`;
  if (role === 'intent') return `You are a design-conformance detector. Compare ${path.join(stateDir, `round-${round}-diff.txt`)} with ${path.join(stateDir, `intent-${slug}.md`)}. Raise a finding ONLY for an active contradiction of an explicit stated requirement on an exact changed line. Each finding MUST have an intent: ID, file, span containing that exact changed line, the verbatim requirement text, and summary. Never report omissions, unchanged lines, design taste, or non-normative text. Still-open intent IDs from the previous round: ${JSON.stringify(priorIntentIds || [])}. For the SAME objection against the SAME requirement, REUSE that id verbatim so a human recognises the objection they already saw; mint a new id ONLY for a genuinely new objection -- nothing dedupes intent findings, so a re-slugged repeat reads as a second problem. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate') return `Review ${path.join(stateDir, `round-${round}-diff.txt`)} for defects a diff-local reviewer cannot catch. You MAY Read/Grep the repository and MUST read ${path.join(stateDir, `intent-${slug}.md`)} if it exists. Report only gate: findings, and every ID MUST be gate:<class>:<slug> with <class> one of cross-context, silent-gap, ac-coverage, design-conformance -- a two-segment id silently defaults the class. Each finding needs file, span/evidence anchor, requirement text when available, and summary.${GATE_SWEEP_CLAUSE} Report every gap you find, including ones you are uncertain about: a separate gate-verify pass rejects false positives, so your job here is coverage, not filtering. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate-verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-gate.json`)} against the diff and repository. Reject false positives and design-taste objections; keep actionable gaps. You MAY add genuinely new gate: findings using the same file, span/evidence, requirement, and summary shape. Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}; each rejection is {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"}.${retry}`;
  if (role === 'fix') {
    const mirrorClaim = targetType === 'file' ? '' : `,"resolvedFindingIds":["<distinct planned mirror finding id>"]`;
    const mirrorNote = targetType === 'file' ? '' : ` Omit resolvedFindingIds unless this commit also resolves that distinct planned finding: its exact span must be absent from a file in files. It may contain only IDs from this round's other planned fixes: ${JSON.stringify(plannedFindingIds.filter((id) => id !== finding.id))}`;
    return `Apply the minimal correct fix for ${finding.id} at ${finding.file}, ${finding.span}: ${finding.summary}. Edit only necessary files. Then write ONLY to ${artifact}: either {"status":"ok","edited":false} if no change was warranted, or {"status":"ok","edited":true,"files":["<every edited path>"]${mirrorClaim}}.${mirrorNote} The files array MUST truthfully list EVERY file edited, including required companion files, as repository-relative paths. It MUST NOT include this state artifact, any stateDir artifact, or any path outside the repository.${retry}`;
  }
  throw new Error(`harness-failure: unknown reviewer role ${role}`);
}

module.exports = { ROLE_SEQUENCE, BLOCKED_CLAUSE, GATE_SWEEP_CLAUSE, reviewerPrompt };
