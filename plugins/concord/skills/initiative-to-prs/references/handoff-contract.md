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
- A substantive reconciliation packet: supporting evidence, every realistic option with its consequence, the recommendation and rationale, and the exact decision required
- Delivery mode (`base` or `lite`), review run key, budgets, and any lite-to-base escalation trigger with the exclusion that caused it
- Ticket or PR identities and dependency relationships
- Checks actually run, their exact result, and checks not run with the blocker
- Requested and resolved model, provider and catalog basis, reasoning effort when exposed, escalation or fallback reason, and for a required Deep decision the separate child invocation or agent identity, successful completion, conclusion, and covered decision identities; when a second independent Deep reviewer is required, preserve the same fields in a distinct second-reviewer evidence record; labels such as `active root agent` are not resolved model evidence
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

## Review boundary execution packet

Before design-note or diff review, persist: the approved contract and authoritative evidence references; project root, branch, exact head and resolved base (or committed design-note path and content identity); red/green commands, results and artifact paths; outstanding gates; authorization; target review state directory; resolved review CLI path, provider/model selections and all initiative options including the same run key, budgets and mode. Record the next stage as `AWAITING_REVIEW`, not `PASS` for an unfinished ticket. Do not include implementation reasoning, exploratory logs or the conversation. The orchestrator reconstructs independent review evidence from the approved sources and verifies the revisions itself.

A driver replacement also records the exact next CLI verb and arguments, completed role artifacts and their identities, existing reservations, and any still-live worker identity. Continue that step from the existing ledger; consume completed artifacts instead of relaunching reviewers. Keep every prior launch charged to the same run budget. Replacing context is not a new review run or permission to increase the budget.

## Read-once discipline

A stage that reads the same source document, ticket, or code file more than once inside its own execution is spending tokens on content it already has. The moment a document is read, note its path or URL, its identity, and the excerpt or conclusion the stage actually needs, in that stage's own running plan or scratchpad — not left to working memory that a later tool call pushes out. Before issuing another Read for a path already noted this stage, consult the note first; re-read only when the note is stale, missing the needed detail, or the source may have changed since it was recorded. This is the single-agent counterpart to the handoff above: the handoff stops a child from re-auditing the parent's work, and this stops the same agent from re-fetching its own.

## Investigation reuse on relaunch

A worktree-isolated investigative subagent this stage spawns (an `Agent` tool call with `isolation: "worktree"`) loses its worktree whenever the harness cleans it up between dispatch and resumption — this is guaranteed, not occasional, for a read-only investigative subagent: it makes no changes by construction, and the harness cleans up an unchanged worktree by default. A relaunch or resume that follows a long idle period carries the same risk. Do not let the resumed subagent start blind.

Before it repeats an expensive sweep, do one of:

- If an earlier notification from that subagent already reported a conclusion, pass that conclusion forward in the resume prompt instead of a bare re-dispatch, and instruct the subagent to use it unless it finds the conclusion stale or contradicted.
- If no conclusion was received yet, ask the resumed subagent to report what it already found — including any note it can recover from its own prior output — before it redoes the sweep, and have it redo only the portion that report cannot answer.

Losing worktree state is the harness's; redoing the investigation without checking for what survived is the orchestrator's. The orchestrator, not the resumed subagent, is the one holding the last notification, so the orchestrator is the one obligated to hand it forward.

## Exit rules

A handoff is complete only when its evidence supports the exit verdict and its named output artifacts can be read back. `PASS`, `NO PR NEEDED`, and `BLOCKED` are distinct. A tool call without a verified side effect is not success. Missing or truncated evidence remains a blocker, not an invitation to infer completion.

Keep handoffs concise: prefer an evidence table and exact identifiers over narrative chronology. Preserve long raw evidence in its source system or a separate artifact and reference it by stable identity.


## Efficiency checkpoint protocol

Persist the session handoff policy (`off`, default `suggest`, or `stop-at-checkpoint`) in state and handoff. Before a triggered checkpoint, finish the current stage, batch or round and drain every owned child. Save distinct nonempty state and handoff text files in durable storage. Include the exact next CLI verb and options, head/base or file identity, target ledger directory, source versions, completed role artifacts, existing reservations, dispositions, blockers and original authorization. Do not duplicate raw logs or implementation reasoning.

Write an absolute JSON packet path with this bounded shape (use real absolute paths):

```json
{
  "scope": "review",
  "boundary": "round-complete",
  "liveWorkers": [],
  "statePath": "/project-state/run/state.md",
  "handoffPath": "/project-state/run/handoff.md",
  "nextAction": "Read the recorded decision and continue its exact next CLI step",
  "observations": {"inputTokens": null, "toolCalls": 50, "noProgressCalls": 0}
}
```

`scope` is `orchestrator`, `implementation` or `review`; `boundary` is `stage-complete`, `batch-complete` or `round-complete`. Counts are caller-reported nonnegative integers, or null when unmeasured. `nextAction` is at most 1,000 characters; unknown packet fields are not copied into the prompt. Call `node "<review-cli>" session-checkpoint <absolute-packet.json> --session-handoff <policy>` with all original initiative options. This verb reads the existing initiative ledger without opening, reserving, re-arming or finalising it. Pass `--session-handoff` only to this verb, never to ordinary review mutations. It requires an existing keyed run; before that run exists, persist the same source-based handoff and offer a manual continuation without claiming a CLI checkpoint.

Apply its JSON decision: `continue` proceeds; `defer` finishes a safe boundary and drains owned workers before retrying; `suggest` offers the generated `promptPath` and `checkpointPath` once per distinct trigger in this context and continues; `stop` reads both artifacts back, presents the prompt and paths, then returns without starting another batch or round. A CLI error is a failed handoff: report it and preserve state rather than claiming a resumable checkpoint. The CLI produces a decision, not host process termination.

On resume, verify the recorded source hashes and current authoritative versions, approved scope, authorization, revisions, live ledger status and remaining budgets. Preserve terminal or reconciliation decisions. Inspect existing worker artifacts and reservations before continuing the exact next step; do not relaunch completed work or invent a new run key. Return to normal reconciliation on source drift or exhaustion.

Suggested continuations preserve private immutable copies of state and handoff alongside their original paths. Resume verifies snapshot hashes, then reads the latest originals and live ledger to skip steps completed after the suggestion. Ordinary execution progress does not require source-drift reconciliation; changed authoritative requirements or authorization still do. The prompt preserves the selected session handoff policy.
