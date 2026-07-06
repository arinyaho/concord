# concord

Claude Code plugins for harness engineering - small fixes for recurring dysfunction in long Claude Code sessions. Personal tooling for the `~/.claude` workflow, not tied to any product codebase.

## Install

Add the marketplace, then install a plugin:

```
/plugin marketplace add arinyaho/concord
/plugin install session-state@arinyaho-concord
```

Enabling a plugin registers its hooks automatically - no `settings.json` editing required.

## Plugins

- `session-state` - persists a compact per-session state file from the transcript and re-injects it on resume, compaction, or a fresh session, so the model stops re-reading its own transcript to recover.

## Track map

The plugins come from a diagnosis of recurring session dysfunction (the "D-track"):

- D1 - shell env re-export + `cd` tax -> ambient-env tooling (elsewhere).
- D2 - memory / ledger / doc churn + self-transcript re-reads -> `session-state`.
- D3 - monster resumed sessions (session hygiene).
- D4 - Edit round-trip waste (edit-before-read, string-not-found).

Design notes and implementation plans for each fix are kept local, not in this repo.
