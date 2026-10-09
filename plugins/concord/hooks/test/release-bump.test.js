'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const BUMP = path.join(REPO, 'scripts/release-bump.mjs');
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const RELEASE_FILES = [
  '.github/plugin/marketplace.json',
  'VERSION',
  'plugins/concord-codex/.codex-plugin/plugin.json',
  'plugins/concord-copilot/plugin.json',
  'plugins/concord/.claude-plugin/plugin.json',
];
const COPIED = [...RELEASE_FILES, 'scripts/release-version.mjs', 'scripts/release-bump.mjs'];
// Isolate the temp repositories from the developer's git configuration.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

const loadBump = () => import(pathToFileURL(BUMP).href);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configure(dir) {
  git(dir, 'config', 'user.name', 'Test Author');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function clone(remote, dir) {
  execFileSync('git', ['clone', '-q', remote, dir], { env: ENV, stdio: 'ignore' });
  configure(dir);
  return dir;
}

function runBump(cwd, ...args) {
  return spawnSync(process.execPath, ['scripts/release-bump.mjs', ...args], { cwd, env: ENV, encoding: 'utf8' });
}

// A bare origin plus a seed commit holding copies of the release script, the bump script, and the version files.
function makeOrigin() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bump-'));
  const remote = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: ENV });
  const seed = path.join(tmp, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'main', seed], { env: ENV });
  configure(seed);
  for (const file of COPIED) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(seed, file));
  }
  fs.writeFileSync(path.join(seed, 'VERSION'), '0.9.0-beta.9\n');
  execFileSync(process.execPath, ['scripts/release-version.mjs', '0.9.0-beta.9'], { cwd: seed, env: ENV });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  return { tmp, remote };
}

function originLog(tmp, remote) {
  const view = clone(remote, path.join(tmp, `view-${Date.now()}-${Math.random()}`));
  return {
    count: Number(git(view, 'rev-list', '--count', 'HEAD')),
    subject: git(view, 'log', '-1', '--format=%s'),
    author: git(view, 'log', '-1', '--format=%ae'),
    files: git(view, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort(),
    version: fs.readFileSync(path.join(view, 'VERSION'), 'utf8').trim(),
    manifest: JSON.parse(fs.readFileSync(path.join(view, 'plugins/concord/.claude-plugin/plugin.json'), 'utf8')).version,
  };
}

test('nextBeta raises the trailing beta number and rejects other versions', async () => {
  const { nextBeta } = await loadBump();
  assert.equal(nextBeta('0.9.0-beta.9'), '0.9.0-beta.10');
  assert.equal(nextBeta('1.2.3-beta.0'), '1.2.3-beta.1');
  for (const bad of ['0.9.0', '0.9.0-rc.1', '0.9.0-beta', '0.9.0-beta.x', '']) {
    assert.throws(() => nextBeta(bad), undefined, bad);
  }
});

test('touchedVersionFiles keeps only the files the release script writes', async () => {
  const { touchedVersionFiles } = await loadBump();
  assert.deepEqual(touchedVersionFiles(['README.md', 'docs/x.md']), []);
  assert.deepEqual(touchedVersionFiles(['docs/x.md', ...RELEASE_FILES, 'VERSION.md']).sort(), RELEASE_FILES);
  assert.deepEqual(touchedVersionFiles(['plugins/concord/package.json', '.claude-plugin/marketplace.json']), []);
});

test('push makes one bot bump per merge, serializes stale clones, skips its own commit, and retries a lost race', () => {
  const { tmp, remote } = makeOrigin();
  const first = clone(remote, path.join(tmp, 'first'));
  const stale = clone(remote, path.join(tmp, 'stale'));

  let result = runBump(first, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  let log = originLog(tmp, remote);
  assert.equal(log.count, 2);
  assert.equal(log.subject, 'chore(release): bump Concord to 0.9.0-beta.10');
  assert.equal(log.version, '0.9.0-beta.10');
  assert.equal(log.manifest, '0.9.0-beta.10');
  assert.equal(log.author, BOT_EMAIL);
  assert.deepEqual(log.files, RELEASE_FILES);

  // A run whose checkout predates the previous bump still yields the next consecutive version.
  result = runBump(stale, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  log = originLog(tmp, remote);
  assert.equal(log.count, 3);
  assert.equal(log.version, '0.9.0-beta.11');
  assert.deepEqual(log.files, RELEASE_FILES);

  // A run triggered by the bot's own bump commit does nothing.
  const fresh = clone(remote, path.join(tmp, 'fresh'));
  result = runBump(fresh, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originLog(tmp, remote).count, 3);

  // Lost race: another clone pushes a bump after this run fetched and before its push lands.
  git(fresh, 'commit', '-q', '--allow-empty', '-m', 'feature merged');
  git(fresh, 'push', '-q', 'origin', 'main');
  const racer = clone(remote, path.join(tmp, 'racer'));
  const racing = clone(remote, path.join(tmp, 'racing'));
  const marker = path.join(tmp, 'raced');
  const hook = path.join(racing, '.git/hooks/pre-push');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -e '${marker}' ]; then\n  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n  touch '${marker}'\n  cd '${racer}' && '${process.execPath}' scripts/release-bump.mjs push main >/dev/null 2>&1 || exit 2\nfi\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  result = runBump(racing, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(marker), 'the race hook did not run');
  const view = clone(remote, path.join(tmp, 'final'));
  const subjects = git(view, 'log', '-3', '--format=%s').split('\n');
  assert.deepEqual(subjects, [
    'chore(release): bump Concord to 0.9.0-beta.13',
    'chore(release): bump Concord to 0.9.0-beta.12',
    'feature merged',
  ]);
  assert.equal(fs.readFileSync(path.join(view, 'VERSION'), 'utf8').trim(), '0.9.0-beta.13');
});

test('guard fails a branch that edits a version file and passes one that does not', () => {
  const { tmp, remote } = makeOrigin();
  const repo = clone(remote, path.join(tmp, 'guard'));

  git(repo, 'checkout', '-q', '-b', 'docs-only');
  fs.writeFileSync(path.join(repo, 'README.md'), 'docs\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'docs');
  let result = runBump(repo, 'guard', 'origin/main');
  assert.equal(result.status, 0, result.stderr);

  git(repo, 'checkout', '-q', '-b', 'edits-version', 'origin/main');
  fs.writeFileSync(path.join(repo, 'VERSION'), '0.9.0-beta.10\n');
  git(repo, 'commit', '-q', '-am', 'hand bump');
  result = runBump(repo, 'guard', 'origin/main');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /VERSION/);
});
