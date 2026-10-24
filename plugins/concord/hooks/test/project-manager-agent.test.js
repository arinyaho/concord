'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');
const section = (text, heading) => {
  const match = text.match(new RegExp('^## ' + heading + '\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))', 'm'));
  assert.ok(match, 'missing section ' + heading);
  return match[1];
};

test('project-manager is a Claude-only agent that defers session mechanics to coordinate-sessions', () => {
  const agent = read('plugins/concord/agents/project-manager.md');
  assert.match(agent, /^---\nname: project-manager\n/);
  assert.match(agent, /^model: opus$/m);
  assert.match(section(agent, 'Start'), /`concord:coordinate-sessions`/);
  assert.doesNotMatch(agent, /HPKE|concord-implementer|concord-architect/, 'the agent stays rollout-neutral and names only agents the plugin ships or the harness provides');
  for (const pkg of ['concord-codex', 'concord-copilot']) {
    assert.ok(!fs.existsSync(path.join(REPO, 'plugins', pkg, 'agents', 'project-manager.md')));
  }
  assert.match(read('README.md'), /\| `project-manager` agent \|.*\| Claude Code \|/);
  assert.match(read('.claude-plugin/marketplace.json'), /project-manager/);
});

test('the Authority section carries the merge gates of coordinate-sessions', () => {
  const authority = section(read('plugins/concord/agents/project-manager.md'), 'Authority');
  assert.match(authority, /--match-head-commit/);
  assert.match(authority, /squash every PR into `main`/);
  assert.match(authority, /`record-delivery` state names that head/);
  assert.match(authority, /never merge a head recorded `blocked`/);
  assert.match(authority, /`mergeable-without-review` is the user's decision/);
  assert.match(authority, /Never `--admin`, force-push/);
  // The skill is the source of the delivery rule; the agent must not drop what the skill makes binding.
  const skill = read('plugins/concord/skills/coordinate-sessions/SKILL.md');
  assert.match(skill, /never merge a head recorded `blocked`/);
  assert.match(skill, /`mergeable-without-review`/);
  assert.match(skill, /A PR into `main` is always squash-merged; for any other base choose the method that fits the branch/);
  assert.match(read('docs/design/coordinate-sessions.md'), /a PR into `main` is always squash-merged, and any other base uses the method that fits the branch/);
});

test('deep-review is routed to only on an explicit user request, and CI is read by head SHA', () => {
  const agent = read('plugins/concord/agents/project-manager.md');
  assert.match(section(agent, 'Hand out work'), /`concord:deep-review` only when the user explicitly asks/);
  assert.match(section(agent, 'Judge delivery'), /filter check runs by `headSha`/);
  assert.match(read('plugins/concord/skills/deep-review/SKILL.md'), /explicitly asks for deep-review/);
});
