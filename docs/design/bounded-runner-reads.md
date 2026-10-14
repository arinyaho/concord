# Bounded runner reads of subagent-written artifacts

The runners read review artifacts that subagents write with `fs.readFileSync`, which has no size limit and blocks on a FIFO. A subagent that replaces its artifact with a FIFO or a very large file can stall or exhaust the runner before `review-cli` refuses the artifact (#339, source: item 1 of #304). The sites are `fixDeclaration` in `round-plan.js`, the verify branch of `services/agent-team/src/adapters/spawn_subagent.mjs`, and in `codex-review-runner.js` the `artifactList` reads (verify `examined`, declared fix files), the gate-panel lens read and the gate-panel vote verdict read.

## Decision

`bounded-artifact.js` gains `readArtifactJson(file)`, which reads through `readArtifactBytes` (regular file, no symlink, at most 20 MiB, same inode throughout) and parses the result. A missing artifact, a missing state directory and malformed JSON return `null`; an artifact that is not a bounded regular file throws `harness-failure: unsafe or oversized review artifact`. Every site above calls it, so the runners treat a hostile artifact exactly as `review-cli` does and end the round with a harness failure, while the lenient behaviors stay (an empty `examined` list, a panel lens that counts as no findings, a vote that counts as refuted).

The service adapter loads the helper through the `createRequire` path that loads `round-plan.js`. Its verify read falls back to an empty `examined` list on a missing or malformed artifact, as the packaged runner does.

This change is not stateful: it adds no state and only narrows what an existing read accepts.

## Cost and residual exposure

A subagent can still write a bounded regular file with hostile content; parsing and prompt-injection exposure are unchanged. The runners read these artifacts after the subagent exits, so a subagent that swaps the file between the size check and the read is caught only by the inode and size recheck inside `readArtifactBytes`.

`declaredFixFiles` reads the same fix artifact that `reportedNoEdit` has just read through `fixDeclaration`, so a hostile fix artifact is refused at the first read. The read in `declaredFixFiles` is bounded as well, but no runner-level test can reach it independently.
