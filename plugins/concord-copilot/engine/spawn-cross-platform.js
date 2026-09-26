'use strict';

// On Windows, a globally-installed CLI (codex, claude, copilot, and any
// npm-shimmed tool) resolves on PATH to a `.cmd`/`.bat` wrapper, not a real
// executable. child_process.spawn/execFileSync cannot exec a `.cmd` directly
// without `shell: true` (Node throws ENOENT/EINVAL otherwise), because
// Windows' CreateProcess only launches PE binaries directly; PATHEXT-based
// resolution of `.cmd`/`.bat` is a shell (cmd.exe) responsibility.
// macOS/Linux binaries are plain executables, so `shell: true` there would
// only add needless quoting risk -- this helper opts in only on win32.
const isWindows = process.platform === 'win32';

// Merge the platform-appropriate spawn options. Callers keep their exact
// binary name and argument array unchanged; only the child_process `opts`
// gain `shell: true` on Windows. This resolves the ENOENT/EINVAL Windows
// throws for a `.cmd`-shimmed binary, but it does NOT make every argument
// shell-safe: Node's docs state `windowsVerbatimArguments` is forced `true`
// whenever the resolved shell is cmd.exe, so Node performs no quoting or
// escaping of `args` in that case -- the caller is fully responsible. Every
// call site behind this helper passes only developer-controlled, quote-free
// arguments (flags, paths, SHAs, branch names) EXCEPT the reviewer-prompt
// and commit-message spawns in core/codex-review-runner.js and
// core/review-cli.js, which can carry arbitrary text containing a literal
// `"`; that gap is unresolved and disclosed in
// docs/superpowers/specs/2026-09-26-windows-support-design.md.
function crossPlatformOpts(opts = {}) {
  return isWindows ? { ...opts, shell: true } : opts;
}

module.exports = { isWindows, crossPlatformOpts };
