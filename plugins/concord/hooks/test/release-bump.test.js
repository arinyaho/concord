'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('./temp-dir');

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
  const tmp = tempDir('release-bump-');
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

function merge(remote, tmp, name) {
  const dir = clone(remote, path.join(tmp, `merge-${name}`));
  git(dir, 'commit', '-q', '--allow-empty', '-m', `merge ${name}`);
  git(dir, 'push', '-q', 'origin', 'main');
}

function botVersions(tmp, remote) {
  const view = clone(remote, path.join(tmp, `bots-${Date.now()}-${Math.random()}`));
  return git(view, 'log', '--reverse', '--format=%ae %s').split('\n')
    .filter((line) => line.startsWith(`${BOT_EMAIL} `))
    .map((line) => line.replace(`${BOT_EMAIL} chore(release): bump Concord to `, ''));
}

test('push bumps once for the first merge and is a no-op while the tip is a bump', () => {
  const { tmp, remote } = makeOrigin();
  const run = clone(remote, path.join(tmp, 'run'));
  let result = runBump(run, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  const log = originLog(tmp, remote);
  assert.equal(log.count, 2);
  assert.equal(log.subject, 'chore(release): bump Concord to 0.9.0-beta.10');
  assert.equal(log.version, '0.9.0-beta.10');
  assert.equal(log.manifest, '0.9.0-beta.10');
  assert.equal(log.author, BOT_EMAIL);
  assert.deepEqual(log.files, RELEASE_FILES);

  result = runBump(clone(remote, path.join(tmp, 'again')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originLog(tmp, remote).count, 2);
});

test('push gives three quick merges three consecutive bumps even though only one run survives', () => {
  const { tmp, remote } = makeOrigin();
  runBump(clone(remote, path.join(tmp, 'seed-run')), 'push', 'main');
  for (const name of ['a', 'b', 'c']) merge(remote, tmp, name);
  const result = runBump(clone(remote, path.join(tmp, 'survivor')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(botVersions(tmp, remote), ['0.9.0-beta.10', '0.9.0-beta.11', '0.9.0-beta.12', '0.9.0-beta.13']);
  const log = originLog(tmp, remote);
  assert.equal(log.version, '0.9.0-beta.13');
  assert.deepEqual(log.files, RELEASE_FILES);
});

test('push counts only the merges after the last bump when a bump landed between merges', () => {
  const { tmp, remote } = makeOrigin();
  runBump(clone(remote, path.join(tmp, 'seed-run')), 'push', 'main');
  merge(remote, tmp, 'a');
  const early = clone(remote, path.join(tmp, 'early'));
  runBump(early, 'push', 'main');
  merge(remote, tmp, 'b');
  merge(remote, tmp, 'c');
  const result = runBump(early, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(botVersions(tmp, remote), ['0.9.0-beta.10', '0.9.0-beta.11', '0.9.0-beta.12', '0.9.0-beta.13']);
});

test('push ignores a bot commit that is not a release bump and still bumps the merge before it', () => {
  const { tmp, remote } = makeOrigin();
  runBump(clone(remote, path.join(tmp, 'seed-run')), 'push', 'main');
  merge(remote, tmp, 'human');
  const docs = clone(remote, path.join(tmp, 'docs-bot'));
  git(docs, '-c', 'user.name=github-actions[bot]', '-c', `user.email=${BOT_EMAIL}`, 'commit', '-q', '--allow-empty', '-m', 'docs: regenerate index');
  git(docs, 'push', '-q', 'origin', 'main');
  const result = runBump(clone(remote, path.join(tmp, 'run')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(botVersions(tmp, remote).filter((v) => v.startsWith('0.')), ['0.9.0-beta.10', '0.9.0-beta.11']);
});

test('rerunning a finished run at its original checkout creates no commit', () => {
  const { tmp, remote } = makeOrigin();
  const original = clone(remote, path.join(tmp, 'original'));
  runBump(clone(remote, path.join(tmp, 'first-run')), 'push', 'main');
  assert.equal(originLog(tmp, remote).count, 2);
  const result = runBump(original, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originLog(tmp, remote).count, 2);
  assert.deepEqual(botVersions(tmp, remote), ['0.9.0-beta.10']);
});

test('push retries a lost race and ends with the racer\'s bump only', () => {
  const { tmp, remote } = makeOrigin();
  runBump(clone(remote, path.join(tmp, 'seed-run')), 'push', 'main');
  merge(remote, tmp, 'feature');
  const racer = clone(remote, path.join(tmp, 'racer'));
  const racing = clone(remote, path.join(tmp, 'racing'));
  const marker = path.join(tmp, 'raced');
  const hook = path.join(racing, '.git/hooks/pre-push');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -e '${marker}' ]; then\n  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n  touch '${marker}'\n  cd '${racer}' && '${process.execPath}' scripts/release-bump.mjs push main >/dev/null 2>&1 || exit 2\nfi\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  const result = runBump(racing, 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(marker), 'the race hook did not run');
  assert.deepEqual(botVersions(tmp, remote), ['0.9.0-beta.10', '0.9.0-beta.11']);
});

test('guard fails a head that edits a version file and passes one that does not', () => {
  const { tmp, remote } = makeOrigin();
  const repo = clone(remote, path.join(tmp, 'guard'));

  git(repo, 'checkout', '-q', '-b', 'docs-only');
  fs.writeFileSync(path.join(repo, 'README.md'), 'docs\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'docs');
  let result = runBump(repo, 'guard', 'origin/main', 'docs-only');
  assert.equal(result.status, 0, result.stderr);

  git(repo, 'checkout', '-q', '-b', 'edits-version', 'origin/main');
  fs.writeFileSync(path.join(repo, 'VERSION'), '0.9.0-beta.10\n');
  git(repo, 'commit', '-q', '-am', 'hand bump');
  result = runBump(repo, 'guard', 'origin/main', 'edits-version');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /VERSION/);
});

test('guard run from the base code fails a head that rewrites the guard together with VERSION', () => {
  const { tmp, remote } = makeOrigin();
  const pr = clone(remote, path.join(tmp, 'pr'));
  const script = path.join(pr, 'scripts/release-bump.mjs');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace(/export const VERSION_FILES = \[[^\]]*\];/, 'export const VERSION_FILES = [];'));
  fs.writeFileSync(path.join(pr, 'VERSION'), '0.9.0-beta.10\n');
  git(pr, 'commit', '-q', '-am', 'disable the guard and hand bump');
  git(pr, 'push', '-q', 'origin', 'HEAD:refs/pull/1/head');

  // The checkout the old workflow ran from: the pull request's own script approves itself.
  assert.equal(runBump(pr, 'guard', 'origin/main', 'HEAD').status, 0);

  // The trusted checkout holds the base code and fetches the head only as data.
  const trusted = clone(remote, path.join(tmp, 'trusted'));
  git(trusted, 'fetch', '-q', '--no-tags', 'origin', 'refs/pull/1/head:refs/pr/head');
  const result = runBump(trusted, 'guard', 'origin/main', 'refs/pr/head');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /VERSION/);
});
