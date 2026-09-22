---
description: Deterministically review, fix, commit, and repeat with independently selected Claude, Codex, or Copilot providers and models until Concord reaches a terminal decision.
argument-hint: "[target | file:<path-or-glob> | resume <ref>] [--reviewer <claude|codex|copilot>] [--reviewer-model <model>] [--fixer <claude|codex|copilot>] [--fixer-model <model>] [--broad|--no-broad] [--no-dod]"
---

Run the bundled deterministic runner once; do not manually orchestrate reviewers:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-until-green.js" $ARGUMENTS
```

Reviewer and fixer selections are independent. Codex has no native clean-context subagent primitive, so this host invokes the selected provider through its non-interactive CLI. An omitted provider defaults to `codex`; an omitted model uses that provider's configured default. A requested provider or model is never silently replaced.

For ledger operations required by composed workflows, invoke the packaged CLI directly:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-cli.js" rerun <ref>
```

Use `file:<path-or-glob>` for the explicit documentation-only profile. It skips the full branch DoD and broad front pass by default. `--broad` opts into the repository-wide front pass; an enabled broad-review panel can still review the repository unless `--no-broad` suppresses it.

Return its terminal handoff verbatim. If it exits with `harness-failure`, report that failure without treating the target as clean.

A repo with no `review.config.json` is NOT such a failure: the run proceeds on the review gates alone and the handoff reports `DoD: DEFERRED`. Relay that deferral in your own summary too -- never call such a run verified -- and if the user wants a gate on future runs, point them at `{"dod":["pnpm build"]}` at the repo root (commit it -- an uncommitted config leaves the tree dirty and the next round rejects a dirty tree). Never add `--no-dod` on your own initiative; it is the user's call.
