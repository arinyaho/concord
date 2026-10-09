# Planner Provider Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve safe execution diagnostics and offer exactly one supported planner-only transport recovery after a failed semantic replacement.

**Architecture:** A shared provider-failure module owns canonical diagnostics and continuation. The CLI owns durable transport dispatch and all existing semantic, evidence and budget invariants. The runner consumes that authority and packages it consistently.

**Tech Stack:** Node.js, node:test, deterministic review CLI, provider subprocess seam, self-contained Codex/Copilot bundles.

---

### Task 1: Establish the failing contract

Create `plugins/concord/hooks/test/planner-provider-recovery.test.js` and `provider-failure.test.js`. Drive the real CLI with sealed reviewers, incomplete plan and failed replacement. Verify the outcome red on unchanged beta.5. Cover credential-bearing errors, terminal continuation and bounded planner-only recovery.

### Task 2: Canonicalize provider failure

Create `plugins/concord/core/provider-failure.js`. Implement `providerFailure`, `normalizeProviderFailure` and `reviewContinuation` with fixed messages and closed metadata enums. Capture bounded diagnostic material in `codex-review-runner.js`; sanitize nonzero and thrown subprocess failures before persistence. Run `node --test plugins/concord/hooks/test/provider-failure.test.js`; require behavioral assertions to pass and no credential marker to survive.

### Task 3: Consume separate transport recovery

Modify `plugins/concord/core/review-cli.js`: canonicalize failure records, authorize `execution.planTransportRetry` only for identified retryable failed replacement, consume its one dispatch after a fresh reservation, and preserve it during same-round resume. Reject recovery without exact sealed dependencies or after dispatch exhaustion. Modify runner error packet and `review.js` reports to use shared durable continuation. Run the recovery regression and existing `plan-resume.test.js`; require exact reviewer identities and failed-launch accounting to remain unchanged.

### Task 4: Document and package

Correct every document identified in the design note sweep, including manual commands and Copilot output guidance. Regenerate with `node plugins/concord-codex/bin/bundle.mjs` and `node plugins/concord-copilot/bin/bundle.mjs`. Run recovery tests against the packaged engine, focused runner/CLI/initiative/telemetry and packaging checks. Run docs GAP/xref checks and inspect changed-file links.

### Task 5: Verify, version and deliver

Run CI plugin and agent-team suites and `node scripts/dod.mjs`. Use `node scripts/release-version.mjs 0.9.0-beta.6` to align release metadata, and verify version tests. Commit the combined result. Run independent branch review-and-fix from a clean isolated checkout, fix accepted findings, then create one PR against main. Record the exact-head/base delivery disposition and report remaining blockers without claiming green. Merge and publication remain separate actions.
