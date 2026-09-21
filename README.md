# concord

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
codex plugin marketplace add arinyaho/concord
codex plugin add concord-codex@arinyaho-concord
```

Run those commands in a shell, then start or restart Codex. Use `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, `proposal-package-authoring`, and `review-until-lgtm` in a Codex conversation; they are skills, not shell commands.

The Codex plugin ships the session-state checkpoint, `/charter`, `/review-until-green`, `review-until-lgtm`, provider-neutral `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`. Reviewers and fixers run as `codex exec` subprocesses.

### GitHub Copilot

```sh
copilot plugin marketplace add arinyaho/concord
copilot plugin install concord-copilot@arinyaho-concord
```

Restart VS Code after installation. The Copilot package provides charter persistence, native clean-context reviewer and fixer agents, `review-until-green`, cross-model review through Copilot-hosted models, `review-until-lgtm`, `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring` without requiring the Claude or Codex CLI.

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
codex plugin add concord-codex@arinyaho-concord
```

### GitHub Copilot

```sh
copilot plugin update concord-copilot@arinyaho-concord
```

## Remove

```sh
copilot plugin uninstall concord-copilot@arinyaho-concord
copilot plugin marketplace remove arinyaho-concord
```

Back up `CONCORD_COPILOT_HOME` or `~/.copilot/concord` first when persistent Concord state must survive removal.

## Plugins

- `concord` (Claude Code) - a per-session state checkpoint, cross-session task charter, `/review-until-green`, `review-until-lgtm`, `initiative-to-prs`, `ticket-to-pr`, provider-neutral `ticket-writing`, `proposal-package-authoring`, and a cross-model skill that lets Codex perform review passes while Claude drives and fixes.
- `concord-codex` (Codex) - the same state checkpoint, charter, review loop, `review-until-lgtm`, `initiative-to-prs`, `ticket-writing`, `ticket-to-pr`, and `proposal-package-authoring`, packaged natively for Codex. It reuses the vendor-neutral core and shared skills verbatim; reviewers and fixers run as `codex exec` subprocesses.
- `concord-copilot` (GitHub Copilot) - explicit project charter persistence, the shared workflow set, and Copilot-native clean-context review and fix agents. It deliberately omits transcript-derived checkpoints and uses only documented hook fields.

## Track map

The plugins come from a diagnosis of recurring session dysfunction:

- Shell env re-export + `cd` tax -> ambient-env tooling (elsewhere).
- Memory / ledger / doc churn + self-transcript re-reads -> the `concord` plugin (session-state checkpoint).
- Monster resumed sessions (session hygiene).
- Edit round-trip waste (edit-before-read, string-not-found).
- Manual cross-session review<->fix ping-pong that ends on a weak "looks good" gate -> the `concord` plugin (`/review-until-green` review-and-fix loop).
- Tickets that leave the next agent guessing about product intent, design constraints, or proof -> the shared `ticket-writing` skill.
- Multi-stage ticket work that skips reproducible red/green evidence or opens a PR with unfinished gates -> the shared `ticket-to-pr` skill.
- Initiatives that need evidence, product decisions, an implementation-ready ticket set, model-routed execution, and verified PRs -> the shared `initiative-to-prs` skill.
- Proposal decks that lose requirement traceability, editability, visual consistency, or export safety -> the shared `proposal-package-authoring` skill.

Design notes and implementation plans for each fix are kept in Notion, not in this repo.
