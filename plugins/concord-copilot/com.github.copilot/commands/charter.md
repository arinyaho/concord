---
description: Show or update the persistent Concord project charter
argument-hint: "[set <north star> | show]"
---

CONCORD_CHARTER_SET: $ARGUMENTS

Handle the arguments as a Concord charter request:

- For `set <north star>`, the hook has persisted the exact text after `set`. Confirm the update in one line.
- For an empty argument or `show`, display the injected `Task charter`. If none was injected, say that no charter is set.
- Reject other arguments with the supported forms. Do not read a transcript or invent project state.