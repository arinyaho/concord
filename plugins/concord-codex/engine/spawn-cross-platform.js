'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

// `doubleEscapeMetaChars`: when the resolved binary is itself a
// `node_modules/.bin/*.cmd` shim (see CMD_SHIM_RE below), the shim's own
// `cmd.exe` invocation consumes one escaping pass before re-expanding
// `%*` to forward the real arguments, so a second pass is needed for the
// final target to see correctly-escaped arguments -- exactly cross-spawn's
// own `escapeArgument(arg, doubleEscapeMetaChars)` signature and reasoning.
function quoteArgumentForWindows(arg, doubleEscapeMetaChars) {
  let value = String(arg);
  // A run of backslashes immediately before a double quote: double it and
  // escape the quote.
  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // A run of backslashes (zero or more) at the very end of the string
  // (immediately before the closing quote this function adds): double it.
  value = value.replace(/(?=(\\+?)?)\1$/, '$1$1');
  // Every other backslash occurs literally. Quote the whole thing, then
  // escape cmd.exe metacharacters -- including the quotes just added.
  value = `"${value}"`.replace(META_CHARS_RE, '^$1');
  if (doubleEscapeMetaChars) value = value.replace(META_CHARS_RE, '^$1');
  return value;
}

// The command/binary name goes through the same cmd.exe-metacharacter
// escape (no quoting -- see resolveOnPath below for why a space in a
// resolved path is a known, accepted limitation shared with cross-spawn).
function escapeCommandForWindows(bin) {
  return String(bin).replace(META_CHARS_RE, '^$1');
}

// Apply the escaping above to every argument, only on Windows -- POSIX
// shells and direct (non-shell) exec need no such rewrite, and rewriting
// there would only add needless, incorrect escaping. `doubleEscapeMetaChars`
// should be the result of `isCmdShim(resolveOnPath(bin))` for the same
// `bin` this call's command resolved to (see needsDoubleEscape below).
function crossPlatformArgs(args = [], doubleEscapeMetaChars = false) {
  return isWindows ? args.map((a) => quoteArgumentForWindows(a, doubleEscapeMetaChars)) : args;
}

// A Windows PATH component containing a space is conventionally wrapped in
// a matching pair of double quotes (e.g. `"C:\Program Files\Git\cmd"`); a
// GitHub Codex review on this exact code (PR #113) caught that an
// unstripped pair left `path.join` building a literal, nonexistent path
// (`"C:\Program Files\Git\cmd"\git.EXE`, quotes and all), so a real,
// correctly-installed Git or provider was reported missing. Strip exactly
// one matching leading/trailing quote pair -- not every quote, so a
// directory name that legitimately contains one is not corrupted.
function unquotePathEntry(dir) {
  return dir.length >= 2 && dir[0] === '"' && dir[dir.length - 1] === '"' ? dir.slice(1, -1) : dir;
}

// Resolve `bin` to an absolute path by searching PATH directories ONLY --
// deliberately never the current working directory. A GitHub Codex review
// on this exact code (PR #113) caught a real Windows footgun: with
// `shell: true`, cmd.exe's own bare-name resolution searches the child
// process' cwd BEFORE PATH, and every call site behind this helper sets
// cwd to the repository under review. review-until-green exists to review
// arbitrary, untrusted checkouts -- one containing a committed `git.cmd`
// or `codex.cmd` at its root could have that file executed the moment the
// review starts, before any reviewer or sandbox logic runs at all. Passing
// spawn/execFileSync an absolute resolved path instead of the bare name
// means cmd.exe performs no bare-name search of its own, so cwd is never
// consulted for this. Modeled on cross-spawn's `resolveCommand`, without
// its `which` dependency (this repo has none): walk `PATH`, try each
// `PATHEXT` extension (Windows' own default list) when `bin` has none.
//
// `excludeDir` (pass the repository under review) closes a second,
// distinct route to the same class of bug that a follow-up GitHub Codex
// review round caught: PATH itself, not just cwd, can be untrustworthy.
// When Concord is launched through an npm/pnpm script inside the reviewed
// repository, that script's own tooling conventionally prepends the
// repository's `node_modules/.bin` to PATH for the child process -- so a
// naive PATH-only search would find and return a repository-controlled
// `git.cmd`/`codex.cmd`/provider shim there and treat it as trusted. Any
// candidate whose resolved, absolute path falls inside `excludeDir` is
// skipped, exactly like cwd is never searched at all.
//
// Returns `null`, not the bare name, when nothing (uncontrolled) matches
// on PATH -- an earlier version of this function returned the bare name
// as a fallback, reasoning that "the eventual ENOENT is the honest
// failure". A follow-up GitHub Codex review caught that this reasoning
// was wrong: the bare name still goes back into a `shell: true` spawn, so
// cmd.exe performs its OWN bare-name search (cwd first) on exactly that
// fallback value, recreating the vulnerability this function exists to
// close, for the specific case of an uninstalled or misconfigured
// provider. The caller (crossPlatformCommand) must fail closed on `null`,
// not spawn anyway.
function resolveOnPath(bin, excludeDir) {
  if (/[\\/]/.test(bin)) return bin; // already a path; do not search PATH for it
  const excludeResolved = excludeDir ? path.resolve(String(excludeDir)) : null;
  const isExcluded = (candidate) => {
    if (!excludeResolved) return false;
    const rel = path.relative(excludeResolved, path.resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean).map(unquotePathEntry);
  const hasExt = /\.[^.\\/]+$/.test(bin);
  const exts = hasExt ? [''] : String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile() && !isExcluded(candidate)) return candidate;
      } catch {
        // Not present at this candidate -- keep searching.
      }
    }
  }
  return null;
}

// cross-spawn's own shim-detection: a resolved path shaped like a local
// npm-bin `.cmd` shim (as opposed to a globally-installed one) needs the
// double-escape pass above. Exposed separately from crossPlatformCommand
// so a caller can compute `doubleEscapeMetaChars` for crossPlatformArgs
// using the exact same resolved path crossPlatformCommand used, rather
// than guessing from the bare name.
const CMD_SHIM_RE = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function isCmdShim(resolvedPath) {
  return typeof resolvedPath === 'string' && CMD_SHIM_RE.test(resolvedPath);
}

// Resolve + escape the command for spawn/execFileSync's first argument.
// `excludeDir` should be the repository under review (its cwd at every
// call site) -- see resolveOnPath's doc comment for why PATH itself, not
// only cwd, needs that exclusion. Throws on win32 when `bin` cannot be
// found on (uncontrolled) PATH at all, rather than falling back to the
// bare name (see resolveOnPath's doc comment for why that fallback
// reintroduced the cwd-search vulnerability for exactly the "provider
// isn't installed" case).
function crossPlatformCommand(bin, excludeDir) {
  if (!isWindows) return bin;
  const resolved = resolveOnPath(bin, excludeDir);
  if (resolved === null) {
    throw new Error(`harness-failure: "${bin}" was not found on a trusted PATH entry; refusing to spawn it unresolved on Windows (cmd.exe would otherwise search the reviewed repository's own directory first)`);
  }
  return escapeCommandForWindows(resolved);
}

// Convenience for callers building the `doubleEscapeMetaChars` argument to
// crossPlatformArgs: resolves `bin` (again, with the same `excludeDir`;
// resolution is a cheap filesystem walk, not a hot path) and reports
// whether it is a local node_modules/.bin/*.cmd shim. Returns `false` on
// POSIX and when `bin` cannot be resolved at all (crossPlatformCommand is
// the one responsible for failing closed on that; this helper only
// answers the escaping question).
function needsDoubleEscape(bin, excludeDir) {
  if (!isWindows) return false;
  return isCmdShim(resolveOnPath(bin, excludeDir));
}

module.exports = {
  isWindows,
  crossPlatformOpts,
  crossPlatformArgs,
  crossPlatformCommand,
  needsDoubleEscape,
  quoteArgumentForWindows,
  escapeCommandForWindows,
  resolveOnPath,
  isCmdShim,
};
