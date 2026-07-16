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

plugins/concord-codex/            the Codex plugin, packaged FLAT — mirroring the as-built
                                  Claude Code plugin layout (plugins/concord/ is flat:
                                  .claude-plugin/ + commands/ + hooks/), NOT a packaging/ dir
  .codex-plugin/plugin.json       manifest: name, version, commands (+ marketplace metadata)
  bin/review-cli.js               ENTRYPOINT SHIM (the Codex analogue of hooks/review-cli.js):
                                  requires core/review-cli.js, injects adapters/codex/statedir.js's
                                  resolver, and `if (require.main === module) cli.runMain(resolveFromCwd)`.
                                  <review-cli> resolves to THIS shim, never to core/review-cli.js
                                  directly -- core/review-cli.js exports runMain but does NOT
                                  self-invoke, so run directly it is inert.
  commands/review-until-green.md  composed = core/review-driver.md + adapters/codex/spawn-include.md,
                                  with <review-cli> resolved to bin/review-cli.js (the shim) and
                                  <arguments> resolved to $ARGUMENTS
  (bundled core/ + adapters/codex/)   the deterministic engine the shim requires into
```

Note on layout: the parent design's diagram named a `packaging/claude-code/` directory, but the as-built Claude Code plugin was kept FLAT at `plugins/concord/` (`.claude-plugin/`, `commands/`, `hooks/`, with `core/` and `adapters/` as siblings) — no `packaging/` directory exists in the repo. This Codex design follows the real, as-built convention: a flat sibling plugin directory, symmetric with the Claude Code plugin. Whether the Codex plugin vendors a copy of `core/`+`adapters/codex/` or references the shared tree is the one packaging choice left to implementation.

### StateDirPort (Codex)

Mirrors `adapters/claude-code/statedir.js` but rooted at Codex's config dir. `core/review-cli.js` already takes the resolver by injection (`runMain(resolveFromCwd)` — the layering fix from the vendor-agnostic deliverable), so the Codex entrypoint injects `adapters/codex/statedir.js`'s resolver exactly as the Claude Code shim injects its own. State lands under a `~/.codex`-rooted `projects/<slug>/state` path (the exact layout is Codex's to define; the resolver is the only vendor-specific piece).

### ReviewerPort (Codex) — the hard part

The neutral `core/review-driver.md` says, at each spawn site, "spawn ONE ... subagent per the harness spawn-include (clean context)". The Codex `spawn-include.md` defines that mechanism for the Codex main model driving the loop:

> Spawn each **review-class** subagent (correctness, verify, intent, gate-review, gate-verify, panel lens, adversarial-verify) as a subprocess: `codex exec --cd <repoRoot> --sandbox workspace-write "<the prompt>"`. Each is a fresh, clean-context Codex agent that reviews the diff and writes ONLY its JSON artifact to the state directory. For a parallel fan-out (the 5-lens panel, the 3-way adversarial verify), launch the `codex exec` calls concurrently as background processes and wait for all their artifact files before proceeding. For a sequential dependency ("wait for the file"), launch the dependent `codex exec` only after the prior artifact exists.
>
> Spawn the **fix subagent** (driver step 5) the same way — `codex exec --cd <repoRoot> --sandbox workspace-write "<the fix prompt>"` — but note it is different in kind: it EDITS arbitrary source files in the working tree (not just a JSON artifact), so `workspace-write` must cover the whole repo, not only the state dir. It runs strictly ONE AT A TIME (never backgrounded/parallel — two fixes may touch the same file), and after each fix subagent returns, the main Codex session runs `node <review-cli> commit-fix <ref> <id>` itself before spawning the next. The fix subagent still writes its `round-<n>-fix-<id>.json` result artifact as the driver requires.

The fix step is why `workspace-write` (not a read-only sandbox) is the required mode: review-class subagents only need to write under the state dir, but the fix subagent needs to edit repo source — so the single sandbox mode chosen must satisfy the stricter of the two.

Consequences, documented honestly:

- **Cost.** Each reviewer is a full `codex exec` model run. A broad round (correctness + verify + 5-lens panel + 3-way verify) can be ~15–20 `codex exec` processes. This is materially heavier than Claude Code's in-session `Task` subagents. The spawn-include states this so an operator opts in knowingly; `--broad` stays off by default (as in the neutral driver).
- **Clean context is native.** `codex exec` is a fresh process — it *is* the clean context the driver wants, with no risk of inheriting the main session's reasoning.
- **Orchestration substrate.** The main Codex session running the command drives the loop through its shell: it runs `node <review-cli> <verb>` for the CLI verbs and `codex exec` for the reviewers. This requires the Codex session to have shell access with permission to spawn `codex exec` and let those writes land — the command documents the sandbox/approval expectation.

### CommandPort (Codex)

The Codex plugin's `commands/review-until-green.md` is composed by the same *procedure* Task 7 of the prior deliverable used for the Claude Code command (splice the neutral `core/review-driver.md` body with the vendor `spawn-include.md`, resolving `<review-cli>` to the bundled engine's path and `<arguments>` to `$ARGUMENTS`) — not by mirroring a `packaging/` directory that does not exist. Both plugins are flat; both compose the same neutral driver with their own spawn-include. Front-matter `description:` mirrors the Claude Code command's.

## Relationship to the Codex stub (GAPS.md / README.md)

This design resolves two of the open questions the stub `adapters/codex/GAPS.md` records, and the implementation MUST update the stub docs so they stop reading "documented, not implemented" for the ports this deliverable ships:

- **Fan-out strategy** (GAPS open question) → resolved: OS-level process-parallel `codex exec` (background subprocesses), with the cost documented in the ReviewerPort section above.
- **Install-model choice** (GAPS open question, (i) native `~/.codex` plugin vs (ii) CC-shells-out) → resolved: option (i), a native flat Codex plugin dir.

The implementation updates `adapters/codex/GAPS.md` (mark these two resolved, note the fix-subagent sandbox requirement + fan-out cost as the remaining known trade-off) and `adapters/codex/README.md`'s port-mapping table (mark `command`, `reviewer`, `statedir` as implemented for review-until-green; `lifecycle`/`transcript` remain not-implemented, deferred with session-state/charter). Leaving the stub stale is a defect this design explicitly forbids.

## Open details (confirm at implementation, not blockers)

- **Plugin-root path resolution.** Claude Code commands reference files via `${CLAUDE_PLUGIN_ROOT}`. Codex's exact equivalent for a command to locate its bundled `bin/review-cli.js` shim is unconfirmed (observed: Codex `hooks.json` uses plugin-relative `./scripts/...`). The `<review-cli>` placeholder is resolved at composition to whatever Codex's convention is — a `${CODEX_PLUGIN_ROOT}`-style variable or a plugin-relative path — pointing at the `bin/review-cli.js` shim (not `core/review-cli.js`). Confirm the first implementation step.
- **`codex exec` sandbox mode for artifact writes.** The reviewer must write its JSON artifact. `--sandbox workspace-write` (or a `-c sandbox_permissions=[...]` override) must permit writing under the repo/state dir without an interactive prompt. Confirm the minimal safe mode; avoid `--dangerously-bypass-approvals-and-sandbox` unless the environment is already externally sandboxed.
- **Bundling.** Whether the Codex plugin dir vendors a copy of `core/` + `adapters/codex/` or references a shared install is a packaging decision; the design only requires that the command can invoke the same deterministic engine.

Following the parent design's "enforced, not just asserted" standard, verification is mechanical first, E2E second:

- **Mechanical (required):** `adapters/codex/statedir.js` gets a unit test mirroring `hooks/test/statedir.test.js` — asserting its `resolveStateDirFromCwd` produces the expected `~/.codex`-rooted project-scoped path (config-dir + project-slug encoding), the same way the Claude Code test asserts the `CLAUDE_CONFIG_DIR` + slug path. The `REVIEW_STATE_DIR` override is deliberately NOT part of this test: it lives one layer up in `core/review-cli.js`'s `resolveStateDir()` wrapper, not in the injected resolver (`adapters/claude-code/statedir.js` documents that the resolver "has no override of its own"), so it is core's concern, already covered there. This is the port-shape enforcement the parent design mandates for every adapter, and statedir is the one file in this deliverable with an existing unit-test precedent.
- **Mechanical (required):** `core/` is unchanged — the existing Claude Code suite stays green and the neutrality guard still passes (the Codex adapter lives outside `core/`). A guard confirms no core edit was needed.
- **E2E:** `review-until-green` runs end-to-end under `codex` on a real branch through a FULL convergence, not just a review pass: round-start → at least one review-class `codex exec` producing a valid artifact → **a fix subagent `codex exec` that edits the tree → the main session's `commit-fix` → record** → a terminal decision, with the state dir under `~/.codex`. The fix+commit leg is explicitly exercised, since it is what makes the loop *converge* rather than merely *review*.
- **E2E:** the composed Codex command instructs the same loop as the neutral driver (same verbs, artifact paths, ordering), differing only in the spawn mechanism; a Codex reviewer prompt writes the same artifact JSON shape the Claude Code reviewers write (the CLI is the shared consumer, so the contract is identical).

## Non-goals (this deliverable)

- session-state checkpoint and charter on Codex (need `TranscriptPort` over the rollout format + `LifecyclePort` over Codex `hooks.json` — a separate design).
- Reducing the `codex exec` fan-out cost (a possible later optimization: collapse lenses, or a batch-review mode); this deliverable ships the honest, correct-but-heavier fan-out.
- A Codex marketplace/publish flow.
