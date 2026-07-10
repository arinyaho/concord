'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Deterministic project-check runner for the DoD-exec gate (design §5): "clean"
// requires this to have actually run and passed, not just reviewer silence.
// Commands are configurable per-repo via `review.config.json` at the repo
// root; `execFn` is injectable so unit tests never spawn a real process.

const CONFIG_FILENAME = 'review.config.json';

// Reads `review.config.json` from repoRoot. An ABSENT config is a hard error
// (harness-failure): there is no silent default. On a repo with no node tests,
// a silent `node --test` default finds 0 tests, exits 0, and manufactures a
// false-clean DoD pass -- violating concord's fail-closed / distrust-green
// principle. The user must declare their gate explicitly. A PRESENT-BUT-CORRUPT
// config also fails closed.
function loadDodConfig(repoRoot, readFileFn = fs.readFileSync) {
  let raw;
  try {
    raw = readFileFn(path.join(repoRoot, CONFIG_FILENAME), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(
        `harness-failure: no ${CONFIG_FILENAME} at the repo root -- declare your DoD gate, e.g. {"dod":["node --test"]} or {"dod":["pnpm build"]}. concord will not run a silent default gate that can pass on a repo it never actually tested (false clean).`,
      );
    }
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but unreadable: ${e && e.message ? e.message : e}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but malformed: ${e && e.message ? e.message : e}`);
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
function defaultExecFn(cmd, cwd) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout, stderr: r.stderr };
}

module.exports = { CONFIG_FILENAME, loadDodConfig, runDodExec, defaultExecFn };
