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

The Codex plugin ships the session-state checkpoint, `/charter`, `/review-until-green`, and provider-neutral `ticket-writing`. Reviewers run as `codex exec` subprocesses.

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
- `concord-codex` (Codex) - the same state checkpoint, charter, review loop, and `ticket-writing`, packaged natively for Codex. It reuses the vendor-neutral core verbatim; reviewers and fixers run as `codex exec` subprocesses.

## Track map

The plugins come from a diagnosis of recurring session dysfunction:

- Shell env re-export + `cd` tax -> ambient-env tooling (elsewhere).
- Memory / ledger / doc churn + self-transcript re-reads -> the `concord` plugin (session-state checkpoint).
- Monster resumed sessions (session hygiene).
- Edit round-trip waste (edit-before-read, string-not-found).
- Manual cross-session review<->fix ping-pong that ends on a weak "looks good" gate -> the `concord` plugin (`/review-until-green` review-and-fix loop).
- Tickets that leave the next agent guessing about product intent, design constraints, or proof -> the shared `ticket-writing` skill.

Design notes and implementation plans for each fix are kept in Notion, not in this repo.
