'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { DENY_REASON } = require('../../core/read-only');

const CODEX = path.join(__dirname, '..', '..', '..', 'concord-codex');
const HOOK = path.join(CODEX, 'hooks', 'read-only-guard.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'codex-pretooluse');

// Payloads captured from codex-cli 0.167 PreToolUse hooks; cwd and paths are placeholders.
const fixture = (name, cwd) => ({ ...JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')), cwd });

function setup() {
  const home = tempDir('crog-');
  const dir = path.join(home, 'concord', 'explain-pr');
  const prepared = path.join(dir, 'prs', 'o__r__1__abcdefabcdef');
  fs.mkdirSync(path.join(prepared, 'head'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), JSON.stringify({ trackers: { probe: ['mcp__probe__echo'] } }));
  return { home, dir, inside: path.join(prepared, 'head'), elsewhere: tempDir('crog-cwd-') };
}

function run(env, input) {
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  return { stdout: r.stdout, status: r.status };
}

const deny = (dir) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON(path.join(dir, 'prs')) },
});

test('a reading session (cwd inside prs/) is denied apply_patch', () => {
  const { dir, inside } = setup();
  const r = run({ EXPLAIN_PR_DIR: dir }, JSON.stringify(fixture('apply_patch', inside)));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), deny(dir));
});

test('a reading session is denied an unlisted MCP tool and a local function tool', () => {
  const { dir, inside } = setup();
  for (const tool_name of ['mcp__probe__other', 'update_plan']) {
    const r = run({ EXPLAIN_PR_DIR: dir }, JSON.stringify({ ...fixture('mcp', inside), tool_name }));
    assert.deepEqual(JSON.parse(r.stdout), deny(dir), tool_name);
  }
});

test('a reading session may run shell commands and listed MCP tools: no output', () => {
  const { dir, inside } = setup();
  for (const name of ['bash', 'mcp']) {
    assert.deepEqual(run({ EXPLAIN_PR_DIR: dir }, JSON.stringify(fixture(name, inside))), { stdout: '', status: 0 }, name);
  }
});

test('a session elsewhere is allowed everything: no output', () => {
  const { dir, elsewhere } = setup();
  for (const name of ['apply_patch', 'bash', 'mcp']) {
    assert.deepEqual(run({ EXPLAIN_PR_DIR: dir }, JSON.stringify(fixture(name, elsewhere))), { stdout: '', status: 0 }, name);
  }
});

test('the data directory comes from CODEX_HOME even when a Claude Code session id is set', () => {
  const { home, dir, inside } = setup();
  const env = { CODEX_HOME: home, CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: tempDir('crog-claude-'), EXPLAIN_PR_DIR: '' };
  assert.deepEqual(JSON.parse(run(env, JSON.stringify(fixture('apply_patch', inside))).stdout), deny(dir));
});

test('malformed stdin prints nothing and exits 0', () => {
  const { dir } = setup();
  assert.deepEqual(run({ EXPLAIN_PR_DIR: dir }, 'not json'), { stdout: '', status: 0 });
});

test('hooks.json runs the guard on every PreToolUse', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(CODEX, 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.PreToolUse.find((e) => e.matcher === '*');
  assert.ok(entry);
  assert.match(entry.hooks[0].command, /\/hooks\/read-only-guard\.js/);
});
