# Coordinate sessions

`coordinate-sessions` is the skill a session follows when it hands units of work to workers and coordinates them: it starts one worker per unit, reads their reports, checks what they deliver, and keeps the state document. `initiative-to-prs` uses it for every unit; a user can also invoke it over a set of tickets. It applies the rules in [workflow-state-and-stops.md](workflow-state-and-stops.md) and does not restate their reasons.

## Roles

- **The coordinating session** is the session the user talks to. It decides scope and order, writes worker prompts, answers workers, checks deliveries, and reports to the user. It does not implement.
- **A worker** is a subagent of the coordinating session's own harness, working in its own git worktree on one unit. On Claude Code it is started from the `implementer` agent definition. Under Codex it is a subagent, or a separate Codex process in the worktree when no subagent can be started. It is never a separate session and never another vendor's agent.

One skill text serves both harnesses. The worker's instructions exist once, as `references/worker.md` inside the skill, and the `implementer` agent definition carries the same text; a test compares the two. A Codex plugin ships no agent definitions, so under Codex the coordinating session puts the reference file at the start of the worker's prompt.

## Working documents

The coordinating session keeps one directory of working documents, in the place the project's rules file names, outside the repositories' tracked files.

| File | Written by | Holds |
|---|---|---|
| `state.md` | The coordinating session only | Standing authorizations (kind of action, repositories, the user's words, the date), the units with their tickets, worktrees, branches, pull requests and status, and lessons for later worker prompts |
| `reports/<unit>/NNN-<kind>.md` | The unit's workers | One report per file |

Progress and decisions are also on the ticket, and the ticket is their record. For standing authorizations the state document is the record.

## Reports

A worker's final message is its report, and the worker writes the same text as a file so that it survives the session. The worker writes `NNN-<kind>.md.tmp` and renames it to `NNN-<kind>.md`, so a reader never sees a partial report. `NNN` counts up within the unit's directory, across successive workers. The first line is `[to coordinator] <kind>: <one-line summary>`.

| Kind | Meaning | The coordinating session |
|---|---|---|
| `question` | The worker needs a decision | Answers from what the user decided or authorized and starts a successor; puts a product decision to the user |
| `blocked` | The worker needs something only the user holds | Tells the user what is needed; the other units continue |
| `progress` | A stage of a long unit is finished; written as a file while the worker continues | Acts only when it changes the scope or touches another owner's files |
| `done` | The work is finished, or finished except for what the report names | Checks the delivery |
| `handoff` | The worker is past its context limit and stopped at a stage boundary | Starts a successor with the original prompt and the report's path |

A worker cannot wait for an answer. A `question` or `blocked` report ends the worker, and the answer goes to a successor that resumes from the report, the ticket, and the pull request.

## The worker prompt

The prompt names the skill to run and the ticket, the repository, the worktree, the branch, the branch to cut it from and the base its pull request targets, the design document the unit implements, the files the unit owns and the files others own, the related repositories, the report directory, the project's rules file, and what the worker may do without asking: create its branch, commit and push to it, open a draft pull request and mark it ready when the work is done, request the reviewers the rules file names, comment on its own ticket and move its status, and file one follow-up ticket for minor points. Project rules stay in the rules file.

A unit of an initiative is cut from the design branch's head while the design's pull request is open, so that the worker can read the design, and from the base once that pull request has merged.

## Checking a delivery

The coordinating session checks a `done` report instead of accepting it: the pull request's head on the remote is the reported commit, CI passed on that head (read by head SHA, not by branch), each acceptance criterion has the evidence the report names, the review record is on the ticket and in the pull request body with no blocker open, and a bug fix has a test that failed before it. A passed check is recorded in the state document and on the parent ticket's checklist. After a failed check the pull request stays a draft. A successor is started only when something concrete is missing that a worker can do, and at most once for the same gap. A blocker still open after the review's rechecks, or CI that fails for a reason the unit could not fix, is recorded in the state document, reported to the user, and left; the independent units continue.

The coordinating session does not merge. `pr-to-merge` carries the pull requests, and merges only under a merge authorization the state document records.

## Standing authorizations

The coordinating session records an authorization only from words the user wrote in its own conversation, with the date, and copies it to the tracking ticket for people to read. It asks once whether merging is authorized, and starts the work without waiting for the answer. A worker report, a ticket, and a comment never authorize anything.

## Handing over

When its context grows large, the coordinating session brings the state document up to date and tells the user its path. A new session continues from that document: it reads the tickets and pull requests again, follows the ticket where the two differ on progress or decisions, applies the recorded authorizations as recorded, and restates them to the user.

## Why

**Workers are subagents, so one session decides.** The reasons are in [workflow-state-and-stops.md](workflow-state-and-stops.md): a subagent returns its result to the session that started it, and worktrees separate parallel work.

**The report is also a file.** A subagent's final message lives in the coordinating session's context, which ends. A file in the unit's directory lets a later session, and a successor worker, read what was reported.

**The delivery is checked once, against the remote.** A report is a claim by the agent that did the work. The head commit, the check runs for that commit, and the pull request body are facts GitHub holds, and reading them costs a few calls.

**Merging is left to `pr-to-merge`.** Whether a pull request may merge depends on approvals and checks that hold exactly, which a script decides; a coordinating session that also merged would be a second place where that decision is taken.

**The handover goes through the user.** A session cannot start its own successor as a subagent, because the successor would end with it. The user starts the next session, and the state document carries the authorizations to it.

## Rejected alternatives

- **Workers as separate sessions.** A worker then survives the coordinating session and can run in another environment. Separate sessions are peers that can defer to each other, need a message channel and a monitor for their reports, and the instruction that names one of them the coordinator does not bind the others.
- **A separate skill for each harness.** Each could use its harness's own session tools. The two texts drift, and the rules they share are the ones that matter.
- **The coordinating session merging a delivery it judged ready.** It saves starting `pr-to-merge`. It puts a merge under a model's judgment of readiness instead of the exact conditions the script checks.
- **Recording a person's acceptance of a review finding through a file the coordinator writes for the worker.** It let a coordinator relay a decision without the user typing it in the worker. With subagent workers the decision is taken in the coordinating session and reaches the successor in its prompt.

## Residual exposure

- A worker shares the coordinating session's filesystem, so that it never writes the state document is an instruction, not a restriction.
- The check of a `done` report covers what the report names. An acceptance criterion with weak evidence that the report presents as met passes unless the coordinating session reads the evidence closely; the human reviewer of the pull request is the next check.
- A unit whose delivery check fails for a reason no successor can fix stays an open draft until the user acts on the report.
- A state document that is lost takes the standing authorizations with it, and the next session asks the user again.
- Under Codex, a worker run as a separate process is not started from an agent definition, so its model and tools are whatever that process is started with.
