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

## Exit rules

A handoff is complete only when its evidence supports the exit verdict and its named output artifacts can be read back. `PASS`, `NO PR NEEDED`, and `BLOCKED` are distinct. A tool call without a verified side effect is not success. Missing or truncated evidence remains a blocker, not an invitation to infer completion.

Keep handoffs concise: prefer an evidence table and exact identifiers over narrative chronology. Preserve long raw evidence in its source system or a separate artifact and reference it by stable identity.
