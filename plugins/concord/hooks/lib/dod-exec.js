'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Deterministic project-check runner for the DoD-exec gate (design §5): "clean"
// requires this to have actually run and passed, not just reviewer silence.
// Commands are configurable per-repo via `review.config.json` at the repo
// root; `execFn` is injectable so unit tests never spawn a real process.

const DEFAULT_DOD_COMMANDS = ['node --test'];
const CONFIG_FILENAME = 'review.config.json';

// Reads `review.config.json` from repoRoot. Missing/corrupt config degrades to
// the default command list rather than throwing (mirrors review.js's
// readLedger: a broken durable file is "nothing yet", not a blocker).
function loadDodConfig(repoRoot, readFileFn = fs.readFileSync) {
  try {
    const raw = readFileFn(path.join(repoRoot, CONFIG_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    const dod = Array.isArray(parsed.dod) && parsed.dod.length ? parsed.dod.filter((c) => typeof c === 'string' && c.trim()) : null;
    return { dod: dod && dod.length ? dod : DEFAULT_DOD_COMMANDS };
  } catch (e) {
    return { dod: DEFAULT_DOD_COMMANDS };
  }
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

module.exports = { DEFAULT_DOD_COMMANDS, CONFIG_FILENAME, loadDodConfig, runDodExec, defaultExecFn };
