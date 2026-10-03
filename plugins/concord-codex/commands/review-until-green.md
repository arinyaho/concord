---
description: Compatibility alias for review-and-fix.
argument-hint: "[target | file:<path-or-glob> | resume <ref>] [review-and-fix options]"
---

Run the same bounded review-and-fix runner used by the primary command:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix.js" $ARGUMENTS
```

Return its terminal handoff verbatim. Report a `harness-failure` without treating the target as clean.
