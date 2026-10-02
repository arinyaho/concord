# Initiative context and review budget boundaries

> **For Claude:** Use the executing-plans skill when implementing this plan in a separate session.

**Goal:** Keep implementation histories out of review orchestration and prevent a budgeted native review from becoming an unbudgeted review by omission or reset.

**Architecture:** A target ledger records its initiative binding after a successful keyed CLI operation. Every mutating target operation takes the same lock, including operations before the first binding. Later mutating operations require the original key and canonical initiative state directory with the complete options; read-only inspection remains available without them. Keyed reset is rejected; rerun retains history and charges the existing initiative budget. Implementation workers return a durable handoff before review, and a separate review driver reads only the approved contract, exact target revisions and verification evidence.

**Tech stack:** Node.js CLI and node:test, Markdown skills, generated Codex and Copilot packages.

## Decisions

- Preserve review roles, independent verification, executable checks and base/lite eligibility. Changing the review standard is a separate decision.
- Prefer bounded context ownership over frequent automatic compaction: the harness does not expose portable per-agent context replacement.
- Do not bundle several fix artifacts into one worker invocation in this change. The existing reservation and commit attribution contracts count one launch per fix, so batching needs its own executable contract.
- Treat instruction-level context boundaries separately from executable budget enforcement. Native agent behavior and actual token savings require a follow-up real session measurement.

## Implementation plan

1. Add CLI regressions for missing initiative flags, keyed reset and rerun retaining an exhausted budget. Run them against Claude and Copilot entry points and confirm the failures before changing production code.
2. Persist the binding after successful keyed target operations. Reject mutations without the flags and reject keyed reset before opening or modifying a run. Keep standalone reviews, unreadable standalone-ledger recovery and unkeyed read-only inspection compatible. Prove that concurrent unkeyed and keyed operations cannot erase the first binding, and that a different key or state directory cannot replenish an exhausted budget.
3. Require an implementation handoff before both design-note and diff review when an initiative delegates implementation. Give a fresh review driver the contract, immutable revisions, checks, authorization, exact CLI options and state paths; exclude implementation reasoning and transcripts. Bound the driver's lifetime to one target, and preserve the run budget across driver replacement.
4. Regenerate provider packages. Run the targeted native CLI tests, packaging and skill checks, then the repository Definition of Done. Review the diff for bypasses and context-boundary contradictions.

## Verification criteria

- Removing flags from a bound target cannot grant a free launch, record evidence or erase its ledger.
- Reset cannot erase a keyed target; rerun retains the binding, archived history and spent launch budget.
- Existing standalone review behavior remains available.
- Generated provider copies agree with their canonical sources.
- Instruction changes do not claim a completed ticket stage before the external review gate passes.
