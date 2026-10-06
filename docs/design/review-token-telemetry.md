# Review token telemetry and evaluation

Concord measures the tokens that `review-and-fix` spends on its review and fix subagents, and evaluates any change meant to reduce that cost against a paired quality and token gate. Claude Code and Codex are measured and judged separately, so one engine cannot hide the other's regression.

The measured quantity is a proxy: the sum of provider-reported tokens for review and fix subagent or subprocess model calls only. All parent-session usage, unreported provider work, and unrelated activity are excluded, so a proxy reduction is never claimed as a reduction in total provider billing. Reports name this limitation.

## Invariants

- Telemetry is observational. Recording it never changes prompts, role order, fan-out, defaults, or terminal decisions.
- Missing, malformed, or inconsistent usage is `partial`, never zero.
- Live model runs are explicit and paid. Ordinary tests use recorded provider-event fixtures.
- Telemetry stores identifiers and numeric usage only, never prompts, responses, reasoning, credentials, or transcript content.

## Normalized record

Both adapters emit one normalized record per review or fix invocation:

- engine, provider, provider-schema version, role, operation, round, invocation ID, requested model, reasoning effort, service tier, and exposed resolved model;
- fresh input, cache-write input, cached input, reasoning output when exposed separately, visible or aggregate output, and total tokens;
- elapsed milliseconds, terminal status, and `usagePartial`; and
- the non-negative provider usage numbers used for normalization.

The round/normalize flow records a deterministic attempt slot `(engine, provider, artifact path, attempt number)` for every review or fix launch, including failed attempts and retries. The authoritative artifact path is the single destination in the prompt's exact `Write ONLY ... to <path>` output directive; input and reference paths never qualify, and a missing or multiple destination makes usage partial. After the run, each engine reconciles only its owned slots, and each slot must map to exactly one lifecycle telemetry record so every attempt's tokens count. Missing or duplicate telemetry for a slot, or orphan provider evidence, makes the run's usage partial. Per-role and per-run aggregates deduplicate by invocation ID. An incomplete invocation stays visible and makes that run's token comparison non-passing without changing review behavior.

### Codex

Codex runs through `codex exec --json`. The adapter pins and records the exact CLI version and the requested model, `model_reasoning_effort`, and `service_tier`, passing the latter two through explicit `--config` overrides so ambient configuration cannot change them. The stream exposes no resolved model, applied reasoning effort, or applied service tier, so the resolved model is recorded as `unavailable` and the other two are reported as requested values only, not proof of what the provider applied.

Every non-empty stdout line must parse as one recognized JSON event of the pinned version, and the stream must contain exactly one `turn.completed`; an unknown, malformed, truncated, or duplicate event makes usage partial, and no line is silently discarded. The adapter accepts only a `turn.completed.usage` object whose key set is exactly `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, and `reasoning_output_tokens`, each a non-negative safe integer. Cached plus cache-write input must not exceed input, and reasoning output must not exceed output. Fresh input is input minus cached and cache-write input, visible output is output minus reasoning output, and total is input plus output. A real invocation must have a positive total; an all-zero object is partial because it is indistinguishable from a default usage value after a missing token update. A CLI-version mismatch, a missing or extra usage field, a malformed value or component relationship, a missing completion event, or subprocess failure sets `usagePartial: true`.

Any structured error item makes usage partial; only its presence and count are retained. Any parent-thread collaboration or agent-spawn item also marks usage partial, because the stream omits child-thread tokens. Child work that emits no observable parent-thread evidence cannot be scored, and silent provider rerouting cannot be detected; both are reported limitations.

### Claude Code

Claude Code hook `totalTokens` and `usage` aggregate the subagent invocation when present. They remain audit data because a background launch response can omit them; the complete invocation proxy comes from the subagent transcript path supplied by `SubagentStop`.

The adapter is pinned to a checked-in transcript schema for one Claude Code version. It reads JSONL without retaining message content, selects assistant rows for the stopped `agent_id`, and groups them by `(requestId, message.id)`. Streaming rows can repeat that pair with growing usage, so only the last row is counted. Each counted row must have a non-empty request ID, message ID, model, and non-negative `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens`. The four fields sum to that request's total and then to the invocation total.

Because transcript persistence can lag `SubagentStop`, the adapter waits for a bounded, manifest-recorded interval and repeatedly reopens and parses the whole file. It accepts only an EOF-complete snapshot whose identity, size, and modification time stay unchanged across the read and whose last assistant row is a unique terminal response for the stopped agent, never an intermediate tool-use response. Timeout, concurrent mutation, an incomplete row, or an ambiguous terminal response makes the invocation partial.

The invocation is also partial if the transcript path escapes the expected session `subagents` directory, the file is absent or unreadable, a row is truncated, a usage row has missing or malformed identity or usage, one request/message identity maps inconsistently, no usage row exists, the event and rows disagree on `agent_id`, multiple models appear for one requested configuration, or the aggregate hook usage disagrees with the summed transcript requests.

`PreToolUse` for `Agent|Task` writes a partial started record keyed by `tool_use_id`. `PostToolUse` or `PostToolUseFailure` adds terminal hook metadata and the returned `agentId` when available. `SubagentStop` observations are stored append-only and exactly one is required for each `agent_id`; a repeated observation makes the invocation partial. Folding joins the tool and stop identities and replaces the partial start only when both are consistent. This works whether `PostToolUse` represents foreground completion or background launch; artifact existence and idle time are not completion evidence.

Only prompts with a single authoritative destination under the active state directory are associated with review telemetry. Hooks write atomically and emit no output, so retries, concurrent subagents, unrelated Agent calls, path traversal, malformed input, or telemetry failure cannot alter the tool result or review decision.

The transcript format is an observed, version-pinned interface, not a promised stable API. A different Claude Code version or transcript schema is unsupported and partial until a recorded fixture and reviewed adapter version are added. This bounded compatibility rule was chosen over an OpenTelemetry collector design, which needed an external collector, a protobuf dependency, managed-settings attestation, debug-log retention, and process-environment rewriting.

## Evaluator

The evaluator (`core/review-eval.js`) accepts engine-labelled baseline and candidate manifests at `schemaVersion: 2` and reports separate `qualityPass` and `tokenPass` values per engine. Overall quality is the conjunction of both engines' quality results; overall token pass also requires both token results. Missing engines, mismatched pairing identities or provider schemas, duplicate or incomplete repetitions, partial usage, zero baseline totals, unadjudicated findings, invalid fix evidence, and invalid terminal or DoD values are unevaluable rather than silently accepted. Manifests carry no parent-session proxy fields; token gates use only the complete telemetry total.

### Corpus

The versioned corpus contains clean changes, seeded defects, false-positive traps, malformed or blocked artifacts, holistic-review cases, and a fix-and-confirm case. Before collection it freezes expected finding identities, required fixes, probes, allowed terminal outcomes, and a boolean `hasExecutableDoD`. For a `clean` result, `hasExecutableDoD: true` requires `dod: "passed"`; `hasExecutableDoD: false` is the only DoD exemption and requires `dod: "deferred"`. Each scenario freezes a `probesByFinding` mapping from every scenario-qualified seeded-defect, confirmed-defect, or required-fix identity to a non-empty list of probes in that scenario's inventory; a missing entry, empty list, or unknown probe makes the corpus invalid.

Before scoring a repetition, a reviewer blinded to the producing side adjudicates every accepted finding that does not match the frozen identities and assigns it one unique scenario-qualified identity. An adjudicated non-defect extends the shared set `N` used to score both sides; a confirmed defect enters required-defect handling with a frozen `probesByFinding` entry, and both sides are rescored. An unadjudicated finding, unassignable identity, or identity collision makes the repetition unevaluable.

### Pairing

Each engine runs 30 independent paired repetitions of baseline and candidate; each repetition runs every scenario once per side. A pair uses the same repository snapshot, review configuration, requested model, reasoning-effort and service-tier configuration, provider alias, and corpus revision, but separate sessions, checkouts, and artifact directories. Each scenario pair records equal `targetDiffIdentity`, `targetDiffHash`, `intentIdentity`, and `intentHash` (`"none"` when there is no intent). When an adapter exposes the resolved model, each requested configuration must resolve to exactly one identity and the two sides must match; an `unavailable` marker records absence of evidence and never proves equality. Run order alternates within five blocks of six; manifests record `scheduleBlock`, `schedulePosition`, and the first side, and they must match the frozen schedule. Provider randomness remains a limitation where no seed control exists.

### Quality gate

Quality passes per engine only when:

- neither side produces a false clean;
- on each side, every confirmed defect is accepted, has fix commit evidence, is absent from confirmation, and passes every probe in its `probesByFinding` entry, even when the terminal result is not `clean`;
- the lower bound of the paired 95% interval for candidate-minus-baseline seeded-defect recall is at least -5 percentage points;
- the upper bound of the equivalent false-positive-rate interval is at most +5 percentage points;
- the lower bound of the equivalent successful-fix-rate interval is at least -5 percentage points;
- both bounds of every terminal-outcome share interval lie within +/-5 percentage points; and
- replay fixtures preserve accepted findings, fixes, probes, DoD, and terminal results exactly.

A `clean` result is false when the scenario disallows `clean`, an executable DoD did not pass, any seeded or confirmed defect was not accepted, lacks fix evidence, recurs in confirmation, or fails a probe, any other required fix lacks fix evidence, recurs, or fails a probe, or any other frozen probe fails.

For repetition `r` and side `s`, with `D` and `F` the frozen non-empty sets of scenario-qualified seeded-defect and required-fix identities, `N` the shared non-defect set, and `S` the frozen scenario set:

- `recall(s,r) = |accepted(s,r) ∩ D| / |D|`
- `falsePositiveRate(s,r) = |accepted(s,r) ∩ N| / |N|`
- `successfulFixRate(s,r) = |{f ∈ F: accepted, fix evidence, absent from confirmation, passes every probe}| / |F|`
- `terminalShare(s,r,o) = |{x ∈ S: terminal(s,r,x) = o}| / |S|` for every frozen terminal value `o`

Each metric contributes the paired observation `candidate - baseline`; across the 30 repetitions its two-sided 95% Student-t interval is `mean ± t(0.975, 29) · sd / sqrt(30)`. Any incomplete repetition or empty denominator is unevaluable and non-passing.

### Token gate

For repetition `r`, `B_r` and `C_r` are the baseline and candidate sums of every scenario's proxy tokens; the paired change is `(C_r - B_r) / B_r`. The token gate passes per engine only when quality passes, every compared run has complete usage, the median of the 30 paired changes is at most -30%, and `sum(C_r) <= 0.70 · sum(B_r)`. Any `B_r = 0` is unevaluable. A candidate is compared both with the immediately preceding measured revision and with the recorded pre-optimization baseline revision; a missing or mismatched revision is unevaluable.

Provider component equations stay engine-specific: Claude sums fresh input, cache creation, cache read, and aggregate output from deduplicated transcript requests; Codex uses the relationship declared by its pinned event schema. Per-role values never substitute for a partial run total.

## Rationale and rejected alternatives

- Measuring before optimizing makes every later change answerable to the same gate; a change that cannot show quality parity is not accepted on token savings alone.
- Per-engine judgement keeps a regression on one engine from being averaged away by a gain on the other.
- Treating missing usage as zero would make an incomplete run look cheaper. Partial is the only honest value.
- The OpenTelemetry collector design was rejected for the external dependencies listed above; a pinned transcript reader with a fail-partial rule gives the same per-invocation data with no new infrastructure.

## Residual exposure

- Parent-session usage is never measured, so the proxy cannot speak to total cost.
- Codex's applied reasoning effort, service tier, and resolved model are not observable; recorded values are requested configuration only.
- Invocation-boundary guards cannot claim a hard provider-request ceiling.
- A Claude Code version change makes telemetry partial until a new fixture and adapter version are added.
- A Copilot-driven run allocates no telemetry slots; see the GitHub Copilot support design.
