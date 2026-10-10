'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Deterministic project-check runner for the DoD-exec gate (design §5): "clean"
// requires this to have actually run and passed, not just reviewer silence.
// Commands are configurable per-repo via `review.config.json` at the repo
// root; `execFn` is injectable so unit tests never spawn a real process.

const CONFIG_FILENAME = 'review.config.json';

// Reads `review.config.json` from repoRoot. An ABSENT config DEFERS the gate:
// the review still converges, and the handoff says so ("DEFERRED (no
// review.config.json)"), never "passed". What must never happen is a silent
// DEFAULT gate -- `node --test` on a repo with no node tests finds 0 tests,
// exits 0, and manufactures a false-clean pass. Deferring is honest; defaulting
// is not. A PRESENT-BUT-CORRUPT config still fails closed: a file that was
// written and then broke means an intent existed, and skipping it silently is
// the real accident.
function loadDodConfig(repoRoot, readFileFn = fs.readFileSync) {
  let raw;
  try {
    raw = readFileFn(path.join(repoRoot, CONFIG_FILENAME), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { deferred: true, deferredBy: 'no-config' };
    }
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but unreadable: ${e && e.message ? e.message : e}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but malformed: ${e && e.message ? e.message : e}`);
  }
  // Explicit opt-out: `"dod": null` declares there is no executable gate (an
  // infra/VTL/CDK change validated out-of-band, e.g. post-deploy e2e). Both this
  // and an ABSENT config defer, but for different reasons -- absent means nothing
  // was ever declared (`deferredBy: 'no-config'`), `null` means the repo declared
  // it has no executable gate -- so the handoff wording differs. Either way the
  // review gates still run and the executable DoD is deferred, never faked to a
  // false clean.
  if (parsed && parsed.dod === null) {
    return { deferred: true };
  }
  const dod =
    parsed && Array.isArray(parsed.dod) && parsed.dod.length ? parsed.dod.filter((c) => typeof c === 'string' && c.trim()) : null;
  if (!dod || !dod.length) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but its "dod" field is not a non-empty array of commands`);
  }
  return { dod };
}

// Runs each configured command in order via the injected `execFn(cmd, cwd) ->
// { status, stdout, stderr }`. Fail-fast: stops at the first failing command
// (later commands' output is noise once one has already failed) and returns
// pass/fail plus per-command results for the terminal handoff.
function runDodExec({ cwd, commands, execFn }) {
  const results = [];
  let passed = true;
  for (const cmd of commands || []) {
    const { status, stdout, stderr } = execFn(cmd, cwd);
    const ok = status === 0;
    results.push({ cmd, passed: ok, exitCode: status, output: `${stdout || ''}${stderr || ''}` });
    if (!ok) {
      passed = false;
      break;
    }
  }
  return { passed, results };
}

// Real execFn: a project-authored command string from review.config.json (not
// untrusted runtime input) run through a shell so compound commands ("cd x &&
// y") work the same way they would typed at a terminal.
// The driver's provider executable override is not the DoD's: a test that
// spawns a provider must not silently reach the driver's real CLI. A command
// that needs it sets it inline (`CONCORD_CODEX_BIN=... node ...`).
function defaultExecFn(cmd, cwd) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.CONCORD_CODEX_BIN;
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout, stderr: r.stderr };
}

// The words a DoD command list starts: the leading word of each simple
// command, after any `NAME=value` assignments. A false name would make
// round-start refuse a DoD that runs fine, while a missed name only fails later
// where the reviewer's blocked clause catches it, so anything uncertain is left
// out: a part with a command substitution and a word that is not a plain name
// (a path, a redirect, a quoted word). Builtins and keywords are named here and
// resolved by the shell in missingPrograms. A program reached only through
// another one (an npm script, a shell script, the command after `env`, `exec`
// or a keyword) is not seen.
// Splits on `;`, `|`, `||`, `&&` and newlines outside quotes, and drops a
// comment up to the newline: an unquoted, unescaped `#` at the start of a word,
// meaning at the start of a part, after a blank, or after one of `(`, `)`, `&`,
// `<` or `>`. A lone `&` (as in `2>&1`) stays inside its part. Words are split
// on whitespace outside quotes, so a quoted assignment value such as
// `GOFLAGS="-mod mod"` is one word.
function simpleCommands(cmd) {
  const parts = [];
  let cur = '';
  let quote = null;
  let wordStart = true;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && quote !== "'") { cur += c + (cmd[i + 1] || ''); i++; wordStart = false; continue; }
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; wordStart = false; continue; }
    if (c === '#' && wordStart) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; continue; }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && cmd[i + 1] === '&')) {
      parts.push(cur); cur = ''; wordStart = true;
      if (c !== ';' && c !== '\n' && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
    wordStart = /[\s()&<>]/.test(c);
  }
  parts.push(cur);
  return parts;
}
function commandExecutables(commands) {
  const names = new Set();
  for (const cmd of commands || []) {
    for (const part of simpleCommands(String(cmd))) {
      if (/\$\(|`/.test(part)) continue;
      const words = part.trim().replace(/^[({\s]+/, '').match(/(?:[^\s'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) || [];
      const name = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      if (name && /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

// The names the DoD's shell cannot run, asked of the shell `shell: true` uses so
// its builtins and keywords count as present: `/bin/sh` answers with
// `command -v`; cmd.exe's internal commands are a fixed set.
const CMD_BUILTINS = new Set(['assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if',
  'md', 'mkdir', 'mklink', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd', 'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time', 'title', 'type', 'ver', 'verify', 'vol']);
function missingPrograms(names, cwd, platform = process.platform) {
  if (!names.length) return [];
  if (platform === 'win32') {
    // cmd.exe looks in the working directory before PATH (a `gradlew.bat` in the repository root runs as `gradlew`).
    const { resolveOnPath } = require('./spawn-cross-platform');
    // Lower-case variants too: win32 matches names case-insensitively, and the tests run this branch on Linux.
    const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).flatMap((e) => [e, e.toLowerCase()]);
    const inCwd = (name) => (/\.[^.\\/]+$/.test(name) ? [''] : exts).some((ext) => {
      try { return fs.statSync(path.join(cwd, name + ext)).isFile(); } catch { return false; }
    });
    return names.filter((name) => !CMD_BUILTINS.has(name.toLowerCase()) && !inCwd(name) && resolveOnPath(name) === null);
  }
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('/bin/sh', ['-c', 'for n do command -v "$n" >/dev/null 2>&1 || printf "%s\\n" "$n"; done', 'sh', ...names], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`dod-exec: could not ask /bin/sh which DoD programs exist: ${r.error ? r.error.message : `exit ${r.status}`}`);
  return r.stdout.split('\n').filter(Boolean);
}

module.exports = { CONFIG_FILENAME, loadDodConfig, runDodExec, defaultExecFn, commandExecutables, missingPrograms };
