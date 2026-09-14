# Review-until-green Token Efficiency Design

## Goal

Reduce the measured evaluation-token proxy for `review-until-green` without materially reducing review quality. Deliver the work as five independently reviewable PRs, starting with measurement so every later optimization is compared against a recorded baseline.

Tracking ticket: [Make review-until-green token-efficient without quality regression](https://app.notion.com/p/Make-review-until-green-token-efficient-without-quality-regression-3d9db3e25ffb812cb59cf238bcb1d403)

## Non-goals

- Do not weaken the existing artifact contracts, blocked-tool handling, DoD gate, or false-clean protections.
- Do not change the default review depth, model, or reasoning effort before measurements justify it.
- Do not run paid live-model evaluations in ordinary CI.
- Do not combine the five deliverables into one large PR.

## Quality definition

“No performance difference” is treated as a paired non-inferiority claim, not exact equality. Baseline and candidate runs use the same target-repository snapshot, target diff, intent, model, reasoning effort, and review configuration. Each result manifest records an identity for all six pairing inputs and separately records the review-tool implementation revision used for that run. Before scoring any delta, the evaluator requires every identity to be available and all six pairing-input identities to be equal across the pair; the review-tool revisions are recorded but need not be equal. Otherwise, it marks the comparison unevaluable and non-passing and exits non-zero.

The candidate passes when:

- DECISION: For each paired repetition of each corpus scenario, a false-clean outcome is a run whose final terminal outcome is `clean` when `clean` is not one of that scenario's declared allowed terminal outcomes. The gate passes only if there is no pair in which the candidate has a false-clean outcome and the baseline does not; false-clean outcomes in different pairs cannot offset one another. A missing allowed-outcome declaration or final terminal outcome makes the comparison unevaluable and non-passing.
- The lower bound of the paired 95% confidence interval for seeded-defect recall is at least -5 percentage points.
- Its false-positive rate has no material increase: for each paired repetition, use the shared set of non-defect identities in the union of corpus-declared identities and identities accepted by either run as the denominator, then require the upper bound of the paired 95% confidence interval for the candidate-minus-baseline rate to be at most +5 percentage points.
- DECISION: For every paired repetition of each corpus scenario marked behavior-preserving, require exact equality of this normalized tuple: the set of finding identities recorded `fixed` (a declared required fix counts only when its edit was committed and the identity is absent in the subsequent confirmation round; the set is empty when no fix is required), the DoD result (`passed`, `failed`, `deferred`, or `not-run`), and the final terminal outcome (`clean`, `parked`, `abandoned`, `intent-review`, `gate-pending`, `budget-stopped`, or `harness-failure`). The gate passes only with zero tuple mismatches across all such pairs; a missing identity or value, an unknown enum value, or a run that stops before a final outcome makes the comparison unevaluable and non-passing.
- The median paired percentage change in evaluation total token use across the corpus and repetitions is at most -30% after the optimization sequence.

Generate repetitions independently: each repetition starts fresh baseline and candidate model sessions from the fixed paired inputs, uses independently generated sampling randomness for every invocation, and shares no conversation state, outputs, or adaptive feedback with any other repetition. Replayed outputs and repetitions whose generation can depend on earlier outcomes are invalid; if fewer than 30 valid independent paired differences remain, the corresponding interval gate is unevaluable and non-passing.

For the seeded-defect recall gate, one sampling unit is one paired baseline/candidate repetition over the complete corpus. DECISION: A declared seeded-defect identity counts as recalled by a run only when it is present in that run's final verifier-accepted finding-identity set; proposed or verifier-rejected identities do not count. For each repetition, compute the candidate-minus-baseline recall difference across the declared seeded-defect identities; the estimator is the arithmetic mean of those paired differences. Use at least 30 paired repetitions and the two-sided 95% paired Student's t interval `mean difference ± t(0.975, n - 1) × sample standard deviation / sqrt(n)`; the gate uses that interval's lower bound.

For the false-positive gate, one sampling unit is one paired baseline/candidate repetition over the complete corpus. After adjudication, each run's false-positive numerator is the set of identities in the shared non-defect denominator that the run accepted as findings. Divide each numerator's size by the shared denominator's size, then subtract the baseline rate from the candidate rate; the estimator is the arithmetic mean of those paired differences. Use at least 30 paired repetitions and the two-sided 95% paired Student's t interval `mean difference ± t(0.975, n - 1) × sample standard deviation / sqrt(n)`; the gate uses that interval's upper bound.

Before scoring the false-positive gate, adjudicate every accepted identity absent from the corpus declarations as a defect or non-defect against the expected behavior. Any unadjudicated identity makes the gate unevaluable and non-passing.

Latency and subprocess count are recorded as secondary metrics. A faster run does not compensate for a quality-gate failure.

## Evaluation corpus

Use versioned, deterministic scenarios covering:

- A clean diff that must converge without findings.
- Seeded correctness defects.
- Verifier-gaming changes such as weakened assertions and hard-coded test answers.
- Design-conformance, silent-gap, acceptance-coverage, cross-context, and threat-model findings.
- False-positive candidates that verifiers should reject.
- Malformed and blocked artifacts that must fail closed.
- A fix round that must edit, commit, rerun DoD, and converge.

Each scenario declares whether it is behavior-preserving, its finding identities classified as seeded defects or non-defects, and its allowed terminal outcomes rather than checking counts alone. Offline tests exercise orchestration and scoring with recorded artifacts. Live-model trials are explicit, paired commands run outside CI; their raw artifacts and usage summaries are retained for audit without committing credentials or model reasoning logs.

## Measurement architecture

The Codex subprocess adapter records one usage entry per invocation:

- Role and round.
- Model and reasoning-effort labels when available.
- Fresh input, cached input, output, and total tokens when reported by the CLI.
- Elapsed wall time and exit status.
- Whether usage was complete or partial.

The run ledger stores aggregate totals and per-role summaries. Missing provider fields remain marked partial; they are never silently treated as zero. If either result set has partial usage, the evaluation excludes that comparison from token deltas and medians, marks the 30% token-reduction gate unevaluable, and exits non-zero until complete usage is recorded. Existing human-readable handoffs gain one compact usage line while JSON callers retain structured data.

Because parent-session token usage is not available from provider telemetry, parent-orchestration context is represented by a reproducible proxy rather than reported as actual consumption. For each paired corpus scenario, the evaluator renders the baseline and candidate parent-facing orchestration instructions with identical scenario inputs, counts them with a pinned tokenizer, and records the tokenizer version, content hash, and token count. Each run's evaluation total is that proxy count plus the sum of its complete subprocess total-token fields. The reported token change is `(candidate evaluation total - baseline evaluation total) / baseline evaluation total` for each pair, excluding invariant session context; the 30% gate requires the median paired change across the corpus and repetitions to be at most -30%.

The evaluation command compares a baseline result set with a candidate result set. It reports paired quality deltas, confidence bounds, token deltas, subprocess counts, and latency. It exits non-zero when a hard quality gate or the configured token target fails.

## PR sequence

### PR 1: Telemetry and evaluation foundation

Capture per-role token usage, subprocess count, latency, and partial-usage state. Add deterministic scoring fixtures and a paired comparison command. This PR must not change reviewer prompts, role scheduling, terminal decisions, or defaults.

### PR 2: Compact skill orchestration

Replace the cross-engine skill’s repeated manual choreography with a small deterministic entrypoint. Keep the generated reviewer prompts and state transitions equivalent. Measure the parent-orchestration context reduction and rerun the quality corpus.

### PR 3: Structured reviewer output

Use Codex structured-output support for review artifacts and let the runner persist validated JSON. Preserve semantic artifact normalization and fail-closed behavior. Demonstrate fewer malformed-artifact retries without changing accepted findings.

DECISION: For PR 3, use the merged PR 2 implementation as the baseline and run at least 30 valid independent paired repetitions over the complete corpus under the protocol above. For each repetition, count all retry subprocesses launched because a review artifact failed parsing, schema validation, or semantic normalization, then compute the candidate-minus-baseline difference; the retry gate passes only when the upper bound of its two-sided 95% paired Student's t interval is below zero. The set of accepted finding identities must be exactly equal in every paired scenario and repetition; any missing, duplicate, or unknown identity, any set mismatch, or fewer than 30 valid paired differences makes the comparison unevaluable and non-passing.

### PR 4: Batched panel verification

DECISION: Deterministically partition the round's candidates in stable identity order into the fewest batches whose rendered voter prompt fits the selected model's input limit, whose reserved structured-output budget fits its output limit, and whose prompt token count plus reserved structured-output budget fits its shared context-window limit. For each batch, give each of three fresh independent adversarial voters the full batch and collect one verdict per candidate. A candidate too large to fit alone is a loud blocked-tool failure before any votes are counted. Concatenate complete batch responses and apply the existing per-candidate three-vote majority semantics; never compute a majority from partial batches. This reduces verifier subprocesses from `3N` to `3` when all candidates fit and uses `3B` for `B` batches on overflow. Use paired live-model trials because this PR changes prompt grouping.

A batched voter is complete only when it returns exactly one verdict for every input candidate identity, with no missing, duplicate, or unknown identities. If the voter is blocked, its subprocess fails, its output is malformed, or this completeness check fails, discard its entire response and stop the panel round with the existing loud blocked-tool failure; do not convert that voter slot into candidate verdicts or compute candidate majorities.

### PR 5: Explicit depth and budget controls

Expose review-depth and token-budget controls. Preserve current behavior when no new option is supplied. A budget stop must be explicit and non-clean; it must never manufacture convergence or a passing DoD result.

`--review-depth` accepts exactly `quick`, `standard`, or `deep`; omitting it is equivalent to `standard`. Every depth runs DoD when the target has an executable DoD, correctness review followed by independent verification on every main round, and the intent detector when intent is available. `quick` caps the main loop at 3 rounds and skips both the first-round broad gate-review/gate-verify pair and the convergence-boundary holistic panel. `standard` preserves the current 5-round main-loop cap, runs the broad gate-review/gate-verify pair on the first main round, and runs the five-lens (`ac-coverage`, `design-conformance`, `cross-context`, `silent-gap`, and `threat-model`) holistic panel with three adversarial verifier votes per candidate until 2 consecutive panel rounds confirm no new findings. `deep` raises the main-loop cap to 8 rounds, runs the broad gate-review/gate-verify pair on every main round, and runs the same five-lens, three-vote holistic panel until 3 consecutive panel rounds confirm no new findings. Target-specific invariants still apply (for example, file targets have no executable DoD), and `--token-budget` limits the selected depth without implicitly changing it or bypassing any phase required before a clean result.

`--token-budget <tokens>` accepts a positive integer and is a hard, persisted ceiling for one review run, including resumes. It counts every adapter-launched model invocation's normalized fresh-input, cached-input, reasoning, and visible-output tokens exactly once; when provider `totalTokens` includes those categories, that value is authoritative and the components are not added again. It excludes the parent-orchestration proxy, local orchestration, and DoD/test processes because they are not adapter-launched model usage. Omitting the option leaves budgeting disabled and preserves current scheduling and termination behavior.

Before launching an invocation, the adapter reserves a conservative upper bound for its total charge. It uses the complete request's input count from an authoritative provider-supplied, model-matched preflight counter plus a provider-enforced completion cap covering reasoning and visible output only when both are available; otherwise, it reserves the selected model's full context-window limit. The pinned tokenizer used for the parent-orchestration proxy is never used for budget enforcement. It launches only when persisted actual charges plus all outstanding reservations remain at or below the budget; concurrent invocations require the sum of their reservations, and an all-or-nothing voter batch is reserved as a group. The reservation must be atomically persisted in the run ledger before launch, and a persistence failure prevents launch. On resume after a crash, every persisted reservation without complete usage remains charged at its full amount unless durable adapter state proves that the invocation was never launched, so a crash between launch and usage persistence cannot make that budget available again. On completion, complete provider usage replaces the reservation; incomplete usage retains the full reservation as the charge. If the next required invocation cannot be reserved, the run stops before launching it and returns a distinct `budget-stopped` terminal decision with `converged: false`, `clean: false`, the blocked phase/role, charged tokens, and budget, and exits non-zero. The handoff reports only the DoD result actually observed against the current tree (passed, failed, deferred, or not run); the budget stop cannot promote or replace it. Tests cover omitted-option compatibility, exact category accounting without double counting, equality at the budget boundary, preflight refusal without overshoot, concurrent reservations, incomplete usage, persistence across resume, crash recovery with an outstanding reservation, and a budget stop after an earlier DoD pass remaining non-clean.

## Delivery and rollback

Merge one PR before starting the next. Compare each PR's quality and token results with both the immediately preceding merged stage, to attribute its marginal effect, and the original recorded baseline, to track the cumulative effect. Each PR updates the Notion checklist with its PR link and measured result. A failed non-inferiority gate blocks that PR; rollback is reverting only that PR because earlier stages remain independently valid.

## Verification

Every PR runs the complete `node --test` suite. Tests added for behavior changes must be observed failing against the pre-change implementation before the fix is written. Live-model evaluation reports the exact model/configuration, corpus revision, repetitions, quality deltas, confidence bounds, and token totals used for the decision.
