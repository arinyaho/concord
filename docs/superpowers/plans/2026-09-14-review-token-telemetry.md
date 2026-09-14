# Review Token Telemetry Implementation Plan

> **For Claude Code and Codex:** Execute this plan task by task with test-driven development and verification before completion.

**Goal:** Add behavior-preserving Claude Code subagent and Codex subprocess telemetry plus a deterministic paired-evaluation command so later token optimizations can be measured against trustworthy, engine-specific baselines.

**Architecture:** Keep orchestration unchanged. Parse `turn.completed` usage events from the existing `codex exec --json` stream. For Claude Code, associate `Agent|Task` hook records with the `SubagentStop` transcript, deduplicate streaming rows by request/message identity, and sum the pinned provider usage fields without retaining content. Normalize both provider shapes into one record without discarding provider-specific components. Add a small pure evaluator that compares versioned baseline/candidate manifests per engine and passes only when both engines pass independently.

**Tech Stack:** Node.js CommonJS, Node built-ins, `node:test`, Claude Code hook JSON, Codex CLI JSONL.

---

### Task 1: Capture and normalize Codex subprocess usage

**Files:**
- Modify: `plugins/concord/hooks/test/codex-review-runner.test.js`
- Modify: `plugins/concord/core/codex-review-runner.js`
- Regenerate: `plugins/concord-codex/engine/codex-review-runner.js`

1. Add a fake `codex` executable test that emits a documented `turn.completed` JSONL event and assert the returned identity fields: role, elapsed time, exit status, fresh input, cached input, reasoning output, visible output, total tokens, and `usagePartial: false`.
2. Run the focused test and observe it fail against the current adapter because `codexExec` returns only `{status}`.
3. Pin the parser to `codex-cli 0.154.0`, require every non-empty stdout line to be one recognized valid JSON event and exactly one `turn.completed`, and mark malformed, truncated, unknown, or duplicate events, structured error items, and parent-thread collaboration or agent-spawn evidence partial as applicable without retaining content. Accept only the exact non-negative-safe-integer usage keys `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, and `reasoning_output_tokens`, enforce their component bounds, and derive total as input plus output; silently discarding stream evidence is forbidden.
4. Add and run a partial-usage test for a successful subprocess with no usage event.
5. Run the focused adapter tests.

### Task 2: Aggregate telemetry without changing orchestration

**Files:**
- Modify: `plugins/concord/hooks/test/codex-review-runner.test.js`
- Modify: `plugins/concord/core/codex-review-runner.js`
- Modify: `plugins/concord/core/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`
- Regenerate: `plugins/concord-codex/engine/codex-review-runner.js`
- Regenerate: `plugins/concord-codex/engine/review-cli.js`

1. Use the already-observed RED acceptance test `runner reports aggregate and per-role subprocess telemetry` as the specification.
2. Add a shared review CLI operation used immediately before every Codex subprocess or manual Claude `Agent` review/fix launch, including retries and failures, to persist a deterministic `(destination, attempt number)` slot without a pre-known tool ID or prompt change. Add a RED reconciliation test requiring exactly one telemetry record per slot and marking missing, duplicate, or orphan evidence partial, then make `invoke` return and record each normalized Codex result.
3. Return `{...terminalResult, telemetry}`. Aggregate by exact role identity and total calls, partial calls, token categories, and elapsed milliseconds; do not alter any reviewer prompt or call order.
4. Run the focused telemetry test, the runner test file, and the Codex bundle drift test.

### Task 3: Capture and aggregate Claude Code subagent usage

**Files:**
- Create: `plugins/concord/hooks/review-telemetry.js`
- Create: `plugins/concord/adapters/claude-code/review-telemetry.js`
- Create: `plugins/concord/core/review-telemetry.js`
- Create: `plugins/concord/hooks/test/claude-review-telemetry.test.js`
- Modify: `plugins/concord/hooks/hooks.json`
- Modify: `plugins/concord/core/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

1. Add a RED unit test with realistic `PreToolUse`, `PostToolUse`, and `SubagentStop` events plus a version-pinned transcript containing repeated streaming rows for several requests. Assert that only the last row per `(requestId, message.id)` is counted and that the joined invocation contains exact role, round, model, status, duration, components, total, and `usagePartial: false`.
2. Add RED cases for `PostToolUseFailure`, background-launch ordering, the legacy `Task` name, malformed or escaping transcript paths, missing usage, identity/model/final-request disagreement, unrelated prompts, two concurrent identities, a delayed terminal transcript append within the bound, a valid prefix ending at a tool-use response, repeated `SubagentStop` observations for one agent, and a persisted attempt slot with its entire tool hook missing. Add timeout, mutation-during-read, and ambiguous-terminal cases; only the delayed stable terminal case may be complete, while every other invalid or incomplete case, including repeated stop or missing hook, remains partial.
3. Extend the fail-soft hook entrypoint to write tool-use records keyed by `tool_use_id` and every `SubagentStop` as a distinct append-only transcript observation grouped by `agent_id`; never overwrite an earlier stop observation. After `SubagentStop`, repeatedly reopen and parse the whole file within a bounded manifest-recorded interval, accepting only a stable EOF-complete snapshot with one final non-tool-use assistant response for that agent; timeout, mutation, truncation, ambiguity, or more than one stop observation is partial. Read only identity and numeric usage fields; never persist prompt, response, reasoning, or transcript content.
4. Register `SubagentStop` alongside the existing `Agent|Task` launch/success/failure hooks. Keep every hook observational: emit no model-visible output and never block a tool result.
5. Before each manual `Agent` launch, persist its expected `(destination, attempt number)` through the shared review CLI operation, then fold matching tool and agent records against those slots into the run ledger and terminal handoff. Deduplicate by invocation ID, require the pinned Claude Code/transcript schema, and mark missing or inconsistent joins partial without changing prompts, scheduling, or terminal decisions.
6. Run the Claude telemetry, review CLI, hook manifest, neutrality, and full hook tests.

### Task 4: Add deterministic paired evaluation

**Files:**
- Create: `plugins/concord/core/review-eval.js`
- Create: `plugins/concord-codex/bin/review-eval.js`
- Create: `plugins/concord/hooks/test/review-eval.test.js`
- Create: `plugins/concord/hooks/test/fixtures/review-eval/baseline.json`
- Create: `plugins/concord/hooks/test/fixtures/review-eval/candidate.json`
- Regenerate: `plugins/concord-codex/engine/review-eval.js`

1. Add `schemaVersion: 2` engine-labelled fixtures with exactly 30 paired repetitions per engine and scenario-qualified identities for clean, seeded defect, false positive, malformed/blocked, all required holistic lenses, and fix-round behavior. Each scenario declares `hasExecutableDoD` and a valid total `probesByFinding` mapping.
2. Add RED tests that assert exact finding identities, zero false cleans on both baseline and candidate under the design's full false-clean predicate (including a same-pair false clean on both sides that must fail), the absolute confirmed-defect gate even for non-clean outcomes, paired recall/FPR and successful-fix confidence bounds, both bounds of every per-terminal interval, exact behavior-preserving tuples, complete usage, median paired token change, invocation count, and latency for each engine. Also cover the `hasExecutableDoD` exemption, reject missing or unknown `probesByFinding` references and unqualified identities, and prove that version 1 manifests and version 2 `parentProxy*` fields are rejected.
3. Add RED tests proving a strong Codex result cannot hide a Claude regression, cross-engine pairs are rejected, missing engine coverage is non-passing, and provider-specific component equations are checked without double-counting. Add CLI-stage tests proving each exact PR 2-4 candidate revision is compared with both its immediately preceding measured revision and the frozen PR 1 baseline, with both comparisons evaluable, telemetry-complete, and quality-passing while token progress is reported without enforcing the final `-30%`/`70%` thresholds. For PR 5, prove the adjacent-stage comparison likewise requires evaluable complete telemetry and passing quality but only reports its token delta, while the original-PR-1 comparison alone must meet the final thresholds.
4. Migrate the manifest contract to `schemaVersion: 2` and reject version 1 rather than upgrading it in memory. Remove parent-proxy fields, provenance, and parent-plus-telemetry arithmetic; version 2 totals and token gates use only provider-reported review/fix subagent or subprocess telemetry. Implement strict manifest validation and comparison as pure functions, using scenario-qualified identities and validated `hasExecutableDoD` and `probesByFinding` fields for false-clean, absolute confirmed-defect, successful-fix, and probe checks. Require exactly 30 independent paired repetitions per engine and validate each manifest's block, within-block position, and actual first side against the frozen schedule; fewer, extra, missing, duplicate, or out-of-order repetitions are rejected. Compute the successful-fix paired interval and every per-terminal paired interval with the design's declared bounds. Also reject mismatched pairing identities, engine or provider-schema mismatches, unknown accepted identities without adjudication, partial usage, and missing terminal/DoD/fix values.
5. Implement the CLI as a thin file reader with a required `--stage pr1|pr2|pr3|pr4|pr5` mode. For each PR 2-4 stage, require its exact candidate revision to pass evaluability, telemetry completeness, and quality against both the exact immediately preceding measured revision and frozen PR 1 baseline, and report both token deltas without applying the final thresholds. For PR 5, require the adjacent-stage comparison to be evaluable with complete telemetry and passing quality and report its token delta without applying the cumulative thresholds; apply the `-30%` median and `70%` aggregate gates only to the original-PR-1 comparison.
6. Run evaluator unit and CLI tests.

### Task 5: Verify and prepare the PR

**Files:**
- Modify only if needed: `docs/superpowers/specs/2026-09-12-review-token-efficiency-design.md`
- Regenerate: `plugins/concord-codex/engine/*`

1. Run `node plugins/concord-codex/bin/bundle.mjs` and confirm the Codex distribution drift guard passes; verify the Claude plugin hook manifest and command composition tests too.
2. Run the exact Codex and Claude telemetry acceptance tests and confirm both now pass.
3. Run `CONCORD_RUN_PLUGIN_INSTALL_E2E=1 node --test` from the worktree and record the result.
4. Commit only PR 1 files, run `review-until-green` on the branch against `origin/main`, and resolve findings until terminal clean.
5. Re-run the full DoD after review changes.
6. Push `feat/review-token-telemetry`, open a PR targeting `main`, and update the Notion ticket checklist/status with the PR link and per-engine measurement status. Do not merge.
