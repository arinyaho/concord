# Install, update and remove

The Claude Code steps are in the [README](../README.md). This page covers Codex and GitHub Copilot.

## Codex

Install:

```
codex plugin marketplace add arinyaho/concord --ref main --sparse .agents/plugins --sparse plugins/concord-codex
codex plugin add concord@arinyaho-concord
```

Run those commands in a shell, then start or restart Codex. Use `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, `proposal-package-authoring`, and `review-until-lgtm` in a Codex conversation; they are skills, not shell commands.

The Codex plugin ships the session-state checkpoint, `/charter`, `/review-and-fix`, `review-until-lgtm`, `review-until-approve`, `deep-review`, provider-neutral `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `/review-until-green` remains a compatibility alias. Reviewers and fixers run as `codex exec` subprocesses.

Update:

```
codex plugin marketplace upgrade arinyaho-concord
codex plugin add concord@arinyaho-concord
```

Remove:

```
codex plugin remove concord@arinyaho-concord
codex plugin marketplace remove arinyaho-concord
```

Back up any persistent Concord state (session checkpoints, charter, review ledgers) before removal if it must be retained.

## GitHub Copilot

Install:

```sh
copilot plugin marketplace add arinyaho/concord
copilot plugin install concord@arinyaho-concord
```

Restart VS Code after installation. The Copilot package provides charter persistence, native clean-context reviewer and fixer agents, `review-and-fix`, `review-until-lgtm`, `deep-review`, `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. `review-until-green` remains a compatibility alias.

VS Code Preview hooks are required for automatic charter injection and `/charter set` persistence. An organization policy can disable hooks; in that degraded mode the packaged skills and agents remain discoverable, but charter hook behavior is unavailable and must not be treated as persisted. `/charter` persists only the text passed to `/charter set`. Copilot's transcript format is not a stable hook API, so automatic transcript-derived checkpoints are unavailable.

Copilot state defaults to `~/.copilot/concord`, isolated by a SHA-256 hash of the canonical project root. Set `CONCORD_COPILOT_HOME` to keep it elsewhere. Uninstall behavior can remove plugin-managed data, so back up this directory before uninstalling when the charter or review ledgers must be retained.

Update:

```sh
copilot plugin update concord@arinyaho-concord
```

Remove:

```sh
copilot plugin uninstall concord@arinyaho-concord
copilot plugin marketplace remove arinyaho-concord
```

Back up `CONCORD_COPILOT_HOME` or `~/.copilot/concord` first when persistent Concord state must survive removal.
