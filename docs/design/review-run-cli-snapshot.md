# Review run code snapshot

A review run executes the code version it started with. The Codex updater removes the previous version directory, so a run that spawned `node <plugin>/bin/review-cli.js` for every ledger verb failed with `MODULE_NOT_FOUND` after an update and could not record its own failure (#309).

## Decision

`plugins/concord-codex/bin/review-and-fix.js` calls `snapshotRunEngine` (`plugins/concord/core/run-snapshot.js`) before it loads the runner. The snapshot is a directory `concord-run-<pid>-<random>` under `os.tmpdir()` (mode 0700, falling back to `/tmp` when the temp directory is inside the repository) holding every regular `.js` file of the plugin's `engine/` directory, `bin/review-cli.js`, and a `package.json` of type `commonjs`. The driver loads `codex-review-runner` from the snapshot and passes `cliPath: snapshot.cliPath`, so the runner's `cliPath` binding is the one path every in-run CLI call uses. Reviewer subagents receive that binding (#310): see "Path handed to reviewers".

Copying the whole `engine/` directory includes modules loaded lazily, such as `initiative-report`, without a list that could drift. The copy source is the driver's own plugin directory, never a path from the repository, the state directory or the environment. Files are written with `wx` and mode 0400, so nothing is overwritten and nothing is written in the repository.

`nextStep.cliPath` and `carryCommand` are read by a person or a later session after the run has ended and its snapshot was deleted. They use `publicCliPath`, the plugin's own `bin/review-cli.js`. That path works until the next update and then fails with `MODULE_NOT_FOUND` without side effects; running the driver again snapshots the installed version. The Copilot package has no driver; it carries the same runner through `engine/`, and its CLI is driven one verb at a time by the skill.

## Path handed to reviewers

Every role prompt built by `reviewerPrompt` ends with one sentence naming the run's `cliPath` and forbidding any other `review-cli.js` path, so repository guidance never needs to name one. The runner also exports the same value to each reviewer child process as `CONCORD_REVIEW_CLI`. The prompt is the primary channel because native Claude subagents do not inherit the runner's environment; the native driver (`review-driver.md`, `commands/review-and-fix.md`) appends the same sentence with `${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js`. The value is the snapshot path, never the installed plugin directory, so it stays valid after an update.

## Cleanup

The driver removes the snapshot on `exit`; `handleSignals` turns SIGINT and SIGTERM into exits. Each `snapshotRunEngine` call first removes snapshots of killed runs: a direct child of the temp directory whose name matches `^concord-run-(\d+)-[A-Za-z0-9]{6}$`, is a real directory (not a symlink) owned by the current user, whose pid is not running, and whose mtime is over 24 hours old. Deletion targets come only from `mkdtemp` in the same process or that match, never from the ledger, state directory or environment. `resume <ref>` starts a new process and takes a new snapshot of the installed version.

## Stateful change

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| plugin directory removed mid-run | next CLI verb | runs from the snapshot; every call reports the starting version | introduced | `a plugin update that removes the starting version directory mid-run does not break the run (#309)` |
| plugin directory removed | driver loads a lazily required module | module found in the snapshot | introduced | `the driver loads every engine module from its snapshot after the plugin directory is gone (#309)` |
| temp directory inside the repository | snapshot | placed in `/tmp`; repository unchanged | introduced | `a snapshot is never placed inside the repository, even when TMPDIR points there` |
| snapshot of a killed run | next driver start | removed only when dead pid, own, old, real directory; live, fresh, symlinked or differently named entries kept | introduced | `reapStale removes only old, dead-pid, own, real snapshot directories` |
| run ends | driver exit | snapshot removed | introduced | `the Codex launcher runs from a snapshot, tells later readers the plugin path, and removes the snapshot on exit (#309)`; a signal ends the run through the runner's handlers, untested, because it needs a real driver run |
| update installs a new version, new run starts | driver start | snapshots the new version | unchanged in effect | untested, because a new process always copies the installed directory |
| two runs at once | both start | separate directories, no shared state | introduced | name carries the pid and a random suffix; untested, because `mkdtemp` guarantees it |

## Residual exposure

A snapshot of a run killed by SIGKILL stays up to 24 hours and about 1 MB. The Claude driver (`plugins/concord/commands/review-and-fix.md`) and the Copilot skill keep calling the plugin directory: Claude Code retains old version directories (`.orphaned_at` marker and an `.in_use` registry of live processes), so the reported failure does not occur there, but whether its age-based cleanup can remove the directory of a long-running or detached run is not verified. A snapshot in the Claude driver would need a copy step and a temp path that the model carries across context compaction, which adds more failure modes than it removes. The environment passed to `node` (`NODE_OPTIONS` and similar) is trusted as before.
