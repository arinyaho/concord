# Review Token Telemetry Implementation Plan

> **For Codex:** Execute this plan task by task with test-driven development and verification before completion.

**Goal:** Add behavior-preserving Codex subprocess telemetry and a deterministic paired-evaluation command so later token optimizations can be measured against a trustworthy baseline.

**Architecture:** Keep orchestration in `codex-review-runner.js`. Parse only `turn.completed` usage events from the existing `codex exec --json` stream, normalize one record per subprocess, and aggregate records in the runner result without changing prompts, scheduling, or terminal decisions. Add a small pure evaluator that compares versioned baseline/candidate manifests; its CLI reads JSON files and emits a machine-readable report.

**Tech Stack:** Node.js CommonJS, Node built-ins, `node:test`, Codex CLI JSONL.

---

### Task 1: Capture and normalize Codex subprocess usage

**Files:**
- Modify: `plugins/concord/hooks/test/codex-review-runner.test.js`
- Modify: `plugins/concord/core/codex-review-runner.js`
- Regenerate: `plugins/concord-codex/engine/codex-review-runner.js`

1. Add a fake `codex` executable test that emits a documented `turn.completed` JSONL event and assert the returned identity fields: role, elapsed time, exit status, fresh input, cached input, reasoning output, visible output, total tokens, and `usagePartial: false`.
2. Run the focused test and observe it fail against the current adapter because `codexExec` returns only `{status}`.
3. Add `--json`, stream stdout line-by-line, retain only the last valid `turn.completed.usage`, and normalize non-negative finite integers. Derive `totalTokens` from components only when the event omits it; mark missing or invalid required fields partial rather than silently treating them as zero.
4. Add and run a partial-usage test for a successful subprocess with no usage event.
5. Run the focused adapter tests.

### Task 2: Aggregate telemetry without changing orchestration

**Files:**
- Modify: `plugins/concord/hooks/test/codex-review-runner.test.js`
- Modify: `plugins/concord/core/codex-review-runner.js`
- Regenerate: `plugins/concord-codex/engine/codex-review-runner.js`

1. Use the already-observed RED acceptance test `runner reports aggregate and per-role subprocess telemetry` as the specification.
2. Make `invoke` return its normalized result and record exactly one entry after each completed spawn, including failed/partial status where available.
3. Return `{...terminalResult, telemetry}`. Aggregate by exact role identity and total calls, partial calls, token categories, and elapsed milliseconds; do not alter any reviewer prompt or call order.
4. Run the focused telemetry test, the runner test file, and the Codex bundle drift test.

### Task 3: Add deterministic paired evaluation

**Files:**
- Create: `plugins/concord/core/review-eval.js`
- Create: `plugins/concord-codex/bin/review-eval.js`
- Create: `plugins/concord/hooks/test/review-eval.test.js`
- Create: `plugins/concord/hooks/test/fixtures/review-eval/baseline.json`
- Create: `plugins/concord/hooks/test/fixtures/review-eval/candidate.json`
- Regenerate: `plugins/concord-codex/engine/review-eval.js`

1. Add fixtures with 30 paired repetitions and identity-bearing scenarios for clean, seeded defect, false positive, malformed/blocked, and fix-round behavior.
2. Add RED tests that assert exact finding identities, zero additional false cleans, exact behavior-preserving tuples, paired recall/FPR confidence bounds, complete usage, median paired token change, subprocess count, and latency.
3. Implement strict manifest validation and comparison as pure functions. Reject mismatched pairing identities, unknown accepted identities without adjudication, partial usage, missing terminal/DoD/fix values, and fewer than 30 independent pairs.
4. Implement the CLI as a thin file reader that prints the report JSON and exits non-zero when the report is unevaluable or any quality/token gate fails.
5. Run evaluator unit and CLI tests.

### Task 4: Verify and prepare the PR

**Files:**
- Modify only if needed: `docs/superpowers/specs/2026-09-12-review-token-efficiency-design.md`
- Regenerate: `plugins/concord-codex/engine/*`

1. Run `node plugins/concord-codex/bin/bundle.mjs` and confirm the drift guard passes.
2. Run the exact Stage 2 telemetry acceptance test and confirm it now passes.
3. Run `CONCORD_RUN_PLUGIN_INSTALL_E2E=1 node --test` from the worktree and record the result.
4. Commit only PR 1 files, run `review-until-green` on the branch against `origin/main`, and resolve findings until terminal clean.
5. Re-run the full DoD after review changes.
6. Push `feat/review-token-telemetry`, open a PR targeting `main`, and update the Notion ticket checklist/status with the PR link and measured result. Do not merge.
