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

The Codex plugin ships `/review-until-green`; reviewers run as `codex exec` subprocesses. (Session-state and charter are Claude-Code-only for now.)

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

- `concord` (Claude Code) - a bundle of harness-engineering tools. Currently: a per-session state checkpoint (persists + re-injects session state so the model stops re-reading its own transcript), a cross-session task charter (north-star framing + merged decisions, so a fresh session inherits the founding task context), and a review-and-fix loop (`/review-until-green`) that keeps reviewing a code change, fixing what it finds, and re-checking until the tests pass - with the loop state saved so a fresh session picks up where the last one stopped instead of starting over. More capabilities to come.
- `concord-codex` (Codex) - the same `/review-until-green` review-and-fix loop, running natively under the Codex CLI. Reuses the vendor-neutral core verbatim (a self-contained vendored copy lives in the plugin); reviewers and fixers run as `codex exec` subprocesses.

## Track map

The plugins come from a diagnosis of recurring session dysfunction:

- Shell env re-export + `cd` tax -> ambient-env tooling (elsewhere).
- Memory / ledger / doc churn + self-transcript re-reads -> the `concord` plugin (session-state checkpoint).
- Monster resumed sessions (session hygiene).
- Edit round-trip waste (edit-before-read, string-not-found).
- Manual cross-session review<->fix ping-pong that ends on a weak "looks good" gate -> the `concord` plugin (`/review-until-green` review-and-fix loop).

Design notes and implementation plans for each fix are kept in Notion, not in this repo.
