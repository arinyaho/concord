# Windows support

Concord's production code paths run on native Windows (cmd.exe or PowerShell, no WSL or Git Bash required): the hook manifests of each distribution, every spawn of `codex`, `git`, `claude`, and `copilot`, and JSONL and diff line parsing. The spawn behavior is centralized in one shared helper, `core/spawn-cross-platform.js`, mirrored byte for byte into the Codex and Copilot engines, instead of each call site patching its own options.

The recurring threat model is that Concord reviews an arbitrary, untrusted checkout. Nothing the reviewed repository contains (a committed `git.cmd`, a `node_modules/.bin` shim, a multi-line commit message, a branch name with shell metacharacters) may change which program runs or how its arguments are read.

## Hook manifests

Each host dispatches hooks differently, so each manifest is judged by its host's own mechanism, not by pattern-matching shell syntax.

- Claude Code (`plugins/concord/hooks/hooks.json`) has no per-platform key. It substitutes `${CLAUDE_PLUGIN_ROOT}` itself as a plain string before the command runs, and the resulting `node "<path>"` has no shell-specific syntax, so the same command runs whether Windows resolves the shell to Git Bash or PowerShell. No Windows-specific form is needed.
- GitHub Copilot's manifest carries a `"windows"` key per hook.
- Codex (`plugins/concord-codex/hooks.json`) defines a `commandWindows` field per hook as its Windows override. The POSIX `command` is an `sh -c` script with no Windows equivalent, so each hook also carries a `commandWindows` PowerShell form.

The `commandWindows` strings follow three rules:

- PowerShell is invoked by its absolute install path, `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, not by bare name. The hook runs with the reviewed project as its working directory, and a bare name lets a repository-controlled `powershell.exe` or `.cmd` run instead. A literal path is used rather than `%SystemRoot%` because the Codex dispatcher's invocation mechanism may not expand environment variables.
- `node` is looked up only in fixed install locations (`$env:ProgramFiles\nodejs\node.exe`, then `${env:ProgramFiles(x86)}\nodejs\node.exe`), never through `PATH`. An npm or pnpm script started inside the reviewed repository prepends its `node_modules/.bin` to `PATH`, and the hook cannot learn the repository root to exclude it, so no `PATH`-based lookup can be made safe. When `node` is not found, the hook exits 0 like every other "cannot locate node" case.
- Each string first sets `[Console]::OutputEncoding` to UTF-8, so a legacy console code page does not corrupt non-ASCII content (charters, persisted messages, findings) the hooks emit.

## Spawn helper

`core/spawn-cross-platform.js` is applied at every spawn of `codex`, `git`, `claude`, and `copilot` in `core/target.js`, `core/codex-review-runner.js`, `core/review-cli.js`, and the Codex `bin/review-and-fix.js` entry point. On anything other than `win32` it passes options and arguments through unchanged.

On `win32`:

- `crossPlatformOpts` adds `shell: true`, so `.cmd` shims resolve.
- `resolveOnPath(bin, excludeDir)` resolves the binary to an absolute path before spawning, modeled on `cross-spawn`'s command resolution. It searches `PATH` directories only, trying each `PATHEXT` extension when the name has none, and never consults the current directory, because cmd.exe's own bare-name lookup searches the working directory (the reviewed repository) before `PATH`. A candidate inside `excludeDir`, the repository under review, is skipped, which closes the case where a script runner has prepended the repository's `node_modules/.bin`. Every candidate is made absolute with `path.resolve` before the exclusion check and the return, so a relative `PATH` entry cannot validate one file and run another. One matching pair of surrounding double quotes is stripped from each `PATH` entry.
- When nothing trusted is found, resolution returns `null` and `crossPlatformCommand` throws a `harness-failure` instead of spawning the bare name, which would let cmd.exe search the reviewed repository after all.
- `crossPlatformArgs` quotes each argument with the CommandLineToArgvW rule and then escapes every cmd.exe metacharacter (`()[]%!^"` `` ` `` `<>&|;, *?`) with `^`, reproducing `cross-spawn`'s escaping exactly; `escapeCommandForWindows` does the same for the resolved binary. With cmd.exe as the shell, Node forces `windowsVerbatimArguments` and performs no quoting of its own, so without this a path with a space splits into several arguments and a ref such as `foo&whoami` runs a second command. When the resolved binary is a `node_modules/.bin/*.cmd` shim (`isCmdShim`, cross-spawn's pattern), `needsDoubleEscape` applies the metacharacter pass twice, because the shim's own cmd.exe invocation consumes one pass.

Escaping test cases use hardcoded expected outputs computed from `cross-spawn`'s reference implementation rather than a second copy of the algorithm, so the test cannot share a transcription error with the code it checks.

## Multi-line arguments

Quoting does not stop cmd.exe from reading an embedded line break as a command separator, and reviewer prompts and commit messages are routinely multi-line.

- On `win32`, the runner writes the prompt to the child's stdin instead of argv: `codex exec -` (the stdin sentinel), `claude -p` with no positional prompt, and `copilot` with no `-p`/`--prompt` (Copilot ignores piped stdin when that flag is present). POSIX keeps the prompt on argv.
- `gitCommitFix` uses `git commit -F -` on every platform, so the commit message never travels on argv.
- A no-op `'error'` listener is attached to the child's stdin before writing, so an `EPIPE` from a child that exits early becomes failed telemetry through the child's own error handling instead of crashing the review process.

## Line splitting

`core/review-cli.js`, `core/extract.js`, and `adapters/claude-code/review-telemetry.js` split on `/\r?\n/`. `JSON.parse` already tolerates a trailing `\r`, but a blank CRLF line split on `'\n'` alone becomes the truthy string `'\r'`, survives `.filter(Boolean)`, and then fails to parse. The transcript readers split on `'\n'` and are correct as they are, because each line is trimmed before parsing.

## Bundle parity

Drift tests assert that both `plugins/concord-codex/engine/` and `plugins/concord-copilot/engine/` stay byte-identical to the shared core files they vendor, including `spawn-cross-platform.js`.

## Non-goals

- Windows CI.
- Rewriting Unix-only test fixtures: symlink and `sh`/`bash` spawn fixtures, executable-bit `chmodSync` fixtures, and the read-only-mode fixtures of the release-script test.
- The Linux/Docker-only container isolation smoke check under `services/agent-team/`.
- Rewriting user-authored shell commands in `review.config.json`.
- `fs.chmodSync(stateDir, 0o700)` in the Copilot state directory adapter, which is a harmless no-op on Windows.

## Residual exposure

- Nothing here has run on a real Windows host. Hook manifests are verified at the schema and content level (`commandWindows` is present, references the right script, and never shells out to `sh` or `bash`), stdin prompt delivery is verified by mocking `child_process.spawn`, and escaping is verified as a pure string transform. Whoever first runs the Codex plugin on native Windows performs the first real check of `commandWindows`.
- Copilot's stdin prompt path is less exercised by its own host than `-p`.
- A `node` installed outside the two fixed locations, including most `nvm-windows` setups, is not found by the Codex hooks, which then do nothing.
- The PowerShell path assumes Windows is installed on `C:`.
- The resolved binary path is escaped but not quoted, as in `cross-spawn`, so a resolved path containing a space is not handled.
- cmd.exe delayed expansion (`!VAR!`) edge cases beyond the escaped character set are not verified.
