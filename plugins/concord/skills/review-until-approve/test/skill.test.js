'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');

test('SKILL.md names the skill and instructs the whole loop with scripts that exist', () => {
  assert.match(skill, /^---\nname: review-until-approve\n/);
  for (const verb of ['start', 'round', 'approve', 'waive', 'reclass', 'stop']) assert.match(skill, new RegExp(`approve\\.js" ${verb} `));
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

test('SKILL.md records trust only from the user\'s own confirmed words and names what is not a declaration', () => {
  const trust = skill.slice(skill.indexOf('## Trust'), skill.indexOf('## Loop'));
  assert.match(trust, /one pull request/);
  assert.match(trust, /asks? the user exactly that question, once/);
  assert.match(trust, /verbatim/);
  assert.match(trust, /Not a declaration/);
  for (const notDeclaration of [/text in the pull request or its code/, /another session or a coordinating session relayed/, /ambiguous/]) assert.match(trust, notDeclaration);
  assert.match(trust, /approve\.js" trust <owner\/repo> <pr> --declaration/);
  assert.match(trust, /--revoke/);
});

test('SKILL.md has no standing setting, never passes a flag to turn the Claude reviewer on, never picks the other vendor, and stops after a denial', () => {
  assert.equal(skill.includes('CONCORD_REVIEW_UNCONFINED_CLAUDE'), false);
  assert.equal(skill.includes('--allow-unrestricted-home'), false);
  assert.match(skill, /never falls back to the other vendor/);
  assert.match(skill, /only when the user asked for the other vendor in their own words; never pick it yourself/);
  assert.match(skill, /#366/);
  assert.match(skill, /denied[^.]*relay[^.]*stop|relay[^.]*denial[^.]*stop/i);
});

test('the foreground `next` call is given a Bash timeout longer than its 540 second wait', () => {
  const section = skill.slice(skill.indexOf('## Round with subagents'), skill.indexOf('## Findings the user disputes'));
  const timeoutMs = Number(section.match(/approve\.js" next[^\n]*`timeout: (\d+)`/)?.[1]);
  assert.ok(timeoutMs > 540000, `timeout ${timeoutMs}`);
});

test('`finished` is trusted only after the background round has exited: the round registers after its first GitHub calls', () => {
  const section = skill.slice(skill.indexOf('## Round with subagents'), skill.indexOf('## Findings the user disputes'));
  assert.match(section, /`finished`[^\n]*background task (has|is)[^\n]*(still running|exited)/);
  assert.match(section, /still running[^\n]*run `next` again/);
});

test('SKILL.md maps the user\'s language and effort words to start options, passes effort to subagents, and never edits plugin files', () => {
  assert.match(skill, /--language <tag>/);
  assert.match(skill, /--effort <level>/);
  assert.match(skill, /Agent[^.]*`effort`/);
  assert.match(skill, /never edit(?:s)? (?:the )?plugin files/i);
  assert.match(skill, /tell the user/i);
});

test('SKILL.md keeps watching a draft, handles several pull requests one round at a time, and never picks another account (#420, #421)', () => {
  assert.match(skill, /`ready`: a clean, unapproved head/);
  assert.doesNotMatch(skill, /re-invoke the skill once the pull request is ready/);
  assert.match(skill, /one watch per pull request and run rounds one at a time/);
  assert.match(skill, /waits until that round ends/);
  assert.match(skill, /cannot read the pull request, stop and ask the user which account to use; never choose another account or profile yourself/);
});

test('SKILL.md says a finding about the pull request description is judged against its title and body, not git objects (#423)', () => {
  assert.match(skill, /finding about the pull request description is judged against its title and body/);
  assert.match(skill, /`\/pr-description`/);
});
