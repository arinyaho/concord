# Handoff contract

Persist one compact Markdown handoff per completed stage. The file is the child agent's input and the initiative's audit trail; chat summaries point to it instead of reproducing it.

## Required fields

- Initiative and run identifier
- Stage and timestamp with timezone
- Applicable project root, repository, branch, worktree, tracker, and environment
- Source artifact identities and versions
- Evidence references: stable URLs or absolute local paths, hashes when identity matters, and the environment, entry point, and state provenance of an execution
- Claims separated into observed, code-proven, intent-only, tracker-only, unresolved, and refuted
- Decisions: exact user decisions, accepted contract, rejected alternatives that affect later work, and the authorization envelope
- Ticket or PR identities and dependency relationships
- Checks actually run, their exact result, and checks not run with the blocker
- Requested and resolved model, provider, reasoning effort when exposed, and escalation or fallback reason
- Exit verdict, failed exit conditions, blockers, and the only dependency-ready next stage

## Context discipline

Do not copy the parent conversation, raw document corpus, full transcript, binaries, screenshots, secrets, credentials, or customer-identifying data into a handoff. Link or identify source evidence and include only the excerpts or structured facts needed to decide the next stage. Never put a secret into a command, URL, prompt, state file, or report.

The orchestrator passes a child only:

- The initiative objective and authoritative source references needed for the stage
- The applicable project root and instructions
- The stage reference
- The immediately preceding handoff or ticket execution handoff
- Exact user decisions made at a checkpoint
- The current authorization envelope

The child may read current artifacts needed to verify drift or execute its stage. It must not repeat the broad initiative audit unless the handoff is missing, stale, or contradicted by current evidence.

## Read-once discipline

A stage that reads the same source document, ticket, or code file more than once inside its own execution is spending tokens on content it already has. The moment a document is read, note its path or URL, its identity, and the excerpt or conclusion the stage actually needs, in that stage's own running plan or scratchpad — not left to working memory that a later tool call pushes out. Before issuing another Read for a path already noted this stage, consult the note first; re-read only when the note is stale, missing the needed detail, or the source may have changed since it was recorded. This is the single-agent counterpart to the handoff above: the handoff stops a child from re-auditing the parent's work, and this stops the same agent from re-fetching its own.

## Investigation reuse on relaunch

A worktree-isolated investigative subagent (an `Agent` tool call with `isolation: "worktree"`) can lose its worktree between dispatch and resumption — the harness cleans it up, or the resume follows a long idle period. When the orchestrator relaunches or resumes work that shows signs of that loss (the worktree path no longer exists, the branch has no new commits since dispatch, or the resumed agent reports starting an investigation it already reported finishing), do not let the resumed subagent start blind.

Before it repeats an expensive sweep, do one of:

- If an earlier notification from that subagent already reported a conclusion, pass that conclusion forward in the resume prompt instead of a bare re-dispatch, and instruct the subagent to use it unless it finds the conclusion stale or contradicted.
- If no conclusion was received yet, ask the resumed subagent to report what it already found — including any note it can recover from its own prior output — before it redoes the sweep, and have it redo only the portion that report cannot answer.

Losing worktree state is the harness's failure; redoing the investigation without checking for what survived is the orchestrator's. The orchestrator, not the resumed subagent, is the one holding the last notification, so the orchestrator is the one obligated to hand it forward.

## Exit rules

A handoff is complete only when its evidence supports the exit verdict and its named output artifacts can be read back. `PASS`, `NO PR NEEDED`, and `BLOCKED` are distinct. A tool call without a verified side effect is not success. Missing or truncated evidence remains a blocker, not an invitation to infer completion.

Keep handoffs concise: prefer an evidence table and exact identifiers over narrative chronology. Preserve long raw evidence in its source system or a separate artifact and reference it by stable identity.
