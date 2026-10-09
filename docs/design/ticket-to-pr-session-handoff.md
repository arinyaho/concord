# Session handoff in ticket-to-pr

A session that carries one PR into the next pays for the first PR's transcript on every later request, and the agent's view of the repository drifts from `main`'s current skills and CLIs. The "Session handoff" section of the `ticket-to-pr` skill therefore ends a standalone run's session at a fixed boundary and moves only a compact packet into the next session. The skill text is the authoritative statement; this note explains why it has that shape.

## Decision

A standalone run ends its session at the PR delivery boundary, which is the delivery disposition recorded for the exact PR head, or earlier when observed input context passes 128,000 tokens or the session passes 50 tool calls, whichever comes first. The thresholds are the initial triggers of the `initiative-to-prs` session handoff, so one run and an initiative measure a session the same way. The agent writes the packet, returns its path, and stops; the skill instructs the stop, and the CLI does not terminate the session.

The packet holds the ticket, the PR, the exact head and base, the delivery record, open follow-ups, decisions made, and what the next PR needs. It has no fixed location, because the initiative handoff contract defines none for a standalone run; the agent writes it where the next session is told to read it. The next session starts from the packet and from `main`'s skills and CLIs, never from the previous transcript. The packet is data an agent wrote, so the next session reads the current PR and ticket state again before acting. A context replacement never resets a review ledger or a budget.

When `initiative-to-prs` composes the run, its own session handoff policy and checkpoints govern, and this rule does not apply.

## Trade-off

The next session reads the ticket and the PR once more, a cost paid once per handoff in exchange for requests that no longer carry the earlier transcript.

## Residual exposure

A session that cannot read its own context size relies on the tool-call count alone, so a few large tool results can carry it past 128,000 tokens before the handoff triggers.

A packet that omits a decision loses it; the next session's reread of the PR and ticket recovers what those record, and nothing else.
