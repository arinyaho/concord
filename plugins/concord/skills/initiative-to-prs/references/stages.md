# Stages

Every stage writes a handoff before the orchestrator advances. Source documents describe intent; current code and an execution against the relevant entry point establish behavior.

## 1. Evidence and contract

This stage is read-only except for narrowly scoped, owner-controlled synthetic test state when the applicable project instructions and user authorization permit it.

Read the authoritative brief and design, current related tickets and comments, relevant repository instructions and code, and the deployed or otherwise shipped behavior named by the report. Search for duplicate or superseding work. Trace the real caller and upstream guards before treating a code path as reachable. Reproduce the reported consequence at the same environment, entry point, and state provenance when possible; label every unmatched coordinate next to the result.

Separate these classes in the evidence packet:

- Observed current behavior
- Behavior present in code and proven reachable
- Behavior present in code but not proven reachable
- Accepted product or design intent
- Tracker or comment claims without independent evidence
- Material decisions that remain unsettled

Propose the smallest behavioral contract and ticket set supported by the evidence. Each proposed ticket names its outcome, scope, non-goals, affected surface, observable acceptance checks, executable Definition of Done, dependencies, and whether current behavior supplies a discriminating red condition. Do not invent file paths before tracing the caller.

If current behavior already satisfies the approved outcome, propose a no-change closure with its evidence instead of manufacturing tickets or PRs.

### Human checkpoint 1

Present a concise evidence verdict, material decisions with realistic options and consequences, recommended contract, proposed tickets, dependencies, and any no-change items. Record the user's exact decisions and ticket-set approval. No tracker or design-document mutation occurs before this checkpoint.

## 2. Ticket set

Use `ticket-writing` for every approved ticket. Reuse or update existing work when it already owns the outcome. Create new tickets only for approved gaps. Keep provider-native formatting and the project's artifact language.

Synchronize an affected product or architecture design only when the user explicitly approved that specific mutation at checkpoint 1, the approved contract changes it, and project instructions authorize that document system. Keep product design timeless and keep implementation paths and test locations in local plans or tickets.

Read every ticket and changed design record back. Verify exact titles, bodies, links, attachments, statuses, acceptance criteria, Definition of Done, decisions, and preserved fields. A ticket is not ready when an unresolved question can change its outcome, scope, or design direction. Do not count comments, implementation notes, or a screenshot alone as acceptance criteria or Definition of Done.

Write the dependency order and one execution handoff per ticket. Each handoff contains the final ticket URL, accepted contract, evidence identity, relevant repositories, target base, authorization envelope, and executable gates. Do not prescribe speculative implementation details.

### Human checkpoint 2

Present the read-back ticket set, design changes, dependency order, observable acceptance criteria, Definition of Done, and any rejected fields or blocked transitions. Continue only after the user approves implementation of that exact set.

## 3. Execute each ticket

Execute dependency-ready tickets with `ticket-to-pr`. Its stage exits and delegation rule remain authoritative: unless the user, selected model, or CLI harness expressly requires subagents, keep implementation, review, and final mutations with the active agent. Use `model-routing.md` only to select required roles and models when that authorization exists.

The implementer establishes the unchanged red at the altitude of the ticket's observable outcome and writes the design required by `ticket-to-pr`. Complete `ticket-to-pr`'s design-note review gate before planning or implementation begins. Then write the plan, implement the smallest root-cause change, prove the check runs where CI runs it, and reach local green. If a discriminating current-behavior reproduction shows that unchanged behavior satisfies the acceptance check, do not enter `ticket-to-pr`'s PR exit. Return `NO PR NEEDED` only after recording the reproduction and reconciling the approved ticket to an explicitly approved no-change closure or supersession, then reading it back; without that authorization or read-back, the ticket is `BLOCKED`, not a successful no-PR disposition. Then correct the initiative record instead of changing code.

Run `review-until-green` as `ticket-to-pr`'s required diff-local gate. When an independent reviewer role is authorized, route the ticket contract, evidence identity, branch or diff, and verification commands to that reviewer in a separate handoff. It verifies premise, contract coverage, reachability, security and data boundaries, test execution, documentation completeness, and unnecessary complexity without receiving the implementer's handoff or editing the branch. When it finds an in-contract issue, final mutations apply the fix, explicitly re-arm the clean diff-local ledger with `review-cli.js rerun <ref>`, rerun `review-until-green` on the changed diff with the same target and base, and return the resulting diff to a fresh independent review; repeat until clean in both gates on the same final diff. A clean ledger returns terminal without reviewing changed content, so merely invoking `review-until-green` again is insufficient. Any later code or documentation mutation must pass this review cycle again before push or PR creation. This contract review supplements rather than replaces `review-until-green`.

Final mutations apply verified findings, rerun the same green check plus repository-required checks, sweep affected documentation, push the branch, create the PR from the repository template, attach the exact PR URL to the ticket where authorized, and read both PR and ticket back. A finding that changes the approved product contract returns to the user. If the user approves a revised contract, invalidate the affected ticket and its downstream handoffs, return to the ticket set stage, update and read back the ticket through `ticket-writing`, and pass checkpoint 2 again before implementation resumes. A correctness finding within the approved contract is fixed without a routine checkpoint.

Execute tickets sequentially by default. Parallelize only independent tickets with separate repositories or worktrees and no shared mutable state or contract dependency. A failure in one ticket does not erase completed evidence for another, but an upstream contract failure blocks every dependent ticket.

## 4. Initiative completion

The initiative exits successfully when every approved ticket has one of these verified dispositions:

- A PR URL whose head, base, body, documentation disposition, and tracker link were read back, with every required PR check in a successful terminal state; a pending, failed, or missing required check leaves the ticket `BLOCKED`
- `NO PR NEEDED`, supported by a discriminating current-behavior check and a read-back of the ticket's explicitly approved no-change closure or supersession

If any approved ticket is `BLOCKED`, the initiative exits blocked rather than successfully. Report the exact failed exit condition, owner, and unblock condition alongside the completed dispositions. Never describe an open PR as merged, released, deployed, or available to customers.
