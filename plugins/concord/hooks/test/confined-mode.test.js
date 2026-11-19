'use strict';
// The read-only guard's two confined kinds: a confined agent and a writable headless session.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const HOOK = path.join(__dirname, '..', 'read-only-guard.js');

function run(data, sid, tool_name, tool_input = {}) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ session_id: sid, tool_name, tool_input }), encoding: 'utf8', env: { ...process.env, EXPLAIN_PR_DIR: data } });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none';
}

const logLines = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function agentSetup() {
  const data = tempDir('cm-data-');
  const root = fs.realpathSync(tempDir('cm-'));
  const round = path.join(root, 'round');
  fs.mkdirSync(path.join(round, 'head'), { recursive: true });
  fs.writeFileSync(path.join(round, 'head', 'a.js'), 'x');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir);
  const mode = { kind: 'agent', dir: round, output: path.join(outDir, 'result.json'), canary: path.join(round, '.canary-A'), log: path.join(data, 'A.log') };
  fs.mkdirSync(path.join(data, 'modes'));
  fs.writeFileSync(path.join(data, 'modes', 'A'), JSON.stringify(mode));
  return { data, root, round, mode };
}

test('confined agent: every call is denied until a Read of the canary has been denied and logged', () => {
  const { data, round, mode } = agentSetup();
  assert.equal(run(data, 'A', 'Read', { file_path: path.join(round, 'head', 'a.js') }), 'deny');
  assert.equal(run(data, 'A', 'Write', { file_path: mode.output, content: '{}' }), 'deny');
  assert.equal(run(data, 'A', 'Read', { file_path: mode.canary }), 'deny');
  assert.deepEqual(logLines(mode.log), [
    { tool: 'Read', decision: 'deny' }, { tool: 'Write', decision: 'deny' }, { tool: 'Read', decision: 'deny', canary: true },
  ]);
  assert.equal(run(data, 'A', 'Read', { file_path: path.join(round, 'head', 'a.js') }), 'allow');
});

test('confined agent: after the canary, reads in the round directory and the one Write are allowed explicitly', () => {
  const { data, round, mode } = agentSetup();
  run(data, 'A', 'Read', { file_path: mode.canary });
  assert.equal(run(data, 'A', 'Read', { file_path: path.join(round, 'head', 'a.js') }), 'allow');
  assert.equal(run(data, 'A', 'Glob', { pattern: '**/*.js', path: round }), 'allow');
  assert.equal(run(data, 'A', 'Grep', { pattern: 'x', path: round, glob: '*.js' }), 'allow');
  assert.equal(run(data, 'A', 'Write', { file_path: mode.output, content: '{}' }), 'allow');
  assert.deepEqual(logLines(mode.log).slice(1).map((l) => l.decision), ['allow', 'allow', 'allow', 'allow']);
});

test('confined agent: any other write, tool, or path is denied', () => {
  const { data, root, round, mode } = agentSetup();
  fs.writeFileSync(path.join(data, 'allowed-tools.json'), JSON.stringify({ trackers: { jira: ['mcp__atl__get'] } }));
  run(data, 'A', 'Read', { file_path: mode.canary });
  const outside = fs.realpathSync(tempDir('cm-out-'));
  for (const [tool, input] of [
    ['Write', { file_path: path.join(round, 'x.json'), content: '' }],
    ['Write', { file_path: path.join(path.dirname(mode.output), 'other.json'), content: '' }],
    ['Write', { file_path: `${round}/../out/result.json`, content: '' }],
    ['Edit', { file_path: mode.output, old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'true' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['Agent', { prompt: 'x' }],
    ['ToolSearch', { query: 'select:mcp__atl__get' }],
    ['mcp__atl__get', { id: 1 }],
    ['Read', { file_path: path.join(outside, 'x') }],
    ['Read', { file_path: path.join(root, 'out', 'result.json') }],
    ['Glob', { pattern: '*', path: outside }],
    ['Grep', { pattern: 'x', path: root }],
  ]) assert.equal(run(data, 'A', tool, input), 'deny', `${tool} ${JSON.stringify(input)}`);
});

test('writable worktree: after the canary, Edit and Write inside the two directories are allowed; Bash and outside paths are denied', () => {
  const data = tempDir('cm-wt-data-');
  const root = fs.realpathSync(tempDir('cm-wt-'));
  const worktree = path.join(root, 'sessions', 's1', 'worktree');
  const session = path.join(root, 'sessions', 's1', 'session');
  const gitDir = path.join(root, 'git');
  for (const d of [worktree, session, gitDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'a.js'), 'x');
  fs.writeFileSync(path.join(gitDir, 'config'), 'x');
  const mode = { kind: 'worktree', worktree, session, canary: path.join(worktree, '.canary-W'), log: path.join(data, 'W.log') };
  fs.mkdirSync(path.join(data, 'modes'));
  fs.writeFileSync(path.join(data, 'modes', 'W'), JSON.stringify(mode));

  assert.equal(run(data, 'W', 'Edit', { file_path: path.join(worktree, 'a.js'), old_string: 'x', new_string: 'y' }), 'deny');
  assert.equal(run(data, 'W', 'Read', { file_path: mode.canary }), 'deny');
  assert.equal(logLines(mode.log).at(-1).canary, true);
  for (const [tool, input] of [
    ['Read', { file_path: path.join(worktree, 'a.js') }],
    ['Grep', { pattern: 'x', path: session }],
    ['Edit', { file_path: path.join(worktree, 'a.js'), old_string: 'x', new_string: 'y' }],
    ['Write', { file_path: path.join(worktree, 'new.js'), content: '' }],
    ['Write', { file_path: path.join(session, 'result.json'), content: '{}' }],
  ]) assert.equal(run(data, 'W', tool, input), 'allow', `${tool} ${JSON.stringify(input)}`);
  // A symlink in the worktree whose target does not exist yet: a write through it would create the target outside.
  fs.symlinkSync(path.join(gitDir, 'hooks-new'), path.join(worktree, 'dangling'));
  for (const [tool, input] of [
    ['Write', { file_path: path.join(worktree, 'dangling'), content: '' }],
    ['Edit', { file_path: path.join(worktree, 'dangling'), old_string: 'x', new_string: 'y' }],
    ['Write', { file_path: path.join(worktree, 'dangling', 'x'), content: '' }],
    ['Bash', { command: 'true' }],
    ['Read', { file_path: path.join(gitDir, 'config') }],
    ['Write', { file_path: path.join(gitDir, 'config'), content: '' }],
    ['Edit', { file_path: path.join(gitDir, 'config'), old_string: 'x', new_string: 'y' }],
    ['Write', { file_path: `${worktree}/../../../git/config`, content: '' }],
    ['Write', { file_path: path.join(root, 'elsewhere.js'), content: '' }],
    ['NotebookEdit', { notebook_path: path.join(worktree, 'n.ipynb') }],
    ['WebFetch', { url: 'https://example.com' }],
    ['ToolSearch', { query: 'x' }],
  ]) assert.equal(run(data, 'W', tool, input), 'deny', `${tool} ${JSON.stringify(input)}`);
});

test('a confined mode whose log cannot be written denies every call', () => {
  const { data, round, mode } = agentSetup();
  fs.writeFileSync(path.join(data, 'modes', 'B'), JSON.stringify({ ...mode, log: path.join(round, 'missing-dir', 'B.log') }));
  assert.equal(run(data, 'B', 'Read', { file_path: mode.canary }), 'deny');
  assert.equal(run(data, 'B', 'Read', { file_path: path.join(round, 'head', 'a.js') }), 'deny');
});

test('explain-pr\'s reading mode still allows silently', () => {
  const { data, round } = agentSetup();
  fs.writeFileSync(path.join(data, 'modes', 'R'), JSON.stringify({ kind: 'read', dir: round }));
  assert.equal(run(data, 'R', 'Read', { file_path: path.join(round, 'head', 'a.js') }), 'none');
  assert.equal(run(data, 'R', 'Bash', { command: 'true' }), 'deny');
});
