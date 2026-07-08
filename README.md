# concord

Claude Code plugins for harness engineering - small fixes for recurring dysfunction in long Claude Code sessions. Personal tooling for the `~/.claude` workflow, not tied to any product codebase.

## Install

Add the marketplace, then install a plugin:

```
/plugin marketplace add arinyaho/concord
/plugin install concord@arinyaho-concord
```

Enabling a plugin registers its hooks automatically - no `settings.json` editing required.

## Plugins

- `concord` - a bundle of harness-engineering tools. Currently: a per-session state checkpoint (persists + re-injects session state so the model stops re-reading its own transcript), a cross-session task charter (north-star framing + merged decisions, so a fresh session inherits the founding task context), and a review-and-fix loop (`/review-until-green`) that keeps reviewing a code change, fixing what it finds, and re-checking until the tests pass - with the loop state saved so a fresh session picks up where the last one stopped instead of starting over. More capabilities to come.

## Track map

The plugins come from a diagnosis of recurring session dysfunction:

- Shell env re-export + `cd` tax -> ambient-env tooling (elsewhere).
- Memory / ledger / doc churn + self-transcript re-reads -> the `concord` plugin (session-state checkpoint).
- Monster resumed sessions (session hygiene).
- Edit round-trip waste (edit-before-read, string-not-found).
- Manual cross-session review<->fix ping-pong that ends on a weak "looks good" gate -> the `concord` plugin (`/review-until-green` review-and-fix loop).

Design notes and implementation plans for each fix are kept local, not in this repo.
