'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

const SKILL_DIR = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const LOCATOR = skill.match(/`(node -e "const fs=[^`]*process\.exit\(1\)")`/)[1];

// A fixture Codex install: <home>/.codex/plugins/cache/arinyaho-concord/concord/<version>/ holding a copy of the scripts.
function install(home, version) {
  const root = path.join(home, '.codex', 'plugins', 'cache', 'arinyaho-concord', 'concord', version);
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'concord', version }));
  fs.cpSync(path.join(SKILL_DIR, 'scripts'), path.join(root, 'skills', 'review-until-approve', 'scripts'), { recursive: true });
  // approve.js needs the runner modules locate.js looks for: the shared core as engine/ and the review CLI as bin/.
  const plugin = path.join(SKILL_DIR, '..', '..');
  fs.cpSync(path.join(plugin, 'core'), path.join(root, 'engine'), { recursive: true });
  fs.cpSync(path.join(plugin, 'adapters', 'codex'), path.join(root, 'engine'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(plugin, 'hooks', 'review-cli.js'), path.join(root, 'bin', 'review-cli.js'));
  return root;
}

// A fake `gh` that reports the reviewed head, so a window ends idle.
function fixture(ledger) {
  const dir = tempDir('rua-relocate-');
  const home = path.join(dir, 'home');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
console.log(JSON.stringify(a[0] === 'pr' ? { headRefOid: 'h1', state: 'OPEN', isDraft: false, author: { login: 'dev' }, title: 't', body: 'b' } : [[]]));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger));
  return { dir, home, ledgerPath: path.join(dir, 'ledger.json') };
}
const env = (f) => ({ ...process.env, HOME: f.home, USERPROFILE: f.home, PATH: `${f.dir}${path.delimiter}${process.env.PATH}` });
// One Codex window: the locator and the watch in one shell command, as the skill says.
const window = (f) => spawnSync('sh', ['-c', `SCRIPTS=$(${LOCATOR}) && node "$SCRIPTS/watch.js" "${f.ledgerPath}" o/r 5 --max-wait 0.3 --interval 0.05`], { encoding: 'utf8', env: env(f), timeout: 20000 });

const ledger = { version: 1, plugin: '0.9.1-beta.1', reviewer: 'bot', rounds: [{ n: 1, head: 'h1', mergeBase: 'm', intent: 'i', submittedAt: new Date().toISOString(), commentIds: [11] }], findings: [{ id: 'w', key: 'w', status: 'open' }] };

test('a watch window run after the plugin version directory was replaced runs from the installed version', () => {
  const f = fixture(ledger);
  const first = install(f.home, '0.9.1-beta.1');
  const stale = path.join(first, 'skills', 'review-until-approve', 'scripts', 'watch.js');
  const before = fs.readFileSync(f.ledgerPath, 'utf8');
  assert.equal(JSON.parse(window(f).stdout).event, 'idle');
  fs.rmSync(first, { recursive: true });
  install(f.home, '0.9.1-beta.2');
  // Before: the path resolved once at skill start no longer exists.
  const reused = spawnSync('node', [stale, f.ledgerPath, 'o/r', '5'], { encoding: 'utf8', env: env(f) });
  assert.match(reused.stderr, /MODULE_NOT_FOUND/);
  // After: the next window locates the installed version again.
  const second = window(f);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).event, 'idle');
  // The watch never writes the ledger.
  assert.equal(fs.readFileSync(f.ledgerPath, 'utf8'), before);
});

test('the locator names the newest installed version and never a path from the reviewed checkout', () => {
  const f = fixture(ledger);
  install(f.home, '0.9.1-beta.2');
  const newest = install(f.home, '0.9.1-beta.10');
  const r = spawnSync('sh', ['-c', LOCATOR], { encoding: 'utf8', env: env(f), cwd: SKILL_DIR });
  assert.equal(r.stdout.trim(), path.join(newest, 'skills', 'review-until-approve', 'scripts'));
});

test('a ledger of another format ends the watch naming both versions and leaves the ledger unchanged', () => {
  const f = fixture({ ...ledger, version: 2, plugin: '0.10.0' });
  install(f.home, '0.9.1-beta.2');
  const before = fs.readFileSync(f.ledgerPath, 'utf8');
  const r = window(f);
  const event = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(event.event, 'error');
  assert.match(event.detail, /concord 0\.9\.1-beta\.2 reads ledger format 1/);
  assert.match(event.detail, /format 2 written by concord 0\.10\.0/);
  assert.equal(fs.readFileSync(f.ledgerPath, 'utf8'), before);
});

test('a ledger written by the previous version (no plugin field) is read and keeps its findings', () => {
  const { plugin, ...previous } = ledger;
  const f = fixture(previous);
  install(f.home, '0.9.1-beta.2');
  const before = fs.readFileSync(f.ledgerPath, 'utf8');
  assert.equal(JSON.parse(before).findings[0].status, 'open');
  assert.equal(JSON.parse(before).rounds.length, 1);
  const r = window(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).event, 'idle');
  assert.equal(fs.readFileSync(f.ledgerPath, 'utf8'), before);
});

test('approve.js refuses a ledger of another format without writing it', () => {
  const f = fixture({ ...ledger, version: 2, plugin: '0.10.0', repo: 'o/r', pr: 5 });
  const root = install(f.home, '0.9.1-beta.2');
  const state = path.join(f.dir, 'state');
  fs.mkdirSync(state);
  fs.copyFileSync(f.ledgerPath, path.join(state, 'o__r__5__me.json'));
  fs.writeFileSync(path.join(f.dir, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'api' && a[1] === 'user') console.log('me');
else console.log(JSON.stringify({ state: 'OPEN', author: { login: 'dev' }, headRefOid: 'h1', isDraft: false }));
`, { mode: 0o755 });
  const r = spawnSync('node', [path.join(root, 'skills', 'review-until-approve', 'scripts', 'approve.js'), 'start', 'o/r', '5'], { encoding: 'utf8', env: { ...env(f), REVIEW_APPROVE_STATE_DIR: state } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /format 2 written by concord 0\.10\.0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'o__r__5__me.json'), 'utf8')).version, 2);
});

test('approve.js next reads a run file that has no format version', () => {
  const f = fixture(ledger);
  const root = install(f.home, '0.9.1-beta.2');
  const state = path.join(f.dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(f.dir, 'gh'), '#!/usr/bin/env node\nconsole.log("me");\n', { mode: 0o755 });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(path.join(state, 'o__r__5__me.json.run.json'), JSON.stringify({ pid: dead, dir: f.dir }));
  const r = spawnSync('node', [path.join(root, 'skills', 'review-until-approve', 'scripts', 'approve.js'), 'next', 'o/r', '5'], { encoding: 'utf8', env: { ...env(f), REVIEW_APPROVE_STATE_DIR: state } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).event, 'finished');
});

test('a failed poll whose message mentions ledger format is retried, not treated as a format refusal', () => {
  const f = fixture(ledger);
  install(f.home, '0.9.1-beta.2');
  fs.writeFileSync(path.join(f.dir, 'gh'), '#!/usr/bin/env node\nconsole.error("ledger format");\nprocess.exit(1);\n', { mode: 0o755 });
  const r = window(f);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).event, 'idle');
});
