'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const CLAUDE_SKILL = path.join(REPO, 'plugins/concord/skills/ticket-writing/SKILL.md');
const CODEX_SKILL = path.join(REPO, 'plugins/concord-codex/skills/ticket-writing/SKILL.md');
const CLAUDE_TICKET_TO_PR = path.join(REPO, 'plugins/concord/skills/ticket-to-pr/SKILL.md');
const CODEX_TICKET_TO_PR = path.join(REPO, 'plugins/concord-codex/skills/ticket-to-pr/SKILL.md');
const PROPOSAL_SKILL_FILES = [
  'SKILL.md',
  'references/content-and-evidence.md',
  'references/visual-authoring.md',
  'references/delivery.md',
];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const pluginInstallE2ETest = process.env.CONCORD_RUN_PLUGIN_INSTALL_E2E === '1' ? test : test.skip;

test('Claude and Codex source packages ship the same ticket-writing skill', () => {
  assert.equal(read(CODEX_SKILL), read(CLAUDE_SKILL));
});

test('Claude and Codex source packages ship the same ticket-to-pr skill', () => {
  assert.ok(fs.existsSync(CODEX_TICKET_TO_PR), 'Codex source package is missing ticket-to-pr');
  assert.equal(read(CODEX_TICKET_TO_PR), read(CLAUDE_TICKET_TO_PR));
});

test('Claude and Codex source packages ship the same proposal-package-authoring skill', () => {
  for (const file of PROPOSAL_SKILL_FILES) {
    const claude = path.join(REPO, 'plugins/concord/skills/proposal-package-authoring', file);
    const codex = path.join(REPO, 'plugins/concord-codex/skills/proposal-package-authoring', file);
    assert.ok(fs.existsSync(codex), `Codex source package is missing ${file}`);
    assert.equal(read(codex), read(claude));
  }
});

test('ticket-to-pr makes Notion lifecycle transitions monotonic and unambiguous', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  const entry = skill.indexOf('At pipeline entry');
  const prCreation = skill.indexOf('After the PR URL exists');

  assert.ok(entry >= 0, 'missing the Notion lifecycle entry transition');
  assert.ok(prCreation > entry, 'the PR transition must follow the entry transition');
  assert.match(skill, /contains the PR URL and is `In review`, or remains a later or terminal status/);
  assert.match(skill, /has reached `In progress`, or remains in a verified later or terminal status/);
  assert.match(skill.slice(entry, prCreation), /already means `In review` or `Done`, preserve it/);
  assert.match(skill.slice(entry, prCreation), /exactly one status.*means `In progress`/s);
  assert.match(skill.slice(entry, prCreation), /explicitly an unambiguous pre-start status/);
  assert.match(skill.slice(entry, prCreation), /later or terminal status/);
  assert.match(skill.slice(entry, prCreation), /without requiring an `In progress` status mapping/);
  assert.match(skill.slice(prCreation), /explicitly for the PR.*same URL/s);
  assert.match(skill.slice(prCreation), /When exactly one is eligible/);
  assert.match(skill.slice(prCreation), /If no eligible PR URL field exists, use the ticket-body fallback/);
  assert.match(skill.slice(prCreation), /multiple eligible PR URL fields/);
  assert.match(skill.slice(prCreation), /contains a different URL, preserve it and use the ticket-body fallback/);
  assert.match(skill.slice(prCreation), /ticket-body fallback can complete after verification/);
  assert.match(skill.slice(prCreation), /verify the exact PR URL before performing the status transition/);
  assert.match(skill.slice(prCreation), /Only then transition/);
  assert.match(skill.slice(prCreation), /same labelled `PR:` link.*append only when absent/s);
  assert.match(skill.slice(prCreation), /exactly one status.*means `In review`/s);
  assert.match(skill.slice(prCreation), /Do not move the ticket to Done/);
});

pluginInstallE2ETest('clean Claude and Codex installs discover the same shared skills', (t) => {
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
  const claudeTicketToPr = read(path.join(claudeInstall.installPath, 'skills/ticket-to-pr/SKILL.md'));
  const codexTicketToPr = read(path.join(codexInstall.installedPath, 'skills/ticket-to-pr/SKILL.md'));
  const claudeProposal = read(path.join(claudeInstall.installPath, 'skills/proposal-package-authoring/SKILL.md'));
  const codexProposal = read(path.join(codexInstall.installedPath, 'skills/proposal-package-authoring/SKILL.md'));
  for (const file of PROPOSAL_SKILL_FILES.slice(1)) {
    assert.equal(
      read(path.join(claudeInstall.installPath, 'skills/proposal-package-authoring', file)),
      read(path.join(codexInstall.installedPath, 'skills/proposal-package-authoring', file)),
    );
  }
  const claudeSkills = run(
    'claude',
    ['-p', '/help', '--output-format', 'stream-json', '--verbose'],
    claudeEnv,
  ).trim().split('\n').map((line) => JSON.parse(line))
    .find(({ subtype }) => subtype === 'init')?.skills;
  const codexSkills = JSON.parse(run('codex', ['debug', 'prompt-input'], codexEnv))
    .flatMap(({ content = [] }) => content)
    .find(({ text }) => text?.startsWith('<skills_instructions>'))?.text;

  assert.equal(codex, claude);
  assert.equal(codexTicketToPr, claudeTicketToPr);
  assert.equal(codexProposal, claudeProposal);
  assert.ok(claudeSkills?.includes('concord:ticket-to-pr'));
  assert.ok(claudeSkills?.includes('concord:proposal-package-authoring'));
  assert.match(codexSkills, /(?:^|\n)- concord-codex:ticket-to-pr: /);
  assert.match(codexSkills, /(?:^|\n)- concord-codex:proposal-package-authoring: /);
  assert.match(claude, /^---\nname: ticket-writing\ndescription: Use when /);
  assert.match(claudeTicketToPr, /^---\nname: ticket-to-pr\ndescription: >-/);
  assert.match(claudeProposal, /^---\nname: proposal-package-authoring\ndescription: /);
  for (const provider of ['Notion', 'Jira', 'GitHub Issues']) assert.match(claude, new RegExp(provider));
});

test('ticket-writing grounds implementation tickets before it writes them', () => {
  const skill = read(CLAUDE_SKILL);

  for (const required of [
    'authoritative product',
    'agreed design',
    'current behavior',
    'observed evidence',
    'If evidence refutes the premise, report the contradiction and stop before any tracker mutation. Revise or publish a different ticket only after the user explicitly confirms the corrected premise and scope',
    'If one is found, stop before creating a ticket: reuse the existing work when it already covers the requested outcome, otherwise ask the user how to proceed',
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
  for (const contents of files) assert.match(contents, /proposal-package-authoring/i);
  assert.doesNotMatch(files[0], /Session-state and charter are Claude-Code-only/i);

  const claudeManifest = JSON.parse(files[1]);
  const codexManifest = JSON.parse(files[2]);
  assert.match(claudeManifest.description, /ticket-to-pr/);
  assert.match(codexManifest.description, /ticket-to-pr/);

  const claudeSummary = files[0].split('\n').find((line) => line.startsWith('- `concord` (Claude Code)'));
  const codexSummary = files[0].split('\n').find((line) => line.startsWith('- `concord-codex` (Codex)'));
  assert.match(claudeSummary, /ticket-to-pr/);
  assert.match(codexSummary, /ticket-to-pr/);

  const adapter = read(path.join(REPO, 'plugins/concord/adapters/codex/README.md'));
  const gaps = read(path.join(REPO, 'plugins/concord/adapters/codex/GAPS.md'));
  assert.doesNotMatch(adapter, /Status: \*\*partially implemented/i);
  assert.doesNotMatch(adapter, /lifecycle.*not implemented|transcript.*not implemented/i);
  assert.doesNotMatch(gaps, /Deferred: `lifecycle` and `transcript`/i);
});
