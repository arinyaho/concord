# Review-until-green Token Efficiency Design

## Goal

Reduce the total tokens consumed by `review-until-green` without materially reducing review quality. Deliver the work as five independently reviewable PRs, starting with measurement so every later optimization is compared against a recorded baseline.

Tracking ticket: [Make review-until-green token-efficient without quality regression](https://app.notion.com/p/Make-review-until-green-token-efficient-without-quality-regression-3d9db3e25ffb812cb59cf238bcb1d403)

## Non-goals

- Do not weaken the existing artifact contracts, blocked-tool handling, DoD gate, or false-clean protections.
- Do not change the default review depth, model, or reasoning effort before measurements justify it.
- Do not run paid live-model evaluations in ordinary CI.
- Do not combine the five deliverables into one large PR.

## Quality definition

“No performance difference” is treated as a paired non-inferiority claim, not exact equality. Baseline and candidate runs use the same repository snapshot, target diff, intent, model, reasoning effort, and review configuration.

The candidate passes when:

- It produces zero additional false-clean outcomes on the evaluation corpus.
- The lower bound of the paired 95% confidence interval for seeded-defect recall is at least -5 percentage points.
- Its false-positive rate has no material increase.
- Fix success, DoD result, and terminal decision remain equivalent for behavior-preserving changes.
- Median total token use falls by at least 30% after the optimization sequence.

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

Each scenario declares finding identities and allowed terminal outcomes rather than checking counts alone. Offline tests exercise orchestration and scoring with recorded artifacts. Live-model trials are explicit, paired commands run outside CI; their raw artifacts and usage summaries are retained for audit without committing credentials or model reasoning logs.

## Measurement architecture

The Codex subprocess adapter records one usage entry per invocation:

- Role and round.
- Model and reasoning-effort labels when available.
- Fresh input, cached input, output, and total tokens when reported by the CLI.
- Elapsed wall time and exit status.
- Whether usage was complete or partial.

The run ledger stores aggregate totals and per-role summaries. Missing provider fields remain marked partial; they are never silently treated as zero. Existing human-readable handoffs gain one compact usage line while JSON callers retain structured data.

The evaluation command compares a baseline result set with a candidate result set. It reports paired quality deltas, confidence bounds, token deltas, subprocess counts, and latency. It exits non-zero when a hard quality gate or the configured token target fails.

## PR sequence

### PR 1: Telemetry and evaluation foundation

Capture per-role token usage, subprocess count, latency, and partial-usage state. Add deterministic scoring fixtures and a paired comparison command. This PR must not change reviewer prompts, role scheduling, terminal decisions, or defaults.

### PR 2: Compact skill orchestration

Replace the cross-engine skill’s repeated manual choreography with a small deterministic entrypoint. Keep the generated reviewer prompts and state transitions equivalent. Measure the parent-context reduction and rerun the quality corpus.

### PR 3: Structured reviewer output

Use Codex structured-output support for review artifacts and let the runner persist validated JSON. Preserve semantic artifact normalization and fail-closed behavior. Demonstrate fewer malformed-artifact retries without changing accepted findings.

### PR 4: Batched panel verification

Give each of three independent adversarial voters the full candidate set and collect one verdict per candidate. Preserve three votes and majority semantics while reducing verifier subprocesses from `3N` to `3` per panel round. Use paired live-model trials because this PR changes prompt grouping.

### PR 5: Explicit depth and budget controls

Expose review-depth and token-budget controls. Preserve current behavior when no new option is supplied. A budget stop must be explicit and non-clean; it must never manufacture convergence or a passing DoD result.

## Delivery and rollback

Merge one PR before starting the next so every quality or token change is attributable. Each PR updates the Notion checklist with its PR link and measured result. A failed non-inferiority gate blocks that PR; rollback is reverting only that PR because earlier stages remain independently valid.

## Verification

Every PR runs the complete `node --test` suite. Tests added for behavior changes must be observed failing against the pre-change implementation before the fix is written. Live-model evaluation reports the exact model/configuration, corpus revision, repetitions, quality deltas, confidence bounds, and token totals used for the decision.
