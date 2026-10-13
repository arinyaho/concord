'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins/concord/skills/coordinate-sessions/SKILL.md');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');

test('coordinate-sessions is a Claude-only skill', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /^---\nname: coordinate-sessions\n/);
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins/concord-codex/skills/coordinate-sessions')));
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins/concord-copilot/skills/coordinate-sessions')));
  assert.match(read('plugins/concord/.claude-plugin/plugin.json'), /coordinate-sessions/);
  assert.match(read('README.md'), /\| `coordinate-sessions` \|.*\| Claude Code \|/);
});

test('the environment comes from get_session, not the system prompt', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /`get_session` without a `session_id`/);
  assert.match(skill, /`environment_kind`/);
  assert.match(skill, /system prompt does not decide/);
  assert.match(skill, /"Create a worker" means calling `create_session`/);
  assert.match(skill, /A subagent started with the Agent tool is not a worker/);
});

test('both channels, report kinds and the file-channel refusal are defined', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /\[to coordinator\] <kind>: <summary>/);
  for (const kind of ['question', 'blocked', 'progress', 'done', 'handoff']) assert.match(skill, new RegExp('`' + kind + '`'));
  assert.match(skill, /File channel/);
  assert.match(skill, /Direct channel/);
  assert.match(skill, /refuse the file channel/);
  assert.match(skill, /`status_bucket`/);
  assert.match(skill, /created in your own environment/);
});

test('decisions, verification and merging follow the design', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /only what the user typed into this session/);
  assert.match(skill, /`dismiss --by`/);
  assert.match(skill, /check each finding the worker called minor against the code/);
  assert.match(skill, /only if the user allowed merging/);
  assert.match(skill, /--match-head-commit/);
  assert.match(skill, /disjoint/);
  for (const forbidden of [/mien exec/, /arinyaho/, /release-bump/, /claude plugin update/]) assert.doesNotMatch(skill, forbidden);
});

test('a fresh coordinator can set up, run and stop the file channel', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /mkdir -p <reports>\/<group>/);
  assert.match(skill, /`group01`/);
  assert.match(skill, /## 0\. Start/);
  assert.match(skill, /Stop the Monitor when no worker is active/);
  assert.match(skill, /`NNN-<kind>\.md\.tmp`/);
  assert.doesNotMatch(skill, /handoff-\*/);
  assert.match(skill, /`status_bucket` `blocked`/);
  assert.match(skill, /`status` `idle`/);
});
