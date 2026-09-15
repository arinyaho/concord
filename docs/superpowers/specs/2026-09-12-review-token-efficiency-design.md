# Review-until-green Token Efficiency Design

## Goal

Reduce the measured review-token proxy for `review-until-green` on Claude Code and Codex without materially reducing review quality. Deliver five separately reviewable PRs, beginning with measurement. The proxy covers only provider-reported review/fix subagent or subprocess tokens; all parent-session usage is excluded, so the experiment does not claim a reduction in total provider billing.

Tracking ticket: [Make review-until-green token-efficient without quality regression](https://app.notion.com/p/Make-review-until-green-token-efficient-without-quality-regression-3d9db3e25ffb812cb59cf238bcb1d403)

## Invariants

- Claude Code and Codex are evaluated separately. One engine cannot hide the other's regression.
- PR 1 is observational: it does not change prompts, role order, fan-out, defaults, or terminal decisions.
- Missing, malformed, or inconsistent usage is `partial`, never zero.
- Live model runs are explicit and paid. Ordinary tests use recorded provider-event fixtures.
- Telemetry stores identifiers and numeric usage only, never prompts, responses, reasoning, credentials, or transcript content.

## Quality and token gates

The versioned corpus contains clean changes, seeded defects, false-positive traps, malformed or blocked artifacts, holistic-review cases, and a fix-and-confirm case. It freezes expected finding identities, required fixes, probes, allowed terminal outcomes, and a boolean `hasExecutableDoD` before collection. For a `clean` result, `hasExecutableDoD: true` requires `dod: "passed"`; `hasExecutableDoD: false` is the sole DoD exemption and requires `dod: "deferred"`. A missing or non-boolean flag, or a mismatched DoD value, is unevaluable. Each scenario also freezes a `probesByFinding` mapping from every scenario-qualified `(scenarioId, identity)` in its seeded-defect, confirmed-defect, or required-fix inventory to a non-empty list of valid IDs in that scenario's frozen probe inventory; a missing mapping entry, empty list, or unknown referenced probe makes the corpus invalid.

Before scoring a repetition, a reviewer blinded to the producing side adjudicates every accepted finding from either side that does not match the scenario's frozen identities and assigns it one unique frozen scenario-qualified identity. An adjudicated non-defect extends the shared frozen set `N` used to score both sides; a confirmed defect enters that scenario's required-defect handling with a frozen `probesByFinding` entry, and both sides are rescored. An unadjudicated finding, unassignable identity, or identity collision makes the repetition unevaluable and non-passing.

Each engine runs 30 independent paired repetitions of baseline and candidate, and each repetition runs every scenario in the complete frozen corpus once per side. A pair uses the same repository snapshot, review configuration, requested model, reasoning-effort and service-tier configuration, provider alias, and corpus revision, but separate sessions, checkouts, and artifact directories. Every Codex run records those three requested settings and the evaluator requires each to match the paired manifest; missing or unequal requested configuration is unevaluable. For every scenario pair, its corresponding baseline and candidate run manifests record that scenario's `targetDiffIdentity`, `targetDiffHash`, `intentIdentity`, and `intentHash`; no intent is represented explicitly by `intentIdentity: "none"` and `intentHash: "none"`. The evaluator requires all four fields to be present and exactly equal within that corresponding scenario pair, otherwise the pair is unevaluable. When an adapter exposes resolved-model identity, each requested configuration must have exactly one identity across all invocations and the baseline and candidate identities must be equal; a missing, mixed, or unequal exposed identity makes the pair partial and unevaluable. An `unavailable` marker records absence of evidence and never proves actual-model equality. Codex does not expose the applied reasoning effort or service tier either, so reports treat those requested values as configuration evidence only. Run order alternates within five blocks of six. Each paired repetition's manifests record `scheduleBlock`, `schedulePosition`, and the actual first side; the evaluator requires those fields to match each other and the corpus revision's frozen alternating schedule exactly. Provider randomness remains a limitation when no seed control exists.

Quality passes per engine only when:

- neither side produces a false clean;
- on each side, every confirmed defect is accepted, has fix commit evidence, is absent from confirmation, and passes every probe in its `probesByFinding` entry, even when the terminal result is not `clean`;
- the lower bound of the paired 95% interval for candidate-minus-baseline seeded-defect recall is at least -5 percentage points;
- the upper bound of the equivalent false-positive-rate interval is at most +5 percentage points;
- the lower bound of the equivalent successful-fix-rate interval is at least -5 percentage points;
- terminal-outcome share differences remain within +/-5 percentage points; and
- replay fixtures preserve accepted findings, fixes, probes, DoD, and terminal results exactly.

A `clean` terminal result is false when the scenario disallows `clean`, a scenario with `hasExecutableDoD: true` did not pass DoD, any seeded or confirmed defect was not accepted, lacks fix evidence, recurs in confirmation, or fails a probe in its `probesByFinding` entry, any other required fix lacks fix evidence, recurs in confirmation, or fails a probe in its entry, or any other frozen probe fails. This applies to every seeded defect even when it is not separately listed in `requiredFixes`; only `hasExecutableDoD: false` with `dod: "deferred"` is exempt from the DoD condition.

For repetition `r` and side `s`, let `D` and `F` be the frozen non-empty corpus sets of scenario-qualified seeded-defect and required-fix identities, let `N` be the shared frozen set of corpus-declared and adjudicated scenario-qualified non-defect identities for that repetition, and let `S` be the frozen non-empty set of scenarios; each identity is represented as `(scenarioId, identity)`. `accepted(s,r)` uses the same scenario-qualified identity pairs, and acceptance, fix evidence, confirmation absence, and probes for a required fix are all matched within that pair's scenario. The evaluator computes `recall(s,r) = |accepted(s,r) intersect D| / |D|`, `falsePositiveRate(s,r) = |accepted(s,r) intersect N| / |N|`, `successfulFixRate(s,r) = |{f in F: f was accepted, has fix evidence, is absent from confirmation, and passes every probe in probesByFinding[f]}| / |F|`, and, for every frozen terminal value `o`, `terminalShare(s,r,o) = |{x in S: terminal(s,r,x) = o}| / |S|`. Each metric contributes the paired observation `candidate - baseline`; across the 30 repetitions its two-sided 95% Student-t interval is `mean +/- t(0.975, 29) * sampleStandardDeviation / sqrt(30)`. Quality requires the recall and successful-fix lower bounds to be at least `-0.05`, the false-positive upper bound to be at most `0.05`, and both bounds of every terminal-share interval to lie within `[-0.05, 0.05]`; any incomplete repetition or empty denominator is unevaluable and non-passing.

After passing the same adjacent quality and token comparison against the exact PR 4 review-tool revision, PR 5's final token gate compares the exact PR 1 pre-optimization baseline revision recorded in the baseline manifests with the exact PR 5 candidate revision recorded in the candidate manifests. It passes per engine only when quality passes, every compared run has complete usage, the median paired review-token-proxy change is at most -30%, and aggregate candidate proxy tokens are at most 70% of baseline; a missing or mismatched revision is unevaluable. Earlier PRs report progress without claiming the final target.

The proxy is the sum of provider-reported tokens for review/fix subagent or subprocess model calls only. For repetition `r`, `B_r` and `C_r` are the baseline and candidate sums of every scenario's review/fix proxy tokens in that repetition; its paired change is `(C_r - B_r) / B_r`, and the reported median is taken across exactly 30 repetition-level changes. Any `B_r = 0` is unevaluable, and the aggregate gate is `sum(C_r) <= 0.70 * sum(B_r)` across those same repetitions. The proxy excludes all parent-session usage, unreported provider work, and unrelated activity. Reports name this limitation.

## PR 1 measurement architecture

Both adapters emit one normalized record per review or fix invocation:

- engine, provider, provider-schema version, role, round, invocation ID, requested model, reasoning effort, service tier, and exposed resolved model;
- fresh input, cache-write input, cached input, reasoning output when exposed separately, visible or aggregate output, and total tokens;
- elapsed milliseconds, terminal status, and `usagePartial`; and
- the non-negative provider usage numbers used for normalization.

PR 1 migrates the evaluator and recorded fixtures to manifest `schemaVersion: 2`; this study rejects version 1 manifests. Version 2 removes all parent-proxy fields, contents, provenance validation, and arithmetic, including `parentProxyContents`, `parentProxyTokenizerVersion`, `parentProxyContentHash`, and `parentProxyTokens`; token gates use only the complete telemetry total.

The existing round/normalize flow records a deterministic attempt slot `(engine, provider, artifact path, attempt number)` for every review or fix launch, including failed attempts and retries. The authoritative artifact path is the single destination in the prompt's exact `Write ONLY ... to <path>` output directive; input and reference paths never qualify, and a missing or multiple destination makes usage partial. After the run, each engine reconciles only its owned slots, and each slot must map to exactly one lifecycle telemetry record so every attempt's tokens count; a required artifact missing from ledger consumption already prevents a successful review and scored run, while missing or duplicate telemetry for a slot, or orphan provider evidence, makes the run's usage partial. No prompt change or pre-known tool ID is required. Per-role and per-run aggregates then deduplicate by invocation ID. An incomplete invocation remains visible and makes that run's token comparison non-passing without changing review behavior.

### Codex

Codex already runs through `codex exec --json`. PR 1 pins and records the exact CLI version `codex-cli 0.154.0` and exact requested model, `model_reasoning_effort`, and `service_tier` configuration on both sides, passing the latter two through explicit `--config` overrides so ambient config cannot change them. Because that stream exposes no resolved model, applied reasoning effort, or applied service tier, Codex records the resolved model as `unavailable` and reports the other two as unavailable limitations; the recorded settings are requested values, not proof of provider application. Any structured error item makes usage partial while only its presence and count, never its content, are retained. PR 1 leaves multi-agent behavior unchanged, but the pinned stream parser recognizes any parent-thread collaboration or agent-spawn item or event and marks usage partial because the stream omits child-thread tokens; it retains only kind presence and count, never content. Child work that emits no observable parent-thread collaboration evidence cannot be scored and is disclosed as a study limitation. Silent provider rerouting remains an unresolved study limitation in every Codex report, and the evaluator does not claim actual-model equality. Every non-empty stdout line must parse as one recognized `0.154.0` JSON event, and the stream must contain exactly one `turn.completed`; an unknown, malformed, truncated, or duplicate event makes usage partial, and no line is silently discarded. The adapter accepts only a `turn.completed.usage` object whose key set is exactly `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, and `reasoning_output_tokens`, with every value a non-negative safe integer. It requires cached plus cache-write input not to exceed input and reasoning output not to exceed output, then normalizes fresh input as input minus cached and cache-write input, visible output as output minus reasoning output, and total tokens as input plus output. A real review/fix invocation must have a positive total; an all-zero object is partial because it is indistinguishable from `0.154.0`'s `Usage::default()` after a missing token update. A CLI-version mismatch, a missing or extra usage field, a malformed value or component relationship, a missing completion event, or subprocess failure sets `usagePartial: true`.

### Claude Code

Claude Code hook `totalTokens` and `usage` aggregate the subagent invocation when present. They remain audit data because a background launch response can omit them; the complete invocation proxy comes from the subagent transcript path supplied by `SubagentStop`.

The adapter is pinned to a checked-in transcript schema for Claude Code `2.1.268`. It reads JSONL without retaining message content, selects assistant rows for the stopped `agent_id`, and groups them by the pair `(requestId, message.id)`. Streaming rows can repeat that pair with growing usage, so only the last row is counted. Each counted row must have one non-empty request ID, message ID, model, and non-negative `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens`. The four fields sum to that request's total and then to the invocation total.

Because transcript persistence can lag `SubagentStop`, the adapter waits for a bounded, manifest-recorded interval and repeatedly reopens and parses the whole file. It accepts only an EOF-complete JSONL snapshot whose identity, size, and modification time remain unchanged across the read and whose pinned schema identifies a unique terminal assistant response for the stopped agent as its last assistant row, never an intermediate tool-use response. Timeout, concurrent mutation, an incomplete row, multiple terminal candidates, or inability to distinguish the terminal response makes the invocation partial.

The adapter marks the invocation partial if the transcript path escapes the expected session `subagents` directory, the file is absent or unreadable, any JSONL row is truncated, an assistant usage row has missing or malformed identity or usage, one request/message identity maps inconsistently, no usage row exists, the event and rows disagree on `agent_id`, multiple models appear for one requested configuration, or the aggregate hook usage disagrees with the summed deduplicated transcript requests.

`PreToolUse` for `Agent|Task` writes a partial started record keyed by `tool_use_id`. `PostToolUse` or `PostToolUseFailure` adds terminal hook metadata and the returned `agentId` when available. `SubagentStop` observations are stored append-only and exactly one is required for each `agent_id`; a repeated observation makes the invocation partial, so an earlier complete total can never remain final. Ledger folding joins the tool and sole stop identities, replaces the partial start only when both sides are consistent, and otherwise preserves partial evidence. This works whether `PostToolUse` represents foreground completion or background launch; artifact existence and idle time are not completion evidence.

Only prompts with that single authoritative destination under the active state directory are associated with review telemetry. Hooks write atomically and emit no output, so retries, concurrent subagents, unrelated Agent calls, path traversal, malformed input, or telemetry failure cannot alter the tool result or review decision.

This transcript format is an observed, version-pinned Claude Code interface rather than a promised stable API. A different Claude Code version or transcript schema is unsupported and partial until a recorded fixture and reviewed adapter version are added. This bounded compatibility rule replaces the discarded OTel collector design; no external collector, protobuf dependency, managed-settings attestation, debug-log retention, or process-environment rewriting is required.

## Evaluator

The evaluator accepts engine-labelled baseline and candidate manifests and reports separate `qualityPass` and `tokenPass` values per engine. Overall quality is the conjunction of both quality results; overall token pass additionally requires both token results. Missing engines, mismatched pairing identities or provider schemas, duplicate or incomplete repetitions, partial usage, zero baseline totals, unadjudicated findings, invalid fix evidence, and invalid terminal or DoD values are unevaluable rather than silently accepted.

Provider component equations remain engine-specific. Claude sums fresh input, cache creation, cache read, and aggregate output from deduplicated transcript requests. Codex uses the component relationship declared by its pinned JSON event schema. Per-role values never substitute for a partial run total.

## Delivery sequence

1. Add telemetry and the paired evaluator without changing orchestration.
2. Move duplicated engine orchestration behind existing shared-core entrypoints while preserving prompts and state transitions.
3. Use structured output where supported while preserving the normalized artifact contract and fail-closed fallback.
4. Batch panel verification while preserving three fresh votes per finding and rejecting partial batches.
5. Add explicit depth and budget guards supported by both adapters; omitted options preserve current behavior and exhaustion remains non-clean.

Each PR is measured before the next starts. PRs 2-4 compare their exact candidate review-tool revision both with the exact immediately preceding measured revision and with the exact recorded PR 1 pre-optimization baseline revision; any manifest revision mismatch is unevaluable. A quality failure, missing engine, or partial token result blocks an optimization PR. Each PR updates the tracking ticket with its link and per-engine results. PR 5 requires a separate feasibility review because invocation-boundary guards cannot claim a hard provider-request ceiling.

## Verification

Every new behavior test is first observed failing against the pre-change code. PR 1 covers:

- Codex complete, missing, malformed, and inconsistent completion usage;
- Claude start, success, failure, background launch, `SubagentStop`, repeated streaming rows, multi-request aggregation, malformed and escaping transcript paths, identity/model/usage disagreement, unrelated calls, concurrency, atomic replacement, and deduplication;
- resume persistence and unchanged review decisions;
- strict evaluator validation, per-engine isolation, fixed 30-repetition scheduling, false-clean and fix evidence, and provider-specific equations; and
- generated Codex bundle parity plus the complete configured test suite.

The live report records engine, requested and exposed resolved model identities, provider/schema versions, corpus and tool revisions, quality intervals, complete or partial token proxy, invocation count, latency, and the transcript-interface limitation; it explicitly states that all parent-session usage is excluded.
