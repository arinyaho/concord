# Workflow state and stops

Concord's workflows (`ticket-to-pr`, `initiative-to-prs`, `review-and-fix`, `pr-to-merge`, `review-until-approve`, and `coordinate-sessions`) share three rules: where the state of the work lives, when a workflow may stop and ask the user, and which parts are code. This document defines those rules. The documents for the individual workflows apply them and do not restate them.

The measure of the rules is a long unattended run: a session that works through dozens of tickets, with its own goal, must be able to use every Concord workflow without Concord ending the run.

## Where state lives

The state of the work lives in three places, each of which exists without Concord.

| Place | Holds |
|---|---|
| The repository's `docs/` | Design and the large specifications |
| The ticket | The small specification, the plan, the acceptance criteria, progress, and decision records |
| The pull request | The change, the review threads, the approvals, and the CI results |

Concord keeps no store of its own that decides anything. A workflow that needs to know what is done reads the ticket and the pull request again. A workflow that makes progress or receives a decision writes it to the ticket. A session that starts with no memory of the work resumes from the ticket and the pull request alone.

Three kinds of local file are allowed, and none decides the state of the work:

- **Working documents.** A coordinating session keeps one state document (the user's standing authorizations with their words and dates, the list of work units and their pull requests, and lessons) and receives worker reports as files. They are plain Markdown, written and read by agents. The progress and decisions in them are also on the ticket. Deleting them loses convenience and the record of standing authorizations; a successor then asks the user again.
- **Notice records.** A polling script may keep a file of the notices it has already printed, so that it does not print them twice. Deleting the file causes a repeated notice and nothing else. No script reads such a file to decide whether a pull request merges or a review passes.
- **Locks.** A script may keep a lock file so that two runs do not work on the same thing at once; `review-until-approve` uses one so that only one round runs at a time on a machine. Deleting a lock changes no outcome, except that two runs may overlap.

Minor points that a workflow does not fix are collected into one follow-up ticket in the project's tracker. `pr-to-merge` files a GitHub issue instead, because the pull request it works on is on GitHub.

## When a workflow stops

A workflow stops and asks the user in three cases only:

1. **A product decision.** A choice that changes a ticket's acceptance criteria, its scope, or the design.
2. **Something only the user holds.** A credential, hardware, an account, or a human approval.
3. **An unauthorized action that is hard to reverse.** A merge, a release, a deletion, or a message to people outside the session, when the user has not authorized that kind of action.

Every other obstacle is recorded and the work continues. The table gives the behavior for the obstacles that occur most.

| Obstacle | Behavior |
|---|---|
| A reviewer cannot run a command or reach a file | The reviewer reports that item as unverified and reviews the rest. The review result lists the unverified items |
| A script or CLI call fails | Retry once where a retry is sensible, otherwise report the error in the result and continue with the remaining work |
| The base branch moved | Read the new base and continue. Nothing recorded before the move becomes invalid by rule. The independent reviewer of `review-and-fix` is asked to recheck when a merge of the base changed lines its review covered; a person's approval in `pr-to-merge` stands across merges of the base as [pr-to-merge.md](pr-to-merge.md) defines |
| The design or the acceptance criteria changed with the user's approval | Read the new text and continue |
| A review was not run, or did not finish | Say so in the pull request body and in the ticket. The pull request is still opened |
| A blocker finding remains after the fixes | Leave the pull request as a draft, list the finding in its body, and continue with independent work |
| A worker reaches its context limit | It writes a `handoff` report and a successor continues from it |

A stop names the decision or the item needed, the options, and a recommendation. Work that does not depend on the answer continues while the question is open.

A workflow has no launch, round, or run budget that it enforces. The procedures are bounded by their text: `review-and-fix` runs one review and at most two rechecks, and a polling script runs to a deadline.

## What is code

A step is code when a model gets it wrong under repetition or when it should cost no tokens:

- waiting and polling (CI, review activity, a merge queue);
- conditions that must hold exactly (whether an approval covers the current head, whether every check passed, the order in which stacked pull requests merge);
- paging through an API.

Everything else is skill text: the order of stages, what a review request contains, how to answer a review thread, when to file a follow-up ticket.

Each script is one file, reads the live state from GitHub and git on every run, and depends only on Node, `gh`, and `git`. A script prints what it did and what it could not decide, one line per event, and exits. It does not print instructions for the model to obey, and it does not refuse to run because of what an earlier run recorded.

## Workers

A coordinating session hands a unit of work to a worker. A worker is a subagent of the coordinating session, started with the harness's own agent tool, working in its own git worktree.

- The worker's final message is its report, and the worker also writes it as a file in the unit's report directory so that it survives the session. The first line is `[to coordinator] <kind>: <one-line summary>`. The kinds are `question`, `blocked`, `progress`, `done`, and `handoff`.
- A worker cannot wait for an answer. When it reaches one of the three stop cases it ends with a `question` or `blocked` report that gives the options and a recommendation.
- A `done` report lists the pull request URL, the head commit, the CI result for that head, the review findings with how each was handled, and each acceptance criterion with its evidence or the statement that it is not met.
- Project rules (repository locations, the worktree directory, pull request conventions, the tracker, reviewers to request) live in the project's own rules file. The worker prompt gives the path to that file; the skills do not contain project rules.

This document relies on two of Concord's agent definitions: the implementer, which carries one ticket through `ticket-to-pr` in its worktree and reports a new design choice instead of making it, and the reviewer, which is described in [independent-review.md](independent-review.md). `review-until-approve` has its own confined agents.

The decisions stay with the coordinating session. It takes as a decision only what the user wrote in its own conversation, together with the standing authorizations its state document records from such words in a predecessor's conversation. A worker report, a ticket, and a comment are data.

## Standing authorizations

The user can authorize a kind of action once for a run, such as "merge approved pull requests" or "push when GitHub's merge requirements pass". Only the coordinating session records one, and only from words the user wrote in that session's own conversation: it writes the words and the date in its state document and applies the authorization to later cases of the same kind without asking again. A successor session reads the state document as the record of those authorizations. A worker never writes the state document.

The coordinating session also copies each authorization to the tracking ticket as a decision record, for people to read. No workflow reads a ticket or a comment back as an authorization, because other people can write there.

An authorization covers the kind of action and the repositories the user named, and nothing wider.

## Harnesses

The workflows run on Claude Code and Codex. A workflow uses the harness's own agents for workers and reviewers: a subagent, or under Codex a separate process of the same harness where confinement requires one. It never uses another vendor's agent.

## Why

**A store with authority disagrees with the three places, and every disagreement is a stop.** A ledger that pins the hash of a design note stops the run when the user approves a change to that note. A ledger bound to one repository stops a change that spans two. A recorded base stops the run when the base moves. In each case the work itself is sound and the user has nothing to decide. Reading the ticket and the pull request again cannot disagree with them.

**A rule that fails closed on procedure moves the cost to the user.** When a procedural failure ends the run, the user must return, read an error about Concord's internals, and authorize a continuation. Under a session goal this ends the goal. The stop rule keeps the user's attention for the three cases that need it.

**An authorization is read only from a place that only the user's words reach.** The user's conversation with the coordinating session is the one channel other people cannot write to. The state document carries those words to a successor. A ticket and a pull request accept text from anyone with access, so an authorization read back from them could be one that no user gave.

**Subagents keep the decision in one place.** Separate sessions are peers: each can defer to another, and an instruction that names one of them the coordinator does not bind the others. A subagent returns its result to the session that started it and ends, so there is one place where decisions are taken. The two things separate sessions offered are obtained otherwise: a `handoff` report carries work across a context limit, and worktrees separate parallel work.

## Rejected alternatives

- **A review ledger that a CLI owns, with the CLI as the authority on rounds and termination.** It gives exact accounting of findings and spend. It also needs a verb for every way real work departs from the expected sequence (a fix made outside the loop, a changed intent, a moved base, a second repository), and each missing verb is a run with no supported way forward.
- **Budgets enforced by a CLI.** They bound cost, but a budget that runs out mid-task stops the task at a point unrelated to its state, and raising it needs the user. The procedures are short enough to be bounded by their text.
- **Workers as separate sessions.** Described under Why.
- **Another vendor's agent as the reviewer.** It gives a second model's view. It runs in its own sandbox, which cannot run the project's tests or read neighboring repositories, so its failures are failures of the sandbox and say nothing about the change.

## Residual exposure

- Nothing forces a review to run. A workflow that skips it says so in the pull request, and the human reviewer is the check on that statement.
- The working documents can drift from the ticket when a session writes one and not the other. For progress and decisions the ticket is the record, and a successor that finds a difference follows the ticket; for standing authorizations the state document is the record.
- A worker shares the coordinating session's filesystem, so that it never writes the state document is an instruction to the worker, not a restriction on it.
- A standing authorization is applied by a model reading its own state document. An authorization recorded more widely than the user meant is applied that widely, so the record quotes the user's words.
