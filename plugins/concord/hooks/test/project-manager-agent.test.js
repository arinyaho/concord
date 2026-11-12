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

test('project-manager has a Claude agent and a native Codex skill', () => {
  const agent = read('plugins/concord/agents/project-manager.md');
  assert.match(agent, /^---\nname: project-manager\n/);
  assert.match(agent, /^model: sonnet$/m);
  assert.match(section(agent, 'Start'), /`concord:coordinate-sessions`/);
  assert.doesNotMatch(agent, /HPKE|concord-implementer|concord-architect/, 'the agent stays rollout-neutral and names only agents the plugin ships or the harness provides');
  for (const pkg of ['concord-codex']) {
    assert.ok(!fs.existsSync(path.join(REPO, 'plugins', pkg, 'agents', 'project-manager.md')));
  }
  assert.ok(fs.existsSync(path.join(REPO, 'plugins/concord-codex/skills/project-manager/SKILL.md')));
  assert.match(read('README.md'), /\| `project-manager` agent \/ skill \|.*\| Claude Code, Codex \|/);
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

test('Codex coordination preserves delivery gates while reusing scoped review evidence', () => {
  const coordination = read('plugins/concord-codex/skills/coordinate-sessions/SKILL.md');
  const pm = read('plugins/concord-codex/skills/project-manager/SKILL.md');
  assert.match(coordination, /queue success proves enqueueing\s+only/);
  assert.match(coordination, /Request acknowledgement/);
  assert.match(coordination, /Filter CI check runs by the verified head SHA/);
  assert.match(coordination, /never merge `blocked`/);
  assert.match(coordination, /`mergeable-without-review` requires the user's applicable decision/);
  assert.match(coordination, /--match-head-commit/);
  assert.match(coordination, /Never use `--admin`, force-push, delete branches/);
  assert.match(coordination, /unchanged relevant dependencies, configuration\s+and approved intent/);
  assert.match(pm, /Never resolve a human reviewer's thread/);
  assert.match(pm, /Do not move Jira tickets to Done/);
});

test('Codex coordination checks the CLI creation route before refusing and keeps queue separate from creation', () => {
  const skill = read('plugins/concord-codex/skills/coordinate-sessions/SKILL.md');
  const create = section(skill, 'Create workers').replace(/\s+/g, ' ');
  assert.match(create, /Prefer the app's session creation tool \(`create_thread`\)/);
  assert.match(create, /absent, that alone does not mean no route exists/);
  assert.match(create, /Inspect the installed CLI \(`codex --help`, `codex exec --help`\)/);
  assert.match(create, /`codex exec --json`.*`thread\.started`/s);
  assert.match(create, /argument-array process API/);
  assert.match(create, /distinct thread ID and a task acknowledgement bound to that worker's assigned task ID/);
  assert.match(create, /A PID.*insufficient/s);
  assert.match(create, /Report startup as startup/);
  assert.match(create, /Do not call it a sidebar-visible app chat/);
  assert.match(create, /which capabilities were checked.*concrete missing prerequisite/s);
  assert.match(create, /queue messages existing workers and never creates one/);
  assert.match(skill, /`codex queue` sends to an existing session; it does not create a worker/);
  assert.match(skill, /same remote selection on every\s+call/);
});

test('Claude coordination assigns one observer and reuses evidence without weakening merge gates', () => {
  const pm = read('plugins/concord/agents/project-manager.md');
  const coordination = read('plugins/concord/skills/coordinate-sessions/SKILL.md');
  assert.match(pm, /Prefer a Haiku subagent/);
  assert.match(pm, /Keep coordination, workers and reviews within Claude/);
  assert.doesNotMatch(pm + coordination, /Luna|Astra|Codex provider selected/);
  assert.match(pm, /One Sonnet review plus relevant tests/);
  assert.match(pm, /One Opus review plus confirmation of fixes/);
  assert.doesNotMatch(pm, /rerun the key command|Confirm with the user in your own session before the first merge/);
  assert.match(coordination, /one CI\/status observer per task/);
  assert.match(coordination, /do not turn unchanged waiting\s+into repeated model turns or user updates/);
  assert.match(coordination, /current-head CI and delivery\s+gates remain mandatory/);
  assert.match(coordination, /attempt\/context,\s+observation time and provenance/);
  assert.match(coordination, /Include the Claude-only provider policy in each creation prompt/);
  assert.match(coordination, /rather than falling back to another vendor/);
  assert.match(pm, /excluding the implementer's reasoning and conclusions/);
});
