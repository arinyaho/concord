# concord

Harness-engineering design docs and agreements.

This repo is the home for the "D-track": a diagnosis of recurring dysfunction in
long Claude Code sessions (session-corpus mining) and the fix for each finding.
It is personal tooling for the `~/.claude` workflow and is not tied to any
product codebase.

## Layout

- `harness-engineering/specs/` - design specs, one per fix (dated).

## Track map

- D1 - shell env re-export tax + `cd` tax -> ambient-env tooling.
- D2 - memory / ledger / doc churn + self-transcript re-reads. <- current
- D3 - monster resumed sessions (session hygiene).
- D4 - Edit round-trip waste (edit-before-read, string-not-found).

Each spec states the problem, the enforcement or need-removal fix (behavioral
rules are treated as unreliable), and the honest scope boundary.
