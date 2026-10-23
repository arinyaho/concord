# concord

[![pull-request](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml/badge.svg)](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml)
[![License: MIT](https://img.shields.io/github/license/arinyaho/concord)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757)
![Codex](https://img.shields.io/badge/Codex-supported-black)
![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-supported-1F6FEB)

concord is a plugin for Claude Code, Codex, and GitHub Copilot that reviews and fixes your branches, reviews pull requests until they can be approved, and takes tickets through to pull requests.

- `/review-and-fix` has independent reviewer subagents review your branch, fixes what they find, and re-reviews until a deterministic CLI ends the loop within a fixed round budget. Only serious bugs, security issues, and unmet acceptance criteria block; minor findings are collected and ticketed once before merge.
- `review-until-lgtm` collects the Codex and Copilot reviews on your pull request, fixes them in bounded batches, and pushes until the current head gets an explicit LGTM. It merges only when you ask.
- `review-until-approve` (Claude Code and Codex) reviews someone else's pull request round by round, waits for the author to push or reply, and approves the reviewed head once a round is clean. It never requests changes, merges, or pushes.
- The reviewer and the fixer can each be Claude, Codex, or Copilot, each with its own model.

For example, type this in Claude Code:

```
Take issue #212 through design, implementation and a PR.
```

concord agrees acceptance criteria for the issue, records a check that fails, writes a design note, implements the change, reviews it, and gets the check to pass. It ends with the pull request URL and does not merge it.

Install it in Claude Code:

```
/plugin marketplace add arinyaho/concord
/plugin install concord@arinyaho-concord
```

Enabling the plugin registers its hooks automatically - no `settings.json` editing required. Codex and GitHub Copilot steps are in [docs/install.md](docs/install.md).

## Usage

Each workflow starts from one request. The examples below are what a user would type.

| Workflow | Example request |
|---|---|
| `/review-and-fix` | `/review-and-fix feature/login origin/main` reviews the branch against `origin/main`. Add `--reviewer codex --fixer claude` to pick the provider for each role, and `--reviewer-model` or `--fixer-model` to pick the model. |
| `review-until-approve` | "Review https://github.com/acme/app/pull/57 until it is approvable." Findings are classed as blockers or minor follow-ups. The approving review lists the minors. A finding in a file the diff touches but outside a hunk becomes a file comment. Threads the skill started for fixed or addressed findings are answered and resolved, and a draft is watched until it is ready. |
| `ticket-to-pr` | "Take issue #212 through design, implementation and a PR." |
| `review-until-lgtm` | "Collect the Codex and Copilot reviews on PR 58, fix them, and tell me when the head has an LGTM." |

## Workflows

| Workflow | What it does | Harnesses |
|---|---|---|
| `/review-and-fix` | Reviews a branch, PR, or file, fixes the findings, and re-reviews until a deterministic CLI decides to stop. | All three |
| `review-until-lgtm` | Fixes the automated GitHub PR reviews in bounded batches until the current head gets an explicit LGTM; it merges only at your explicit request. | All three |
| `deep-review` | Runs one bounded review of a fixed base/head pair with independent reviewers and groups the verified findings by root cause. | All three |
| `ticket-to-pr` | Takes one ticket through acceptance criteria, a failing check, a design note, implementation, review, a passing check, and a pull request. | All three |
| `initiative-to-prs` | Turns a product brief, problem report, or set of incomplete tickets into implementation-ready tickets and drives each one to a verified PR. | All three |
| `ticket-writing` | Drafts or updates tickets in GitHub Issues, Jira, Notion, or another tracker so another agent can implement from them. | All three |
| `proposal-package-authoring` | Builds editable bid and proposal slide decks in Google Slides or PowerPoint from an RFP, source evidence, and reference decks. | All three |
| `/charter` | Stores the project goal and merged decisions and injects them into each new session. | All three |
| Session-state checkpoint | Saves per-session state from the transcript when a session stops and restores it on start, resume, or compaction. | Claude Code, Codex |
| `delegate-verbose-work` | Sends broad repository-wide searches to a subagent and keeps only the conclusion in the main conversation. | Claude Code |
| `coordinate-sessions` | Hands work to separate Claude Code sessions, watches their reports, and judges and merges their PRs when allowed. | Claude Code |
| `review-until-approve` | Reviews someone else's pull request in a loop and approves the reviewed head once a round is clean. | Claude Code, Codex |

## Review policy

Review blocks a pull request only for rollout blockers: serious bugs, security issues, and unmet acceptance criteria. Minor findings do not block. They are collected and triaged once, just before merge, and become tickets.

Concord does not try to prove a change free of defects, and it does not let review or test runs consume tokens without limit. Exhaustive static analysis and repeated full-diff review multiply cost for diminishing returns, and a loop of review and test runs that never ends spends tokens without moving the change forward. Review rounds have a budget, and the loop ends on a deterministic decision instead of running until no finding is left.

## Update

Claude Code:

```
/plugin marketplace update arinyaho-concord
/plugin install concord@arinyaho-concord
```

Installing, updating, and removing on Codex and GitHub Copilot, and what each package contains, are in [docs/install.md](docs/install.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
