const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const claudeWait = skill.slice(skill.indexOf('## Wait'), skill.indexOf('## Trust'));

test('the Claude Code wait re-arms silently on idle or a killed run and never ends the skill for a background reason', () => {
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
  const readmeLines = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('\n');
  const readmeRow = readmeLines.find((line) => line.trim().startsWith('| `review-until-approve`')) || readmeLines.find((line) => line.includes('`review-until-approve`'));
  assert.doesNotMatch(watchHeader, /Token-free|Monitor/);
  assert.doesNotMatch(readmeRow, /no model calls/);
});
