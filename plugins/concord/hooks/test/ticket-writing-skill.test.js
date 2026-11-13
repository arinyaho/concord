'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const INITIATIVE_TO_PRS_FILES = require('./initiative-to-prs-files.json');
const { tempDir } = require('./temp-dir');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const CLAUDE_SKILL = path.join(REPO, 'plugins/concord/skills/ticket-writing/SKILL.md');
const CODEX_SKILL = path.join(REPO, 'plugins/concord-codex/skills/ticket-writing/SKILL.md');
const CLAUDE_TICKET_TO_PR = path.join(REPO, 'plugins/concord/skills/ticket-to-pr/SKILL.md');
const CODEX_TICKET_TO_PR = path.join(REPO, 'plugins/concord-codex/skills/ticket-to-pr/SKILL.md');
const CLAUDE_INITIATIVE_TO_PRS = path.join(REPO, 'plugins/concord/skills/initiative-to-prs/SKILL.md');
const CODEX_INITIATIVE_TO_PRS = path.join(REPO, 'plugins/concord-codex/skills/initiative-to-prs/SKILL.md');
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

test('ticket-to-pr has the ten stages in order, and stages 4 and 7 are review-and-fix', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  const rows = skill.split('\n').filter((l) => /^\| \d \|/.test(l));
  assert.deepEqual(rows.map((l) => l.split('|')[1].trim()), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.match(rows[2], /Discriminating red/);
  assert.match(rows[4], /`review-and-fix` on the design document/);
  assert.match(rows[7], /`review-and-fix` on the change/);
  assert.match(rows[8], /Discriminating green/);
  assert.match(rows[9], /draft pull request.*marked ready when the work is done/i);
  const review = skill.split('### Stages 4 and 7: review\n')[1]?.split('\n### ')[0] ?? '';
  for (const row of ['Target', 'Must satisfy', 'Evidence']) assert.match(review, new RegExp(`^\\| ${row} \\|`, 'm'), row);
  assert.match(review, /The ticket's acceptance criteria and plan, and the design document/);
});

test('ticket-to-pr keeps its state on the ticket and the pull request and stops only in the three cases', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  assert.match(skill, /plan, progress, decisions, and the review record go on the ticket/);
  assert.match(skill, /resume from the ticket and the pull request/);
  assert.match(skill, /Stop and ask only for a product decision .*something only the user holds .*hard-to-reverse action the user has not authorized/s);
  assert.match(skill, /Record every other obstacle on the ticket and continue/);
  assert.match(skill, /come from the project's rules file/);
});

test('ticket-to-pr opens a draft and marks it ready on three conditions, and never merges', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  const section = skill.split('### Stage 9: the pull request\n')[1]?.split('\n## ')[0] ?? '';
  assert.match(section, /open the pull request as a draft/);
  assert.match(section, /no `blocker` finding is open, CI passed on the head, and every acceptance criterion has its evidence/);
  assert.match(section, /Otherwise it stays a draft/);
  assert.match(section, /Do not merge\. `pr-to-merge` carries the pull request/);
  assert.match(skill, /Never move a ticket to done/);
});

test('ticket-to-pr defines the table and tests required for stateful changes', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  const section = skill.split('## Stateful changes\n')[1]?.split('\n## ')[0] ?? '';
  assert.ok(section, 'missing "Stateful changes" section');
  assert.match(section, /^\| State \| Event \| Outcome \| Kind \| Evidence \|$/m);
  for (const pattern of [
    /retry, recovery, or replay path/,
    /in the unit's design document when the unit wrote one, and in the pull request body when it did not/,
    /resulting state/,
    /fails before the change and passes after it/,
    /found missing later, including in review, is added to the table, in the same place and the same pull request/,
  ]) assert.match(section, pattern);
});

test('ticket-to-pr requires a red that reproduces the harm before the design', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  const section = skill.split('### Stage 2: discriminating red\n')[1]?.split('\n### ')[0] ?? '';
  for (const pattern of [/Reproduce the harm, not the mechanism/, /build one that can/, /Record what the run ran against/, /refuse to pass for the wrong reason/]) assert.match(section, pattern);
});

test('ticket-to-pr sorts work by design versus applying a decision, waits once, and hands off through the ticket', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  assert.match(skill, /decides what something should be or applies a decision already made/);
  assert.match(skill, /A worker reports it and does not make it/);
  assert.match(skill, /one blocking wait or a background notification, never with repeated short sleeps/);
  assert.match(skill, /Run the full suite once, on the final head/);
  const handoff = skill.split('## Past the context limit\n')[1]?.split('\n## ')[0] ?? '';
  assert.match(handoff, /Stop at the next stage boundary/);
  assert.match(handoff, /`handoff` report/);
  assert.doesNotMatch(handoff, /\d{2,} (tokens|tool calls)/);
});

test('ticket-to-pr keeps one coherent outcome per unit and permits only justified boundaries', () => {
  const skill = read(CLAUDE_TICKET_TO_PR);
  for (const rule of [
    /one coherent ticket outcome; keep its changes together/,
    /deployed or reverted on its own/,
    /prerequisite must merge first/,
    /repository boundary/,
    /ownership split the approved plan names/,
    /frontend\/backend label or size alone is not a boundary/,
    /Record the red for the whole outcome once, against the unchanged combined system/,
    /A proposed version is not a pin/,
  ]) assert.match(skill, rule);
});

test('Claude and Codex source packages ship the same initiative-to-prs skill', () => {
  for (const file of INITIATIVE_TO_PRS_FILES) {
    const claude = path.join(REPO, 'plugins/concord/skills/initiative-to-prs', file);
    const codex = path.join(REPO, 'plugins/concord-codex/skills/initiative-to-prs', file);
    assert.ok(fs.existsSync(codex), `Codex source package is missing initiative-to-prs/${file}`);
    assert.equal(read(codex), read(claude));
  }
});

test('Claude and Codex source packages ship the same proposal-package-authoring skill', () => {
  for (const file of PROPOSAL_SKILL_FILES) {
    const claude = path.join(REPO, 'plugins/concord/skills/proposal-package-authoring', file);
    const codex = path.join(REPO, 'plugins/concord-codex/skills/proposal-package-authoring', file);
    assert.ok(fs.existsSync(codex), `Codex source package is missing ${file}`);
    assert.equal(read(codex), read(claude));
  }
});

pluginInstallE2ETest('plugin-install e2e: clean Claude and Codex installs discover the same shared skills', (t) => {
  const root = tempDir('concord-ticket-writing-');
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
    ['plugin', 'add', 'concord@arinyaho-concord', '--json'],
    codexEnv,
  ));

  const claude = read(path.join(claudeInstall.installPath, 'skills/ticket-writing/SKILL.md'));
  const codex = read(path.join(codexInstall.installedPath, 'skills/ticket-writing/SKILL.md'));
  const claudeTicketToPr = read(path.join(claudeInstall.installPath, 'skills/ticket-to-pr/SKILL.md'));
  const codexTicketToPr = read(path.join(codexInstall.installedPath, 'skills/ticket-to-pr/SKILL.md'));
  const claudeInitiativeToPrs = read(path.join(claudeInstall.installPath, 'skills/initiative-to-prs/SKILL.md'));
  const codexInitiativeToPrs = read(path.join(codexInstall.installedPath, 'skills/initiative-to-prs/SKILL.md'));
  for (const file of INITIATIVE_TO_PRS_FILES.filter((file) => file !== 'SKILL.md')) {
    assert.equal(
      read(path.join(claudeInstall.installPath, 'skills/initiative-to-prs', file)),
      read(path.join(codexInstall.installedPath, 'skills/initiative-to-prs', file)),
    );
  }
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
  assert.equal(codexInitiativeToPrs, claudeInitiativeToPrs);
  for (const skill of ['review-and-fix', 'coordinate-sessions', 'pr-to-merge']) {
    assert.equal(
      read(path.join(codexInstall.installedPath, 'skills', skill, 'SKILL.md')),
      read(path.join(claudeInstall.installPath, 'skills', skill, 'SKILL.md')),
      skill,
    );
  }
  assert.equal(
    read(path.join(codexInstall.installedPath, 'skills/review-and-fix/references/reviewer.md')),
    read(path.join(claudeInstall.installPath, 'skills/review-and-fix/references/reviewer.md')),
  );
  for (const agent of ['reviewer', 'implementer']) assert.ok(fs.existsSync(path.join(claudeInstall.installPath, 'agents', `${agent}.md`)), agent);
  assert.equal(codexProposal, claudeProposal);
  assert.ok(claudeSkills?.includes('concord:ticket-to-pr'));
  assert.ok(claudeSkills?.includes('concord:initiative-to-prs'));
  for (const skill of ['review-and-fix', 'coordinate-sessions', 'pr-to-merge']) assert.ok(claudeSkills?.includes(`concord:${skill}`), skill);
  assert.ok(!claudeSkills?.includes('concord:review-until-lgtm'));
  assert.ok(claudeSkills?.includes('concord:proposal-package-authoring'));
  assert.match(codexSkills, /(?:^|\n)- concord:ticket-to-pr: /);
  assert.match(codexSkills, /(?:^|\n)- concord:initiative-to-prs: /);
  for (const skill of ['review-and-fix', 'coordinate-sessions', 'pr-to-merge']) assert.match(codexSkills, new RegExp(`(?:^|\\n)- concord:${skill}: `), skill);
  assert.doesNotMatch(codexSkills, /concord:review-until-(lgtm|green)|concord:project-manager/);
  assert.match(codexSkills, /(?:^|\n)- concord:proposal-package-authoring: /);
  assert.match(claude, /^---\nname: ticket-writing\ndescription: Use when /);
  assert.match(claudeTicketToPr, /^---\nname: ticket-to-pr\ndescription: >-/);
  assert.match(claudeInitiativeToPrs, /^---\nname: initiative-to-prs\ndescription: >-/);
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
  for (const contents of files) assert.match(contents, /initiative-to-prs/i);
  for (const contents of files) assert.match(contents, /proposal-package-authoring/i);
  // Only the README and the marketplace are held to the current workflow set.
  for (const contents of [files[0], files[3]]) {
    for (const name of ['review-and-fix', 'pr-to-merge', 'coordinate-sessions', 'review-until-approve']) assert.match(contents, new RegExp(name), name);
    assert.doesNotMatch(contents, /review-until-lgtm|review-until-green|project-manager|Copilot/i);
  }
  assert.doesNotMatch(files[0], /Session-state and charter are Claude-Code-only/i);

  const claudeManifest = JSON.parse(files[1]);
  const codexManifest = JSON.parse(files[2]);
  assert.match(claudeManifest.description, /ticket-to-pr/);
  assert.match(codexManifest.description, /ticket-to-pr/);
  assert.match(claudeManifest.description, /initiative-to-prs/);
  assert.match(codexManifest.description, /initiative-to-prs/);

  for (const name of ['ticket-to-pr', 'initiative-to-prs', 'review-and-fix', 'pr-to-merge', 'coordinate-sessions', 'review-until-approve']) {
    assert.match(files[0], new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  }

  const adapter = read(path.join(REPO, 'plugins/concord/adapters/codex/README.md'));
  const gaps = read(path.join(REPO, 'plugins/concord/adapters/codex/GAPS.md'));
  assert.doesNotMatch(adapter, /Status: \*\*partially implemented/i);
  assert.doesNotMatch(adapter, /lifecycle.*not implemented|transcript.*not implemented/i);
  assert.doesNotMatch(gaps, /Deferred: `lifecycle` and `transcript`/i);
});
