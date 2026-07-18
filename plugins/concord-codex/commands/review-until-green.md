---
description: Deterministically review, fix, commit, and repeat with clean-context Codex subprocesses until the Concord harness reaches a terminal decision.
argument-hint: "[target | resume <ref>] [--broad]"
---

Run the bundled deterministic runner once; do not manually orchestrate reviewers:

```sh
node "${PLUGIN_ROOT}/bin/review-until-green.js" $ARGUMENTS
```

Return its terminal handoff verbatim. If it exits with `harness-failure`, report that failure without treating the target as clean.
