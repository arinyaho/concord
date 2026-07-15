# B-1 SDK behavior spike findings

Probe: `scratch/b1-sdk-spike.mjs` (throwaway, removed after recording). Live Max OAuth, network.
SDK `@anthropic-ai/claude-agent-sdk@0.3.205`, on `Jungjoos-Mac-mini.local` (the daemon host).

## Observed (verbatim)

```
ABORT: ended=threw: Error after 2208ms (honored if << a full completion)
BAD_RESUME: threw: Error: Claude Code returned an error result: Error: --resume requires a valid session I
```

## Decisions for the runRole contract (Task 6)

- **Abort: HONORED.** Aborting the `AbortController` ~200ms into a long-essay query terminated
  the stream at ~2.2s (well short of a full single-turn completion), surfacing as a thrown
  `Error` (not a clean stream end, and not the name `AbortError`). Contract: `runRole` sets
  `options.abortController` and a per-turn wall-clock timeout calls `.abort()`; the caller treats
  a hung role as cancelled, not abandoned. NOTE: because abort manifests as a THROW, a running
  query's cancellation and a genuine SDK error are indistinguishable by exception type at this
  layer -- both flow through the same catch. This is acceptable for B-1 (abort only fires on a
  timeout hang; the turn engine posts an error notice and continues either way).

- **Bad resume: THROWS (not silent-fresh).** Resuming a bogus session id throws
  `--resume requires a valid session Id`; it does NOT silently start a fresh session. Contract:
  `runRole` wraps the resume attempt in try/catch; on throw WITH a `resumeId` it retries once
  WITHOUT `resume` and sets `reset: true`. The secondary silent-fresh guard
  (`out.sessionId !== resumeId`) is kept as belt-and-suspenders but is inert on this SDK version.

Both outcomes match the Task 6 plan defaults (abort honored, bad-resume throws), so the
`roles.mjs` code in the plan stands unchanged.
