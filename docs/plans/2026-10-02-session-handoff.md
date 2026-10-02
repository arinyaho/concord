# Session handoff implementation plan

> **For Claude:** Use executing-plans when continuing this plan in a separate session.

**Goal:** Offer a short continuation prompt when a session becomes inefficient, and optionally stop at a safe checkpoint while preserving the initiative's identity, evidence and review budget.

**Architecture:** A run-level `session-checkpoint` CLI verb evaluates a bounded structured packet. `off` continues without artifacts; `suggest` writes continuation artifacts without requiring termination; `stop-at-checkpoint` emits a stop decision after verified handoff files are persisted. Unsafe boundaries or live children defer the checkpoint. Native hosts apply the decision; the CLI does not kill a session or create a new chat.

**Tech stack:** Shared Node.js engine, native review CLI, node:test, packaged Markdown instructions.

## Contract

- The default is `suggest`. Input context of 128,000 tokens, 50 tool calls, or 10 consecutive calls without meaningful progress is a trigger. These are initial heuristics, not measured financial limits; cumulative cache-read volume is not a trigger.
- Observations are explicitly caller-reported. Record input context only when exposed by the runtime; missing context is unmeasured, not zero.
- Allowed boundaries are completed stages, implementation batches or review rounds. Drain existing children first; never cancel a build, abandon a live reviewer or relaunch a reserved role to obtain a checkpoint.
- State and handoff files must be readable, distinct text artifacts. The checkpoint stores their identities and hashes. Resume verifies them and authoritative source versions before acting.
- Continuation artifacts contain source pointers, the bounded next action, scope, observations, existing run key, mode, current status and budget usage. They exclude arbitrary packet fields, transcripts, implementation reasoning and raw logs.
- The command is read-only with respect to the initiative and target ledgers. It never resets, re-arms, finalises, reserves or increases a budget. A parked, exhausted or terminal run remains so after context replacement.
- The generated prompt tells the next session to inspect sources, blockers, target revisions and existing worker artifacts and reservations before taking the recorded next action. Reuse verified investigation; never treat a session handoff as permission to restart completed stages.

## Implementation

1. Add native Claude/Copilot CLI tests for all modes, every trigger, unsafe boundaries, unreadable handoffs, preserved budgets, bounded prompts and excluded raw fields. Confirm the new CLI verb fails before implementation.
2. Add shared `session-handoff.js` and the run-level verb with explicit option parsing. Atomically write private continuation artifacts and return their absolute paths only after read-back.
3. Add the optional invocation flag and checkpoint/resume procedure to initiative, handoff and review-driver instructions. Distinguish suggestions from opt-in stopping, and worker handoffs from ending the user's main session.
4. Regenerate provider packages. Run relevant CLI/packaging tests, independent review and the repository Definition of Done.

## Validation limits

Automated tests cover evaluation, durable artifacts, CLI decisions and budget preservation. Actual native session termination and token savings require a host session measurement; no process termination is inferred from a JSON decision.

Suggested continuations preserve private immutable copies of state and handoff alongside their original paths. Resume verifies snapshot hashes, then reads the latest originals and live ledger to skip steps completed after the suggestion. Ordinary execution progress does not require source-drift reconciliation; changed authoritative requirements or authorization still do. The prompt preserves the selected session handoff policy.

## Review feedback corrections

Checkpoint creation and delivery run after the CLI records the round. Their failures are returned as `sessionHandoff: { action: "failed", mode, error }`, preserving the recorded review result and continuation claim without adding an initiative error disposition. A suggestion failure permits the review loop to continue. A failed stop checkpoint preserves the continuing review decision and stops before any next round; it does not claim that a valid continuation snapshot was saved.

The native launcher returns exit code 1 for a continuing `session-handoff` decision or a failed `stop-at-checkpoint` handoff, while still outputting the review result and handoff failure. A successful checkpoint attached to an already terminal review preserves the review's existing exit behavior. Source snapshots retain the source file extension, so native runner JSON state/handoff files are saved as `.json`; Markdown sources remain `.md`.
