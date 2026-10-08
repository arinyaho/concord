# Incomplete Plan Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Retry an incomplete protocol-v2 classification once without rerunning sealed review stages or bypassing reservations.

**Architecture:** The CLI owns plan acceptance and bounded rejection state. The runner reuses hash-bound normalized pending plans and passes corrective prompts to a fresh reserved planner.

**Tech Stack:** Node.js, deterministic review CLI, provider subprocess seam, node:test.

## Task 1: Reproduce the wrapper outcome

Create `plugins/concord/hooks/test/plan-resume.test.js`. Run `node --test plugins/concord/hooks/test/plan-resume.test.js` against unchanged production. Assert real CLI completeness rejection before fixer launch, then fresh planner-only resume, identity/hash preservation, repeated incompleteness exhaustion, budget denial, and accepted-plan idempotency. Expected baseline: replacement and budget cases fail because the first plan is replayed; accepted-plan reuse passes.

## Task 2: Record plan acceptance and rejection

Modify `plugins/concord/core/review-cli.js`. Normalization writes `execution.normalizedPlan` with the canonical hash, preserving pending status. Resume preserves that hash-bound artifact and returns `normalizedArtifacts: ['plan']`. Successful `plan-fixes` moves it to completed. Incomplete classification records `planRetry`, a corrective prompt and failure, invalidates only plan evidence and supersedes its launch once. Persist retry state across same-scope resumes; stop exhausted recovery before another role dispatch. Do not preserve stale plan repair records after semantic rejection.

Run the focused test above; successful replacement must reach the real fixer boundary with exact identities, and denial must expose budget-exhausted.

## Task 3: Consume durable evidence in every driver

Modify `plugins/concord/core/codex-review-runner.js` to skip both completed and normalized pending roles and pass `retryArtifacts[role]` with the normal planner prompt. Update `plugins/concord/core/review-driver.md`, composed Claude/Copilot commands, and Codex command guidance to distinguish normalization from plan acceptance and describe the one semantic replacement. Regenerate Codex/Copilot bundles using their `bin/bundle.mjs` scripts.

Run focused regression and runner/CLI/initiative/telemetry/bundle suites; confirm pending-normalized interruption and repaired rejected plan coverage.

## Task 4: Verify and deliver

Update `docs/design/review-artifact-contract.md` and `docs/design/review-ledger.md` to document the pending plan and semantic retry boundary. Sweep related operator instructions and record unchanged documents in the design note. Run plugin and agent-team CI commands under Node 22 plus `node scripts/dod.mjs`. Run the design and branch `review-and-fix` gates, correct accepted blockers, then create the PR against main and record its exact-head/base delivery disposition.
