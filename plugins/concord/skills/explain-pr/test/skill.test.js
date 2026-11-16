'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'explain-pr.js'), 'utf8');
const [, front, body] = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) || [];

test('the frontmatter names the skill, says when to use it, and sends review and approval elsewhere', () => {
  assert.match(front, /^name: explain-pr\ndescription: >-\n/);
  for (const trigger of ['explain this PR', '이 PR 설명해줘', 'help me understand a pull request before approving']) assert.ok(front.includes(trigger), trigger);
  assert.match(front, /Do NOT use[\s\S]*review-until-approve/);
  assert.match(front, /review-and-fix/);
  assert.ok(skill.split('\n').length < 120, `${skill.split('\n').length} lines`);
});

test('the guide has the eight sections in order, the source labels, and no verdict', () => {
  let at = -1;
  for (const heading of ['TL;DR', 'Intent', 'Diff map', 'Reading order', 'Decisions', 'Reach', 'Evidence', 'Questions for the author']) {
    const i = body.indexOf(heading, at + 1);
    assert.ok(i > at, `${heading} out of order or missing`);
    at = i;
  }
  assert.match(body, /`inferred`/);
  assert.match(body, /`no record`/);
  assert.match(body, /never say(s)? the pull request is correct, safe, or ready/);
});

test('the steps run prepare, allow, and start in that order, and no command ends the mode', () => {
  const used = [...body.matchAll(/node SCRIPT (\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)], ['prepare', 'allow', 'start']);
  assert.deepEqual([...script.matchAll(/cmd === '(\w+)'/g)].map((m) => m[1]), ['prepare', 'allow', 'start']);
  assert.doesNotMatch(body, /SCRIPT (stop|end|off|exit|clear)\b/);
  assert.match(body, /\/clear/);
  assert.match(body, /unlistedTrackers/);
  assert.match(body, /Read nothing in the prepared directory before `start`/);
});

test('the Codex path prints the launch command, names the skipped tools, and asks for hook trust', () => {
  assert.match(body, /`launch`/);
  assert.match(body, /`skippedTools`/);
  assert.match(body, /`skippedServers`/);
  assert.match(body, /Under Claude Code, always start at step 1/);
  assert.match(body, /Under Codex, when your working directory is a prepared directory[^\n]*go to "Read"/);
  assert.ok(body.indexOf('/hooks') < body.indexOf('give `launch` verbatim'), 'hook trust comes before the launch command');
  assert.match(body, /\/hooks/);
  assert.match(body, /git 2\.40/);
  assert.match(body, /reader\.json/);
});

test('the Codex launch prompt names the skill explicitly, so Codex loads it into a session that cannot read the plugin', () => {
  assert.match(script, /'\$concord:explain-pr /);
});

test('before reading, the session checks that the mode is enforced, and stops when it is not', () => {
  const claude = body.indexOf('run `Bash` with the command `true`');
  assert.ok(claude > body.indexOf('node SCRIPT start'), 'the Claude Code check follows start');
  assert.match(body, /run `Bash` with the command `true`[^\n]*denial names the read-only mode[^\n]*not enforced[^\n]*stop without reading/);
  const read = body.indexOf('## Read');
  const codex = body.indexOf('run `ls ~`');
  assert.ok(codex > read && codex < body.indexOf('| File |'), 'the Codex check comes before the files are read');
  assert.match(body, /run `ls ~`[^\n]*succeeds[^\n]*stop without reading/);
});

test('the reader is told not to fork or resume a reading session to act, and how a failed fetch of a private repository is retried', () => {
  assert.match(body, /fork or resume/);
  assert.match(body, /--checkout <local clone>/);
  assert.match(body, /<unparsed mcp_servers form>/);
});
