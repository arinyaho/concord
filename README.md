# concord

[![pull-request](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml/badge.svg)](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml)
[![License: MIT](https://img.shields.io/github/license/arinyaho/concord)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757)
![Codex](https://img.shields.io/badge/Codex-supported-black)

concord is a plugin for Claude Code and Codex that reviews and fixes your branches, reviews pull requests until they can be approved, and takes tickets through to pull requests.

- `review-and-fix` has one independent reviewer, in a fresh context, review a design document, a ticket, or your change against its requirements and the repositories it depends on. You fix what it finds through the session, and a new reviewer rechecks the fixes.
- `ticket-to-pr` and `initiative-to-prs` take a ticket, or a whole initiative, through design, implementation, review, and a pull request. Progress and decisions are written on the ticket and the pull request, so a new session can resume from them.
- `pr-to-merge` carries your own pull requests to their merge from a background watcher that keeps running after the session ends, and merges each one as soon as it qualifies when you have authorized merging.
- `review-until-approve` reviews someone else's pull request round by round, with a confined reviewer and a confined verifier, and the review it publishes holds the whole state, so any session or machine resumes from the pull request. After one invocation, a background watcher that calls no model runs the next round when the author pushes, replies, or edits the description, or the user's notes change, approves when the pull request becomes ready, and drops it when it is merged or closed. It approves the reviewed head once nothing blocks, and never requests changes, merges, or pushes.
- `explain-pr` walks you through someone else's pull request before you approve it, with every claim pointing at a file and line. It reads the pull request in a read-only mode and approves nothing.

For example, type this in Claude Code:

```
Take issue #212 through design, implementation and a PR.
```

concord checks the issue's acceptance criteria, records a check that fails, writes and reviews a design document, implements the change, reviews it, and gets the check to pass. It opens a draft pull request, marks it ready when no blocking finding is open, CI is green, and every criterion has evidence, and does not merge it.

Install it in Claude Code:

```
/plugin marketplace add arinyaho/concord
/plugin install concord@arinyaho-concord
```

Enabling the plugin registers its hooks automatically - no `settings.json` editing required. Codex steps are in [docs/install.md](docs/install.md).

## Usage

Each workflow starts from one request. The examples below are what a user would type.

| Workflow | Example request |
|---|---|
| `review-and-fix` | "Review and fix this branch." or "Review docs/design/login.md against issue #212." One reviewer reads the target, what it must satisfy, and the related repositories; the findings are verified and fixed, and the fixes are rechecked, at most twice. The outcome is written on the ticket and in the pull request body. |
| `review-until-approve` | "Review https://github.com/acme/app/pull/57 until it is approvable." Your session never reads the pull request: a reviewer and a verifier that can read only a prepared copy of it, with no network or GitHub token, find and check the findings, and a script publishes them. Tell it your view ("approach X is fine", "don't flag naming") and both agents take it as your instruction; the notes stay private to you, in a secret gist or a private repository of yours, whichever you choose the first time. Findings are classed as blockers or minor follow-ups; the approving review lists the minors. What turns on judgment, an edited state, or a changed submodule is asked of you, and `decide` records your answer on the pull request. A background watcher reviews the author's pushes and replies and approves when the pull request is ready, with no session open; its questions and approvals appear at your next session start. Say "stop watching" to end it. |
| `ticket-to-pr` | "Take issue #212 through design, implementation and a PR." |
| `initiative-to-prs` | "Turn this brief into tickets and take them to PRs." It writes the design, proposes the tickets, asks you once to approve the set, then runs each ticket with a worker in its own worktree. |
| `explain-pr` | "Explain https://github.com/acme/app/pull/57 before I approve it." The session prepares the pull request in one directory, then reads it in a mode where it can read only that directory and the tracker tools you allowed, and writes a guide: intent, a map of the diff, the order to read the core hunks in, the decisions and their records, what the change reaches, the evidence, and questions for the author. Under Codex it prints the command that starts the reading session. |
| `pr-to-merge` | "Merge my PRs in acme/app as they become ready." A background watcher checks every five minutes without a model and without the session open: it requests reviewers, asks a stale approver again, re-runs a failed check once, and merges each of your pull requests (and the automated ones you name) that qualifies; other people's pull requests are left to their authors. What needs you appears at the start of your next session and in `watch status`. A watch lasts seven days from your words; without your authorization to merge it only reports pull requests as ready, and `--confirm` makes every head wait for your confirmation. |

## Workflows

| Workflow | What it does | Harnesses |
|---|---|---|
| `review-and-fix` | Has one independent reviewer review a design document, a ticket, or a change of your own, fixes the verified findings, and has the fixes rechecked. | Claude Code, Codex |
| `deep-review` | Runs one bounded review of a fixed base/head pair with independent reviewers and groups the verified findings by root cause. | Claude Code, Codex |
| `ticket-to-pr` | Takes one ticket through acceptance criteria, a failing check, a reviewed design document, implementation, review, a passing check, and a draft pull request that is marked ready when the work is done. | Claude Code, Codex |
| `initiative-to-prs` | Turns a product brief, problem report, or set of incomplete tickets into a design and implementation-ready tickets, asks once for approval of the ticket set, and runs each ticket to a pull request with workers. | Claude Code, Codex |
| `ticket-writing` | Drafts or updates tickets in GitHub Issues, Jira, Notion, or another tracker so another agent can implement from them. | Claude Code, Codex |
| `proposal-package-authoring` | Builds editable bid and proposal slide decks in Google Slides or PowerPoint from an RFP, source evidence, and reference decks. | Claude Code, Codex |
| `/charter` | Stores the project goal and merged decisions and injects them into each new session. | Claude Code, Codex |
| Session-state checkpoint | Saves per-session state from the transcript when a session stops and restores it on start, resume, or compaction. | Claude Code, Codex |
| `delegate-verbose-work` | Sends broad repository-wide searches to a subagent and keeps only the conclusion in the main conversation. | Claude Code |
| `coordinate-sessions` | Hands units of work to worker subagents in their own worktrees, reads their report files, checks each delivery, and keeps a state document with your standing authorizations. | Claude Code, Codex |
| `review-until-approve` | Reviews someone else's pull request in rounds with confined agents, keeps its state on the pull request, waits for the author in a background watcher with no model call, and approves the reviewed head once nothing blocks. | Claude Code, Codex |
| `explain-pr` | Explains someone else's pull request in a read-only session so you can decide on approving it, with every claim anchored to a file and line. | Claude Code, Codex |
| `pr-to-merge` | Carries your own and named automated pull requests in named repositories to their merge from a background watcher, reports what needs you, and answers reviews on your own pull requests. | Claude Code, Codex |

## Review policy

A finding blocks only when it is a serious defect, a security problem, an unmet acceptance criterion, or a mismatch with a related repository. A pull request with an open blocking finding stays a draft. Minor findings do not block: small ones are fixed, and the rest go into one follow-up ticket.

`review-and-fix` runs one broad review and at most two rechecks of the fixes. It does not try to prove a change free of defects, and it never runs another broad review by itself; you can ask for one.

`pr-to-merge` never counts an approval `review-until-approve` posted, so a person must still approve. A teammate on a Concord version from before this rule runs the older `pr-to-merge`, which counts that approval as a person's; nothing on your side prevents that.

The workflows stop and ask you only for a product decision, for something only you hold, or before a hard-to-reverse action you have not authorized. Anything else is recorded on the ticket and the work continues.

## Update

Claude Code:

```
/plugin marketplace update arinyaho-concord
/plugin install concord@arinyaho-concord
```

Installing and updating on Codex, and what the package contains, are in [docs/install.md](docs/install.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
