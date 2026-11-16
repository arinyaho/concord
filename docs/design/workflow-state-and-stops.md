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

These kinds of local file are allowed. None records the state of the work, and each decides only what its entry says:

- **Working documents.** A coordinating session keeps one state document (the user's standing authorizations with their words and dates, the list of work units and their pull requests, and lessons) and receives worker reports as files. They are plain Markdown, written and read by agents. The progress and decisions in them are also on the ticket. Deleting them loses convenience and the record of standing authorizations; a successor then asks the user again.
- **Notice records.** A polling script may keep a file of the notices it has already printed, so that it does not print them twice, and a background watcher may record when it last checked, so that a stopped one is reported. Deleting the file causes a repeated or delayed notice and, for a watcher that also records failed rounds, at most one repeated round and a reset failed-round count, and nothing else, except that `pr-to-merge`'s record also says which review items went to a session and which approvers were asked again, so deleting it replays those. No script reads such a file to decide whether a pull request merges or a review passes.
- **The notice list.** One list in Concord's per-user state directory, shared by the background watchers of `review-until-approve` and `pr-to-merge`, holds the lines the user has not yet seen. Both notify by the same rule: one system notification per check that added a line that is not informational, with the count and no pull request text, and one after ten failed checks in a row. The plugin's `SessionStart` hook prints the pending lines; a line stays pending until its skill marks it, `review-until-approve` when the question is answered and `pr-to-merge` when `watch status` shows it in the user's session. A headless session marks nothing. A line is informational when it reports an action the watcher took that needs nothing from the user: for `review-until-approve`, a published round with no question or approval and a restored `review-blocked` label; for `pr-to-merge`, `approved`, `rerun`, `synced`, and `requested`. Every other line counts toward a notification.
- **Locks.** A script may keep a lock file so that two runs do not work on the same thing at once. A lock decides only whether a run may start, and a run takes one over only when its holder is not running. Deleting one lets two runs overlap.
- **Watch lists.** `review-until-approve` keeps the pull requests its background watcher checks, each with the account, harness, model, and effort to use, adding one when the user invokes the skill on it and removing one when the user stops it or it is merged or closed. It decides which pull requests are checked, how a round's agents start, and that the watcher may run rounds on them, approval included, as the user's invocation authorized. The watcher exits when it is empty. Deleting it stops the checks; invoking the skill on a pull request adds it again. `pr-to-merge` keeps the repositories its watcher checks, each with the options of the invocation, including whether merging is authorized there, until the user removes the entry or seven days pass; it decides which pull requests are acted on and whether they may merge.
- **The user's review notes.** `review-until-approve` keeps a user's notes on a pull request in the store the user chose (a secret gist or a private repository of theirs), with a local copy as a cache that is the only copy until the user chooses. They are the user's input to its rounds, not the state of the work.
- **Read-only modes.** A file per session that names the one directory the session may read and, for a confined agent, the one file it may write; for a `pr-to-merge` headless session, also the worktree, without its `.git`, it may edit. It decides only what that session's tools may do.
- **Logs.** Output kept for a person to read, such as the GitHub messages a polling script does not print. The session does not read them, and they decide nothing.

Minor points that a workflow does not fix are collected into one follow-up ticket in the project's tracker. `pr-to-merge` files none: a minor point it does not fix on the user's own pull request is listed in its reply and in its report to the user.

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

A stop names the decision or the item needed, the options, and a recommendation. Work that does not depend on the answer continues while the question is open. A run with no conversation, such as a background watcher or the headless session it starts, leaves the question where the user sees it next and continues with work that does not depend on it.

A workflow has no launch, round, or run budget that ends its work. The procedures are bounded by their text: `review-and-fix` runs one review and at most two rechecks. A background watcher runs until its watch list is empty and caps its unattended runs at six per pull request in 24 hours; past the cap it hands the pull request to the user instead of ending anything.

## What is code

A step is code when a model gets it wrong under repetition or when it should cost no tokens:

- waiting and polling (CI, review activity, a merge queue);
- conditions that must hold exactly (whether an approval covers the current head, whether every check passed, the order in which stacked pull requests merge);
- paging through an API.

Everything else is skill text: the order of stages, what a review request contains, how to answer a review thread, when to file a follow-up ticket.

Each script is one file, reads the live state from GitHub and git on every run, and depends only on Node, `gh`, and `git`, plus the harness's command-line tool where it starts agents. A script prints what it did and what it could not decide, one line per event, and exits; a background watcher records such lines in the notice list instead. It does not print instructions for the model to obey, and it does not refuse to run because of what an earlier run recorded; a background watcher may hold back a retry of a round that failed on unchanged input, which an invocation by the user always runs.

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

A background watcher has no conversation with the user. `pr-to-merge`'s watcher reads the merge authorization from its watch list, where the skill records it only from the user's words in the invocation or from a standing authorization the coordinating session recorded, and where it lasts until the user removes the entry or seven days pass. That is the one other place an authorization is read from.

An authorization covers the kind of action and the repositories the user named, and nothing wider.

## Harnesses

The workflows run on Claude Code and Codex. A workflow uses the harness's own agents for workers and reviewers: a subagent, or a separate process of the same harness where confinement requires one or no session is open, as for the headless sessions of `pr-to-merge`. Such a process is always confined: it runs no command, and the script that started it runs none of the code it read or edited. It never uses another vendor's agent.

## Why

**A store with authority disagrees with the three places, and every disagreement is a stop.** A ledger that pins the hash of a design note stops the run when the user approves a change to that note. A ledger bound to one repository stops a change that spans two. A recorded base stops the run when the base moves. In each case the work itself is sound and the user has nothing to decide. Reading the ticket and the pull request again cannot disagree with them.

**A rule that fails closed on procedure moves the cost to the user.** When a procedural failure ends the run, the user must return, read an error about Concord's internals, and authorize a continuation. Under a session goal this ends the goal. The stop rule keeps the user's attention for the three cases that need it.

**An authorization is read only from a place that only the user's words reach.** The user's conversation with the coordinating session is the one channel other people cannot write to, and the state document carries those words to a successor. `pr-to-merge`'s watch list is the exception: the skill writes an authorization into it only from those words, it expires, and it lives on the user's machine. A ticket and a pull request accept text from anyone with access, so an authorization read back from them could be one that no user gave.

**Subagents keep the decision in one place.** Separate sessions are peers: each can defer to another, and an instruction that names one of them the coordinator does not bind the others. A subagent returns its result to the session that started it and ends, so there is one place where decisions are taken. A confined agent process started by a script decides nothing either: it writes a result file, and the script acts on it within the authorization it holds. The two things separate sessions offered are obtained otherwise: a `handoff` report carries work across a context limit, and worktrees separate parallel work.

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
