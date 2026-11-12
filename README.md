# concord

[![pull-request](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml/badge.svg)](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml)
[![License: MIT](https://img.shields.io/github/license/arinyaho/concord)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757)
![Codex](https://img.shields.io/badge/Codex-supported-black)

concord is a plugin for Claude Code and Codex that reviews and fixes your branches, reviews pull requests until they can be approved, and takes tickets through to pull requests.

- `review-and-fix` has one independent reviewer, in a fresh context, review a design document, a ticket, or your change against its requirements and the repositories it depends on. You fix what it finds through the session, and a new reviewer rechecks the fixes.
- `ticket-to-pr` and `initiative-to-prs` take a ticket, or a whole initiative, through design, implementation, review, and a pull request. Progress and decisions are written on the ticket and the pull request, so a new session can resume from them.
- `pr-to-merge` merges approved pull requests as soon as GitHub allows it, when you have authorized merging.
- `review-until-approve` reviews someone else's pull request round by round, waits for the author to push or reply, and approves the reviewed head once a round is clean. It never requests changes, merges, or pushes.

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
| `review-until-approve` | "Review https://github.com/acme/app/pull/57 until it is approvable." Findings are classed as blockers or minor follow-ups. The approving review lists the minors. A finding in a file the diff touches but outside a hunk becomes a file comment. Threads the skill started for fixed or addressed findings are answered and resolved, and a draft is watched until it is ready. |
| `ticket-to-pr` | "Take issue #212 through design, implementation and a PR." |
| `initiative-to-prs` | "Turn this brief into tickets and take them to PRs." It writes the design, proposes the tickets, asks you once to approve the set, then runs each ticket with a worker in its own worktree. |
| `pr-to-merge` | "Merge the approved PRs in acme/app as they become ready." A script watches without a model, merges each approved pull request that nothing holds once GitHub allows it, and reports the rest; the skill relays those reports, answers reviews on your own pull requests, and checks each merge afterwards. Without your authorization to merge it only reports pull requests as ready. |

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
| `review-until-approve` | Reviews someone else's pull request in a loop and approves the reviewed head once a round is clean. | Claude Code, Codex |
| `pr-to-merge` | Watches the open pull requests of named repositories, merges each approved one that nothing holds as soon as GitHub allows it, reports the rest, and answers reviews on your own pull requests. | Claude Code, Codex |

## Review policy

A finding blocks only when it is a serious defect, a security problem, an unmet acceptance criterion, or a mismatch with a related repository. A pull request with an open blocking finding stays a draft. Minor findings do not block: small ones are fixed, and the rest go into one follow-up ticket.

`review-and-fix` runs one broad review and at most two rechecks of the fixes. It does not try to prove a change free of defects, and it never runs another broad review by itself; you can ask for one.

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
