# review-until-lgtm design

## Decision

Add a shared `review-until-lgtm` skill rather than a new review engine. The GitHub Codex reaction and review-thread state live on GitHub, so a skill can inspect the source of truth with the existing GitHub CLI without persisting a second state machine.

## Contract

The skill records the exact PR head SHA, the latest GitHub Codex review bound to that SHA regardless of its state, unresolved threads authored by that same bot, and the configured LGTM reaction from that bot on that review's summary. A run is green only when all of those observations match the current head. It waits through the bounded reaction window after a matching review completes, then reports a completed review with no open threads but no LGTM reaction as `completed-without-lgtm`, which is not green.

Stale reviews are ignored. The skill persists the one allowed retry in a durable PR marker for the current head, then stops and reports the external outcome. It never edits source, fabricates an LGTM, or posts repeated requests while monitoring.

## Plan

1. Add identical Claude and Codex skill instructions that make the GitHub observations and bounded retry policy explicit; verify their byte-for-byte parity with a Node test.
2. Advertise the shared skill in the package metadata and install guidance; run the focused Node test against the source packages.
3. Review the branch, create one PR, and link the Notion ticket before moving it to `In review`.

## Residual exposure

GitHub Codex may still complete without adding a reaction. Treating that as a named non-green outcome preserves the signal, but cannot force the external bot to emit its reaction.
