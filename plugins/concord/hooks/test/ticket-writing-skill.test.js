'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const CLAUDE_SKILL = path.join(REPO, 'plugins/concord/skills/ticket-writing/SKILL.md');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const pluginInstallE2ETest = process.env.CONCORD_RUN_PLUGIN_INSTALL_E2E === '1' ? test : test.skip;

pluginInstallE2ETest('clean Claude and Codex installs discover the same provider-neutral ticket-writing skill', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-ticket-writing-'));
  const home = path.join(root, 'home');
  const claudeConfig = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  for (const directory of [home, claudeConfig, codexHome]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (command, args, env) => childProcess.execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
  });

  const claudeEnv = { CLAUDE_CONFIG_DIR: claudeConfig };
  run('claude', ['plugin', 'marketplace', 'add', REPO, '--scope', 'user'], claudeEnv);
  run('claude', ['plugin', 'install', 'concord@arinyaho-concord', '--scope', 'user', '--json'], claudeEnv);
  const claudeInstall = JSON.parse(run('claude', ['plugin', 'list', '--json'], claudeEnv))
    .find(({ id }) => id === 'concord@arinyaho-concord');
  assert.ok(claudeInstall, 'Claude did not install concord@arinyaho-concord');

  const codexEnv = { CODEX_HOME: codexHome };
  run('codex', ['plugin', 'marketplace', 'add', REPO, '--json'], codexEnv);
  const codexInstall = JSON.parse(run(
    'codex',
    ['plugin', 'add', 'concord-codex@arinyaho-concord', '--json'],
    codexEnv,
  ));

  const claude = read(path.join(claudeInstall.installPath, 'skills/ticket-writing/SKILL.md'));
  const codex = read(path.join(codexInstall.installedPath, 'skills/ticket-writing/SKILL.md'));

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
    'If no destination can be established or multiple destinations remain plausible',
    'A content-only draft may proceed with the tracker and project explicitly unset',
    'If none exists for the resolved destination, stop and report the missing access',
    'never invent a provider, account, or project',
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
    'user explicitly requests or approves an in-progress transition',
    'only when the user explicitly requests or approves that tracker mutation',
    'without mutating the tracker',
    'read the created or updated ticket back',
    'Only when the user explicitly requests or approves implementation',
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
