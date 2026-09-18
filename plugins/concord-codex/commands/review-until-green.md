---
description: Deterministically review, fix, commit, and repeat with clean-context Codex subprocesses until the Concord harness reaches a terminal decision.
argument-hint: "[target | file:<path-or-glob> | resume <ref>] [--broad|--no-broad] [--no-dod]"
---

Run the bundled deterministic runner once; do not manually orchestrate reviewers:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-until-green.js" $ARGUMENTS
```

Use `file:<path-or-glob>` for the explicit documentation-only profile. It reviews only the supplied files and skips the full branch DoD and broad front pass by default. `--broad` opts into the repository-wide front pass; a configured panel remains part of broad review unless `--no-broad` suppresses it.

Return its terminal handoff verbatim. If it exits with `harness-failure`, report that failure without treating the target as clean.

A repo with no `review.config.json` is NOT such a failure: the run proceeds on the review gates alone and the handoff reports `DoD: DEFERRED`. Relay that deferral in your own summary too -- never call such a run verified -- and if the user wants a gate on future runs, point them at `{"dod":["pnpm build"]}` at the repo root (commit it -- an uncommitted config leaves the tree dirty and the next round rejects a dirty tree). Never add `--no-dod` on your own initiative; it is the user's call.
