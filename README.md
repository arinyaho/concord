# concord

[![pull-request](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml/badge.svg)](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml)
[![License: MIT](https://img.shields.io/github/license/arinyaho/concord)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757)
![Codex](https://img.shields.io/badge/Codex-supported-black)
![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-supported-1F6FEB)

An agent workflow plugin for **Claude Code**, **Codex**, and **GitHub Copilot** that adds AI code review and fix loops, ticket-to-pull-request pipelines, and project context that carries across sessions.

| Workflow | What it does | Harnesses |
|---|---|---|
| `/review-and-fix` | Reviews a branch, PR, or file, fixes the findings, and re-reviews until a deterministic CLI decides to stop. Reviewer and fixer can each be Claude, Codex, or Copilot, with their own models. | All three |
| `review-until-lgtm` | Collects automated GitHub PR reviews (for example from Codex or Copilot), fixes them in bounded batches, and pushes until the current head gets an explicit LGTM. It merges only at the user's explicit request, and only when `merge-ready` finds the live head's checks green, every configured reviewer's LGTM fresh, and a mergeable delivery record. | All three |
| `deep-review` | Runs one bounded review of a fixed base/head pair with independent reviewers, verifies the pooled findings, and groups them by root cause. | All three |
| `ticket-to-pr` | Takes one ticket through acceptance criteria, a failing check, a design note, implementation, review, a passing check, and a pull request. | All three |
| `initiative-to-prs` | Turns a product brief, problem report, or set of incomplete tickets into implementation-ready tickets and drives each one to a verified PR. | All three |
| `ticket-writing` | Drafts or updates tickets in GitHub Issues, Jira, Notion, or another tracker so another agent can implement from them. | All three |
| `proposal-package-authoring` | Builds editable bid and proposal slide decks in Google Slides or PowerPoint from an RFP, source evidence, and reference decks. | All three |
| `/charter` | Stores the project goal and merged decisions and injects them into each new session. On Copilot it persists only the text passed to `/charter set`, and it needs VS Code Preview hooks. | All three |
| Session-state checkpoint | Saves per-session state from the transcript when a session stops and restores it on start, resume, or compaction. | Claude Code, Codex |
| `delegate-verbose-work` | Sends broad repository-wide searches to a subagent and keeps only the conclusion in the main conversation. | Claude Code |

A personal, vendor-neutral project: one core runs on all three harnesses, and it is not tied to any product codebase.

## Review policy

Review blocks a pull request only for rollout blockers: serious bugs, security issues, and unmet acceptance criteria. Minor findings do not block. They are collected and triaged once, just before merge, and become tickets.

Concord does not try to prove a change free of defects, and it does not let review or test runs consume tokens without limit. Exhaustive static analysis and repeated full-diff review multiply cost for diminishing returns, and a loop of review and test runs that never ends spends tokens without moving the change forward. Review rounds have a budget, and the loop ends on a deterministic decision instead of running until no finding is left.

## Install

### Claude Code

```
/plugin marketplace add arinyaho/concord
/plugin install concord@arinyaho-concord
```

Enabling the plugin registers its hooks automatically - no `settings.json` editing required.

### Codex

```
codex plugin marketplace add arinyaho/concord --ref main --sparse .agents/plugins --sparse plugins/concord-codex
codex plugin add concord@arinyaho-concord
```

Run those commands in a shell, then start or restart Codex. Use `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, `proposal-package-authoring`, and `review-until-lgtm` in a Codex conversation; they are skills, not shell commands.

The Codex plugin ships the session-state checkpoint, `/charter`, `/review-and-fix`, `review-until-lgtm`, `deep-review`, provider-neutral `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `/review-until-green` remains a compatibility alias. Reviewers and fixers run as `codex exec` subprocesses.

### GitHub Copilot

```sh
copilot plugin marketplace add arinyaho/concord
copilot plugin install concord@arinyaho-concord
```

Restart VS Code after installation. The Copilot package provides charter persistence, native clean-context reviewer and fixer agents, `review-and-fix`, `review-until-lgtm`, `deep-review`, `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `review-until-green` remains a compatibility alias.

VS Code Preview hooks are required for automatic charter injection and `/charter set` persistence. An organization policy can disable hooks; in that degraded mode the packaged skills and agents remain discoverable, but charter hook behavior is unavailable and must not be treated as persisted. Copilot's transcript format is not a stable hook API, so automatic transcript-derived checkpoints are unavailable.

Copilot state defaults to `~/.copilot/concord`, isolated by a SHA-256 hash of the canonical project root. Set `CONCORD_COPILOT_HOME` to keep it elsewhere. Uninstall behavior can remove plugin-managed data, so back up this directory before uninstalling when the charter or review ledgers must be retained.

## Update

### Claude Code

```
/plugin marketplace update arinyaho-concord
/plugin install concord@arinyaho-concord
```

### Codex

```
codex plugin marketplace upgrade arinyaho-concord
codex plugin add concord@arinyaho-concord
```

### GitHub Copilot

```sh
copilot plugin update concord@arinyaho-concord
```

## Remove

```sh
copilot plugin uninstall concord@arinyaho-concord
copilot plugin marketplace remove arinyaho-concord
```

Back up `CONCORD_COPILOT_HOME` or `~/.copilot/concord` first when persistent Concord state must survive removal.

## What it does

- A per-session state checkpoint and a cross-session task charter (`/charter`).
- `review-and-fix`: reviews a branch or PR, fixes what the review finds, and re-checks until a deterministic CLI reaches a terminal decision. `review-until-green` is a compatibility alias.
- `review-until-lgtm`, `deep-review`, `initiative-to-prs`, `ticket-to-pr`, `ticket-writing`, `proposal-package-authoring`, and `delegate-verbose-work`.

The Harnesses column above shows where each workflow ships; the install sections list what each package contains.

`review-and-fix` accepts independent `--reviewer`, `--reviewer-model`, `--fixer`, and `--fixer-model` selections. Each role may use `claude`, `codex`, or `copilot`; the active host uses its native clean-context subagent when available and otherwise invokes the selected provider's CLI. Requested models are never silently replaced.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
