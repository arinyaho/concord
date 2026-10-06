# concord

[![pull-request](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml/badge.svg)](https://github.com/arinyaho/concord/actions/workflows/pull-request.yml)
[![License: MIT](https://img.shields.io/github/license/arinyaho/concord)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757)
![Codex](https://img.shields.io/badge/Codex-supported-black)
![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-supported-1F6FEB)

Harness-engineering plugins for **Claude Code**, **Codex**, and **GitHub Copilot** - small fixes for recurring dysfunction in long agent sessions. Personal tooling, not tied to any product codebase. The same vendor-neutral review-and-fix core runs on all three harnesses.

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

The Codex plugin ships the session-state checkpoint, `/charter`, `/review-and-fix`, `review-until-lgtm`, provider-neutral `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `/review-until-green` remains a compatibility alias. Reviewers and fixers run as `codex exec` subprocesses.

### GitHub Copilot

```sh
copilot plugin marketplace add arinyaho/concord
copilot plugin install concord@arinyaho-concord
```

Restart VS Code after installation. The Copilot package provides charter persistence, native clean-context reviewer and fixer agents, `review-and-fix`, `review-until-lgtm`, `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `review-until-green` remains a compatibility alias.

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

Not every workflow ships on every harness; the install sections above list what each package provides.

`review-and-fix` accepts independent `--reviewer`, `--reviewer-model`, `--fixer`, and `--fixer-model` selections. Each role may use `claude`, `codex`, or `copilot`; the active host uses its native clean-context subagent when available and otherwise invokes the selected provider's CLI. Requested models are never silently replaced.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
