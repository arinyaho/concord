# Codex CLI spike findings — exec writes + command script resolution

Date: 2026-07-16

Discovery spike for the Codex adapter (see `2026-07-16-codex-review-until-green-adapter-design.md`, "Open details" section). Confirms two runtime facts against a live Codex CLI 0.144.5 install (`~/.codex/`) before implementation depends on them. No product code changed; this is a recorded findings note only.

## Fact 1 — `codex exec --sandbox workspace-write` writes files non-interactively: CONFIRMED

Minimal working invocation, verbatim, no extra flags needed:

```
codex exec --cd <dir> --sandbox workspace-write '<prompt>'
```

Ran in a scratch git repo (`/tmp/codex-spike`, one empty commit) with the exact prompt from the brief. The run's own banner shows why it needs nothing extra:

```
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
```

`codex exec` sets `approval: never` by default (it is inherently the non-interactive entrypoint — there is no prompt/confirmation path to suppress). `--sandbox workspace-write` alone was sufficient to let the agent write `probe.json` in the repo root with no `-c sandbox_permissions=[...]` override and no `--dangerously-bypass-approvals-and-sandbox`. The file landed with the exact requested byte content (verified via `od`), and the run completed and exited 0 without ever blocking on stdin/approval.

One implementation detail worth carrying forward: the agent's first attempt used `apply_patch`, which failed with `apply_patch verification failed: invalid hunk ... Expected update hunk to start with a @@ context marker, got: '\ No newline at end of file'` when it tried to strip a trailing newline. It recovered on its own by falling back to `printf %s '...' > probe.json` directly. This is a model-behavior detail, not a sandbox/approval issue — it did not require any human input, so it doesn't change the fact above, but a prompt asking for exact byte content may need a retry-tolerant caller if this is scripted (the design's reviewer/fix subagents write structured JSON via whatever mechanism the model picks, so this is worth a note, not a blocker).

## Fact 2 — bundled script path resolution for a Codex plugin **command**: NOT CONFIRMED AS PLUGIN-RELATIVE — evidence points the other way

This is the one to read carefully; it complicates the design's open assumption more than it resolves it.

### What the documentary evidence shows (strong, consistent, but scoped to *declared* manifest integrations)

Inspected real installed plugins under `~/.codex/.tmp/plugins/plugins/*/` (the `openai-api-curated` marketplace root) and Codex's own `plugin-creator` skill spec (`~/.codex/.tmp/plugins/.agents/skills/plugin-creator/references/plugin-json-spec.md`). Every path Codex plugins declare in a manifest field is plugin-relative, prefixed `./`:

- `plugin.json`: `"skills": "./skills/"`, `"hooks": "./hooks.json"`, `"mcpServers": "./.mcp.json"`, `"apps": "./.app.json"`, `"composerIcon": "./assets/icon.png"`, etc. The spec doc states outright: "Path values should be relative and begin with `./`."
- `hooks.json` (figma plugin): `"command": "./scripts/post_write_figma_parity_check.sh"` (also seen in replayio's hooks.json).
- `.mcp.json` (openai-developers, codex-security plugins): `"cwd": ".", "command": "node", "args": ["./mcp/server.mjs"]` — note the explicit `"cwd": "."`. This is the mechanism: Codex spawns the hook/MCP-server subprocess *with its cwd set to the plugin root*, so a `./`-relative arg resolves correctly. This is a Codex-managed remapping, not ambient shell behavior.

No `${CODEX_PLUGIN_ROOT}`-style environment variable exists anywhere in this corpus — not in any plugin's hooks.json/.mcp.json/scripts, not in the official `plugin-json-spec.md`, not in `codex --help`/`codex exec --help`/`codex plugin --help` output. The convention Codex documents and every real plugin uses is: **plugin-relative `./path`, resolved by Codex setting the subprocess `cwd` to the plugin root for declared hook/MCP-server integrations.**

Critically, **`commands/*.md` is not a declared `plugin.json` field at all.** The spec lists only `skills`, `hooks`, `mcpServers`, `apps` as declarable; commands are auto-discovered by directory convention (confirmed: `build-macos-apps`, `figma`, `vercel`, `zoom`, `cloudflare`, `expo` all ship `commands/*.md` with no `"commands"` key in their `plugin.json`). This matters because the `cwd: "."` remapping mechanism above is only observed for fields Codex explicitly manages as subprocess launches (hooks, MCP servers) — there is no equivalent declared launch config for commands to inherit that remapping from.

### What live-agent behavior shows (the actual counter-evidence)

Two empirical observations from `codex exec` runs in `/tmp/codex-spike`, both unprompted (the model chose these on its own):

1. When the agent (mid-turn, following the "superpowers" plugin's `using-superpowers` skill instruction to invoke skills) needed to read a bundled skill file, it read it via an **absolute cache path**, not a relative one:
   ```
   sed -n '1,240p' /Users/inkme/.codex/plugins/cache/openai-curated/superpowers/11c74d6b/skills/using-superpowers/SKILL.md
   ```
   The shell's cwd for this command was `/tmp/codex-spike` (the `--cd` target / session workdir), not the plugin directory — a bare `./skills/...` would not have resolved there. This is the closest live signal to "how does a running agent turn locate bundled plugin content when it isn't a declared hook/MCP-server subprocess," and the answer observed is: absolute path under `~/.codex/plugins/cache/<marketplace>/<plugin>/<hash-or-version>/...`, not plugin-relative.

2. I scaffolded the brief's exact minimal plugin (`.codex-plugin/plugin.json`, `bin/hello.js` printing `HELLO`, `commands/spike.md` running `node "./bin/hello.js"`), registered it as a local marketplace (`codex plugin marketplace add`, which required discovering the undocumented manifest location `.agents/plugins/marketplace.json` — not documented in `codex plugin marketplace add --help`, found by inspecting the real curated marketplace root), and installed it (`codex plugin add spike@codex-spike-market` → installed to `~/.codex/plugins/cache/codex-spike-market/spike/0.0.1/`). Then ran:
   ```
   codex exec --cd /tmp/codex-spike --sandbox workspace-write '/spike'
   ```
   **This did not dispatch to `commands/spike.md` at all.** The literal string `/spike` was passed to the model as plain user text, not expanded into the command's markdown body. The model had no idea what "spike" meant, searched the repo for anything matching, found nothing, and asked "What would you like to investigate in this spike?" — it never read `commands/spike.md`, never ran `bin/hello.js`, and never printed `HELLO`. So the second half of the brief's Step 2 (empirically confirm resolution by installing and invoking) is **inconclusive by a different failure mode than "timed out"**: the command never ran, because `codex exec` does not expand plugin slash-commands from prompt text. This appears to be a TUI-only dispatch mechanism (interactive `codex`, not `codex exec`) — I did not test the interactive TUI path, since driving it would require a pty-automation tool outside this spike's scope, and the brief accepts documentary evidence in lieu of a full interactive install/run.

### Bottom line for the design's open assumption

The design's stated assumption — `<review-cli>` resolves to plugin-relative `./bin/review-cli.js` — is **not confirmed, and the available evidence leans against it working unmodified**:

- The `./`-relative convention is real and consistent, but it is coupled to Codex explicitly setting subprocess `cwd` for declared hook/MCP-server launches. Commands have no equivalent declared launch config, so there's no confirmed mechanism giving a command's shell block a plugin-root cwd.
- The one live data point for "how does an agent turn reach bundled plugin content when it isn't a declared subprocess" shows an absolute cache path being used instead, because the turn's shell cwd is the target repo, not the plugin dir.
- I could not get a `codex exec` run to dispatch a plugin command by name at all, meaning I could not directly observe what cwd a command's own shell block executes with. This is the actual gap, not a proxy — if command dispatch is TUI-only, then whether `<review-cli>` resolves as relative or absolute must be confirmed inside an actual interactive `codex` session with `/review-until-green` typed, not via `codex exec`.
- This also confirms, positively, one thing the adapter design already assumed implicitly: the design's `ReviewerPort` section already has the top-level `/review-until-green` command run in an interactive Codex session, with only the *nested* reviewer/fix subagents spawned via `codex exec`. That structure is now empirically necessary, not just a design choice — `codex exec` cannot be the outer invocation mechanism for a plugin command, because it doesn't dispatch commands at all.

**Recommendation for the implementation step that resolves `<review-cli>`:** don't bake in a bare `./bin/review-cli.js` relative reference on the strength of the hooks.json/`.mcp.json` pattern alone — that pattern's `cwd: "."` remapping is not confirmed to extend to commands. Test path resolution directly inside an interactive `codex` session (`codex` then type `/review-until-green`) as the actual first implementation step, checking `pwd` from within the command body before deciding the reference form. If it turns out the shell cwd during a command turn is the target repo (matching the live-agent evidence above, not the plugin root), `bin/review-cli.js` will need to be located either via an absolute path discovered through `codex plugin list --json` (the CLI does expose installed-plugin paths this way — confirmed: `codex plugin list --marketplace <name>` prints the installed `PATH` column) or via a self-locating shim that doesn't depend on the command's cwd at all.

## Marketplace mechanics learned along the way (not asked for, but load-bearing for Fact 2's test and for any future plugin work)

- `codex plugin add <name>@<marketplace>` only installs from a *configured marketplace* — there is no direct "install from local plugin dir" subcommand. A local marketplace must be registered first via `codex plugin marketplace add <path>`.
- A marketplace root needs a manifest at `.agents/plugins/marketplace.json` (undocumented in `--help` output; found by inspecting the real `openai-api-curated` marketplace root, whose `ROOT` from `codex plugin marketplace list` pointed at `~/.codex/.tmp/plugins`). Shape: `{"name", "interface": {"displayName"}, "plugins": [{"name", "source": {"source": "local", "path": "./plugins/<name>"}, "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"|"ON_USE"}, "category"}]}`. `"authentication": "NONE"` is rejected (`unknown variant, expected ON_INSTALL or ON_USE`).
- `codex plugin add` installs into `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` (version-numbered here; the pre-existing curated plugins use a content hash instead, e.g. `11c74d6b` — both forms observed, so don't assume either is stable across a plugin's lifetime).
- Cleanup: `codex plugin remove <name>@<marketplace>` then `codex plugin marketplace remove <marketplace>` fully un-registers both the plugin and the marketplace source from `~/.codex/config.toml`, but does not delete the plugin cache directory — that needs a manual `rm -rf ~/.codex/plugins/cache/<marketplace>`.

## Cleanup performed

Deleted `/tmp/codex-spike`, `/tmp/codex-spike-market`, and `~/.codex/plugins/cache/codex-spike-market/`. Removed the `spike` plugin and `codex-spike-market` marketplace registration from `~/.codex/config.toml` via `codex plugin remove` / `codex plugin marketplace remove`, and removed the leftover `[projects."/private/tmp/codex-spike"]` trust entry that `--cd` had auto-added. No plugin, marketplace, or trust registration for the scratch spike remains in `~/.codex/config.toml`.
