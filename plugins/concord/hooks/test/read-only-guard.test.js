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
  fs.writeFileSync(path.join(dir, 'modes', 'A'), JSON.stringify({ kind: 'read', dir: fs.realpathSync(prepared) }));
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

test('a subagent call in a session in the mode is denied', () => {
  const { dir } = setup();
  const r = run(dir, JSON.stringify({ session_id: 'A', agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('a mode file that exists but cannot be read or parsed denies every call (fail closed)', () => {
  const { dir, prepared } = setup();
  fs.mkdirSync(path.join(dir, 'modes', 'D'));
  fs.writeFileSync(path.join(dir, 'modes', 'E'), '');
  fs.writeFileSync(path.join(dir, 'modes', 'F'), `${prepared}\n`);
  fs.writeFileSync(path.join(dir, 'modes', 'G'), '{"kind":"agent"');
  for (const sid of ['D', 'E', 'F', 'G']) {
    const read = run(dir, JSON.stringify({ session_id: sid, tool_name: 'Read', tool_input: { file_path: path.join(prepared, 'x') } }));
    assert.equal(JSON.parse(read.stdout).hookSpecificOutput.permissionDecision, 'deny', sid);
    const r = run(dir, bash(sid));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', sid);
  }
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

test('the hook reads the Claude Code data directory even when the session id is not in its environment', () => {
  const base = tempDir('rog-cfg-');
  const dir = path.join(base, 'concord', 'explain-pr');
  const prepared = path.join(dir, 'prs', 'p');
  fs.mkdirSync(prepared, { recursive: true });
  fs.mkdirSync(path.join(dir, 'modes'));
  fs.writeFileSync(path.join(dir, 'modes', 'A'), JSON.stringify({ kind: 'read', dir: fs.realpathSync(prepared) }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: base, CODEX_HOME: tempDir('rog-codex-') };
  delete env.EXPLAIN_PR_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [HOOK], { input: bash('A'), encoding: 'utf8', env });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hooks.json registers the guard on every PreToolUse', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.PreToolUse.find((e) => e.matcher === '*');
  assert.ok(entry);
  assert.equal(entry.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/read-only-guard.js"');
});

test('a name in allowed-tools.json that is not an MCP tool is not allowed', () => {
  const { dir } = setup();
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), JSON.stringify({ trackers: { jira: ['Bash', 'Write', 'mcp__a__get'] } }));
  const r = run(dir, bash('A'));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(run(dir, JSON.stringify({ session_id: 'A', tool_name: 'mcp__a__get', tool_input: {} })), { stdout: '', status: 0 });
});
