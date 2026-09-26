# Windows support design

## Decision

Make Concord's production code paths run correctly on native Windows (cmd.exe/PowerShell, no WSL/Git Bash required): the Codex plugin's hook manifest, the shared spawn call sites for `codex`/`git`/`claude`/`copilot`, and JSONL/diff line parsing. Centralize the spawn fix in one shared helper (`core/spawn-cross-platform.js`) mirrored across the three packaged plugin copies, rather than patching each call site's options object independently with duplicated logic.

## Evidence: two of three originally-scoped fixes were false premises

The ticket's evidence sweep (a static grep across the plugin sources) flagged three "hosts don't run hooks correctly on Windows" items by pattern-matching `${VAR}` and `sh -c` syntax. Before implementing, each host's actual hook-dispatch mechanism was traced instead of trusting the pattern match:

- **`plugins/concord/hooks/hooks.json` (Claude Code plugin): no defect, no change.** Claude Code's own hook docs (code.claude.com/docs/en/hooks) state it has no per-platform `"windows"` key at all, and that `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code itself as a plain string before the command runs -- not by a shell. The substituted command (`node "<path>"`) has no bash-only syntax, so it already runs correctly whether Windows resolves the shell form to Git Bash or PowerShell. The existing pattern here is the officially documented cross-platform-safe form.
- **`plugins/concord-codex/hooks.json` (Codex CLI plugin): real defect, different fix than originally scoped.** Codex's hook-handler schema (`codex-rs/config/src/hook_config.rs`, `HookHandlerConfig::Command`) defines a `commandWindows` field -- confirmed directly in Codex's source, not just its docs -- as the per-hook Windows override, the same role concord-copilot's `"windows"` key plays for its own host. The existing `command` value is a POSIX `sh -c` script with no Windows equivalent, so this manifest needed a real fix: add `commandWindows` per hook entry, resolving `node` and the target script via PowerShell instead of trying to make the `sh -c` wrapper itself portable.
- **`plugins/concord-copilot`'s hooks.json: no defect, reference precedent only.** Already carries the correct `"windows"` key; this is the pattern the concord-codex fix above follows.

Residual exposure: `commandWindows`'s correctness against a real Codex-on-Windows host is unverified (no Windows machine available). Verification here is schema/content-level (`commandWindows` is present, non-empty, references the right target script, and never shells out to `sh`/`bash`) -- see `plugins/concord/hooks/test/codex-hooks-windows.test.js`. Whoever first runs Concord's Codex plugin on native Windows should treat this as the first real-world check of that field, not an already-proven path.

## Spawn helper

`core/spawn-cross-platform.js` exports `crossPlatformOpts(opts)`, which adds `shell: true` to child_process options only when `process.platform === 'win32'`, otherwise passing options through unchanged. Applied at every `spawn`/`execFileSync` call site for `codex`, `git`, `claude`, and `copilot` in `core/target.js` and `core/codex-review-runner.js` (and their byte-identical mirrors in `concord-codex/engine/` and `concord-copilot/engine/`).

Trade-off accepted: `shell: true` on Windows routes the call through cmd.exe, which quotes each `args` element itself; this is Node's documented behavior for `spawn(cmd, args, {shell:true})` and is what every mainstream cross-platform-spawn library (e.g. `cross-spawn`) also relies on, so no additional escaping layer was added. If a future argument here needs to embed a literal `"` or `%`, cmd.exe's quoting rules differ from POSIX shells and would need dedicated handling; none of the current call sites pass such arguments.

## CRLF line-splitting

Fixed `split('\n')` -> `split(/\r?\n/)` in `core/review-cli.js`, `core/extract.js`, and `adapters/claude-code/review-telemetry.js`. The original evidence sweep's framing ("CRLF breaks JSON.parse") was imprecise: `JSON.parse` already tolerates a trailing `\r` per the JSON grammar (verified empirically: `JSON.parse('{"a":1}\r')` succeeds). The real, narrower defect is in `review-telemetry.js`'s `.filter(Boolean)`/`.find(Boolean)` calls -- a genuinely blank line in a CRLF file becomes the string `'\r'` after splitting on `'\n'` alone, which is *truthy* and therefore survives the filter, then fails `JSON.parse('\r')` ("Unexpected end of JSON input"). Splitting on `/\r?\n/` turns that blank line into `''`, which `Boolean` correctly drops.

`adapters/claude-code/transcript.js`, `adapters/codex/transcript.js`, and `concord-codex/engine/transcript.js` also split on `'\n'` but were left unchanged: each result line is immediately `.trim()`med before `JSON.parse`, which already strips a trailing `\r`, so there is no discriminating red there.

## Non-goals (explicit, from the approved ticket)

Windows CI; rewriting the Unix-only test fixtures (`chmodSync` "executable" fixtures, the `fs.symlinkSync` fixture, `sh`/`bash` `spawnSync` fixtures in `codex-event.test.js`/`codex-transcript.test.js`); `services/agent-team/smoke/container-isolation-verify.mjs` (intentionally Linux/Docker-only); rewriting arbitrary user-authored `review.config.json` shell commands; `fs.chmodSync(stateDir, 0o700)` in `adapters/copilot/statedir.js` (harmless no-op on Windows, not a defect).
