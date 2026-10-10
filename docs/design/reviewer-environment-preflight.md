# Reviewer environment preflight

A review run checks, before its first reservation, that the executables its reviewers and its DoD need are on `PATH`; verifiers are handed the exact paths they must read; and the reviewer subprocesses the Codex runner starts and the DoD commands do not inherit the driver's provider executable override.

## Preflight in `round-start`

`review-cli round-start` resolves `git`, `node`, and the leading program of every DoD command on `PATH` after argument validation and before it writes the ledger, reserves a launch, or writes a round artifact. A missing name fails the call non-zero with a message naming it and the DoD commands. The check runs on every `round-start`, including a resume.

The check lives in the CLI verb and not in a driver step because both engines call `round-start`: the Codex runner (`core/codex-review-runner.js`) and the Claude Code and Copilot markdown drivers. A driver step would be prose an agent can skip, and the Codex runner would need its own copy. The CLI process inherits the driver's environment in both engines, and so do the reviewers: Claude and Copilot subagents run in the same host shell, and the Codex runner hands its own environment to `codex exec`. The one exception is the runner's artifact-repair launch, which runs with `repairEnvironment` (`core/codex-review-runner.js`) and drops every `PATH` entry inside the repository or the state directory; a name the preflight finds only through such an entry is missing for that launch and fails there at use time.

`dod-exec.commandExecutables` derives the DoD names: `simpleCommands` splits each command on `&&`, `||`, `;`, `|` and newlines outside quotes; a part containing a command substitution (`$(` or a backtick) is skipped; leading `NAME=value` words are dropped; and the first remaining word is named only when it is a plain word, so a path (`./scripts/check.sh`), a redirect or a quoted word is not checked. Words in `SHELL_WORDS` are skipped: shell builtins and keywords such as `cd`, `true`, `export` and `if`, plus `env` and `exec`, which are skipped although `env` is an external program, so the program after them is not checked either. DoD names are not checked for a file target or a `--no-dod` run (including a ledger where `--no-dod` is sticky), because that run executes no DoD; `git` and `node` are always checked.

Every checked name is a plain word, so every check is a filesystem lookup with `resolveOnPath` from `core/spawn-cross-platform.js`, which on POSIX looks for the bare name with an execute bit and on Windows tries each `PATHEXT` extension. It spawns nothing and contacts no provider, so it costs no process and no budget.

## Paths handed to verifiers

The verify prompt lists the correctness artifact's `examined` paths, relative to the repository root, and tells verify not to guess other names. The certify prompt lists the `files` arrays of the group's fix declarations. Certify inspects the fix and hashes exactly the declared files, so the declared files are its scope; `examined` is the review's scope and would point certify at the wrong files. `reviewerPrompt` in `core/round-plan.js` takes the lists as `examined` and `fixFiles`; the Codex runner reads them from the artifacts, and the markdown drivers tell the agent to paste them verbatim.

## Provider executable override

`CONCORD_CODEX_BIN` is removed from the environment of every reviewer subprocess the Codex runner starts (after it has resolved the reviewer's own executable) and from every DoD command `dod-exec` runs. A test a reviewer or the DoD starts therefore cannot reach the driver's real Codex CLI through the override. A command that needs the variable sets it inline (`CONCORD_CODEX_BIN=... node ...`), which overrides the environment.

## State

The change branches on persisted state: `round-start` reads the ledger's sticky `dodDeferred` to decide whether DoD names are checked.

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| no ledger | `round-start`, DoD program missing | exits non-zero naming the program; no ledger, reservation, or round artifact is written | introduced | `round-start refuses before any reservation when a DoD interpreter is missing from the reviewer environment` |
| no ledger | `round-start --no-dod`, DoD program missing | the round starts; DoD names are not checked | introduced | `round-start with --no-dod does not require the DoD interpreters it will not run` |
| ledger with sticky `dodDeferred` | `round-start` resume, DoD program missing | the round resumes; DoD names are not checked because `dodDeferred` empties the DoD command list, while `git` and `node` still are | introduced | `a resumed round-start on a ledger with sticky --no-dod still does not require the DoD interpreters` |
| no ledger | `round-start`, DoD whose quoted script contains a shell separator | the round starts; the split happens outside quotes only, so no word of the script is named | introduced | `round-start accepts a DoD whose quoted script contains a shell separator`; `commandExecutables never names a word that is not a program: quoted separators, substitutions, keywords, redirects and paths` |
| ledger with an open round | `round-start` resume, program missing | exits non-zero naming the program; the ledger is unchanged | introduced | untested, because it runs the same check before the same first write as the fresh-start row |
| any | `round-start`, every program present | unchanged from the base revision | unchanged | the existing `round-start` tests in `review-cli.test.js` |

## Trade-off and residual exposure

The DoD names come from a small parser, and it names only what is certainly a program: a false name would refuse a DoD that runs, while a missed name fails at use time behind the reviewer's `blocked` clause. It therefore leaves unchecked a program reached through another one (whatever an `npm test` script calls, or a program inside a script file, which only running it would reveal), a path-shaped name, every part with a command substitution, and the program after `env` or `exec`. A program a reviewer picks on its own still fails at use time, where the reviewer's `blocked` clause and `harness-failure` remain the backstop. In the Claude and Copilot drivers, a subagent's own shell still inherits `CONCORD_CODEX_BIN` when the user's shell exports it; only the DoD path is covered there.
