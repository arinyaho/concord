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

Execute dependency-ready tickets with `ticket-to-pr`. Its stage exits remain authoritative. The initiative orchestrator selects separate roles for implementation, independent review, and final mutations using `model-routing.md`; this explicit delegation satisfies `ticket-to-pr`'s requirement that AI handoff be user- or harness-directed.

The implementer establishes the unchanged red at the altitude of the ticket's observable outcome, writes the design and plan required by `ticket-to-pr`, implements the smallest root-cause change, proves the check runs where CI runs it, and reaches local green. If a discriminating current-behavior reproduction shows that unchanged behavior satisfies the acceptance check, return `NO PR NEEDED` and correct the initiative record instead of changing code.

The independent reviewer receives only the ticket contract, evidence identity, branch or diff, verification commands, and implementation handoff. It verifies premise, contract coverage, reachability, security and data boundaries, test execution, documentation completeness, and unnecessary complexity. It does not edit the branch.

Final mutations apply verified findings, rerun the same green check plus repository-required checks, sweep affected documentation, push the branch, create the PR from the repository template, attach the exact PR URL to the ticket where authorized, and read both PR and ticket back. A finding that changes the approved product contract returns to the user; a correctness finding within the contract is fixed without a routine checkpoint.

Execute tickets sequentially by default. Parallelize only independent tickets with separate repositories or worktrees and no shared mutable state or contract dependency. A failure in one ticket does not erase completed evidence for another, but an upstream contract failure blocks every dependent ticket.

## 4. Initiative completion

The initiative exits successfully when every approved ticket has one of these verified dispositions:

- A PR URL whose head, base, body, checks, documentation disposition, and tracker link were read back
- `NO PR NEEDED`, supported by a discriminating current-behavior check
- `BLOCKED`, with the exact failed exit condition, owner, and unblock condition

Report these dispositions together. Never describe an open PR as merged, released, deployed, or available to customers.
