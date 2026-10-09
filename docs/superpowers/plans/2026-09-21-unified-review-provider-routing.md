# Unified Review Provider Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify Concord's plugin identity and review workflow while allowing independent Claude, Codex, or Copilot reviewer and fixer selection with explicit models.

**Architecture:** Generalize the existing deterministic subprocess runner around role-aware provider adapters. Each package supplies its host identity and native spawn capability; the shared router prefers native same-host execution and otherwise invokes the selected provider CLI.

**Tech Stack:** Node.js CommonJS, Node test runner, Markdown plugin manifests and skills.

---

### Task 1: Define routing behavior

**Files:**
- Modify: `plugins/concord/hooks/test/codex-review-runner.test.js`
- Modify: `plugins/concord/core/codex-review-runner.js`
- Modify: `plugins/concord-codex/bin/review-until-green.js`

1. Add failing tests for reviewer/fixer parsing, role-specific provider and model selection, native preference, all CLI adapters, and fail-closed errors.
2. Run the focused test and confirm the new assertions fail for missing routing behavior.
3. Add the minimal provider router and CLI adapters while preserving sequencing and artifact validation.
4. Run the focused test until it passes.

### Task 2: Persist routing identity

**Files:**
- Modify: `plugins/concord/hooks/test/review-cli.test.js`
- Modify: `plugins/concord/core/review-cli.js`
- Modify: `plugins/concord/core/review.js`

1. Add failing tests that a new run records all four routing fields and resume rejects conflicting routing.
2. Run the focused tests and confirm the contract is absent.
3. Store routing in the ledger and include it in terminal handoffs.
4. Run the focused tests until they pass.

### Task 3: Unify package surfaces

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `.github/plugin/marketplace.json`
- Modify: `plugins/concord/.claude-plugin/plugin.json`
- Modify: `plugins/concord-codex/.codex-plugin/plugin.json`
- Modify: `plugins/concord-copilot/plugin.json`
- Modify: `plugins/concord/commands/review-until-green.md`
- Modify: `plugins/concord-codex/commands/review-until-green.md`
- Modify: `plugins/concord-copilot/skills/review-until-green/SKILL.md`
- Delete: `plugins/concord/skills/concord-codex-review/`
- Delete: `plugins/concord-copilot/skills/cross-model-review/`
- Modify: `README.md`

1. Add failing package tests for the common `concord` name, unified flags, and removal of duplicate skills.
2. Run those tests and confirm they fail against the provider-specific names and skills.
3. Update manifests, marketplaces, installation instructions, and workflow surfaces.
4. Run package tests until they pass.

### Task 4: Regenerate and validate distributions

**Files:**
- Regenerate: `plugins/concord-codex/engine/`
- Regenerate: `plugins/concord-copilot/engine/`
- Modify: `scripts/release-version.mjs`
- Modify: affected package and parity tests

1. Run both bundle scripts.
2. Run focused runner, package, version, and bundle-drift tests.
3. Run the repository DoD commands from `review.config.json`.
4. Inspect the final diff for unrelated changes and preserve the pre-existing alpha.27 edits.