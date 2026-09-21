'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const COPILOT = path.join(REPO, 'plugins/concord-copilot');
const pluginInstallE2ETest = process.env.CONCORD_RUN_PLUGIN_INSTALL_E2E === '1' ? test : test.skip;

function read(relativePath) {
  return fs.readFileSync(path.join(COPILOT, relativePath), 'utf8');
}

test('Copilot package uses Agent Plugins 1.0 fixed component locations', () => {
  const manifest = JSON.parse(read('plugin.json'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'concord-copilot');

  const hooks = JSON.parse(read('com.github.copilot/hooks/hooks.json'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  assert.match(hooks.hooks.SessionStart[0].command, /COPILOT_PLUGIN_ROOT.*session-start\.js/);
  assert.match(hooks.hooks.UserPromptSubmit[0].command, /COPILOT_PLUGIN_ROOT.*user-prompt-submit\.js/);
  assert.doesNotMatch(JSON.stringify(hooks), /transcript/i);
});

test('Copilot package exposes charter as both a skill and slash command', () => {
  const skill = read('skills/charter/SKILL.md');
  const command = read('com.github.copilot/commands/charter.md');
  assert.match(skill, /^---\nname: charter\ndescription: /);
  assert.match(skill, /\/charter set <north star>/);
  assert.match(skill, /new Copilot session/i);
  assert.match(command, /^---\ndescription: /);
  assert.match(command, /\$ARGUMENTS/);
  assert.match(command, /CONCORD_CHARTER_SET:/);
});

test('Copilot marketplace points at the Copilot distribution', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(REPO, '.github/plugin/marketplace.json'), 'utf8'));
  const plugin = marketplace.plugins.find(({ name }) => name === 'concord-copilot');
  assert.ok(plugin, 'marketplace is missing concord-copilot');
  assert.equal(plugin.source, './plugins/concord-copilot');
});

test('README documents the Copilot lifecycle and degraded mode', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /copilot plugin marketplace add arinyaho\/concord/);
  assert.match(readme, /copilot plugin install concord-copilot@arinyaho-concord/);
  assert.match(readme, /copilot plugin update concord-copilot@arinyaho-concord/);
  assert.match(readme, /copilot plugin uninstall concord-copilot@arinyaho-concord/);
  assert.match(readme, /Preview hooks/i);
  assert.match(readme, /automatic transcript-derived checkpoints are unavailable/i);
  assert.match(readme, /CONCORD_COPILOT_HOME/);
});

test('Copilot package exposes the approved workflow set', () => {
  const expected = [
    'charter',
    'cross-model-review',
    'initiative-to-prs',
    'proposal-package-authoring',
    'review-until-green',
    'review-until-lgtm',
    'ticket-to-pr',
    'ticket-writing',
  ];
  const actual = fs.readdirSync(path.join(COPILOT, 'skills'))
    .filter((name) => fs.existsSync(path.join(COPILOT, 'skills', name, 'SKILL.md')))
    .sort();
  assert.deepEqual(actual, expected);
});

test('portable Copilot skills remain byte-identical to the shared source', () => {
  const portable = ['ticket-writing', 'ticket-to-pr', 'proposal-package-authoring', 'review-until-lgtm'];
  for (const skill of portable) {
    const sourceRoot = path.join(REPO, 'plugins/concord/skills', skill);
    const packageRoot = path.join(COPILOT, 'skills', skill);
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(source);
        } else {
          const relative = path.relative(sourceRoot, source);
          assert.equal(read(path.join('skills', skill, relative)), fs.readFileSync(source, 'utf8'));
        }
      }
    };
    visit(sourceRoot);
  }
});

test('Copilot-specific orchestration uses native clean-context agents and explicit degradation', () => {
  const review = read('skills/review-until-green/SKILL.md');
  const crossModel = read('skills/cross-model-review/SKILL.md');
  const routing = read('skills/initiative-to-prs/references/model-routing.md');
  assert.match(review, /Concord Reviewer/);
  assert.match(review, /clean context/i);
  assert.match(review, /review-cli\.js/);
  assert.match(review, /do not invoke `telemetry-slot`/i);
  assert.match(review, /telemetry.*unavailable/i);
  assert.match(crossModel, /different.*model/i);
  assert.match(crossModel, /unavailable.*stop/i);
  assert.doesNotMatch(routing, /Codex|Claude Code/);

  for (const agent of ['concord-reviewer.agent.md', 'concord-fixer.agent.md']) {
    const contents = read(path.join('com.github.copilot/agents', agent));
    assert.match(contents, /user-invocable: false/);
  }
  assert.match(read('com.github.copilot/agents/concord-reviewer.agent.md'), /tools: \['read', 'search'\]/);
});

test('Copilot CLI entrypoints run against isolated project state', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-copilot-cli-'));
  const project = path.join(temporary, 'project');
  const home = path.join(temporary, 'home');
  fs.mkdirSync(project);
  const env = { ...process.env, CONCORD_COPILOT_HOME: home };
  const charterCli = path.join(COPILOT, 'bin/charter-cli.js');
  const reviewCli = path.join(COPILOT, 'bin/review-cli.js');

  assert.equal(execFileSync(process.execPath, [charterCli, 'set'], { cwd: project, env, input: 'Ship verified Copilot support.', encoding: 'utf8' }), 'north-star updated.\n');
  assert.match(execFileSync(process.execPath, [charterCli, 'show'], { cwd: project, env, encoding: 'utf8' }), /Ship verified Copilot support\./);
  const ledger = JSON.parse(execFileSync(process.execPath, [reviewCli, 'show', 'feature/copilot'], { cwd: project, env, encoding: 'utf8' }));
  assert.equal(ledger.target.ref, 'feature/copilot');
  const projectDirectories = fs.readdirSync(path.join(home, 'projects'));
  assert.equal(projectDirectories.length, 1);
  assert.match(projectDirectories[0], /^[a-f0-9]{64}$/);
});

pluginInstallE2ETest('clean Copilot config installs, updates, and removes the plugin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-copilot-install-'));
  const config = path.join(root, 'config');
  const home = path.join(root, 'home');
  fs.mkdirSync(config);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args) => execFileSync('copilot', [...args, '--config-dir', config], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

  run(['plugin', 'marketplace', 'add', REPO]);
  assert.match(run(['plugin', 'install', 'concord-copilot@arinyaho-concord']), /installed successfully/i);
  assert.match(run(['plugin', 'list']), /concord-copilot.*0\.9\.0-alpha\.26/i);
  assert.match(run(['plugin', 'update', 'concord-copilot@arinyaho-concord']), /updated|already.*latest/i);
  assert.match(run(['plugin', 'uninstall', 'concord-copilot@arinyaho-concord']), /uninstalled successfully/i);
  assert.doesNotMatch(run(['plugin', 'list']), /concord-copilot/);
});

test('Copilot engine is byte-identical to shared core and Copilot adapters', () => {
  const core = path.join(REPO, 'plugins/concord/core');
  const adapter = path.join(REPO, 'plugins/concord/adapters/copilot');
  const engine = path.join(COPILOT, 'engine');
  const expected = fs.readdirSync(core).filter((file) => file.endsWith('.js')).concat('event.js', 'statedir.js').sort();
  const actual = fs.readdirSync(engine).filter((file) => file.endsWith('.js')).sort();
  assert.deepEqual(actual, expected);

  for (const file of fs.readdirSync(core).filter((name) => name.endsWith('.js'))) {
    assert.ok(fs.readFileSync(path.join(core, file)).equals(fs.readFileSync(path.join(engine, file))), `${file} drifted`);
  }
  for (const file of ['event.js', 'statedir.js']) {
    assert.ok(fs.readFileSync(path.join(adapter, file)).equals(fs.readFileSync(path.join(engine, file))), `${file} drifted`);
  }
});