'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const PLUGINS = path.join(__dirname, '..', '..', '..');
const SKILLS = ['concord', 'concord-codex', 'concord-copilot'].map((pkg) => path.join(PLUGINS, pkg, 'skills', 'review-until-lgtm', 'SKILL.md'));

// The script inside the skill's `node -e "..."` command. It contains no `"`, `$` or backtick, so running it with
// `node -e` directly is what a POSIX shell, PowerShell or cmd.exe runs when the command is pasted as written.
function locatorScript(skillPath) {
  const match = fs.readFileSync(skillPath, 'utf8').match(/`node -e "([^"`$]*)"`/);
  assert.ok(match, `${skillPath} has no locator command`);
  return match[1];
}

function install(root, manifestDir, name, version, binDir) {
  fs.mkdirSync(path.join(root, manifestDir), { recursive: true });
  fs.writeFileSync(path.join(root, manifestDir, 'plugin.json'), JSON.stringify({ name, version }));
  fs.mkdirSync(path.join(root, binDir), { recursive: true });
  const cli = path.join(root, binDir, 'review-lgtm-state.js');
  fs.writeFileSync(cli, '');
  return cli;
}

function claudeCopy(home, version) {
  return install(path.join(home, '.claude', 'plugins', 'cache', 'arinyaho-concord', 'concord', version), '.claude-plugin', 'concord', version, 'hooks');
}

function codexCopy(home, version) {
  return install(path.join(home, '.codex', 'plugins', 'cache', 'arinyaho-concord', 'concord', version), '.codex-plugin', 'concord', version, 'bin');
}

// Copilot's package keeps plugin.json at its root, not in a manifest directory.
function copilotCopy(home, version) {
  return install(path.join(home, '.copilot', 'installed-plugins', 'arinyaho-concord', 'concord'), '', 'concord', version, 'bin');
}

function locate(skillPath, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  return spawnSync(process.execPath, ['-e', locatorScript(skillPath)], { env, encoding: 'utf8' });
}

for (const skillPath of SKILLS) {
  const pkg = path.basename(path.dirname(path.dirname(path.dirname(skillPath))));

  test(`${pkg}: the locator selects a newer Claude cache copy over an older Codex cache copy`, () => {
    const home = tempDir('state-cli-locator-');
    const claude = claudeCopy(home, '0.9.0-beta.25');
    codexCopy(home, '0.9.0-beta.19');
    const result = locate(skillPath, home);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), claude);
  });

  test(`${pkg}: the locator selects a newer Copilot copy, whose manifest sits at the package root`, () => {
    const home = tempDir('state-cli-locator-');
    const copilot = copilotCopy(home, '0.9.0-beta.26');
    codexCopy(home, '0.9.0-beta.19');
    const result = locate(skillPath, home);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), copilot);
  });

  test(`${pkg}: the locator selects a Codex cache copy when it is the only one installed`, () => {
    const home = tempDir('state-cli-locator-');
    const codex = codexCopy(home, '0.9.0-beta.19');
    const result = locate(skillPath, home);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), codex);
  });

  test(`${pkg}: the locator never selects a copy whose manifest does not name concord`, () => {
    const home = tempDir('state-cli-locator-');
    const codex = codexCopy(home, '0.9.0-beta.19');
    install(path.join(home, '.claude', 'plugins', 'cache', 'other', 'impostor', '9.9.9'), '.claude-plugin', 'impostor', '9.9.9', 'hooks');
    install(path.join(home, '.codex', 'plugins', 'cache', 'other', 'impostor', '9.9.9'), '.codex-plugin', 'impostor', '9.9.9', 'bin');
    const result = locate(skillPath, home);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), codex);

    const empty = tempDir('state-cli-locator-');
    install(path.join(empty, '.claude', 'plugins', 'cache', 'other', 'impostor', '9.9.9'), '.claude-plugin', 'impostor', '9.9.9', 'hooks');
    const none = locate(skillPath, empty);
    assert.strictEqual(none.status, 1);
    assert.strictEqual(none.stdout, '');
  });
}

test('the three packages ship the same locator command', () => {
  const [claude, ...others] = SKILLS.map(locatorScript);
  for (const other of others) assert.strictEqual(other, claude);
});
