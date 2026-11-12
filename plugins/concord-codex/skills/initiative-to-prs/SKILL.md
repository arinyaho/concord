---
name: initiative-to-prs
description: >-
  Use when a product brief, problem report, strategic objective, or set of incomplete tickets must be
  investigated, turned into one or more implementation-ready tickets, and driven through verified PRs.
  Do NOT use when one ticket is already implementation-ready; use ticket-to-pr instead. Do NOT use for
  ticket drafting without implementation; use ticket-writing instead.
---

# Initiative to PRs

Turn an initiative into a design in `docs/` and the smallest set of implementation-ready tickets, get the user's approval of that set once, then run each ticket to a pull request with workers and let `pr-to-merge` carry the pull requests.

- **State.** The design is in the repository's `docs/`. Each ticket holds its acceptance criteria, plan, progress, and decisions. A parent issue lists the units as a checklist. Your state document (see `coordinate-sessions`) lists the units, their pull requests, and the user's standing authorizations.
- **Stopping.** Stop and ask only for a product decision, for something only the user holds, or before a hard-to-reverse action the user has not authorized. Give the options and a recommendation, and continue the work that does not depend on the answer. Record every other obstacle on the ticket and continue.
- **Project rules.** The tracker, repository locations, worktree directory, pull request conventions, and reviewers come from the project's rules file.

Read [references/model-routing.md](references/model-routing.md) and [references/context-discipline.md](references/context-discipline.md) before you start. The reasons for these rules are in Concord's `docs/design/workflow-state-and-stops.md`.

## 1. Find the ground

Read the project's rules file. Find the brief, the tracker, the repositories and their base branches, where design documents live, and the commands that validate a change. Take the answer when the workspace gives one; ask only when several destinations remain plausible.

## 2. Gather evidence

This step changes nothing except test state you create and remove yourself.

- Read the brief, the agreed design, related tickets and their comments, the code, and the shipped behavior the report names. Search for duplicate or superseding work.
- Trace the real caller and the guards before it before you call a code path reachable. Reproduce the reported consequence at the same environment and entry point where you can, and say which coordinates you could not match.
- Remove every account, record, job, or resource you created for evidence, and read back that it is gone.

Keep these classes apart in what you write:

- observed current behavior;
- behavior in the code and proven reachable;
- behavior in the code and not proven reachable;
- accepted product or design intent;
- claims from a tracker or a comment with no independent evidence;
- decisions that remain open.

## 3. Write the design

Write the design document under `docs/`, on a branch of the repository that owns it: the behavior the initiative commits to, the decisions with what each costs, the alternatives rejected, and the residual exposure. Run the decisions `model-routing.md` names through a Deep model first. Commit it there. Review the document with `review-and-fix` (target: the document; must satisfy: the brief) and keep its result for the parent issue.

If current behavior already satisfies the objective, propose closing the initiative with that evidence instead of writing tickets.

## 4. Propose the ticket set

Propose the smallest set the evidence supports. Reuse a ticket that already owns an outcome. For each ticket give:

- the outcome, the scope, and the non-goals;
- acceptance criteria, each one something a command or an observer can decide, and the definition of done;
- the repository, the base, the dependencies, and the reason for its boundary;
- whether current behavior gives a discriminating red.

One ticket is one coherent outcome. Split only at a boundary that can be deployed or reverted on its own, where a prerequisite must merge first, at a repository boundary, or for an ownership split. A frontend/backend label or size alone is not a boundary.

When one set of acceptance criteria needs several repositories, propose one ticket with a unit per repository, the versions or artifacts each unit consumes, and one owner of the combined check.

Check every acceptance criterion before you present the set: rewrite any that no command or observation can decide. Do not prescribe file paths you have not traced.

## 5. The checkpoint

This is the one point where you wait for the user. Nothing has been written to the tracker.

Present: the evidence verdict in a few lines, the design document's path, each open decision with its options and your recommendation, the proposed tickets with their acceptance criteria, the order and dependencies, and what you will write to the tracker. Ask for approval of the set, and ask once whether merging is authorized and for which repositories.

Record the user's answers in the state document in their words, with the date.

## 6. Write the tickets

With the approval, and without a second checkpoint:

1. Write each ticket with the `ticket-writing` skill.
2. Write or update the parent issue: a checklist with one item per unit, in order, with each unit's dependencies.
3. Read every ticket back and compare title, body, acceptance criteria, links, and status with what was approved. Fix a difference and read it again.
4. Push the design branch and open a draft pull request for the design document. Put the design review's record on the parent issue and in that pull request's body, and mark it ready when no `blocker` is open.

A tracker field or transition the provider refuses is recorded on the ticket and in your report; the work continues.

## 7. Run the units

Follow the `coordinate-sessions` skill: one worker per unit, each in its own worktree, each running `ticket-to-pr`, each reporting through its report directory.

- Start the units whose dependencies are met. Run in parallel only units with disjoint files whose contracts cannot change each other.
- A unit that depends on an unmerged prerequisite in the same repository is stacked: it branches from the prerequisite's head, its pull request targets the prerequisite's branch, and its review is against the prerequisite's head commit.
- A failure in one unit leaves the others' evidence standing. A failed upstream contract holds every unit that depends on it.
- A unit that needs a released package or a deployment waits until the released version can be read back. Releasing and deploying are not part of this workflow.
- When a worker finds that the unchanged code already satisfies its ticket, it reports that with the evidence. Closing or superseding the ticket is the user's decision.
- When a worker reports scope growth, an unrelated outcome, or a boundary that no longer holds, that is a product decision for the user. An approved change to a ticket is written with `ticket-writing` and read back; the other units continue.

Tick a unit on the parent issue when its `done` report passes your check.

## 8. Carry the pull requests

Start the `pr-to-merge` skill over the repositories of the units. Pass `--no-merge` unless the state document records the user's merge authorization for that repository. It merges what qualifies, including stacks in order, and you relay what it reports.

## 9. Report

When every unit has a pull request, or an approved closure without one, tell the user and write the same on the parent issue:

- each ticket with its pull request, head commit, and state (draft with what is open, ready, or merged);
- the checks that ran and their results, and the review record's open items;
- for an outcome across repositories, the combined check's status, its owner, and what unblocks it;
- what remains for the user.

Say opened, merged, released, and deployed only for what is true of each.
