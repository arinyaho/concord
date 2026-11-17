'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./temp-dir');
const ro = require('../../core/read-only');

function prepared() {
  const root = fs.realpathSync(tempDir('ro-'));
  const dir = path.join(root, 'prs', 'o__r__1__abc');
  fs.mkdirSync(path.join(dir, 'head'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'head', 'a.js'), 'x');
  return { root, dir };
}
const ev = (tool_name, tool_input = {}, extra = {}) => ({ tool_name, tool_input, ...extra });
// explain-pr's reading mode, as the guard calls it.
const decide = (e, { preparedDir, allowedTools }) => ro.decideClaude(e, { kind: 'read', dir: preparedDir }, allowedTools);

test('decideClaude: Read inside allowed, outside and .. denied with the exact reason', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  assert.deepEqual(decide(ev('Read', { file_path: `${dir}/head/a.js` }), o), { allow: true });
  for (const p of [`${dir}/../x`, '/etc/passwd']) {
    assert.deepEqual(decide(ev('Read', { file_path: p }), o), { allow: false, reason: ro.DENY_REASON(dir) });
  }
  assert.equal(decide(ev('Read', {}), o).allow, false);
  assert.equal(
    ro.DENY_REASON('/d'),
    'explain-pr read-only mode: only reading /d and the tools in allowed-tools.json are allowed. /clear or a new session ends the mode.',
  );
});

test('decideClaude: a symlink inside head/ pointing outside is denied (Review Focus 1)', () => {
  const { dir } = prepared();
  const outside = tempDir('ro-out-');
  fs.writeFileSync(path.join(outside, 'id'), 'secret');
  fs.symlinkSync(outside, path.join(dir, 'head', 'link'));
  const o = { preparedDir: dir, allowedTools: [] };
  assert.equal(decide(ev('Read', { file_path: `${dir}/head/link/id` }), o).allow, false);
  assert.equal(decide(ev('Read', { file_path: `${dir}/head/link/new` }), o).allow, false);
});

test('decideClaude: Read of a not-yet-existing path inside is allowed, with .. segment denied', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  assert.equal(decide(ev('Read', { file_path: `${dir}/head/missing.js` }), o).allow, true);
  assert.equal(decide(ev('Read', { file_path: `${dir}/head/missing/../../../x` }), o).allow, false);
});

test('decideClaude: Glob and Grep need a path inside (Review Focus 5)', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  const allow = (n, i) => decide(ev(n, i), o).allow;
  assert.equal(allow('Glob', { pattern: '**/*.js' }), false);
  assert.equal(allow('Glob', { pattern: '../*', path: dir }), false);
  assert.equal(allow('Glob', { pattern: '/etc/*', path: dir }), false);
  assert.equal(allow('Glob', { pattern: '**/*.js', path: `${dir}/head` }), true);
  assert.equal(allow('Glob', { pattern: '*', path: '/etc' }), false);
  assert.equal(allow('Grep', { pattern: 'x', path: dir, glob: '*.js' }), true);
  assert.equal(allow('Grep', { pattern: 'x', path: dir }), true);
  assert.equal(allow('Grep', { pattern: 'x', path: dir, glob: '/etc/*' }), false);
  assert.equal(allow('Grep', { pattern: 'x', path: dir, glob: '../*' }), false);
  assert.equal(allow('Grep', { pattern: 'x' }), false);
});

test('decideClaude: patterns that name an outside place are denied', () => {
  const { dir } = prepared();
  const outside = tempDir('ro-out2-');
  fs.symlinkSync(outside, path.join(dir, 'head', 'link'));
  const o = { preparedDir: dir, allowedTools: [] };
  const allow = (n, i) => decide(ev(n, i), o).allow;
  assert.equal(allow('Glob', { pattern: 'link/*', path: `${dir}/head` }), false);
  assert.equal(allow('Grep', { pattern: 'x', path: dir, glob: 'head/link/*' }), false);
  assert.equal(allow('Grep', { pattern: 'x', path: `${dir}/head`, glob: 'link/*' }), false);
  assert.equal(allow('Glob', { pattern: '{..,x}/*', path: dir }), false);
  assert.equal(allow('Glob', { pattern: '{/etc/*,x}', path: dir }), false);
  assert.equal(allow('Glob', { pattern: '~/*', path: dir }), false);
  assert.equal(allow('Glob', { pattern: 'head/*.js', path: dir }), true);
});

test('decideClaude: relative paths are denied; a sibling sharing the prefix is outside', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  assert.equal(decide(ev('Read', { file_path: 'head/a.js' }), o).allow, false);
  assert.equal(decide(ev('Glob', { pattern: '*', path: 'head' }), o).allow, false);
  const evil = `${dir}-evil`;
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 'f'), 'x');
  assert.equal(decide(ev('Read', { file_path: `${evil}/f` }), o).allow, false);
  assert.equal(decide(ev('Read', { file_path: `${dir}/head/a.js` }), o).allow, true);
});

test('decideClaude: every other tool is denied; listed tools allowed exactly', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: ['mcp__atlassian__getJiraIssue'] };
  for (const n of ['Bash', 'Write', 'Edit', 'WebFetch', 'Agent', 'SendMessage', 'mcp__x__y', 'mcp__atlassian__getJiraIssue2']) {
    assert.equal(decide(ev(n, { command: 'ls' }), o).allow, false, n);
  }
  assert.equal(decide(ev('mcp__atlassian__getJiraIssue'), o).allow, true);
});

test('decideClaude: a subagent call (agent_id) is checked like any other', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  assert.equal(decide(ev('Bash', { command: 'ls' }, { agent_id: 'a1' }), o).allow, false);
  assert.equal(decide(ev('Read', { file_path: '/etc/passwd' }, { agent_id: 'a1' }), o).allow, false);
  assert.equal(decide(ev('Read', { file_path: `${dir}/head/a.js` }, { agent_id: 'a1' }), o).allow, true);
});

test('decideClaude: ToolSearch is allowed, since it only returns tool definitions', () => {
  const { dir } = prepared();
  assert.equal(decide(ev('ToolSearch', { query: 'select:mcp__a__b' }), { preparedDir: dir, allowedTools: [] }).allow, true);
});

test('decideClaude: a prepared directory that no longer exists denies everything (Review Focus 2)', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: ['mcp__t__r'] };
  fs.rmSync(dir, { recursive: true });
  for (const e of [ev('Read', { file_path: `${dir}/head/a.js` }), ev('Glob', { pattern: '*', path: dir }), ev('mcp__t__r')]) {
    assert.equal(decide(e, o).allow, false);
  }
});

test('decideCodex: outside prsRoot allows everything; inside denies patches, unlisted MCP and local tools', () => {
  const { root, dir } = prepared();
  const prsRoot = path.join(root, 'prs');
  const o = { prsRoot, allowedTools: ['mcp__a__ok'] };
  const out = { cwd: tempDir('ro-cwd-') };
  const inn = { cwd: path.join(dir, 'head') };
  assert.equal(ro.decideCodex({ tool_name: 'apply_patch', ...out }, o).allow, true);
  assert.deepEqual(ro.decideCodex({ tool_name: 'apply_patch', ...inn }, o), { allow: false, reason: ro.DENY_REASON(prsRoot) });
  assert.equal(ro.decideCodex({ tool_name: 'mcp__a__b', ...inn }, o).allow, false);
  assert.equal(ro.decideCodex({ tool_name: 'mcp__a__ok', ...inn }, o).allow, true);
  // Codex names every shell call, unified exec included, `Bash` (captured from codex-cli 0.167).
  assert.equal(ro.decideCodex({ tool_name: 'Bash', ...inn }, o).allow, true);
  assert.equal(ro.decideCodex({ tool_name: 'exec_command', ...inn }, o).allow, false);
  assert.equal(ro.decideCodex({ tool_name: 'update_plan', ...inn }, o).allow, false);
  assert.equal(ro.decideCodex({ tool_name: 'apply_patch' }, o).allow, true);
});

test('mode files: write/read, bad session ids, a mode file that cannot be read or parsed throws', () => {
  const dir = tempDir('ro-data-');
  const { dir: pd } = prepared();
  const mode = { kind: 'read', dir: pd };
  assert.equal(ro.readMode(dir, 's1'), null);
  ro.writeMode(dir, 's1', mode);
  assert.deepEqual(ro.readMode(dir, 's1'), mode);
  assert.equal(ro.readMode(dir, '../s1'), null);
  assert.throws(() => ro.writeMode(dir, '../s1', mode));
  for (const bad of [undefined, null, '', 5]) {
    assert.equal(ro.readMode(dir, bad), null);
    assert.throws(() => ro.writeMode(dir, bad, mode));
  }
  assert.equal(fs.existsSync(path.join(dir, 'modes', 'undefined')), false);
  for (const m of [{ kind: 'read' }, { kind: 'read', dir: 'rel' }, { kind: 'agent', dir: pd }, { kind: 'x', dir: pd }, pd]) {
    assert.throws(() => ro.writeMode(dir, 's2', m), JSON.stringify(m));
  }
  // A mode file that exists but is empty, holds a bare path (the old form), is not a mode, or cannot be read: a throw.
  for (const [name, text] of [['empty', ''], ['path', `${pd}\n`], ['kindless', '{"dir":"/x"}'], ['agent', '{"kind":"agent","dir":"/x"}']]) {
    fs.writeFileSync(path.join(dir, 'modes', name), text);
    assert.throws(() => ro.readMode(dir, name), name);
  }
  fs.mkdirSync(path.join(dir, 'modes', 'adir'));
  assert.throws(() => ro.readMode(dir, 'adir'));
  ro.removeMode(dir, 's1');
  assert.equal(ro.readMode(dir, 's1'), null);
  assert.equal(ro.pruneModes, undefined, 'mode files are never pruned');
});

test('readAllowedTools and allToolNames', () => {
  const dir = tempDir('ro-at-');
  assert.deepEqual(ro.readAllowedTools(dir), {});
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), '{"trackers": "x"}');
  assert.deepEqual(ro.readAllowedTools(dir), {});
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), 'nope');
  assert.deepEqual(ro.readAllowedTools(dir), {});
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), '{"trackers":{"jira":["mcp__a__b","Bash"],"bad":"x","n":[1]}}');
  assert.deepEqual(ro.readAllowedTools(dir), { jira: ['mcp__a__b'], n: [] });
  assert.deepEqual(ro.allToolNames({ jira: ['a', 'b'], notion: ['c'] }), ['a', 'b', 'c']);
});

test('decideClaude: every Glob pattern it allows stays inside the prepared directory under fs.globSync', () => {
  const root = fs.realpathSync(tempDir('ro-glob-'));
  const dir = path.join(root, 'prs', 'o__r__1__abc');
  for (const d of ['head/src/x', 'head/.hidden']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['head/a.js', 'head/b.ts', 'head/src/x/c.ts']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, 'outside', 'secret'), 'x');
  const o = { preparedDir: dir, allowedTools: [] };
  const patterns = ['[.][.]/[.][.]/outside/*', '\\.\\./\\.\\./outside/*', '?./*', '.?/*', '[.]./*', '.[.]/*', '..?/*',
    '.*/*', '[!a][!a]/*', '**/*.js', 'src/**/*.ts', '*.[jt]s', 'head/**/*.ts'];
  const allowed = [];
  for (const pattern of patterns) {
    if (!decide(ev('Glob', { pattern, path: dir }), o).allow) continue;
    allowed.push(pattern);
    for (const p of fs.globSync(pattern, { cwd: dir })) {
      const real = path.resolve(dir, p);
      assert.ok(real === dir || real.startsWith(dir + path.sep), `${pattern} reached ${real}`);
    }
  }
  for (const p of ['**/*.js', 'src/**/*.ts', '*.[jt]s', 'head/**/*.ts']) assert.ok(allowed.includes(p), p);
  for (const p of ['[.][.]/[.][.]/outside/*', '\\.\\./\\.\\./outside/*', '.?/*', '[.]./*']) assert.ok(!allowed.includes(p), p);
});

test('decideClaude: a wildcard segment starting with "." or "[" is denied, whatever the matcher; a literal one is not', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  const allow = (pattern) => decide(ev('Glob', { pattern, path: dir }), o).allow;
  for (const p of ['[.a][.a]/*', '.[!a]/*', '.[^a]/*', '.[[:punct:]]/*', '../*', 'head/../x']) assert.equal(allow(p), false, p);
  for (const p of ['.github/**', '**/*.js', '*.[jt]s', 'head/.config/*.json']) assert.equal(allow(p), true, p);
});
