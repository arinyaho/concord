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
2. Locate and resume an existing project-scoped run for this initiative from Concord state or a supplied handoff path. If none exists, create one using Concord state when the harness exposes it, otherwise use a temporary directory and report its absolute path. Keep `state.md` there with the initiative, current stage, artifact paths, ticket and PR URLs, decisions, authorization envelope, requested and resolved models, exit verdicts, and blockers. Never record secrets or customer-identifying data.
3. Read [references/stages.md](references/stages.md), [references/model-routing.md](references/model-routing.md), and [references/handoff-contract.md](references/handoff-contract.md). Execute one dependency-ready stage at a time and persist its handoff before advancing.

## Composition

- Apply `ticket-writing` to create or repair each ticket. Do not reproduce its ticket schema or weaken its grounding and read-back requirements.
- Apply `ticket-to-pr` independently to each implementation-ready ticket. Preserve its one-unit-of-work, one-branch, one-PR contract and every red, design, review, green, documentation, and PR exit condition.
- Run the `review-until-green` command where `ticket-to-pr` requires it. An independent review must not inherit the implementer's reasoning context.

If any required Concord skill or command is unavailable, stop at the current stage and report the missing dependency instead of approximating its contract.

## Human checkpoints

There are two mandatory human checkpoints:

1. After the read-only evidence and contract stage, present the observed reality, material decisions, proposed contract, and proposed ticket set. Continue only with the user's exact decisions and ticket-set approval.
2. After the approved tickets and affected design records have been written and read back, present their URLs, dependency order, acceptance criteria, Definition of Done, and preserved metadata. Continue to implementation only when the user approves the read-back ticket set.

After the second checkpoint, proceed through PR creation without routine pauses. Return to the user only when a new material product decision, scope expansion, authorization outside the recorded envelope, irreconcilable review finding, or blocked exit condition appears. Do not ask again for authority already granted.

## Ticket set

Prefer one ticket for one independently testable user-visible outcome. Split for any repository boundary because `ticket-to-pr` produces one branch and one PR per ticket. Also split for a different owner, deployment boundary, hard dependency, or independently valuable outcome. Record dependencies explicitly and execute them in order. Parallel execution is allowed only when tickets use independent branches and worktrees, share no mutable state, and neither one's contract can change the other.

When a downstream ticket in the same repository depends on an unmerged prerequisite PR, use an explicit stacked delivery: branch from the prerequisite PR head, target the downstream PR at the prerequisite branch, record the stack in both handoffs and PR bodies, and retarget the downstream PR to the repository's normal base only after the prerequisite merges. The final-mutations role keeps the initiative open until it observes that merge, retargets the downstream PR, and reads its new base back; the initial stacked-PR read-back is not a completion disposition. If repository or provider rules do not permit that stack, keep the downstream ticket blocked until the prerequisite is integrated.

## Delegation

Keep the main agent on orchestration, decisions, state, and concise user briefings. Route evidence gathering, implementation, independent review, and final mutations according to `model-routing.md`. Give each child only the applicable project root, stage instructions, previous handoff, exact user decisions, and authorization envelope. Never pass the full conversation.

Model assignment is a plan, not an obligation to spawn. Delegate only when isolated context, independent work, or specialist judgment saves time or protects review independence. Keep dependent mutations sequential.

## Completion report

Report the approved ticket set, ticket-to-PR result for each ticket, exact PR URLs and heads, checks actually run, tracker and design-document read-backs, blocked or no-change outcomes, and remaining risks. Distinguish PR creation from merge, release, deployment, and customer availability.
