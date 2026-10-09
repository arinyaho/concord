# Session handoff in ticket-to-pr

A session that carries one PR into the next pays for the first PR's transcript on every later request, and the agent's view of the repository drifts from `main`'s current skills and CLIs. The "Session handoff" section of the `ticket-to-pr` skill therefore ends a standalone run's session at a fixed boundary and moves only a compact packet into the next session. The skill text is the authoritative statement; this note explains why it has that shape.

## Decision

A standalone run ends its session at the PR delivery boundary, which is the delivery disposition recorded for the exact PR head, or earlier at a soft or hard limit. At the soft limit, 128,000 tokens of observed input context or 50 tool calls, the session finishes the stage in progress, starts no new stage, and writes the packet. At the hard limit, 200,000 tokens or 100 tool calls, it stops at the next safe step and writes the packet. The soft limits are the initial triggers of the `initiative-to-prs` session handoff, so one run and an initiative measure a session the same way; the hard limits apply to the standalone run only. All values are defined in `core/session-handoff.js` (`THRESHOLDS`, `HARD_LIMITS`) and a skill-content test checks that the skill and this note state them. The packet records which limit triggered it. The agent writes the packet, returns its path, and stops; the skill instructs the stop, and the CLI does not terminate the session.

The packet holds the ticket, the PR, the exact head and base, the delivery record, open follow-ups, decisions made, and what the next PR needs. A handoff before delivery also records the active stage and the last completed stage, the gate evidence so far (red and green commands with their results, and each review verdict with the revision pair it covers), the artifact paths (branch, worktree, design note, plan), and the exact next action, and states each field that does not exist yet, such as the PR or the delivery record, as absent; the next session resumes at that action and does not repeat a stage exit the packet records as passed. These fields follow the review boundary execution packet of the `initiative-to-prs` handoff contract, because the ticket and the live PR do not record local red and green runs or which stage exit already passed. It has no fixed location, because the initiative handoff contract defines none for a standalone run; the agent writes it where the next session is told to read it. The next session starts from the packet and from `main`'s skills and CLIs, never from the previous transcript. The packet is data an agent wrote, so the next session reads the current PR and ticket state again before acting. A context replacement never resets a review ledger or a budget.

When `initiative-to-prs` composes the run, its own session handoff policy and checkpoints govern, and this rule does not apply.

## Why two limits

Stopping at a single 50-call limit left reviews half done in two sessions (#267, #270), and the handoff cost a new session. A measurement of 12 merged PRs found no rise of Codex P1 or P2 counts with the context size at the first implementation commit (Spearman 0.06 and -0.16), while sessions that stopped above 230,000 tokens read 19 to 29 million cache tokens against 4 to 9 million below 195,000. The sample is small, so the soft limit is a cost limit that waits for a stage boundary, and only the hard limit interrupts a stage.

## Trade-off

The next session reads the ticket and the PR once more, a cost paid once per handoff in exchange for requests that no longer carry the earlier transcript.

## Residual exposure

A session that cannot read its own context size relies on the tool-call counts alone, so a few large tool results can carry it past 128,000 tokens, or past 200,000, before a limit triggers. A stage that runs long can take a session well past the soft limit before it ends.

A packet that omits a decision loses it; the next session's reread of the PR and ticket recovers what those record, and nothing else.
