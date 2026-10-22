'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');

test('project-manager is a Claude-only agent that defers session mechanics to coordinate-sessions', () => {
  const agent = read('plugins/concord/agents/project-manager.md');
  assert.match(agent, /^---\nname: project-manager\n/);
  assert.match(agent, /^model: opus$/m);
  assert.match(agent, /`concord:coordinate-sessions`/);
  assert.match(agent, /filter check runs by `headSha`/);
  assert.match(agent, /--match-head-commit/);
  assert.match(agent, /Never `--admin`, force-push/);
  assert.doesNotMatch(agent, /HPKE|concord-implementer|concord-architect/, 'the agent stays rollout-neutral and names only agents the plugin ships or the harness provides');
  for (const pkg of ['concord-codex', 'concord-copilot']) {
    assert.ok(!fs.existsSync(path.join(REPO, 'plugins', pkg, 'agents', 'project-manager.md')));
  }
  assert.match(read('README.md'), /\| `project-manager` agent \|.*\| Claude Code \|/);
  assert.match(read('.claude-plugin/marketplace.json'), /project-manager/);
});
