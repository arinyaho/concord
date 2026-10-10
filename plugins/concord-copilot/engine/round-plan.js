'use strict';
// The round plan: which reviewer roles run this round, in what order and
// parallelism, and the exact prompt text each one gets. Both engines drive
// the identical round loop against review-cli's state machine -- Codex spawns
// `codex exec` subprocesses (codex-review-runner.js), Claude Code has the
// live session itself spawn subagents by following plugins/concord/core/
// review-driver.md verbatim. The spawn mechanism differs structurally and
// stays separate in each caller; this module is the single source for what
// gets spawned, in what sequence, and with what wording. Three
// review-driver.md-shaped artifacts exist -- core/review-driver.md, the
// hand-composed commands/review-until-green.md, and the Copilot-vendored
// skills/review-until-green/references/review-driver.md -- and each embeds
// this module's prompt fragments byte-for-byte where it names them;
// round-plan-sync.test.js enforces all three individually (see that file's
// own tests, not a single blanket guarantee). The JS callers use
// reviewerPrompt() to generate the prompt they actually send.
const path = require('node:path');
const { safeIdForFilename } = require('./artifact-name');
const { allowedFindingPrefixes } = require('./artifact-contract');

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
//   4. plan -- after the independent verdict is sealed; it may consult intent
//      and history and must classify every surviving finding.
//   5. fix/certify -- one pair per authorized root-cause group, sequentially.
const ROLE_SEQUENCE = Object.freeze(['correctness', 'verify', 'intent', 'gate', 'gate-verify', 'plan', 'fix', 'certify']);

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
const GATE_VERIFY_PREFIX = allowedFindingPrefixes('gate-verify')[0];
const CORRECTNESS_PREFIXES = allowedFindingPrefixes('correctness').map((prefix) => `${prefix}*`).join(' or ');
const GATE_FOLLOWUP_CLAUSE = ' For each finding also report "releaseBlocking": an array of the release-blocking classes that apply, drawn from acceptance-criterion, required-check, serious-bug, security, data-integrity, contract-choice, compatibility, contradictory-docs, unproven-premise, stage-exit (an empty array only when none applies), and "rationale": a non-empty sentence saying why the approved outcome, checks, safety boundary and documented behavior stay correct without a fix. A priority label or having run out of rounds is not a reason. An absent or invalid field is treated as release-blocking.';
const GATE_VERIFY_BLOCKING_CLAUSE = ' If a gate candidate has an empty "releaseBlocking" but you judge it release-blocking, list it in the optional "blocking" array as {"id":"<gate: finding id>","reason":"<one line>"}; your judgement overrides the finder.';
const GATE_VERIFY_ADDED_CLAUSE = ' A gate: finding you add must be classified the same way as a gate-review finding.' + GATE_FOLLOWUP_CLAUSE;
const GATE_VERIFY_OWNERSHIP_CLAUSE = ` Use correctness candidates only as context when evaluating gate candidates. Your artifact may disposition only ${GATE_VERIFY_PREFIX}* candidate IDs. Do not copy, accept, or reject ${CORRECTNESS_PREFIXES} IDs in this artifact; their disposition belongs to the correctness verifier. A gate candidate that restates the same defect at the same place as a correctness candidate is not a false positive: list it in "duplicates" as {"id":"<gate id>","of":"<correctness id>"} instead of rejecting it. It drops out only if that correctness candidate survives its own verifier, so one defect is reported once and never lost.`;

// The correctness verifier reads the gate batch only as context; gate:* ids
// belong to gate-verify, and a verdict on one fails artifact normalization.
const VERIFY_OWNERSHIP_CLAUSE = ` Use gate candidates only as context. Your artifact may disposition only ${CORRECTNESS_PREFIXES} candidate IDs. Do not copy, accept, or reject ${GATE_VERIFY_PREFIX}* IDs in this artifact; their disposition belongs to the gate verifier.`;

function reviewerPrompt(role, { stateDir, round, targetType, dodDeferred, dodPending, finding, fixGroup, retryPrompt, slug, priorIntentIds, plannedFindings = [], gateMode, gateApplied = false, intentHash = null }) {
  const groupArtifactId = fixGroup && fixGroup.groupId ? fixGroup.groupId : finding && finding.id;
  const artifact = path.join(stateDir, role === 'fix' || role === 'certify' ? `round-${round}-${role}-${safeIdForFilename(groupArtifactId)}.json` : `round-${round}-${role}.json`);
  const retry = `${role === 'fix' ? '' : BLOCKED_CLAUSE}${retryPrompt ? `\n\n${retryPrompt}` : ''}`;
  if (role === 'correctness') {
    const doc = targetType === 'file';
    const dodNote = dodPending
      ? 'The configured DoD will run once after review convergence; do not run the build or test suite yourself.'
      : dodDeferred
      ? "No executable DoD gate ran this run; a single run of the repo's own already-configured build/test command is acceptable if you genuinely need one."
      : 'The DoD scheduling state is unavailable; do not run the full build or test suite yourself.';
    return `${doc ? 'Review the document' : 'Review the diff and surrounding code'} at ${path.join(stateDir, `round-${round}-diff.txt`)}. ${doc ? 'Find contradictions, unsupported claims, placeholders, over-claims, and omitted limitations. Every reviewed target MUST appear in "examined". Finding IDs MUST use docreview:<stable-slug>. Every finding MUST include "file", "span", and "summary"; use {"id":"docreview:<stable-slug>","gate":"correctness","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"}.' : `Find correctness bugs, reuse/efficiency problems, and verifier-gaming. ${dodNote} Every finding MUST include "file", "span", and "summary"; use {"id":"correctness:<stable-slug>","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"} -- a finding with no "file" fails the round outright, it is not retried. Every changed file in the diff MUST appear in "examined". Uncertainty is not a reason to withhold a finding: a separate verify pass rejects false positives, so a finding you are unsure about costs nothing to raise. Triviality is different: a real but minor finding is not a false positive, so it routes to a fixer and an honest "no change warranted" parks the run for a human. Raise a minor one only if the fix is worth making; that judgement is yours, and it is the ONLY thing you may withhold on.`} Ignore any intent-*.md file in the state directory; it is not part of your input. Write ONLY JSON to ${artifact}: {"status":"ok","examined":[],"findings":[]}.${retry}`;
  }
  if (role === 'verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-correctness.json`)}${gateApplied && gateMode !== 'design-conformance' ? ` together with the complete broad candidate set in ${path.join(stateDir, `round-${round}-gate.json`)} so related or conflicting findings are evaluated as one batch` : ''} against ${path.join(stateDir, `round-${round}-diff.txt`)}.${gateApplied && gateMode !== 'design-conformance' ? VERIFY_OWNERSHIP_CLAUSE : ''} Ignore every intent-*.md and history file: this verdict must be independent of the desired design and prior conclusions. Your different lens may catch a bug the first pass missed -- add it to "findings" in the same shape the correctness pass uses. Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}; each rejection is {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"}.${retry}`;
  if (role === 'plan') return `The independent correctness verdict is already sealed in ${path.join(stateDir, `round-${round}-verify.json`)}. Classify every surviving correctness/docreview finding from it and ${path.join(stateDir, `round-${round}-correctness.json`)} into exactly one root-cause group. Now, and only now, read ${path.join(stateDir, `round-${round}-history.json`)} and ${path.join(stateDir, `intent-${slug}.md`)} if it exists. Use {"groupId":"<stable slug>","findingIds":["<every member>"],"rootCause":"<shared cause>","invariants":["<required behavior>"],"changeClass":"local|structural","structuralEffects":["identity|ownership|retry-accounting|ordering|idempotency|lease-fence|deadline-ttl"],"action":"fix|reconcile"}. A structural action:"fix" additionally requires "designEvidence":{"source":"intent-${slug}.md","sourceHash":"${intentHash || '<unavailable>'}","requirements":["<verbatim normative requirement>"],"uniqueness":"<why these requirements determine one answer>"}. If no approved source with the exact supplied hash uniquely settles the structural choice, use action:"reconcile" with a reason. A local group whose fix needs a decision that no approved source settles may also use action:"reconcile"; every reconcile group needs a "reason" naming the unsettled decision. Missing classifications are forbidden; local singleton groups must still be explicit. Write ONLY {"status":"ok","protocolVersion":2,"groups":[]} to ${artifact}.${retry}`;
  if (role === 'intent') return `You are a design-conformance detector. Compare ${path.join(stateDir, `round-${round}-diff.txt`)} with ${path.join(stateDir, `intent-${slug}.md`)}. Raise a finding ONLY for an active contradiction of an explicit stated requirement on an exact changed line. Each finding MUST have an intent: ID, file, span containing that exact changed line, the verbatim requirement text, and summary. Never report omissions, unchanged lines, design taste, or non-normative text. Still-open intent IDs from the previous round: ${JSON.stringify(priorIntentIds || [])}. For the SAME objection against the SAME requirement, REUSE that id verbatim so a human recognises the objection they already saw; mint a new id ONLY for a genuinely new objection -- nothing dedupes intent findings, so a re-slugged repeat reads as a second problem. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate' && gateMode === 'design-conformance') return `Review ${path.join(stateDir, `round-${round}-diff.txt`)} for design-conformance gaps only: places where the change does not do what the design/plan/AC at ${path.join(stateDir, `intent-${slug}.md`)} (read it if it exists) requires, or does something it forbids. You MAY Read/Grep the repository. Report only gate: findings, and every ID MUST be gate:design-conformance:<slug>. Do not report ac-coverage, cross-context or silent-gap findings. Each finding needs file, span/evidence anchor, requirement text when available, and summary.${GATE_SWEEP_CLAUSE} Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate') return `Review ${path.join(stateDir, `round-${round}-diff.txt`)} for defects a diff-local reviewer cannot catch. You MAY Read/Grep the repository and MUST read ${path.join(stateDir, `intent-${slug}.md`)} if it exists. Report only gate: findings, and every ID MUST be gate:<class>:<slug> with <class> one of cross-context, silent-gap, ac-coverage, design-conformance, threat-model -- a two-segment id silently defaults the class. Each finding needs file, span/evidence anchor, requirement text when available, and summary.${GATE_SWEEP_CLAUSE} Report every gap you find, including ones you are uncertain about: a separate gate-verify pass rejects false positives, so your job here is coverage, not filtering.${GATE_FOLLOWUP_CLAUSE} Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate-verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-gate.json`)} together with the complete correctness candidate set in ${path.join(stateDir, `round-${round}-correctness.json`)} against the diff and repository. Evaluate related or conflicting findings as one batch.${GATE_VERIFY_OWNERSHIP_CLAUSE} Reject false positives and design-taste objections; keep actionable gaps. You MAY add genuinely new gate: findings using the same file, span/evidence, requirement, and summary shape.${GATE_VERIFY_ADDED_CLAUSE}${GATE_VERIFY_BLOCKING_CLAUSE} Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}; each rejection is {"id":"<${GATE_VERIFY_PREFIX} finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"}.${retry}`;
  if (role === 'fix') {
    const group = fixGroup || { findingIds: [finding.id], rootCause: finding.summary, invariants: [], changeClass: 'local', action: 'fix', findings: plannedFindings };
    const related = (group.findings || plannedFindings).filter((item) => item.id !== finding.id);
    return `Apply one coherent ${group.changeClass} fix for the entire authorized group ${group.groupId}. Root cause: ${group.rootCause}. Required invariants: ${JSON.stringify(group.invariants || [])}. Findings: ${JSON.stringify([finding, ...related])}. Edit only necessary files; do not patch symptoms one by one or invent a different contract. Then write ONLY to ${artifact}: either {"status":"ok","edited":false} or {"status":"ok","edited":true,"groupId":"${group.groupId}","files":["<every edited path>"]}. The files array MUST truthfully list EVERY file edited as repository-relative paths and MUST NOT include state artifacts or paths outside the repository.${retry}`;
  }
  if (role === 'certify') {
    const members = fixGroup.memberGroups || [fixGroup];
    const declarations = members.map((group) => path.join(stateDir, `round-${round}-fix-${safeIdForFilename(group.groupId)}.json`));
    return `Independently certify the uncommitted candidate for authorized ${members.length > 1 ? 'round transaction' : 'group'} ${fixGroup.groupId}. Read fix declarations ${JSON.stringify(declarations)}, inspect the actual worktree and all affected call paths, and test focused behavior when needed. Certification is all-or-nothing across findingIds ${JSON.stringify(fixGroup.findingIds)} and invariants ${JSON.stringify(fixGroup.invariants)}; an unchanged original span or finding file does not disprove an additive/shared-helper fix. For every declared edited file compute SHA-256 of its exact current bytes. Write ONLY {"status":"ok","groupId":"${fixGroup.groupId}","resolvedFindingIds":${JSON.stringify(fixGroup.findingIds)},"files":["<exact union of fixer files>"],"fileHashes":{"<path>":"<sha256>"},"evidence":["<behavior/check proving the whole transaction>"]} to ${artifact}. If any member or invariant is not established, write {"status":"blocked","groupId":"${fixGroup.groupId}","reason":"<what remains unproven>"}.`;
  }
  throw new Error(`harness-failure: unknown reviewer role ${role}`);
}

module.exports = { ROLE_SEQUENCE, BLOCKED_CLAUSE, GATE_SWEEP_CLAUSE, GATE_FOLLOWUP_CLAUSE, GATE_VERIFY_ADDED_CLAUSE, GATE_VERIFY_BLOCKING_CLAUSE, GATE_VERIFY_OWNERSHIP_CLAUSE, VERIFY_OWNERSHIP_CLAUSE, reviewerPrompt };
