---
description: Deterministically review, fix, commit, and repeat with clean-context Codex subprocesses until the Concord harness reaches a terminal decision.
argument-hint: "[target | resume <ref>] [--broad] [--no-dod]"
---

Run the bundled deterministic runner once; do not manually orchestrate reviewers:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-until-green.js" $ARGUMENTS
```

Return its terminal handoff verbatim. If it exits with `harness-failure`, report that failure without treating the target as clean.

One `harness-failure` has a standard resolution worth spelling out rather than just relaying: `no review.config.json at the repo root` means this repo has never declared an executable Definition-of-Done gate, so the run stops before reviewing anything. Report it and give the user both ways forward -- (a) declare the gate, e.g. `{"dod":["pnpm build"]}` in a `review.config.json` at the repo root, committed (an uncommitted config trips the dirty-tree guard on the next attempt), or (b) re-run with `--no-dod` to converge on the review gates alone, with the handoff reporting the DoD as deferred because nothing executable ran. Let the user choose; never add `--no-dod` on your own initiative.
