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

// Merge the platform-appropriate spawn options: adds `shell: true` on
// Windows only. Node's docs state `windowsVerbatimArguments` is forced
// `true` whenever the resolved shell is cmd.exe, so once `shell: true` is
// set, Node performs NO quoting or escaping of `args` itself -- the caller
// is fully responsible, which is what `crossPlatformArgs` below is for.
function crossPlatformOpts(opts = {}) {
  return isWindows ? { ...opts, shell: true } : opts;
}

// The quoting/escaping below is `cross-spawn`'s algorithm (the de facto
// standard fix for this exact Windows problem, MIT-licensed,
// github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js),
// reproduced rather than re-derived, after a first, self-derived version
// of this file shipped with a real gap: it only quoted an argument that
// contained a space, tab, or double quote, so a value like a git ref
// `foo&whoami` -- no space, no quote -- passed through unescaped, and on
// Windows `&` is a cmd.exe command separator, not ordinary ref text. A
// GitHub Codex review on this exact code caught it (PR #113). Quoting
// alone cannot fix that: cmd.exe's OWN command-line reader interprets
// `&`/`|`/`^`/`<`/`>`/`%VAR%`/etc. as operators or expansion BEFORE the
// argument ever reaches CommandLineToArgvW (the child process' own argv
// parser) -- a POSIX shell honors quotes for this, cmd.exe does not.
//
// See https://qntm.org/cmd for the reasoning cross-spawn's algorithm is
// based on. Two layers:
//
// 1. CommandLineToArgvW quoting, so the argv-splitting every Windows
//    child process' own C runtime startup applies to its command line
//    reconstructs this as one argument even when it contains a space
//    (the common case: "C:\Users\Jane Doe\...", "Program Files") or an
//    embedded double quote: a run of N backslashes immediately before a
//    double quote becomes 2N+1 backslashes (escaping the quote); a run
//    of N backslashes at the very end (immediately before the closing
//    quote this adds) becomes 2N (so the closing quote is never
//    accidentally escaped); every other character passes through
//    literally inside the quotes.
// 2. cmd.exe metacharacter escaping, applied to the ALREADY-quoted
//    result (including the quote characters cross-spawn just added):
//    prefix every character cmd.exe's own reader treats specially with
//    `^`, its escape character, so cmd.exe passes each one through
//    literally instead of acting on it -- closing the layer quoting
//    alone cannot reach.
//
// Known limitation, not silently glossed over: `^`-escaping `%` is the
// same technique cross-spawn ships, and like cross-spawn it does not
// cover every documented cmd.exe edge case around delayed (`!VAR!`)
// expansion. This repo has no Windows host to verify the full edge-case
// set against; see
// docs/superpowers/specs/2026-09-26-windows-support-design.md for what
// remains explicitly untested.
const META_CHARS_RE = /([()[\]%!^"`<>&|;, *?])/g;

function quoteArgumentForWindows(arg) {
  let value = String(arg);
  // A run of backslashes immediately before a double quote: double it and
  // escape the quote.
  value = value.replace(/(?=(\\+?))\1"/g, '$1$1\\"');
  // A run of backslashes at the very end of the string (immediately before
  // the closing quote this function adds): double it.
  value = value.replace(/(?=(\\+?))\1$/, '$1$1');
  // Every other backslash occurs literally. Quote the whole thing, then
  // escape cmd.exe metacharacters -- including the quotes just added.
  return `"${value}"`.replace(META_CHARS_RE, '^$1');
}

// The command/binary name goes through the same cmd.exe-metacharacter
// escape (no quoting -- it is never user- or diff-derived text in this
// codebase, just a literal binary name like `codex`/`git`/`node`, so this
// is a defensive completeness measure matching the reference algorithm
// exactly, not a fix for an active bug).
function escapeCommandForWindows(bin) {
  return String(bin).replace(META_CHARS_RE, '^$1');
}

// Apply the escaping above to every argument, only on Windows -- POSIX
// shells and direct (non-shell) exec need no such rewrite, and rewriting
// there would only add needless, incorrect escaping.
function crossPlatformArgs(args = []) {
  return isWindows ? args.map(quoteArgumentForWindows) : args;
}

function crossPlatformCommand(bin) {
  return isWindows ? escapeCommandForWindows(bin) : bin;
}

module.exports = {
  isWindows,
  crossPlatformOpts,
  crossPlatformArgs,
  crossPlatformCommand,
  quoteArgumentForWindows,
  escapeCommandForWindows,
};
