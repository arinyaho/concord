'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { DENY_REASON } = require('../../core/read-only');

const HOOK = path.join(__dirname, '..', 'read-only-guard.js');

function setup() {
  const dir = tempDir('rog-');
  const prepared = path.join(dir, 'prs', 'p');
  fs.mkdirSync(prepared, { recursive: true });
  fs.mkdirSync(path.join(dir, 'modes'));
  fs.writeFileSync(path.join(dir, 'modes', 'A'), `${fs.realpathSync(prepared)}\n`);
  return { dir, prepared: fs.realpathSync(prepared) };
}

function run(dir, input) {
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, EXPLAIN_PR_DIR: dir } });
  return { stdout: r.stdout, status: r.status };
}

const bash = (sid) => JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });

test('a session in the mode is denied a tool outside the allowed set', () => {
  const { dir, prepared } = setup();
  const r = run(dir, bash('A'));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON(prepared) },
  });
});

test('a session in the mode may Read inside the prepared directory: no output', () => {
  const { dir, prepared } = setup();
  const r = run(dir, JSON.stringify({ session_id: 'A', tool_name: 'Read', tool_input: { file_path: path.join(prepared, 'x') } }));
  assert.deepEqual(r, { stdout: '', status: 0 });
});

test('another session without a mode file is allowed everything: no output', () => {
  const { dir } = setup();
  assert.deepEqual(run(dir, bash('B')), { stdout: '', status: 0 });
});

test('an event without a session_id prints nothing', () => {
  const { dir } = setup();
  assert.deepEqual(run(dir, JSON.stringify({ tool_name: 'Bash', tool_input: {} })), { stdout: '', status: 0 });
});

test('malformed stdin prints nothing and exits 0', () => {
  const { dir } = setup();
  assert.deepEqual(run(dir, 'not json'), { stdout: '', status: 0 });
});

test('hooks.json registers the guard on every PreToolUse', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.PreToolUse.find((e) => e.matcher === '*');
  assert.ok(entry);
  assert.equal(entry.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/read-only-guard.js"');
});
