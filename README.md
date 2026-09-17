# concord

Harness-engineering plugins for the **Claude Code** and **Codex** CLIs - small fixes for recurring dysfunction in long agent sessions. Personal tooling, not tied to any product codebase. The same vendor-neutral review-and-fix loop runs on both harnesses.

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

Run those commands in a shell, then start or restart Codex. Use `ticket-writing` and `ticket-to-pr` in a Codex conversation; they are skills, not shell commands.

The Codex plugin ships the session-state checkpoint, `/charter`, `/review-until-green`, provider-neutral `ticket-writing`, and `ticket-to-pr`. Reviewers and fixers run as `codex exec` subprocesses.

`review-until-green` probes the Codex executable with `--version` before it starts a review and uses that exact executable for every `codex exec` subprocess. It normally selects `codex` from `PATH`. On macOS, if that candidate cannot be launched successfully, it automatically checks the trusted CLI bundled at `/Applications/ChatGPT.app/Contents/Resources/codex`; macOS users do not need to configure anything or alter Gatekeeper, quarantine attributes, or other system security settings.

For troubleshooting or a custom Codex installation, an explicit override is available:

```sh
CONCORD_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
  node plugins/concord-codex/bin/review-until-green.js <target>
```

`CONCORD_CODEX_BIN` is optional and authoritative: if it is set and its `--version` probe fails, the review stops with a diagnostic instead of silently trying another binary.

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

## Plugins

- `concord` (Claude Code) - a per-session state checkpoint, cross-session task charter, `/review-until-green`, `ticket-to-pr`, provider-neutral `ticket-writing`, and a cross-model skill that lets Codex perform review passes while Claude drives and fixes.
- `concord-codex` (Codex) - the same state checkpoint, charter, review loop, `ticket-writing`, and `ticket-to-pr`, packaged natively for Codex. It reuses the vendor-neutral core and shared skills verbatim; reviewers and fixers run as `codex exec` subprocesses.

## Track map

The plugins come from a diagnosis of recurring session dysfunction:

- Shell env re-export + `cd` tax -> ambient-env tooling (elsewhere).
- Memory / ledger / doc churn + self-transcript re-reads -> the `concord` plugin (session-state checkpoint).
- Monster resumed sessions (session hygiene).
- Edit round-trip waste (edit-before-read, string-not-found).
- Manual cross-session review<->fix ping-pong that ends on a weak "looks good" gate -> the `concord` plugin (`/review-until-green` review-and-fix loop).
- Tickets that leave the next agent guessing about product intent, design constraints, or proof -> the shared `ticket-writing` skill.
- Multi-stage ticket work that skips reproducible red/green evidence or opens a PR with unfinished gates -> the shared `ticket-to-pr` skill.

Design notes and implementation plans for each fix are kept in Notion, not in this repo.
