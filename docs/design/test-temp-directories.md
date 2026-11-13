# Temporary directories in plugin tests

Plugin tests created temporary directories with `fs.mkdtempSync` and did not remove them, so every local run added directories to the system temp directory. On 2026-10-10 that exhausted the inodes of a development machine (#280).

## Decision

Tests create temporary directories with `tempDir(prefix)` from `plugins/concord/hooks/test/temp-dir.js`. It creates the directory under `os.tmpdir()`, records it, and removes every recorded directory in a `process.once('exit')` handler. `node --test` runs each test file in its own process, so the directories live as long as the file's tests. The exit handler needs no test context, so the many helpers that create a directory outside a test body convert by replacing one call; `t.after` would have needed `t` passed into each of them.

`temp-dir.test.js` holds the check: it fails when any `*.test.js` file that CI runs (every one under a `test` directory below `plugins/`) calls `mkdtemp` or `mkdtempSync` directly, and it runs a fixture test file that creates directories, once passing and once failing, with `TMPDIR` set to an empty directory and asserts that the directory is still empty afterwards.

This change is not stateful: each directory exists only for the life of one test process.

## Cost and residual exposure

A directory is removed when its test file ends, not when its test ends, so a long test file holds all of its directories until it finishes.

The exit handler does not run when the process ends on a signal, such as Ctrl-C, `SIGTERM` or `SIGKILL`, so those runs still leave their directories. Removing directories left by earlier runs is outside #280.

Directories that the code under test creates by itself in the temp directory are not covered, nor a path a test builds next to one of its directories instead of inside it; the check only sees `mkdtemp` calls in test files.
