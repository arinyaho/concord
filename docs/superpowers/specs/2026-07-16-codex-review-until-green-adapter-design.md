# Codex adapter — review-until-green — design

Date: 2026-07-16

## Problem

The vendor-agnostic refactor (`2026-07-16-vendor-agnostic-harness-adapter-design.md`) extracted a vendor-neutral `core/` and a Claude Code adapter, and left `adapters/codex/` as a documented stub. This design is the first real Codex adapter: it makes **`review-until-green` run natively under the Codex CLI**, validating that the port seam is not a Claude-Code-shape in disguise.

Scope is deliberately one capability. `review-until-green` is the right first target because its loop reads a `git diff`, not the session transcript — so it needs none of the transcript/event/hook machinery the other two capabilities (session-state checkpoint, charter) depend on. Those are deferred to a later Codex deliverable once this proves the seam.

## Grounding — what the Codex CLI actually provides

Verified against a live Codex CLI 0.144.5 install (`~/.codex/`), not assumed:

- **Native plugin system.** `~/.codex/plugins/cache/<marketplace>/<name>/<hash>/` with a `.codex-plugin/plugin.json` manifest (`name`, `version`, `skills`, `apps`, `mcpServers`, `interface`), enabled via `config.toml` `[plugins."name@marketplace"] enabled = true`. Structurally analogous to a Claude Code plugin.
- **Commands.** Plugins ship `commands/*.md` with YAML front-matter (`description:`) + markdown body, and support the `$ARGUMENTS` substitution token — the **same** token Claude Code commands use. (This means the neutral driver's `<arguments>` placeholder resolves to `$ARGUMENTS` in *both* harnesses' composed commands.)
- **Hooks.** Plugins ship a `hooks.json` in the **same shape** as Claude Code's (`{ "hooks": { "PostToolUse": [{ "matcher", "hooks": [{ "type": "command", "command": "./scripts/..." }] }], "Stop": [...] } }`), with plugin-relative `./` command paths. (Not needed for this deliverable — noted because it makes the deferred capabilities feasible.)
- **`codex exec`** — non-interactive Codex run: `codex exec [--cd <DIR>] [--sandbox <mode>] [--dangerously-bypass-approvals-and-sandbox] [--output-schema <FILE>] [--json] "<PROMPT>"`. A fresh, clean-context Codex agent that can read the repo and write files. This is the Codex ReviewerPort primitive.
- **Session rollout transcript** exists at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (shape: `session_meta` / `response_item` with `role` + `input_text`/`output_text` content). Relevant only to the deferred transcript-dependent capabilities, not here.

## Key insight — review-until-green needs three ports, not five

The review loop's inputs are the `git diff` and the CLI-owned state directory; its outputs are subagent JSON artifacts and git commits. It never reads the transcript. So of the five ports, this deliverable implements only:

- **CommandPort** — register `/review-until-green` as a Codex command.
- **ReviewerPort** — spawn clean-context reviewers via `codex exec`.
- **StateDirPort** — resolve a `~/.codex`-rooted project-scoped state directory.

`LifecyclePort` and `TranscriptPort` are untouched (they belong to session-state/charter). This is why the first Codex deliverable is small.

## Architecture

The `core/` layer is reused **verbatim** — `core/review-cli.js`, `core/review.js`, `core/gate*.js`, `core/dod-exec.js`, `core/ports.js`, and the neutral `core/review-driver.md`. No core change. Only new Codex-side files:

```
adapters/codex/
  statedir.js        StateDirPort — resolveStateDirFromCwd() rooted at ~/.codex
                     (CHARTER/REVIEW_STATE_DIR env overrides still honored by the CLI wrapper)
  spawn-include.md   ReviewerPort — the codex-exec spawn fragment composed into the command

packaging/codex/
  .codex-plugin/plugin.json         manifest: name, version, commands (+ marketplace metadata)
  commands/review-until-green.md    composed = core/review-driver.md + adapters/codex/spawn-include.md,
                                    with <review-cli> resolved to the bundled CLI path and
                                    <arguments> resolved to $ARGUMENTS
  bin/review-cli.js (or a bundled copy of core+adapters)   the deterministic engine the command invokes
```

### StateDirPort (Codex)

Mirrors `adapters/claude-code/statedir.js` but rooted at Codex's config dir. `core/review-cli.js` already takes the resolver by injection (`runMain(resolveFromCwd)` — the layering fix from the vendor-agnostic deliverable), so the Codex entrypoint injects `adapters/codex/statedir.js`'s resolver exactly as the Claude Code shim injects its own. State lands under a `~/.codex`-rooted `projects/<slug>/state` path (the exact layout is Codex's to define; the resolver is the only vendor-specific piece).

### ReviewerPort (Codex) — the hard part

The neutral `core/review-driver.md` says, at each spawn site, "spawn ONE ... subagent per the harness spawn-include (clean context)". The Codex `spawn-include.md` defines that mechanism for the Codex main model driving the loop:

> Spawn each reviewer subagent as a subprocess: `codex exec --cd <repoRoot> --sandbox workspace-write "<the reviewer prompt>"`. Each reviewer is a fresh, clean-context Codex agent; it reviews the diff and writes ONLY its JSON artifact to the state directory, exactly as the prompt instructs. For a parallel fan-out (the 5-lens panel, the 3-way adversarial verify), launch the `codex exec` calls concurrently as background processes and wait for all their artifact files before proceeding. For a sequential dependency ("wait for the file"), launch the dependent `codex exec` only after the prior artifact exists.

Consequences, documented honestly:

- **Cost.** Each reviewer is a full `codex exec` model run. A broad round (correctness + verify + 5-lens panel + 3-way verify) can be ~15–20 `codex exec` processes. This is materially heavier than Claude Code's in-session `Task` subagents. The spawn-include states this so an operator opts in knowingly; `--broad` stays off by default (as in the neutral driver).
- **Clean context is native.** `codex exec` is a fresh process — it *is* the clean context the driver wants, with no risk of inheriting the main session's reasoning.
- **Orchestration substrate.** The main Codex session running the command drives the loop through its shell: it runs `node <review-cli> <verb>` for the CLI verbs and `codex exec` for the reviewers. This requires the Codex session to have shell access with permission to spawn `codex exec` and let those writes land — the command documents the sandbox/approval expectation.

### CommandPort (Codex)

`packaging/codex/commands/review-until-green.md` is composed the same way the Claude Code command is (Task 7 of the prior deliverable): the neutral `core/review-driver.md` body spliced with the Codex `spawn-include.md`, resolving the two placeholders — `<review-cli>` to the bundled engine's path, `<arguments>` to `$ARGUMENTS`. Front-matter `description:` mirrors the Claude Code command's.

## Open details (confirm at implementation, not blockers)

- **Plugin-root path resolution.** Claude Code commands reference files via `${CLAUDE_PLUGIN_ROOT}`. Codex's exact equivalent for a command to locate its bundled `review-cli.js` is unconfirmed (observed: Codex `hooks.json` uses plugin-relative `./scripts/...`). The `<review-cli>` placeholder is resolved at composition to whatever Codex's convention is — a `${CODEX_PLUGIN_ROOT}`-style variable or a plugin-relative path. Confirm the first implementation step.
- **`codex exec` sandbox mode for artifact writes.** The reviewer must write its JSON artifact. `--sandbox workspace-write` (or a `-c sandbox_permissions=[...]` override) must permit writing under the repo/state dir without an interactive prompt. Confirm the minimal safe mode; avoid `--dangerously-bypass-approvals-and-sandbox` unless the environment is already externally sandboxed.
- **Bundling.** Whether `packaging/codex/` vendors a copy of `core/` + `adapters/codex/` or references a shared install is a packaging decision; the design only requires that the command can invoke the same deterministic engine.

## Verification

- `review-until-green` runs end-to-end under `codex` on a real branch: a round-start, at least one reviewer `codex exec` producing a valid artifact, `plan-fixes`/`record`, and a terminal decision — with the state dir under `~/.codex`.
- The composed Codex command instructs the same loop as the neutral driver (same verbs, artifact paths, ordering), differing only in the spawn mechanism.
- `core/` is unchanged: the existing Claude Code suite stays green, and the neutrality guard still passes (the Codex adapter lives outside `core/`).
- A Codex reviewer prompt writes the same artifact JSON shape the Claude Code reviewers write (the CLI is the shared consumer, so the contract is identical).

## Non-goals (this deliverable)

- session-state checkpoint and charter on Codex (need `TranscriptPort` over the rollout format + `LifecyclePort` over Codex `hooks.json` — a separate design).
- Reducing the `codex exec` fan-out cost (a possible later optimization: collapse lenses, or a batch-review mode); this deliverable ships the honest, correct-but-heavier fan-out.
- A Codex marketplace/publish flow.
