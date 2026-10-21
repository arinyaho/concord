'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');

test('SKILL.md names the skill and instructs the whole loop with scripts that exist', () => {
  assert.match(skill, /^---\nname: review-until-approve\n/);
  for (const verb of ['start', 'round', 'approve', 'waive', 'stop']) assert.match(skill, new RegExp(`approve\\.js" ${verb} `));
  assert.match(skill, /watch\.js/);
  for (const file of ['approve.js', 'watch.js']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', file)));
  assert.match(skill, /never request changes, merge, push/i);
});

test('the description does not promise a wait without model calls on every harness', () => {
  const description = skill.slice(0, skill.indexOf('\n---', 4));
  assert.doesNotMatch(description, /without spending tokens/);
  assert.match(description, /Codex/);
});

// The Claude Code wait must outlast Monitor's 30 minutes: a background Bash command (up to 2 hours)
// with --max-wait below that cap, re-armed silently on idle or a killed run, never ended by the model.
const claudeWait = (() => {
  const from = skill.indexOf('- Claude Code:');
  return skill.slice(from, skill.indexOf('- Codex:', from));
})();

test('the Claude Code wait uses a background Bash command whose --max-wait fits under the 2 hour cap', () => {
  assert.match(claudeWait, /run_in_background/);
  assert.doesNotMatch(claudeWait, /Monitor/);
  const maxWait = Number(claudeWait.match(/--max-wait (\d+)/)?.[1]);
  assert.ok(maxWait > 1800 && maxWait <= 7200 - 600, `--max-wait ${maxWait}`);
  const timeoutMs = Number(claudeWait.match(/`timeout: (\d+)`/)?.[1]);
  assert.ok(timeoutMs / 1000 - maxWait >= 600, `timeout ${timeoutMs} ms vs --max-wait ${maxWait}`);
});

test('the Claude Code wait re-arms silently on idle or a killed run and never ends on its own', () => {
  assert.match(claudeWait, /idle/);
  assert.match(claudeWait, /killed/);
  assert.match(claudeWait, /same command/i);
  assert.match(claudeWait, /nothing to the user/i);
  assert.match(claudeWait, /only `timeout` or a user stop ends/i);
  assert.match(claudeWait, /never (edit|wrap|replace)/i);
  assert.match(skill, /TaskStop/);
  assert.doesNotMatch(skill, /spends no model tokens/);
});

test('no doc or script comment describes the Claude Code wait as Monitor-based or free of model calls', () => {
  const root = path.join(__dirname, '..', '..', '..', '..', '..');
  const watchHeader = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'watch.js'), 'utf8').split('\n').slice(0, 12).join('\n');
  const readmeRow = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('\n').find((line) => line.includes('`review-until-approve`'));
  assert.doesNotMatch(watchHeader, /Token-free|Monitor/);
  assert.doesNotMatch(readmeRow, /no model calls/);
});
