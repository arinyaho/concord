'use strict';
// The locator in SKILL.md, run as the skill runs it: it finds the newest installed copy of review-until-approve.js,
// never a path from the reviewed checkout, and finds it again after a plugin update replaced the version directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

const SKILL_DIR = path.join(__dirname, '..');
const PLUGIN = path.join(SKILL_DIR, '..', '..');
const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const LOCATOR = skill.match(/`(node -e "const fs=[^`]*process\.exit\(1\)")`/)[1];

// A fixture Codex install: <home>/.codex/plugins/cache/arinyaho-concord/concord/<version>/ holding what the script
// requires.
function install(home, version) {
  const root = path.join(home, '.codex', 'plugins', 'cache', 'arinyaho-concord', 'concord', version);
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'concord', version }));
  for (const d of ['runtime', 'core', 'skills/explain-pr/scripts', 'skills/review-until-approve/scripts', 'skills/review-until-approve/references']) {
    fs.cpSync(path.join(PLUGIN, d), path.join(root, d), { recursive: true, filter: (src) => path.basename(src) !== 'test' });
  }
  return root;
}
const fixture = () => {
  const dir = tempDir('rua-relocate-');
  return { dir, home: path.join(dir, 'home') };
};
const env = (f) => ({ ...process.env, HOME: f.home, USERPROFILE: f.home });
// One call as the skill makes it: the locator and the script in one shell command. Without arguments the script
// prints its usage line and exits 2, which shows it loaded with everything it requires.
const call = (f) => spawnSync('sh', ['-c', `SCRIPTS=$(${LOCATOR}) && node "$SCRIPTS/review-until-approve.js"`], { encoding: 'utf8', env: env(f), timeout: 20000 });

test('a call made after the plugin version directory was replaced runs the installed version', () => {
  const f = fixture();
  const first = install(f.home, '0.9.1-beta.1');
  const stale = path.join(first, 'skills', 'review-until-approve', 'scripts', 'review-until-approve.js');
  const before = call(f);
  assert.equal(before.status, 2, before.stderr);
  assert.match(before.stderr, /^review-until-approve: usage/);
  fs.rmSync(first, { recursive: true });
  install(f.home, '0.9.1-beta.2');
  // A path resolved once at the start no longer exists.
  assert.match(spawnSync('node', [stale], { encoding: 'utf8', env: env(f) }).stderr, /MODULE_NOT_FOUND/);
  // The next call locates the installed version again.
  const after = call(f);
  assert.equal(after.status, 2, after.stderr);
  assert.match(after.stderr, /^review-until-approve: usage/);
});

test('the locator names the newest installed version and never a path from the reviewed checkout', () => {
  const f = fixture();
  install(f.home, '0.9.1-beta.2');
  const newest = install(f.home, '0.9.1-beta.10');
  // A checkout under review carrying a copy with a higher version is never found: only the caches are searched.
  const checkout = path.join(f.dir, 'checkout');
  fs.mkdirSync(path.join(checkout, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'concord', version: '9.9.9' }));
  fs.cpSync(path.join(SKILL_DIR, 'scripts'), path.join(checkout, 'skills', 'review-until-approve', 'scripts'), { recursive: true });
  const r = spawnSync('sh', ['-c', LOCATOR], { encoding: 'utf8', env: env(f), cwd: checkout });
  assert.equal(r.stdout.trim(), path.join(newest, 'skills', 'review-until-approve', 'scripts'));
});

test('the bundled Codex copy of the skill carries its script and request files', () => {
  const codex = path.join(PLUGIN, '..', 'concord-codex', 'skills', 'review-until-approve');
  for (const f of ['scripts/review-until-approve.js', 'references/reviewer-request.md', 'references/verifier-request.md']) assert.ok(fs.existsSync(path.join(codex, f)), f);
});
