'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const CLAUDE_SKILL = path.join(REPO, 'plugins/concord/skills/ticket-writing/SKILL.md');
const CODEX_SKILL = path.join(REPO, 'plugins/concord-codex/skills/ticket-writing/SKILL.md');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('Claude and Codex ship the same provider-neutral ticket-writing skill', () => {
  const claude = read(CLAUDE_SKILL);
  const codex = read(CODEX_SKILL);

  assert.equal(codex, claude);
  assert.match(claude, /^---\nname: ticket-writing\ndescription: Use when /);
  for (const provider of ['Notion', 'Jira', 'GitHub Issues']) assert.match(claude, new RegExp(provider));
});

test('ticket-writing grounds implementation tickets before it writes them', () => {
  const skill = read(CLAUDE_SKILL);

  for (const required of [
    'authoritative product',
    'agreed design',
    'current behavior',
    'observed evidence',
    '| Scope |',
    '| Non-goals |',
    '| Constraints |',
    '| Design direction |',
    'Acceptance criteria',
    'Definition of done',
    'trade-offs',
    'residual risks',
    'never invent an assignee, priority, estimate, due date, label, or workflow state',
    'explicit approval before closing or superseding an existing ticket',
    'Use a draft or proposal state only when the provider exposes one',
    'the provider exposes an in-progress state',
    'only when the user explicitly requests or approves that tracker mutation',
    'without mutating the tracker',
    'read the created or updated ticket back',
    'ticket-to-pr',
  ]) {
    assert.ok(skill.includes(required), `missing ticket contract: ${required}`);
  }
});

test('ticket-writing contains no source-company credential, workflow, or sizing policy', () => {
  const skill = read(CLAUDE_SKILL);
  const forbidden = [
    /code-assistant/i,
    /gcp.secret.manager/i,
    /gcloud\s+secrets/i,
    /customfield_\d+/i,
    /JIRA_(?:BASE_URL|EMAIL|API_TOKEN|PROJECT_KEY)/,
    /envector/i,
    /cryptolab/i,
    /story point guide/i,
    /Backlog\s*->\s*To Do/i,
  ];

  for (const pattern of forbidden) assert.doesNotMatch(skill, pattern);
});

test('maintained package metadata and docs advertise the shared capability set', () => {
  const files = [
    'README.md',
    'plugins/concord/.claude-plugin/plugin.json',
    'plugins/concord-codex/.codex-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
  ].map((file) => read(path.join(REPO, file)));

  for (const contents of files) assert.match(contents, /ticket-writing/i);
  assert.doesNotMatch(files[0], /Session-state and charter are Claude-Code-only/i);

  const claudeManifest = JSON.parse(files[1]);
  const codexManifest = JSON.parse(files[2]);
  assert.match(claudeManifest.description, /ticket-to-pr/);
  assert.doesNotMatch(codexManifest.description, /ticket-to-pr/);

  const claudeSummary = files[0].split('\n').find((line) => line.startsWith('- `concord` (Claude Code)'));
  const codexSummary = files[0].split('\n').find((line) => line.startsWith('- `concord-codex` (Codex)'));
  assert.match(claudeSummary, /ticket-to-pr/);
  assert.doesNotMatch(codexSummary, /ticket-to-pr/);

  const adapter = read(path.join(REPO, 'plugins/concord/adapters/codex/README.md'));
  const gaps = read(path.join(REPO, 'plugins/concord/adapters/codex/GAPS.md'));
  assert.doesNotMatch(adapter, /Status: \*\*partially implemented/i);
  assert.doesNotMatch(adapter, /lifecycle.*not implemented|transcript.*not implemented/i);
  assert.doesNotMatch(gaps, /Deferred: `lifecycle` and `transcript`/i);
});
