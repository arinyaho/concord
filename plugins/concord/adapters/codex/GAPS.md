# Codex adapter — gaps and open questions

This records the real blockers and degradations the port-mapping design in `README.md` surfaced. The `command`, `reviewer`, and `statedir` ports are now implemented (see `README.md`); this file tracks what's still open plus the remaining known trade-offs the implementation carries forward.

## Hard blocker: no native parallel clean-context subagent

Codex CLI exposes no primitive equivalent to Claude Code's `Task` tool — no in-session spawn of a parallel, clean-context subagent that returns a result to the caller. `codex exec "<prompt>"` is the closest analogue, but it is a single-shot subprocess invocation: it runs a prompt to completion in its own process and exits, not a spawn call the parent session can fan out and collect results from in-process.

Concord's review loop (`core/review-driver.md`) fans out in several places that assume exactly that primitive:

- The 5-lens holistic broad-review panel (`ac-coverage`, `design-conformance`, `cross-context`, `silent-gap`, `threat-model`) — 5 subagents spawned in parallel per panel round.
- The 3-way adversarial verify per candidate finding — 3 independent subagents spawned in parallel, majority vote.
- The correctness / verify / intent / gate-review / gate-verify subagents — some sequential (verify depends on correctness's output file; gate-verify depends on gate-review's), some independently parallel (intent alongside the correctness → verify pair).

On Codex CLI this could degrade to one of two strategies, and neither is free:

- **Serial `codex exec` calls.** Run each subagent's prompt as its own `codex exec` invocation, one after another. Preserves the "wait for the file" dependency ordering the driver prose already requires for the sequential pairs, but a genuinely parallel step (5 lenses, 3-way verify) now runs at N× the wall-clock instead of running concurrently.
- **OS-level process-parallel `codex exec` runs.** Launch multiple `codex exec` subprocesses concurrently (e.g. backgrounded shell processes) and collect each one's output artifact on exit. Recovers the wall-clock parallelism but is heavier (N concurrent Codex processes instead of N `Task`-tool spawns inside one session) and gives up whatever shared session context or resource pooling the harness would otherwise provide — each subprocess is a fully independent Codex run with no shared state beyond the files on disk.

### RESOLVED: fan-out strategy

OS-level process-parallel `codex exec` was chosen and is what's implemented. Reviewer subagents (the 5-lens holistic panel, the 3-way adversarial verify, and the other review/verify/gate subagents the driver calls for in parallel) are launched as concurrent backgrounded `codex exec` subprocesses, each writing its own JSON artifact to the state directory; the main session collects results by reading those artifacts once the processes exit. This is encoded in `adapters/codex/spawn-include.md`, analogous to how `adapters/claude-code/spawn-include.md` encodes the `Task`-tool strategy for Claude Code — `core/review-driver.md` itself stays unaware of the tradeoff. The fix subagent (`review-cli.js plan-fixes` step) is the one exception carved out of this strategy: it runs via `codex exec --cd <repoRoot> --sandbox workspace-write --add-dir <stateDir> --skip-git-repo-check "<prompt>"` strictly one-at-a-time, never backgrounded or parallel, because it edits arbitrary files in the working tree rather than writing a single JSON artifact, and two concurrent fixes could race on the same file. `--add-dir <stateDir>` is required here too, since the fix subagent's own JSON artifact still lands in the state directory under `~/.codex`, outside the `--cd <repoRoot>` sandbox grant.

### RESOLVED: install-model choice

Two ways to install Concord against Codex were on the table:

- **(i) Codex-CLI-native plugin under `~/.codex`.** Codex itself is the harness — Codex loads Concord's packaging directly, runs the lifecycle hooks, executes the command/prompt equivalents, and (per the blocker above) is the process spawning its own `codex exec` fan-out. This is true vendor-agnosticism: the same `core/` logic runs under a harness that isn't Claude Code at all.
- **(ii) A Claude Code plugin that shells out to Codex.** Claude Code stays the harness; it invokes `codex exec` as a subprocess the way it might invoke any other CLI tool. This does not make Concord vendor-agnostic — it is cross-engine dispatch from within a Claude-Code-hosted session, not a second harness Concord runs under.

Option (i) was chosen: `plugins/concord-codex/` is a native flat Codex plugin (`.codex-plugin/plugin.json` manifest, `commands/review-until-green.md`, `bin/review-cli.js` shim) that Codex CLI loads directly as its own harness, not a Claude Code plugin dispatching to Codex. Note that the existing `openai-codex` plugin in this ecosystem is pattern (ii); `plugins/concord-codex/` is a different, new package that follows pattern (i) instead.

## Remaining known trade-offs

These are accepted costs of the resolved strategies above, not open questions:

- **`codex exec` fan-out cost.** A broad review round launches roughly 15-20 concurrent `codex exec` processes (5-lens panel plus 3-way adversarial verify per candidate finding, times however many findings surface that round). Each is a fully independent Codex process with its own startup and model-call cost — there is no shared session context or resource pooling across them, unlike `Task`-tool spawns inside one Claude Code session.
- **`--sandbox workspace-write` requirement for the fix subagent.** The fix subagent must run with `--sandbox workspace-write` to edit the working tree; if the invoking Codex session's own sandbox policy is more restrictive, the fix subagent's spawn needs to explicitly widen it, which is itself a trust boundary worth revisiting later.
- **Trust-check hang risk.** An unattended `codex exec` against a repo that isn't yet in Codex's trust table (`~/.codex/config.toml`'s `[projects."..."]` table) hits the trusted-directory prompt and, since there is no TTY to answer it, hangs indefinitely reading stdin — a real risk for automation, not a self-registration non-issue. `--skip-git-repo-check` bypasses the prompt and is now included in every `codex exec` invocation in `spawn-include.md`. Empirically confirmed by a real run: without the flag, `codex exec` against an untrusted repo printed `Not inside a trusted directory and --skip-git-repo-check was not specified.` and hung until killed manually (`docs/superpowers/specs/2026-07-16-codex-e2e-note.md`).
- **UNCONFIRMED: plugin-relative `<review-cli>` path resolution.** `plugins/concord-codex/commands/review-until-green.md` invokes the review CLI as `node "./bin/review-cli.js" <verb> ...`, relative to the plugin's own directory. Task 1's spike could not validate this resolution headless inside a running Codex session, so the composed command carries an explicit absolute-path fallback note ("if it does not resolve in the running Codex session, locate this plugin's bundled `bin/review-cli.js` and use its absolute path instead"). Interactive confirmation that the relative path resolves correctly in a live Codex session is still pending.

## Deferred: `lifecycle` and `transcript`

The `lifecycle` and `transcript` ports remain open and are not part of this deliverable. Both are deferred alongside session-state/charter work — they depend on understanding Codex's native session-lifecycle payload shape and transcript format, which is out of scope until that session-state/charter design lands. See `README.md`'s port-mapping table for the current (still-stub) description of what each would need to do.
