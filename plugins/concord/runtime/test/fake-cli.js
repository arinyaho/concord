#!/usr/bin/env node
'use strict';
// A fake `claude` or `codex` for the launcher tests. Its behavior comes from behavior.json beside it, since the
// launcher passes it only allowlisted variables; every call is appended to calls.jsonl beside it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const here = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(here, 'behavior.json'), 'utf8'));
const args = process.argv.slice(2);
const stdin = process.platform === 'win32' ? fs.readFileSync(0, 'utf8') : '';
const record = (extra = {}) => fs.appendFileSync(path.join(here, 'calls.jsonl'), `${JSON.stringify({ args, env: Object.keys(process.env).sort(), cwd: process.cwd(), stdin, ...extra })}\n`);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function act(output) {
  if (b.agent === 'fail') process.exit(1);
  if (b.agent === 'slow') sleep(60000);
  if (b.agent === 'big') {
    fs.writeFileSync(output, 'x'.repeat(b.bytes));
    sleep(60000);
  }
  fs.writeFileSync(output, b.output);
}

if (args[0] === 'sandbox') {
  // The pre-flight: `sandbox <profile> -C <cwd> -- <command>`.
  const cmd = args.slice(args.indexOf('--') + 1);
  record({ sandbox: cmd });
  const home = require('node:os').homedir();
  if (cmd.includes('curl')) process.exit(b.network === 'open' ? 0 : 6);
  if (cmd.at(-1) === home) process.exit(b.home === 'open' ? 0 : 1);
  process.exit(b.sandbox === 'broken' ? 1 : 0);
} else if (args[0] === 'exec') {
  const cwd = args[args.indexOf('-C') + 1];
  record({ marker: fs.existsSync(path.join(cwd, '.concord-confined-agent')) });
  act(b.outputPath);
} else {
  // claude -p: what the hook does is real; the fake makes the canary read through the --settings hook command.
  const sid = args[args.indexOf('--session-id') + 1];
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  const mode = JSON.parse(fs.readFileSync(path.join(process.env.EXPLAIN_PR_DIR, 'modes', sid), 'utf8'));
  record({ mode });
  const hook = (tool_name, tool_input) => {
    const r = spawnSync(settings.hooks.PreToolUse[0].hooks[0].command, { shell: true, encoding: 'utf8', input: JSON.stringify({ session_id: sid, tool_name, tool_input }) });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none';
  };
  const output = mode.output || path.join(mode.session, 'result.json');
  if (b.agent !== 'nohook') {
    hook('Read', { file_path: mode.canary });
    if (hook('Write', { file_path: output }) !== 'allow') process.exit(1);
  }
  act(output);
}
