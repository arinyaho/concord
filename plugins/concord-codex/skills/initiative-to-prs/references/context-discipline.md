# Context discipline

What a coordinating session passes to a worker or another child agent, and how any agent avoids paying twice for what it already read.

## What a child receives

Give a child only:

- the objective and the references it needs for its task (the ticket, the design document's path, the brief);
- the project root and the path of the project's rules file;
- the user's decisions that bear on the task, in the user's words;
- what it is authorized to do.

Do not pass the conversation, a transcript, raw document corpora, binaries, or screenshots. Link or name source evidence and include only the excerpt needed. Never put a secret, a credential, or customer-identifying data into a prompt, a command, a URL, the state document, a ticket, or a report.

A child reads the current ticket and pull request to check for drift. It does not repeat the initiative's evidence gathering unless what it was given is missing or contradicted.

## Verified results

A result counts when its side effect was read back: the ticket as the tracker returns it, the pull request head on the remote, the check run for the head commit. A tool call without a verified side effect is not success, and missing or truncated evidence is not a reason to infer one. "A pull request exists", "no change is needed", and "a decision is open" are different results; report the one that is true.

## Read-once discipline

The moment you read a source document, a ticket, or a code file, note its path or URL, its identity, and the excerpt or conclusion you need, in your running plan. Before reading a path you already noted, consult the note first; re-read only when the note is stale, lacks the needed detail, or the source may have changed since.

## Investigation reuse on relaunch

A subagent that investigates in an isolated worktree and changes nothing can lose that worktree before it is resumed, because a harness removes an unchanged worktree. A relaunch or a resume after a long idle period carries the same risk. Do not let the resumed subagent start blind.

Before it repeats an expensive sweep, do one of:

- If an earlier notification from that subagent already reported a conclusion, pass that conclusion forward in the resume prompt instead of a bare re-dispatch, and instruct the subagent to use it unless it finds the conclusion stale or contradicted.
- If no conclusion was received yet, ask the resumed subagent to report what it already found — including any note it can recover from its own prior output — before it redoes the sweep, and have it redo only the portion that report cannot answer.

Losing worktree state is the harness's; redoing the investigation without checking for what survived is the orchestrator's. The orchestrator, not the resumed subagent, is the one holding the last notification, so the orchestrator is the one obligated to hand it forward.
