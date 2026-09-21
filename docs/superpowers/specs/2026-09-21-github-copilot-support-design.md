# GitHub Copilot support design

## Decision

Ship GitHub Copilot support as an Agent Plugins 1.0 distribution at `plugins/concord-copilot/`. The distribution vendors the JavaScript core, packages provider-neutral skills, and adds Copilot-specific hooks, commands, agents, model routing, and state resolution. It does not require Claude Code or Codex executables.

## Architecture choice

| Option | Portability | Lifecycle integration | Distribution cost | Decision |
| --- | --- | --- | --- | --- |
| Repository customizations under `.github/` | Bound to one repository | Native skills, prompts, agents, and hooks | Repeated installation and repository churn | Reject |
| Global Agent Plugin | Reusable across workspaces | Native skills, commands, agents, and Preview hooks | One versioned package | Select |
| VS Code extension | Reusable across profiles | Full extension API surface | Build, signing, publishing, activation, and compatibility overhead | Reject |

An extension does not provide a stable conversation transcript contract. The Agent Plugin therefore supplies the required behavior with less privilege and fewer lifecycle surfaces.

## Package boundaries

The shared core remains under `plugins/concord/core/`. `plugins/concord-copilot/bin/bundle.mjs` copies that core and the Copilot adapters into a self-contained `engine/`; drift tests require byte parity. Copilot conditions stay in `plugins/concord/adapters/copilot/` and `plugins/concord-copilot/`.

Provider-neutral workflow files are copied by the bundle. Harness-bound behavior uses Copilot-specific skills or overrides. `review-until-green` drives the shared deterministic CLI but delegates reviewer and fixer roles to clean-context Copilot custom agents. Cross-model review means a second Copilot-hosted model, not an external vendor CLI.

## Capability contract

| Capability | Copilot behavior | Degraded behavior |
| --- | --- | --- |
| Project charter | `/charter set` emits a documented marker; `UserPromptSubmit` persists it; `SessionStart` injects it | Without Preview hooks, skills remain available but persistence and injection are unavailable |
| Session checkpoint | Explicit charter fields only | Automatic transcript-derived checkpoints are unavailable |
| Review until green | Shared CLI plus clean-context `Concord Reviewer` and `Concord Fixer` agents | Missing subagent, model, tool, or artifact access stops the run without a clean verdict |
| Cross-model review | Re-arms the ledger and selects a different available Copilot model | If a different model is unavailable, stop; never silently reuse the first model |
| Initiative execution | Shared stages plus Copilot role-based model routing | Deep contract decisions do not downgrade automatically |
| Ticket and proposal workflows | Packaged skills | External tracker, document, or GitHub prerequisites fail explicitly |
| Review until LGTM | Observes the GitHub Codex bot through `gh` | Missing authentication or repository mechanism stops the observation loop |

## Lifecycle and state

Installation, update, and removal use `copilot plugin marketplace` and `copilot plugin` commands. VS Code loads the plugin's fixed `com.github.copilot/` component paths after restart.

State root precedence is `CONCORD_COPILOT_HOME`, `PLUGIN_DATA`, `COPILOT_PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, then `~/.copilot/concord`. Each project uses `projects/<sha256(realpath(cwd))>/state`, preventing same-name workspaces from sharing ledgers. State directories use mode `0700` where the platform permits it. Users who need state retention back up the resolved root before uninstalling because host removal semantics can delete plugin-managed data.

## Hook contract

Hooks consume at most 1 MiB of JSON from stdin and normalize only documented fields. Missing `cwd` is an explicit warning and never writes shared fallback state. `SessionStart` emits `hookSpecificOutput.additionalContext`; `UserPromptSubmit` accepts `/charter set`, `charter set`, and `CONCORD_CHARTER_SET:` markers. User text is passed as data and is never interpolated into shell commands.

The optional `transcript_path` field is ignored because its file format is not a stable hook API. The design therefore makes no transcript checkpoint parity claim.

## Reviewer isolation

`Concord Reviewer` is hidden from the user picker, cannot spawn children, does not edit product files, and returns only the requested JSON artifact. `Concord Fixer` receives one planned finding, edits sequentially, and reports every changed file. The parent drives CLI verbs and accepts termination only from the deterministic ledger.

A Copilot-driven run does not allocate the shared Claude or Codex telemetry slots. Agent Host does not expose stable provider usage evidence for these subagents, so the handoff identifies telemetry as unavailable and never synthesizes token measurements.

A model request records the requested and resolved model when the host exposes both. Ordinary roles may substitute only within the documented role class and must record the substitution. A required different-model review or deep contract decision stops when the requested capability is unavailable.

## Security

| Threat | Mitigation |
| --- | --- |
| Cross-project state collision | Canonical project root hashed with SHA-256 |
| Oversized hook input | 1 MiB hard limit |
| Missing workspace identity | Explicit warning and no write |
| Shell injection | Fixed hook command plus JSON parsing; no user-text interpolation |
| Reviewer privilege expansion | Separate read-only reviewer instructions and no nested agents |
| False clean after tool failure | Required `blocked` artifact and terminal failure |
| Unstable transcript parsing | Transcript ignored |
| Uninstall data loss | Stable external override plus documented backup step |

## Verification

Unit tests cover event normalization, state isolation, marker persistence, context injection, package layout, bundle drift, workflow inventory, agent restrictions, documentation, and live CLI entrypoints. A clean temporary Copilot configuration installs the marketplace package and verifies discovery without existing customizations.

VS Code acceptance uses a clean profile and extension directory: install the plugin, open two projects with the same basename, set distinct charters, start new sessions, verify isolated context injection, invoke `review-until-green` far enough to observe clean-context agent discovery, then update and uninstall. Hook diagnostics and the GitHub Copilot Chat Hooks output must show the package source and no schema errors. The test also verifies that disabled hooks produce the documented degraded behavior rather than an implied persisted charter.

## Approved constraints

The distribution is a global Agent Plugin. Explicit charter state is the checkpoint MVP. Cross-model means multiple models exposed through Copilot. Preview hooks are a minimum requirement for charter lifecycle behavior. Uninstall may delete plugin-managed state, so retention is an operator responsibility.

## Residual exposure

Agent Plugins, hooks, model names, and subagent model selection remain host-controlled surfaces. Package tests can prove static contracts and CLI discovery, but only clean-profile VS Code acceptance proves the active host exposes the required Preview behavior.