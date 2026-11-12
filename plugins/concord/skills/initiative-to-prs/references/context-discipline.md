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

A stage that reads the same source document, ticket, or code file more than once inside its own execution is spending tokens on content it already has. The moment a document is read, note its path or URL, its identity, and the excerpt or conclusion the stage actually needs, in that stage's own running plan or scratchpad — not left to working memory that a later tool call pushes out. Before issuing another Read for a path already noted this stage, consult the note first; re-read only when the note is stale, missing the needed detail, or the source may have changed since it was recorded. This is the single-agent counterpart to the handoff above: the handoff stops a child from re-auditing the parent's work, and this stops the same agent from re-fetching its own.

## Investigation reuse on relaunch

A worktree-isolated investigative subagent this stage spawns (an `Agent` tool call with `isolation: "worktree"`) loses its worktree whenever the harness cleans it up between dispatch and resumption — this is guaranteed, not occasional, for a read-only investigative subagent: it makes no changes by construction, and the harness cleans up an unchanged worktree by default. A relaunch or resume that follows a long idle period carries the same risk. Do not let the resumed subagent start blind.

Before it repeats an expensive sweep, do one of:

- If an earlier notification from that subagent already reported a conclusion, pass that conclusion forward in the resume prompt instead of a bare re-dispatch, and instruct the subagent to use it unless it finds the conclusion stale or contradicted.
- If no conclusion was received yet, ask the resumed subagent to report what it already found — including any note it can recover from its own prior output — before it redoes the sweep, and have it redo only the portion that report cannot answer.

Losing worktree state is the harness's; redoing the investigation without checking for what survived is the orchestrator's. The orchestrator, not the resumed subagent, is the one holding the last notification, so the orchestrator is the one obligated to hand it forward.
