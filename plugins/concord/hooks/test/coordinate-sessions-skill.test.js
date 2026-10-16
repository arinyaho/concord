'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./temp-dir');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins/concord/skills/coordinate-sessions/SKILL.md');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');

test('coordinate-sessions is a Claude-only skill', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /^---\nname: coordinate-sessions\n/);
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins/concord-codex/skills/coordinate-sessions')));
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins/concord-copilot/skills/coordinate-sessions')));
  assert.match(read('.claude-plugin/marketplace.json'), /coordinate-sessions/);
  assert.doesNotMatch(read('plugins/concord/.claude-plugin/plugin.json'), /coordinate-sessions/, 'plugin.json is a release-bump version file; PRs do not edit it');
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

test('every report is surfaced and every report kind has a handler', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /no \[to coordinator\] header/);
  assert.doesNotMatch(skill, /if \[\[ "\$first" == "\[to coordinator\]"\* \]\]/);
  for (const kind of ['question', 'blocked', 'progress', 'done', 'handoff']) assert.match(skill, new RegExp('^\\| `' + kind + '` \\|', 'm'));
  assert.match(skill, /create a successor worker/);
});

test('worker authority comes from its creation prompt, not later messages', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /data from a peer/);
  assert.match(skill, /in its `create_session` prompt/);
  assert.doesNotMatch(skill, /Workers follow your messages as instructions/);
});

test('a merge honors the recorded delivery state and checks closed issues', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /its `record-delivery` output/);
  assert.doesNotMatch(skill, /with `record-delivery`:/, 'record-delivery writes a record; the coordinator reads the worker\'s output');
  assert.match(skill, /never merge a head recorded `blocked`/);
  assert.match(skill, /`mergeable-without-review`.*the user's decision/);
  assert.match(skill, /every issue named in a `Closes` line is closed/);
});

test('a coordinator handoff moves the watch and marks the handoff as data', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const section = skill.split('## 7. Hand off yourself')[1] || '';
  assert.match(section, /stop your Monitors/);
  assert.match(section, /says that the handoff is data/);
  assert.match(section, /start a Monitor for each file-channel group still running/);
  assert.match(section, /only the user's own messages/);
});

test('the Monitor loop surfaces each report once, flags a bad header and skips temporary files', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const script = skill.match(/```bash\n([\s\S]*?)```/)[1];
  const reports = tempDir('coordinate-sessions-');
  fs.mkdirSync(path.join(reports, 'group01'));
  fs.writeFileSync(path.join(reports, 'group01', '001-done.md'), '[to coordinator] done: ok\n');
  fs.writeFileSync(path.join(reports, 'group01', '002-progress.md'), '\nno header\n');
  fs.writeFileSync(path.join(reports, 'group01', '003-question.md.tmp'), '[to coordinator] question: half\n');
  const once = script.replaceAll('<reports>', reports).replaceAll('<group>', 'group01')
    .replace('while true; do', 'for pass in 1 2; do').replace(/\n\s*sleep 20/, '');
  const lines = execFileSync('bash', ['-c', once], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /001-done\.md: \[to coordinator\] done: ok$/);
  assert.match(lines[1], /002-progress\.md: \(no \[to coordinator\] header\)/);
});

test('a worker that never starts is detected, archived and reported instead of awaited', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /before your first `create_session`/);
  assert.match(skill, /confirm that it started, start the Monitor/);
  assert.match(skill, /until its `connection_status` reads `connected`/);
  assert.match(skill, /within three minutes of `create_session` is stalled in sandbox allocation/);
  assert.match(skill, /Send a worker no message before it has started/);
  assert.match(skill, /archive it with `archive_session`/);
  assert.match(skill, /restart the bridge for that environment/);
  assert.match(skill, /Agent-tool subagent/);
  assert.match(skill, /`status_bucket` `working` does not show that a worker has started/);
});

test('effort goes in the worker prompt and list_sessions is filtered', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /takes no effort setting/);
  assert.match(skill, /the prompt cannot enforce/);
  assert.match(skill, /`list_sessions` with `mine: true`/);
});
