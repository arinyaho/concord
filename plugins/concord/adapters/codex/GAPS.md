# Codex adapter — gaps and open questions

This records the real blockers and degradations the port-mapping design in `README.md` surfaced. Nothing here is implemented; this is the risk register for the next deliverable.

## Hard blocker: no native parallel clean-context subagent

Codex CLI exposes no primitive equivalent to Claude Code's `Task` tool — no in-session spawn of a parallel, clean-context subagent that returns a result to the caller. `codex exec "<prompt>"` is the closest analogue, but it is a single-shot subprocess invocation: it runs a prompt to completion in its own process and exits, not a spawn call the parent session can fan out and collect results from in-process.

Concord's review loop (`core/review-driver.md`) fans out in several places that assume exactly that primitive:

- The 5-lens holistic broad-review panel (`ac-coverage`, `design-conformance`, `cross-context`, `silent-gap`, `threat-model`) — 5 subagents spawned in parallel per panel round.
- The 3-way adversarial verify per candidate finding — 3 independent subagents spawned in parallel, majority vote.
- The correctness / verify / intent / gate-review / gate-verify subagents — some sequential (verify depends on correctness's output file; gate-verify depends on gate-review's), some independently parallel (intent alongside the correctness → verify pair).

On Codex CLI this degrades to one of two strategies, and neither is free:

- **Serial `codex exec` calls.** Run each subagent's prompt as its own `codex exec` invocation, one after another. Preserves the "wait for the file" dependency ordering the driver prose already requires for the sequential pairs, but a genuinely parallel step (5 lenses, 3-way verify) now runs at N× the wall-clock instead of running concurrently.
- **OS-level process-parallel `codex exec` runs.** Launch multiple `codex exec` subprocesses concurrently (e.g. backgrounded shell processes) and collect each one's output artifact on exit. Recovers the wall-clock parallelism but is heavier (N concurrent Codex processes instead of N `Task`-tool spawns inside one session) and gives up whatever shared session context or resource pooling the harness would otherwise provide — each subprocess is a fully independent Codex run with no shared state beyond the files on disk.

The `reviewer` port's spawn-include (see `README.md`) is where this policy would be chosen and encoded — analogous to how `adapters/claude-code/spawn-include.md` encodes "spawn via the `Task` tool, clean context, parallel tool calls in one message run concurrently" today. Whichever strategy (or hybrid — serial for small fan-outs, process-parallel for the 5-lens panel) is picked belongs in that include, not in `core/review-driver.md`, so the neutral driver prose stays unaware of the tradeoff.

## Open: install-model choice

Two ways to install Concord against Codex, and the choice is still open:

- **(i) Codex-CLI-native plugin under `~/.codex`.** Codex itself is the harness — Codex loads Concord's packaging directly, runs the lifecycle hooks, executes the command/prompt equivalents, and (per the blocker above) is the process spawning its own `codex exec` fan-out. This is true vendor-agnosticism: the same `core/` logic runs under a harness that isn't Claude Code at all.
- **(ii) A Claude Code plugin that shells out to Codex.** Claude Code stays the harness; it invokes `codex exec` as a subprocess the way it might invoke any other CLI tool. This does not make Concord vendor-agnostic — it is cross-engine dispatch from within a Claude-Code-hosted session, not a second harness Concord runs under.

Note that the existing `openai-codex` plugin in this ecosystem is pattern (ii): a Claude Code plugin that calls out to Codex. The port design in `docs/superpowers/specs/2026-07-16-vendor-agnostic-harness-adapter-design.md` and the mapping in `README.md` are designed toward (i) — the `ports.js` contract and the adapter/packaging split only pay off as genuine multi-harness support if Codex ends up being the harness, not a tool Claude Code calls.

This choice needs to be made before the real Codex adapter (as opposed to this stub) is implemented, since it determines whether `packaging/codex/` targets a `~/.codex` manifest or a Claude Code command that shells out.

## This is a stub, not an implementation

Everything in `README.md` is a documented mapping, not code. No `adapters/codex/*.js`, no `packaging/codex/`, no Codex-side tests, no Codex spawn-include exist yet. The next deliverable is implementing this adapter: writing the actual port implementations, resolving the install-model choice above, and choosing (and encoding, in the spawn-include) a fan-out degradation strategy for the `reviewer` port.
