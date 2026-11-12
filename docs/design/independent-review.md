# Independent review

`review-and-fix` has one reviewer in a fresh context review a design document, a ticket, or a change, and has the calling session fix what the review finds. The same skill and the same reviewer handle all three targets. It follows the rules in [workflow-state-and-stops.md](workflow-state-and-stops.md).

The first review of a target is broad: it checks the target against the design, the specification, the plan, the acceptance criteria, and the repositories that depend on it or that it depends on. A change that is correct inside its own diff and wrong against a neighboring repository is the defect this review exists to find.

## Roles

- **The caller** is the session that wrote the target or is delivering it: a `ticket-to-pr` worker, a coordinating session, or the user's own session. It writes the review request, verifies each finding, and makes the fixes.
- **The reviewer** is a subagent of the caller's harness, started in a fresh context from the reviewer agent definition that Concord ships. It runs in the caller's environment, so it reads every path the caller reads and runs the project's own commands. It does not edit files, commit, or post anything. It uses the most capable model class the harness offers, because one pass is all the target gets.

The reviewer receives the review request and nothing else. It does not receive the caller's reasoning or conversation.

## The review request

A review target is a list of things to read. The caller gives paths and commands; it never copies the target into another file for the reviewer.

| Item | Design document | Ticket | Change |
|---|---|---|---|
| The target | The document's path | The ticket, as a URL or the command that prints it | The command that prints the diff, with the exact base and head commits |
| What it must satisfy | The ticket or brief the design answers | The design it implements, and its parent ticket | The ticket's acceptance criteria and plan, and the design document |
| Related repositories | Local paths of the repositories the target depends on or that depend on it, with what connects them (a submodule pin, a package version, a shared format, an API) | same | same |
| Evidence | The code or measurements the document's claims rest on | The current behavior the ticket describes | The test runs, with the command, the commit, and the result |
| Not done | What the caller did not check or could not run | same | same |
| Focus | Optional: the risks the caller wants examined first | same | same |

The caller finds the related repositories from the project's rules file, the repository's submodules and dependency manifests, and the ticket. A related repository with no local checkout is listed as unavailable; the reviewer then reports the consistency with it as unverified.

The focus list orders the reviewer's attention. It does not narrow the review: the reviewer still covers the whole target.

## What the reviewer checks

In the first review:

1. **Conformance.** Whether the target does what the documents it must satisfy require, and whether it does something they forbid. For a design document or a ticket, also contradictions inside it, claims without support, criteria no command or observation can decide, and limitations it omits.
2. **Correctness.** For a change: defects in the changed code and in the code that calls it or is called by it.
3. **Consistency across repositories.** Whether interfaces, formats, pinned versions, and assumptions agree with the related repositories as they are at their current commits.
4. **Documents.** Documents the target contradicts, and documents that described the changed thing and are now incomplete.

The reviewer verifies each claim against what it can read and run. It separates what it verified, with file and line, from what it infers.

## The review result

The reviewer's final message is the result:

- **Findings.** Each has a severity, a location (file and line, or the section of a document), a concrete reason, and the evidence. The severities are `blocker` (a serious defect, a security problem, an unmet acceptance criterion, or a mismatch with a related repository), `should-fix`, and `minor`.
- **Unverified.** What the reviewer could not check and why: a command that would not run, a repository that was unavailable, a claim it had no way to test.
- **Covered.** The paths and repositories it read, so that the caller can see what the review rests on.

A reviewer that cannot run a command or read a path reports it under Unverified and reviews the rest. A reviewer always returns a result.

## Fixing and rechecking

1. The caller verifies each finding against the code or the documents before acting on it. A finding that is wrong is rejected with the evidence.
2. The caller fixes every accepted `blocker` and `should-fix`. It fixes a `minor` when the fix is small, and otherwise collects the minors into one follow-up ticket.
3. If any fix was made for a `blocker` or `should-fix`, the caller starts a new reviewer for a recheck. The recheck request lists the findings, the caller's decision on each, and the fix commits. The recheck covers whether each fix resolves its finding and whether the fix introduced a defect in the lines it touched. It is not a second broad review.
4. If the recheck reports a `blocker`, the caller fixes it and requests one more recheck. After the second recheck the procedure ends whatever it reports.

A target with a `blocker` open at the end stays a draft pull request, or an unapproved design or ticket, and the open finding is listed where the record goes.

The user can ask for another broad review at any time. The skill does not start one by itself.

## The record

The caller writes the outcome where the work's state lives:

- on the ticket, a comment with the reviewed commit, each finding with its severity and what was done about it, and the unverified items;
- in the pull request body, the same summary, so that the human reviewer sees what the review covered and what it did not.

Nothing else is stored. A later review of the same target reads these.

## What the skill does not do

- It does not run the test suite as a gate. The caller runs the checks its workflow requires, and CI runs on the pull request.
- It does not decide whether the pull request may merge. Approvals and CI decide that.
- It does not review a pull request from an untrusted author. The reviewer runs the project's commands in the caller's environment, which is safe only for work the caller owns. `review-until-approve` covers other people's pull requests.

## Why

**One broad pass with the right inputs finds what a diff-only pass cannot.** In repositories that work together, the costly defects are mismatches: a consumer that still reads a file the change removes, a pin that does not contain the interface the change calls. The reviewer finds them only if the request names the related repositories and the reviewer can read them. That requires a reviewer in the caller's environment and a request that lists paths.

**A target defined as a list of things to read needs no special case for documents.** A design document and a ticket have no diff. When the target is "the diff", a document must be wrapped to look like one, and the wrapper becomes something a reviewer can mistake for a defect. When the target is a list of paths and commands, a document is one path.

**The caller fixes, because the caller has the context.** A separate fixer starts without knowing why the code is as it is. The reviewer's independence is what matters, and it is kept: the reviewer never sees the caller's reasoning, and the recheck uses a new reviewer.

**The recheck is narrow, because a second broad pass mostly repeats the first.** The first pass is where the breadth is spent. After it, the question is whether the fixes are right.

## Rejected alternatives

- **A loop that reviews and fixes until a CLI declares a terminal state.** It finds more in total, since every round is another look. Each round also needs findings matched to the previous round's, fixes certified, and the run's state kept valid across pushes, base changes, and design changes; that bookkeeping is where runs stop for reasons unrelated to the change.
- **Separate finder, verifier, planner, fixer, and certifier agents.** A verifier removes false findings before anyone acts on them. The caller does the same when it verifies each finding, at the cost of one agent instead of five, and it does so knowing the code.
- **A separate, lighter procedure for small changes.** Choosing between two procedures is itself a decision that can be wrong, and the broad review of a small change is short.
- **A stored list of findings with stable identifiers across rounds.** It lets a later round say which findings are new. With one review and a narrow recheck, the recheck request already carries the findings.

## Residual exposure

- One reviewer misses defects that a second independent pass would find. How many has not been measured against a multi-round procedure. The exposure is highest for changes to recovery, authority, data loss, migration, and security behavior; for those, the user or the coordinating session can require a second broad review by a new reviewer.
- The caller decides what to do with each finding and is also the author. A rejected finding is recorded with its evidence on the ticket and in the pull request, where the human reviewer can disagree.
- The reviewer is told not to edit, and on a harness that cannot restrict a subagent's tools that is an instruction only.
- A related repository that the project's rules, the manifests, and the ticket all fail to name is not reviewed against.
