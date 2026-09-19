---
name: initiative-to-prs
description: >-
  Use when a product brief, problem report, strategic objective, or set of incomplete tickets must be
  investigated, turned into one or more implementation-ready tickets, and driven through verified PRs.
  Do NOT use when one ticket is already implementation-ready; use ticket-to-pr instead. Do NOT use for
  ticket drafting without implementation; use ticket-writing instead.
---

# Initiative to PRs

Turn an initiative into the smallest implementation-ready ticket set, then carry every ticket through Concord's existing delivery contracts. An initiative is a coordinated body of work, not a required tracker issue type.

## Contract

The explicit request to take an initiative to PRs authorizes the ordinary mutations needed by this pipeline at its checkpoints. Checkpoint 1 authorizes creation or update of the approved tickets and any specifically approved design record. Checkpoint 2 authorizes implementation mutations: unambiguous in-progress and review transitions, branches and worktrees, commits and pushes, and PR creation. Follow narrower repository or provider rules when they exist. Closing or superseding tickets still requires explicit approval.

The pipeline ends with one or more verified PR URLs, or with evidence that no code change is required. Never merge, release, or deploy to production. A blocked gate remains blocked; do not turn it into a PR-body caveat.

## Bootstrap

1. Read the applicable project instructions and discover the authoritative brief, tracker, repositories, documentation system, target branches, validation commands, and available agent mechanisms. Infer these from the workspace when one answer is clear. Ask only when multiple plausible destinations or materially different interpretations remain.
2. Maintain a project-scoped index that maps each immutable source URL or tracker identifier, and otherwise a normalized objective fingerprint, to one stable run key. Search the index before creating a key; add a new mapping only when no match or supplied handoff exists. Locate or create a separate directory for that key under project-scoped Concord state. When the harness exposes no state root, use the active runtime's durable user-state root with a deterministic project fingerprint and run key; if no durable user-state root is available, stop and require a supplied durable handoff directory. Do not use an operating-system temporary directory for resumable state. Never reuse one run directory for another key. Keep `state.md` there with the run key, initiative, current stage, artifact paths, ticket and PR URLs, decisions, authorization envelope, requested and resolved models, exit verdicts, and blockers. Never record secrets or customer-identifying data.
3. Read [references/stages.md](references/stages.md), [references/model-routing.md](references/model-routing.md), and [references/handoff-contract.md](references/handoff-contract.md). Execute one dependency-ready stage at a time and persist its handoff before advancing.

## Composition

- Apply `ticket-writing` to create or repair each ticket. Do not reproduce its ticket schema or weaken its grounding and read-back requirements.
- Apply `ticket-to-pr` independently to each implementation-ready ticket. Preserve its one-unit-of-work, one-branch, one-PR contract and every red, design, review, green, documentation, and PR exit condition.
- For every ticket's diff review, override `ticket-to-pr`'s default invocation with `/review-until-green <branch> <target-base>`, using the target base recorded in the execution handoff: the intended PR base for ordinary tickets (including develop or release branches), or the prerequisite branch for stacked tickets. Pass that base explicitly on every diff-review run so the gate covers only the ticket's PR diff. When an independent reviewer role is authorized, give that reviewer the contract and evidence packet separately; it must not inherit the implementer's reasoning context.

If any required Concord skill or command is unavailable, stop at the current stage and report the missing dependency instead of approximating its contract.

## Human checkpoints

There are two mandatory human checkpoints:

1. After the read-only evidence and contract stage, present the observed reality, material decisions, proposed contract, and proposed ticket set. Continue only with the user's exact decisions and ticket-set approval.
2. After the approved tickets and affected design records have been written and read back, present their URLs, dependency order, acceptance criteria, Definition of Done, and preserved metadata. Continue to implementation only when the user approves the read-back ticket set.

After the second checkpoint, proceed through PR creation without routine pauses. Return to the user only when a new material product decision, scope expansion, authorization outside the recorded envelope, irreconcilable review finding, or blocked exit condition appears. Do not ask again for authority already granted.

## Ticket set

Prefer one ticket for one independently testable user-visible outcome. Split for any repository boundary because `ticket-to-pr` produces one branch and one PR per ticket. Also split for a different owner, deployment boundary, hard dependency, or independently valuable outcome. Record dependencies explicitly and execute them in order. Parallel execution is allowed only when tickets use independent branches and worktrees, share no mutable state, and neither one's contract can change the other.

When a downstream ticket in the same repository depends on an unmerged prerequisite PR, use an explicit stacked delivery: branch from the prerequisite PR head and target the downstream PR at the prerequisite branch. For every downstream diff review, override `ticket-to-pr`'s default invocation with `/review-until-green <downstream-branch> <prerequisite-branch>` so the review covers only the downstream PR diff. A verified stacked PR is a completion disposition when its handoff and PR body record the prerequisite branch, normal base, and named owner for the follow-up. After the prerequisite merges, that owner retargets the downstream PR, reruns its required checks against the new base, and reads back the base and check results. This follow-up is outside initiative completion because this pipeline does not merge PRs. If repository or provider rules do not permit that stack, keep the downstream ticket blocked until the prerequisite is integrated.

## Delegation

Keep the main agent on orchestration, decisions, state, and concise user briefings. Route evidence gathering, implementation, independent review, and final mutations according to `model-routing.md`. Give each child only the applicable project root, stage instructions, previous handoff, exact user decisions, and authorization envelope. For independent review, omit the implementer's handoff and build the packet directly from the approved contract, source evidence, exact reviewed head and base, verification commands, and authorization envelope. Never pass the full conversation.

Model assignment is a plan, not an obligation to spawn. Delegate only when isolated context, independent work, or specialist judgment saves time or protects review independence. Keep dependent mutations sequential.

## Completion report

Report the approved ticket set, ticket-to-PR result for each ticket, exact PR URLs and heads, checks actually run, tracker and design-document read-backs, blocked or no-change outcomes, and remaining risks. Distinguish PR creation from merge, release, deployment, and customer availability.
