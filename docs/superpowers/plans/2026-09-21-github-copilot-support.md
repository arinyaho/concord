# GitHub Copilot Support Implementation Plan

> **For GitHub Copilot:** Execute this plan task by task with test-driven development and verification before completion.

**Goal:** Add a self-contained Concord Agent Plugin for GitHub Copilot with explicit charter persistence, shared workflows, native review agents, and documented degraded behavior.

**Architecture:** Vendor the existing CommonJS core through a deterministic bundle script and keep Copilot event and state behavior in a dedicated adapter. Package fixed Agent Plugins 1.0 component paths, use documented Preview hooks for charter lifecycle, and use clean-context Copilot custom agents for review roles.

**Tech Stack:** Node.js CommonJS, Node built-ins, `node:test`, Agent Plugins 1.0, VS Code GitHub Copilot Preview hooks and custom agents.

---

### Task 1: Add the distribution and release contract

**Files:**
- Create: `plugins/concord-copilot/plugin.json`
- Create: `.github/plugin/marketplace.json`
- Modify: `scripts/release-version.mjs`
- Modify: `plugins/concord/hooks/test/plugin-version.test.js`

1. Add a failing test that expects all three manifests to share one version and the Copilot marketplace to resolve the new distribution.
2. Run `node --test plugins/concord/hooks/test/plugin-version.test.js` and confirm the missing manifest failure.
3. Add the Agent Plugins 1.0 manifest, marketplace entry, and release target.
4. Rerun the focused test and require all assertions to pass.

### Task 2: Add isolated Copilot charter state

**Files:**
- Create: `plugins/concord/adapters/copilot/event.js`
- Create: `plugins/concord/adapters/copilot/statedir.js`
- Create: `plugins/concord-copilot/hooks/session-start.js`
- Create: `plugins/concord-copilot/hooks/user-prompt-submit.js`
- Create: `plugins/concord-copilot/com.github.copilot/hooks/hooks.json`
- Test: `plugins/concord/hooks/test/copilot-adapter.test.js`

1. Write failing cases for documented hook fields, the 1 MiB limit, canonical-root isolation, explicit charter markers, context injection, and missing `cwd`.
2. Run the focused adapter test and verify failure for missing modules.
3. Implement JSON normalization, state-root precedence, project hashing, persistence, and hook output.
4. Rerun the adapter test and require all cases to pass.

### Task 3: Build a self-contained package

**Files:**
- Create: `plugins/concord-copilot/bin/bundle.mjs`
- Create: `plugins/concord-copilot/bin/charter-cli.js`
- Create: `plugins/concord-copilot/bin/review-cli.js`
- Generate: `plugins/concord-copilot/engine/*.js`
- Test: `plugins/concord/hooks/test/copilot-package.test.js`

1. Add failing package-layout and byte-parity tests.
2. Implement deterministic core and adapter copying plus thin CLI entrypoints.
3. Add a subprocess smoke test that sets and shows a charter and reads a review ledger under an isolated home.
4. Run `node plugins/concord-copilot/bin/bundle.mjs && node --test plugins/concord/hooks/test/copilot-package.test.js`.

### Task 4: Package workflows and native agents

**Files:**
- Create: `plugins/concord-copilot/skills/review-until-green/SKILL.md`
- Create: `plugins/concord-copilot/skills/cross-model-review/SKILL.md`
- Create: `plugins/concord-copilot/com.github.copilot/agents/concord-reviewer.agent.md`
- Create: `plugins/concord-copilot/com.github.copilot/agents/concord-fixer.agent.md`
- Create: `plugins/concord-copilot/overrides/initiative-model-routing.md`
- Modify: `plugins/concord-copilot/bin/bundle.mjs`
- Test: `plugins/concord/hooks/test/copilot-package.test.js`

1. Add a failing inventory test for the approved eight skills, portable file parity, native agents, explicit degradation, and Copilot-only model routing.
2. Copy provider-neutral workflows during bundling and override only harness-bound routing.
3. Add hidden reviewer and fixer agents with no nested subagents.
4. Add review skills that stop on unavailable isolation, tools, artifacts, or required model diversity.
5. Regenerate and rerun the focused package test.

### Task 5: Document lifecycle and limitations

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-09-21-github-copilot-support-design.md`
- Create: `docs/superpowers/plans/2026-09-21-github-copilot-support.md`
- Test: `plugins/concord/hooks/test/copilot-package.test.js`

1. Add a failing README contract for install, update, uninstall, Preview hooks, state retention, and absent transcript checkpoints.
2. Document the exact Copilot CLI commands and capability boundary.
3. Record architecture, lifecycle, security, model semantics, and clean-profile acceptance in the design.
4. Run the focused package test and the SDD cross-reference checker.

### Task 6: Verify clean installation and VS Code behavior

**Files:**
- Modify only if a defect is found: Copilot distribution or tests above

1. Create a temporary Copilot config directory and install `concord-copilot` from the repository marketplace.
2. Verify text `copilot plugin list` output because CLI 0.0.400 has no `--json` option.
3. Start VS Code with clean `--user-data-dir` and `--extensions-dir`, then inspect Chat Customization diagnostics for the skill, command, agents, and hooks.
4. Exercise distinct charters in two temporary projects, new-session injection, one review-agent spawn, hook-disabled degradation, update, uninstall, and state retention warning.
5. Run `node --test plugins/concord/hooks/test/*.test.js` and report any unrelated baseline failures separately.