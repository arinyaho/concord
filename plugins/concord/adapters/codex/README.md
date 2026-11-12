# Codex adapter — port mapping

Status: **implemented.** This directory records how each of the five ports in `plugins/concord/core/ports.js` (`PORT_NAMES = ['lifecycle', 'transcript', 'reviewer', 'command', 'statedir']`) maps onto the Codex CLI. See `GAPS.md` for resolved decisions and remaining known trade-offs.

Background: `core/ports.js` defines the port contract, and `adapters/claude-code/` is the implementation these mappings mirror.

## Port mapping

| Port | Claude Code (built) | Codex CLI mapping | Status |
| --- | --- | --- | --- |
| `lifecycle` | Reads the `Stop` / `SessionStart` hook payload from stdin (`session_id`, `transcript_path`, `last_assistant_message`) and normalizes it into `NeutralEvent`. | `adapters/codex/event.js` normalizes Codex's Claude-compatible hook payload and carries `cwd` for Codex state-directory resolution. | **implemented** |
| `transcript` | Wraps the existing byte-offset delta reader plus Claude Code's message-shape parsing to produce `NeutralEntry[]`. | `adapters/codex/transcript.js` maps Codex rollout messages and tool calls into the same `NeutralEntry` shape. | **implemented** |
| `reviewer` | The workflow skills start reviewers and workers as subagents of the session. The engine `review-until-approve` runs asks the session for each reviewer role. | The workflow skills use Codex's own subagent, or one `codex exec` process when none can be started. The engine starts each reviewer role as a `codex exec` process (`core/codex-review-runner.js`). | **implemented** |
| `command` | `commands/charter.md` using `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS`; the workflows are skills. | A native flat Codex plugin at `plugins/concord-codex/`: `.codex-plugin/plugin.json`, the shared skills copied by `bin/bundle.mjs`, and `bin/` shims over the vendored `engine/`. | **implemented** |
| `statedir` | `resolveStateDirFromTranscript` derives a `state/` sibling of the transcript path (or `resolveStateDirFromCwd` reconstructs it under `CLAUDE_CONFIG_DIR/projects/<slug>/state`); `inject` writes to stdout on `SessionStart`. | **Implemented** in `adapters/codex/statedir.js`, mirroring the Claude Code shape for a `~/.codex`-rooted, project-scoped state directory. Covered by a unit test. | **implemented** |

## Implementation status

All five ports are implemented. The self-contained `plugins/concord-codex/engine/` copy and the drift tests keep the shared core and the Codex adapters synchronized. Known differences are in `GAPS.md`.
