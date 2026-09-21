---
name: charter
description: Show or update Concord's persistent north-star framing for the current project, especially when context must survive a new GitHub Copilot session.
---

# Project Charter

Use `/charter set <north star>` to persist durable project framing. Concord stores that exact text under a project-scoped key and injects it when a new Copilot session starts.

Use `/charter show` to display the `Task charter` already present in the session context. If no task charter was injected, say that no charter is set. Do not infer one from the unstable transcript or silently create one.

Automatic transcript-derived checkpoints are unavailable in this harness. Tell the user to update the charter explicitly when a durable decision changes the project framing.