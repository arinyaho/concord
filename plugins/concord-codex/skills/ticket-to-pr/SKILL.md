---
name: ticket-to-pr
description: >-
  Use when a request names a unit of work and asks for it to be taken through several stages at once —
  "이 티켓 설계부터 PR까지", "take this issue through design, implementation and a PR",
  "이거 끝까지 해서 PR 올려줘". Do NOT use for a single-stage request (just fix this, just review this).
---

# Ticket to PR

One ticket, one branch, one pull request that carries the code together with the unit's design document, or with a link to the design it implements. The stages below are in the order the work happens, and each has an exit condition.

- **State.** The design goes in the repository's `docs/`. The plan, progress, decisions, and the review record go on the ticket. The change, its checks, and the review summary are on the pull request. Keep nothing that matters anywhere else: a session with no memory of this work must be able to resume from the ticket and the pull request.
- **Stopping.** Stop and ask only for a product decision (a choice that changes the acceptance criteria, the scope, or the design), for something only the user holds (a credential, hardware, an account, a human approval), or before a hard-to-reverse action the user has not authorized (a merge, a release, a deletion, a message to people outside the session). Give the options and a recommendation, and continue the work that does not depend on the answer. Record every other obstacle on the ticket and continue.
- **Project rules.** Tracker commands, repository locations, the worktree directory, pull request conventions, and reviewers come from the project's rules file. Read it first.
- **What this authorizes.** Creating the branch and worktree, commits and pushes to that branch, opening the draft pull request and marking it ready, requesting the reviewers the rules file names, edits to this ticket (body, comments, status), and one follow-up ticket for minor points. Never merging, closing a pull request or a ticket, or anything on other pull requests.

## The unit

The unit is one coherent ticket outcome; keep its changes together. Split it only at a boundary that can be deployed or reverted on its own, where a prerequisite must merge first, at a repository boundary, or for an ownership split the approved plan names. A frontend/backend label or size alone is not a boundary. An outcome a user could accept separately belongs in its own ticket. A ticket that mixes unrelated outcomes, or whose boundary you cannot name, goes back to its author as a product decision before you implement it.

## The stages

| # | Stage | Exit condition |
|---|---|---|
| 0 | Branch | A dedicated branch (in a worktree when the rules file says so) is cut from the branch the pull request will target: the base, or for a stacked unit its prerequisite's branch |
| 1 | Ticket | Every acceptance criterion names something an observer or a command can decide. The ticket has a review record. The ticket is in progress in the tracker |
| 2 | Discriminating red | The harm the ticket names reproduces against the unchanged code, and the command and result are on the ticket |
| 3 | Design document | Committed under `docs/`: the decision, what it costs, the residual exposure, and for a stateful change the table of "Stateful changes". When your prompt names a design document, read it and write none |
| 4 | Review the design | `review-and-fix` on the design document you wrote; its record is on the ticket. Skipped when you wrote none |
| 5 | Plan | On the ticket. Each task ends in something that can be run and rejected on its own |
| 6 | Implement | A test that fails first for the right reason, in the environment CI uses; then the smallest change that makes it pass |
| 7 | Review the change | `review-and-fix` on the change; its record is on the ticket and in the pull request body |
| 8 | Discriminating green | The stage-2 check passes on the final head, and the full test suite has run once on that head |
| 9 | Pull request | A draft pull request with the code, the documents, and the design or a link to it; marked ready when the work is done |

### Stage 1: the ticket

Move the ticket to in progress before stage 3, with the tracker commands from the rules file. A tracker can refuse a transition for a reason it does not advertise (no assignee, a parent that is not in progress, a status that cannot be skipped): attempt it, read the refusal, and fix what the rules file lets you fix. Never move a ticket to done; that follows the merge.

A criterion no command or observation can decide is a product decision: ask for its rewording, and continue with the criteria that are decidable.

A ticket that comes from `initiative-to-prs`, or already carries a review record, was reviewed. Review any other ticket before work starts: run `review-and-fix` with the ticket as the target, the design it implements and its parent ticket as what it must satisfy, and the related repositories. A finding that changes the acceptance criteria or the scope is a product decision for the user; fix the rest in the ticket.

### Stage 2: discriminating red

A change justified by "X is broken" is a claim. The red run makes it a fact, so it comes before the design.

- **Reproduce the harm, not the mechanism.** A unit test showing "the code registers the wrong certificate" proves nothing when the ticket says "and therefore login breaks". The red shows the consequence the ticket names.
- **When the shipped configuration cannot show it, build one that can:** a second profile, another code path, a harness that builds the before and the after artifact. Say in the test which configuration it discriminates on. A check that passes the same before and after is not evidence; label it so.
- **Record what the run ran against:** image tags, dependency pins, the commit each artifact was built from, and where they differ from what the branch declares.
- **Make both phases refuse to pass for the wrong reason.** A red phase that passes means the harness failed. A green phase whose preconditions were not met is inconclusive.

If the red needs an image built or an environment stood up, build it. If the harm does not reproduce against the unchanged code, the ticket's premise is unproven: write the evidence on the ticket and put the premise to the user as a product decision.

### Stage 3: the design document

- **Your prompt names a design document** (a unit of an initiative): read it at the path given. Do not write another and do not edit it. Record the decisions you make within it on the ticket and in the pull request body, link the design's pull request in the body, and skip stage 4. A decision that would change the design is a product decision: end with a `question` report.
- **No design document exists** (a standalone ticket): write one.

### Stages 4 and 7: review

Run the `review-and-fix` skill and fill its review request as it says. What is specific to each stage:

| | Stage 4 | Stage 7 |
|---|---|---|
| Target | The design document you wrote, at the head | The change, with the base as `review-and-fix` defines it |
| Must satisfy | The ticket and its acceptance criteria, and the parent ticket or brief when there is one | The ticket's acceptance criteria and plan, and the design document's path |
| Evidence | The code and the red run the design rests on | The test commands, the commit they ran on, and the results |

Review reads what is in front of it. When the design, the plan, the comments, and the diff share one false premise, review does not find it; the stage-2 run does. Two statements in the source that disagree are a reason to run the code, not to pick one.

If the review cannot run, write "review not run" and why on the ticket and in the pull request body, and continue.

### Stage 9: the pull request

1. Push the branch and open the pull request as a draft. It may be opened earlier, after the first push, so that CI runs.
2. Write the body (see "The pull request body") and run the documentation sweep.
3. Put the pull request link on the ticket and read it back.
4. Wait for CI on the head commit with one blocking wait. When it fails for a reason the change caused, fix it, push, and wait again, at most twice. After a CI fix, run the stage 8 check again on the new head. When the fix changed code the stage 7 review covered, not only tests or configuration, run a recheck for it if that review has one of its two left; otherwise say in the record that the fix was not rechecked. A failure that remains, or one outside the change (a download, a registry, a runner), is recorded on the ticket and in the body; the pull request stays a draft, and your report says so.
5. Mark the pull request ready when all three hold: no `blocker` finding is open, CI passed on the head, and every acceptance criterion has its evidence on the ticket or in the body. Otherwise it stays a draft, and the body and the ticket list what is open.

Do not merge. `pr-to-merge` carries the pull request from here, under the user's merge authorization.

## One outcome across repositories

When one set of acceptance criteria needs several repositories, keep one ticket and run the stages once per repository: each has its own branch, pull request, and red and green check for the behavior it changes.

- Record the red for the whole outcome once, against the unchanged combined system. A repository's green is not the outcome's green; say which one a result is.
- A downstream unit records the exact upstream version or artifact it consumed. A proposed version is not a pin.
- The ticket names one owner of the combined check and keeps the ordered list of units, pull requests, and checks.
- When the combined check cannot run yet (a release, a pin, or an environment is missing), record it on the ticket with its owner and what unblocks it. The unit pull requests proceed.

## Stateful changes

A change is stateful when it writes, reads, or branches on data that outlives one run or process (a stored record, a cache, a git ref, a tracker or pull request field), or when it adds or alters a retry, recovery, or replay path. Input the caller supplies each time is not state unless it carries state from an earlier interaction, such as a cursor. Any other change says so in one line.

A stateful change carries a table, and any other change its one line, in the unit's design document when the unit wrote one, and in the pull request body when it did not (a unit of an initiative). One row per combination of a state and an event the change can affect.

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| pending | approve, first time | approved; notifier called once | changed | `approve_pending_notifies_once` |
| approved | approve replayed | approved; no second notification | introduced | `approve_replay_is_noop` |
| pending | two approvals both read pending | one wins; the other is rejected; notifier called once | introduced | `concurrent_approve_single_winner` |
| legacy `queued` record | approve | rejected with a migration error; record unchanged | introduced | `approve_queued_record_rejected` |

- **Outcome** names the response or error, the resulting state, and every external effect, including what stays unchanged and any ordering that matters.
- **Kind** is introduced, changed, or unchanged against the base.
- **Events** include the first occurrence, a repeat or replay, two operations interleaved on the same state, an interruption between or during durable writes and external effects with the restart that recovers from it, a result that changes the outcome such as a decline or a timeout, and a state value or operation the change removes.
- Combinations an invariant rules out go in one line under the table that names the invariant.

Stage 6 fills the evidence column. An introduced or changed row has a test that fails before the change and passes after it, and that asserts the whole outcome. When no test can exercise a row, such as a crash between two durable writes, record the reason and an executable stand-in held to the same bar. An unchanged row cites an existing test or says "untested, because". A state or event found missing later, including in review, is added to the table, in the same place and the same pull request, with its evidence.

## Design work and applying a decision

Sort each task by whether it decides what something should be or applies a decision already made.

- Deciding the content or wording of a rule, a contract, an interface, a schema, or an architecture is design work. Before accepting a direction, have a model of the most capable class the harness offers examine it, within the models the user allows. A review finding against such content is design work too.
- Implementation, tests, edits, pushes, and the pull request stay with you. Split a task that mixes both.
- For cryptography, security, or migration design, also get a second look in a separate context that sees the source evidence and the proposed decision without your reasoning.
- A new design choice that changes the acceptance criteria, the scope, or the approved design is a product decision. A worker reports it and does not make it.

When the model the task needs is not available or not allowed, ask the user once and continue with the work that does not depend on it.

## Waiting and test scope

- Wait for a long command with one blocking wait or a background notification, never with repeated short sleeps.
- During implementation and fixes, run the tests focused on the change, in the environment CI uses. Run the full suite once, on the final head.

## Past the context limit

Stop at the next stage boundary. Write on the ticket which stages are done with their evidence, the branch and worktree, and the exact next action. A worker then ends with a `handoff` report; a session of your own tells the user. The successor reads the ticket and the pull request, not the transcript, and does not repeat a stage the ticket records as done.

## The pull request body

Read the repository's pull request template immediately before writing, and follow its prompts and order. Without a template, use the content below and invent no house format. The design document holds the reasoning; the body is the reviewer's summary and links to it.

Beyond the template's prompts, include only:

- the observable problem and the changed behavior;
- the checks actually run and their results;
- the review record: the reviewed commit, each finding with its severity and what was done, and what the review could not verify;
- compatibility, migration, security, or other impact that affects the decision to merge;
- one `Closes #n` line per issue the pull request closes (`Closes OWNER/REPOSITORY#n` for another repository), because GitHub closes only the first issue of a list, and `Refs #n` for each related issue left open.

Use the terms the code and the documents already use. Edit the body once so that each item appears once.

### Documentation sweep

Sweep the whole branch diff for documents the change **contradicts**: a removed name still asserted elsewhere, a limitation another document describes, an interface the change widened. Search for the identifiers you touched, not only the files you edited.

Then look for what the change leaves **incomplete**: a document that described the thing without stating the invariant you changed has no string to search for. Find those by asking which documents tell an operator what to do with this thing, and read them.

Every document the change contradicts is corrected in this pull request. Each incomplete one is corrected here, given to a follow-up ticket, or left unchanged with the reason in the body. If the repository tracks known gaps or limitations, check both ways: whether the change closes a row, and whether it creates a residual that needs one.

## Rationalizations

| Excuse | Reality |
|---|---|
| "The red run needs an image build, I'll add it after the pull request" | Then the pull request asserts something you have not checked. Build the image. |
| "The comments and the docs both say it works this way" | Comments are claims. Two that agree may be one copied. |
| "The unit test is red, that's the regression test" | Only if it is red for the harm the ticket names. |
| "The e2e passes, so the fix works" | Run it against the unchanged code. If it passes there too, it discriminates nothing. |
| "The regression test passes locally" | Check that the workflow runs it. A test CI never executes is not coverage. |
| "The doc sweep is clean, the docs are done" | A sweep finds contradictions. A document that never mentioned the invariant is now incomplete. |
| "Review found ten things, it is thorough enough" | Review cannot reject a premise the whole diff shares. |

## Red flags

- A pull request marked ready whose body says "still to be verified"
- An acceptance criterion that no command can decide
- A red test about your own code when the claim is about a dependency's behavior
- A premise copied from a code comment into a design document
- A green run whose image tags and dependency pins are written down nowhere
- A residual exposure that exists only in the design document you just wrote
- A branch with commits while the tracker says the work has not started
