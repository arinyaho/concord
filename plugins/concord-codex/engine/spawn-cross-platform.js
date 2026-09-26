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

// Quote a single argument so a Windows CommandLineToArgvW-compliant parser
// (the argv-splitting every Windows child process, including cmd.exe's own
// `%*`-style forwarding, applies to its command line) reconstructs it as one
// argument -- most importantly when it contains a space, which is the
// common case this helper exists for: a Windows user profile path
// ("C:\Users\Jane Doe\..."), a "Program Files" install, or a multi-word
// prompt/commit-message string would otherwise split into multiple argv
// entries once `shell: true` stops Node from quoting anything itself.
//
// Algorithm: the documented CommandLineToArgvW quoting rule -- a run of N
// backslashes immediately before a double quote becomes 2N+1 backslashes
// (escaping the quote); a run of N backslashes at the end of the whole
// argument (immediately before the closing quote this function adds)
// becomes 2N (so the closing quote is never accidentally escaped); every
// other character, including cmd.exe metacharacters like & | ^ % ( ) < > !,
// passes through literally inside the quotes. This closes the argv-splits-
// on-a-space/quote gap. It does NOT protect against cmd.exe's OWN command-
// line parsing (its `%VAR%` expansion and `&`/`|`/`^` operators are parsed
// before CommandLineToArgvW ever sees the string, and quoting alone does not
// fully suppress that in cmd.exe) -- closing that narrower, harder-to-verify
// layer needs a real Windows host to test against, which this repo does not
// have; it remains a disclosed residual gap.
function quoteArgumentForWindows(arg) {
  const value = String(arg);
  if (value !== '' && !/[ \t"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      result += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

// Apply the quoting above to every argument, only on Windows -- POSIX
// shells and direct (non-shell) exec need no such rewrite, and rewriting
// there would only add needless, incorrect escaping.
function crossPlatformArgs(args = []) {
  return isWindows ? args.map(quoteArgumentForWindows) : args;
}

module.exports = { isWindows, crossPlatformOpts, crossPlatformArgs, quoteArgumentForWindows };
