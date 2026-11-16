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

test('decideClaude: Read inside allowed, outside and .. denied with the exact reason', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  assert.deepEqual(ro.decideClaude(ev('Read', { file_path: `${dir}/head/a.js` }), o), { allow: true });
  for (const p of [`${dir}/../x`, '/etc/passwd']) {
    assert.deepEqual(ro.decideClaude(ev('Read', { file_path: p }), o), { allow: false, reason: ro.DENY_REASON(dir) });
  }
  assert.equal(ro.decideClaude(ev('Read', {}), o).allow, false);
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
  assert.equal(ro.decideClaude(ev('Read', { file_path: `${dir}/head/link/id` }), o).allow, false);
  assert.equal(ro.decideClaude(ev('Read', { file_path: `${dir}/head/link/new` }), o).allow, false);
});

test('decideClaude: Read of a not-yet-existing path inside is allowed, with .. segment denied', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  assert.equal(ro.decideClaude(ev('Read', { file_path: `${dir}/head/missing.js` }), o).allow, true);
  assert.equal(ro.decideClaude(ev('Read', { file_path: `${dir}/head/missing/../../../x` }), o).allow, false);
});

test('decideClaude: Glob and Grep need a path inside (Review Focus 5)', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: [] };
  const allow = (n, i) => ro.decideClaude(ev(n, i), o).allow;
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
  const allow = (n, i) => ro.decideClaude(ev(n, i), o).allow;
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
  assert.equal(ro.decideClaude(ev('Read', { file_path: 'head/a.js' }), o).allow, false);
  assert.equal(ro.decideClaude(ev('Glob', { pattern: '*', path: 'head' }), o).allow, false);
  const evil = `${dir}-evil`;
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 'f'), 'x');
  assert.equal(ro.decideClaude(ev('Read', { file_path: `${evil}/f` }), o).allow, false);
  assert.equal(ro.decideClaude(ev('Read', { file_path: `${dir}/head/a.js` }), o).allow, true);
});

test('decideClaude: every other tool is denied; listed tools allowed exactly', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: ['mcp__atlassian__getJiraIssue'] };
  for (const n of ['Bash', 'Write', 'Edit', 'WebFetch', 'Agent', 'SendMessage', 'mcp__x__y', 'mcp__atlassian__getJiraIssue2']) {
    assert.equal(ro.decideClaude(ev(n, { command: 'ls' }), o).allow, false, n);
  }
  assert.equal(ro.decideClaude(ev('mcp__atlassian__getJiraIssue'), o).allow, true);
});

test('decideClaude: an agent_id call is not checked', () => {
  const { dir } = prepared();
  assert.equal(ro.decideClaude(ev('Bash', {}, { agent_id: 'a1' }), { preparedDir: dir, allowedTools: [] }).allow, true);
});

test('decideClaude: a prepared directory that no longer exists denies everything (Review Focus 2)', () => {
  const { dir } = prepared();
  const o = { preparedDir: dir, allowedTools: ['mcp__t__r'] };
  fs.rmSync(dir, { recursive: true });
  for (const e of [ev('Read', { file_path: `${dir}/head/a.js` }), ev('Glob', { pattern: '*', path: dir }), ev('mcp__t__r')]) {
    assert.equal(ro.decideClaude(e, o).allow, false);
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
  for (const n of ['shell', 'exec_command', 'local_shell']) assert.equal(ro.decideCodex({ tool_name: n, ...inn }, o).allow, true, n);
  assert.equal(ro.decideCodex({ tool_name: 'update_plan', ...inn }, o).allow, false);
  assert.equal(ro.decideCodex({ tool_name: 'apply_patch' }, o).allow, true);
});

test('mode files: write/read, prune by age, bad session ids', () => {
  const dir = tempDir('ro-data-');
  const { dir: pd } = prepared();
  assert.equal(ro.readMode(dir, 's1'), null);
  ro.writeMode(dir, 's1', pd);
  assert.equal(ro.readMode(dir, 's1'), fs.realpathSync(pd));
  assert.equal(ro.readMode(dir, '../s1'), null);
  assert.throws(() => ro.writeMode(dir, '../s1', pd));
  for (const bad of [undefined, null, '', 5]) {
    assert.equal(ro.readMode(dir, bad), null);
    assert.throws(() => ro.writeMode(dir, bad, pd));
  }
  assert.equal(fs.existsSync(path.join(dir, 'modes', 'undefined')), false);
  ro.writeMode(dir, 'old', pd);
  ro.writeMode(dir, 'recent', pd);
  const now = Date.now();
  const age = (n, days) => fs.utimesSync(path.join(dir, 'modes', n), new Date(now - days * 864e5), new Date(now - days * 864e5));
  age('old', 31);
  age('recent', 29);
  assert.equal(ro.pruneModes(dir, now), 1);
  assert.equal(ro.readMode(dir, 'old'), null);
  assert.notEqual(ro.readMode(dir, 'recent'), null);
  assert.equal(ro.pruneModes(tempDir('ro-empty-'), now), 0);
});

test('readAllowedTools and allToolNames', () => {
  const dir = tempDir('ro-at-');
  assert.deepEqual(ro.readAllowedTools(dir), {});
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), '{"trackers": "x"}');
  assert.deepEqual(ro.readAllowedTools(dir), {});
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), 'nope');
  assert.deepEqual(ro.readAllowedTools(dir), {});
  fs.writeFileSync(path.join(dir, 'allowed-tools.json'), '{"trackers":{"jira":["a","b"],"bad":"x","n":[1]}}');
  assert.deepEqual(ro.readAllowedTools(dir), { jira: ['a', 'b'], n: [] });
  assert.deepEqual(ro.allToolNames({ jira: ['a', 'b'], notion: ['c'] }), ['a', 'b', 'c']);
});
