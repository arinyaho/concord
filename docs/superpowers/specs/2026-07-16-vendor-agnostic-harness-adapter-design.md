# Vendor-agnostic harness adapter — design

Date: 2026-07-16

## Problem

Concord is written as a Claude Code plugin. Its three user-facing capabilities — the review-and-fix loop (`/review-until-green`), the cross-session charter (`/charter`), and the per-session state checkpoint — all assume the Claude Code harness: its plugin manifest format, its slash-command format, its lifecycle hooks, its transcript JSONL, and its `Task`-tool subagents. None of that is portable to another agent harness (Codex CLI, and later others).

The goal is to make Concord **AI-vendor-agnostic**: the same capability logic runs under any harness that can provide a small, well-defined set of primitives, and each harness is supported by a thin adapter rather than a fork.

This is a feasibility-driven refactor, not a feature. The first deliverable proves the seam is real without changing any observable behavior for existing Claude Code users.

## What is Claude-coupled today

Audit of the current tree (`plugins/concord/`):

- **Packaging (100% Claude Code format).** `.claude-plugin/plugin.json`, root `marketplace.json`, `commands/*.md` using `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS`, and `hooks/hooks.json` binding the `Stop` and `SessionStart` (`startup|resume|compact`) events.
- **The reviewer-spawn instruction (Claude Code runtime).** `commands/review-until-green.md` is prose the harness's main model executes; it instructs the model to spawn each review/fix/gate subagent via the `Task` tool (`general-purpose`, clean context), some in parallel. "Spawn a clean-context reviewer" is a harness primitive, and the way it is requested is Claude-Code-specific.
- **Session-state hooks (the most coupled).** `session-state-writer.js` reads a Claude Code hook payload from stdin (`session_id`, `transcript_path`, `last_assistant_message`), then parses the Claude Code transcript JSONL via `lib/transcript.js` + `lib/extract.js`. `session-state-injector.js` / `review-injector.js` ride the `SessionStart` payload and emit context via stdout (the Claude Code injection mechanism). `lib/statedir.js` mirrors Claude Code's project-slug encoding and reads `CLAUDE_CONFIG_DIR`.

Audit of what is **already vendor-neutral**:

- `hooks/review-cli.js` — the deterministic authority on rounds, dedupe, termination, `git diff`, and `commit-fix`. Pure Node + git + JSON files. No vendor symbols (only comments mention a retired `claude-p` engine).
- `lib/charter.js`, `lib/state.js`, `lib/gate*.js`, `lib/dod-exec.js`, `lib/config.js` — logic over data structures and files.

So the coupling is concentrated in three places — **packaging, the spawn instruction, and the transcript/lifecycle plumbing** — while the core loop and charter/state logic are already engine-neutral. That is what makes the seam cheap to extract.

## Architecture — ports and adapters

Three layers. The dependency rule points inward: `packaging` depends on `adapters` depends on `core`; `core` depends on nothing harness- or vendor-specific.

```
core/                      No harness/vendor symbols. Pure logic + data.
  review/    rounds · dedupe · termination · gate · dod · ledger   (today's review-cli logic)
  charter/   north-star · merge · render
  state/     fact/rationale extract + merge over NEUTRAL entries · render
  ports.js   the adapter interface contract (JSDoc typedefs)

adapters/
  claude-code/   Port implementations for Claude Code. Built now. Behavior-preserving.
  codex/         STUB now: interface skeleton + a Codex primitive mapping table + GAPS.md

packaging/
  claude-code/   plugin.json · marketplace.json · commands/*.md · hooks/hooks.json
                 (thin: wires the harness to core through the claude-code adapter)
  codex/         (future) Codex-native manifest · prompts · hooks
```

### Directory move (first deliverable)

The existing `plugins/concord/hooks/` tree is re-homed, not rewritten:

- `hooks/review-cli.js`, `hooks/charter-cli.js` logic → `core/review/`, `core/charter/` (thin CLI entrypoints stay where the commands reference them, or move with a shim — see Compatibility).
- `lib/state.js`, `lib/gate*.js`, `lib/dod-exec.js`, `lib/review.js`, `lib/charter.js`, `lib/config.js` → `core/`.
- `lib/transcript.js`, `lib/statedir.js`, and the stdin-payload handling in the three hook entrypoints → `adapters/claude-code/`.
- `lib/extract.js` is **split**, not moved wholesale: its Claude-Code transcript message-shape parsing (`e.type === 'assistant'`, `e.message.content`, `tool_use` items) moves to `adapters/claude-code/` behind the `TranscriptPort`, while its fact/rationale extraction — which only needs `NeutralEntry` — moves to `core/state/`. This is the one file the audit flags as coupled *and* neutral in different parts, so it cannot go to a single layer intact.

Apart from the `extract.js` split, no logic changes in the moved files: import paths update, and that is the extent of the churn in `core`.

## The port contract — five seams

`core/ports.js` defines the interface every adapter implements. Five seams cover every harness dependency found in the audit.

### 1. LifecyclePort

The harness fires lifecycle events; the adapter normalizes each into a neutral shape the core consumes.

```
NeutralEvent = {
  sessionId: string,
  transcriptPath: string,         // adapter-resolved path to the harness transcript
  lastAssistantMessage?: string,  // optional; the just-finished turn, if the harness passes it
  source: 'startup' | 'resume' | 'compact' | 'stop'
}
```

The adapter owns: which harness events map to `stop` (write checkpoint) vs the `startup|resume|compact` group (inject), and how to read the raw payload. Claude Code: stdin JSON on the `Stop` / `SessionStart` hooks. Codex: its own lifecycle hook payload (documented in the stub).

### 2. TranscriptPort

```
parseDelta(transcriptPath, offset) -> { entries: NeutralEntry[], newOffset: number }
NeutralEntry = { role: 'user' | 'assistant', text: string, toolCalls: Array<{ name, input }> }
```

`NeutralEntry` is the minimum `core/state/extract` needs: `extractRationale` reads `text`, and `extractFacts` reads `toolCalls` (file paths and commands come from tool calls, not prose) — so the neutral shape carries both. The Claude Code adapter wraps today's `readDelta` (byte-offset delta read) plus the Claude Code message-shape parsing currently inlined in `extract.js`. The offset-advancement / partial-line semantics stay in the adapter, since they are transcript-format details. `core/state` operates only on `NeutralEntry[]`.

### 3. ReviewerPort — the subtle one

The review loop is driven by prose the **harness's own main model** executes (the `review-until-green.md` command), and the reviewers are subagents that model spawns. So "how to spawn a clean-context reviewer that writes a JSON artifact" is not a Node API the core calls — it is a **prose fragment injected into the driver command per vendor**.

The command markdown is therefore split:

- **Neutral driver prose** — the loop logic: run the CLI verb, read the round diff, spawn *a reviewer* with such-and-such prompt writing to such-and-such artifact path, wait for the file, run the next verb. This references an abstract "reviewer subagent" and never names a harness mechanism.
- **Vendor spawn-include** — a short fragment the packaging step composes into the neutral prose. Claude Code's include: "spawn via the `Task` tool, `general-purpose`, clean context; parallel calls in one message run concurrently." Codex's include (stub): "spawn via `codex exec <prompt>`; N concurrent processes for a fan-out; collect each artifact on exit."

This split is the crux of the whole design: it is what lets the same review loop run on a harness whose subagent primitive is a subprocess rather than a `Task` tool, and it is why the parallelism/quality of a fan-out is an **adapter property**, not a core guarantee.

### 4. CommandPort

How `/review-until-green`, `/charter` are registered and how arguments arrive. Claude Code: `commands/*.md` with `$ARGUMENTS`. Codex: its command/prompt format. This is repackaging only — no logic — but it is a named seam so the packaging layer has a contract to satisfy.

### 5. StateDirPort

```
resolveStateDir(event) -> string      // project-scoped state directory
inject(text) -> void                  // surface text into the harness context
```

Claude Code: state dir is the `state/` sibling of the transcript (or `CLAUDE_CONFIG_DIR/projects/<slug>/state` from cwd); `inject` writes to stdout. Codex: `~/.codex`-rooted path and its injection mechanism (stub).

## First deliverable — scope

Direction (가): extract the neutral seam and refactor Claude Code into adapter #1. Codex is an interface stub plus documentation. No Codex runtime is built.

In scope:

1. Create `core/`, `adapters/claude-code/`, `packaging/claude-code/`. Move the neutral logic into `core/` with import-path updates only — no behavior change.
2. Introduce `NeutralEntry` and the `TranscriptPort`; the Claude Code adapter wraps current parsing.
3. Define `core/ports.js` (the five seams as JSDoc typedefs).
4. Rewire the Claude Code hooks and commands to reach `core` through `adapters/claude-code/`.
5. Split `review-until-green.md` into neutral driver prose + a Claude Code spawn-include, composed at packaging.
6. Create `adapters/codex/` as an interface skeleton + a Codex primitive mapping table + `GAPS.md` recording what each port maps to and what is missing (notably: no native parallel clean-context subagent; degradation = serial or process-fan-out `codex exec`).

Out of scope: any working Codex adapter, Codex packaging/install, transcript parsing for Codex, changes to `review-cli.js` decision logic.

## Compatibility — no regression for Claude Code users

The Claude Code install path is unchanged: `/plugin marketplace add arinyaho/concord` → `/plugin install concord@arinyaho-concord`. `plugin.json`, `marketplace.json`, the command names, the hook bindings, and every observable behavior stay identical. Only the internal file layout and import paths change.

Because the current commands reference `${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js` and `${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js` by path, the packaging layer keeps those entrypoint paths valid — either the CLI entrypoints stay at those paths as thin shims that `require` into `core/`, or the command markdown is updated in lockstep with the move. Either way the plugin as installed exposes the same interface.

## Verification — the seam is enforced, not just asserted

1. **No-regression:** the entire existing hook test suite (`plugins/concord/hooks/test/*`) passes unchanged after the move. These tests are the behavioral contract; green means users see no difference.
2. **Neutrality guard (new test):** a test greps `core/` for harness/vendor symbols — `CLAUDE_`, the raw payload keys (`transcript_path`, `session_id`, `last_assistant_message`), and the literal `Task tool` — and asserts zero matches. This mechanically enforces that no future edit re-couples the core to a vendor.
3. **Port-shape test (new):** the Claude Code adapter is exercised against the `ports.js` typedefs with a fixture payload + fixture transcript, asserting it produces well-formed `NeutralEvent` / `NeutralEntry[]`.

## Open questions deferred to the Codex stage (not this deliverable)

- Which Codex install model to target: (i) a Codex-CLI-native plugin under `~/.codex` (Codex is the harness — true agnosticism), vs (ii) a Claude Code plugin that shells out to Codex (harness stays Claude Code). The seam here is designed toward (i); the stub documents the gap.
- How a fan-out of review lenses degrades on a harness with no parallel clean-context subagent — the `ReviewerPort` include is where that policy lives.
