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

test('nextVersion raises the trailing beta number and rejects other versions', async () => {
  const { nextVersion } = await loadBump();
  assert.equal(nextVersion('0.9.0-beta.9'), '0.9.0-beta.10');
  assert.equal(nextVersion('1.2.3-beta.0'), '1.2.3-beta.1');
  assert.equal(nextVersion('0.9.0'), '0.10.0-beta.1');
  assert.equal(nextVersion('0.10.0-beta.1'), '0.10.0-beta.2');
  assert.equal(nextVersion('1.2.3'), '1.3.0-beta.1');
  for (const bad of ['0.9.0-rc.1', '0.9.0+build', '01.9.0', '0.9', 'v0.9.0', '0.9.0-beta', '0.9.0-beta.x', '']) {
    assert.throws(() => nextVersion(bad), undefined, bad);
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

// The release commit a maintainer merges: a human-authored change that sets a stable version in every release file.
function releaseCommit(remote, tmp, name, version) {
  const dir = clone(remote, path.join(tmp, `release-${name}`));
  execFileSync(process.execPath, ['scripts/release-version.mjs', version], { cwd: dir, env: ENV });
  git(dir, 'add', '--', ...RELEASE_FILES);
  git(dir, 'commit', '-q', '-m', `Release ${version} (#1)`);
  git(dir, 'push', '-q', 'origin', 'main');
}

test('push does not bump the stable release commit and bumps the next merge to the next minor beta', () => {
  const { tmp, remote } = makeOrigin();
  runBump(clone(remote, path.join(tmp, 'seed-run')), 'push', 'main');
  releaseCommit(remote, tmp, 'stable', '0.9.0');
  const count = originLog(tmp, remote).count;
  let result = runBump(clone(remote, path.join(tmp, 'after-release')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originLog(tmp, remote).count, count, 'the release commit was bumped');
  assert.equal(originLog(tmp, remote).version, '0.9.0');

  merge(remote, tmp, 'first-after-release');
  merge(remote, tmp, 'second-after-release');
  result = runBump(clone(remote, path.join(tmp, 'after-merges')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(botVersions(tmp, remote).slice(-2), ['0.10.0-beta.1', '0.10.0-beta.2']);
});

test('push gives no bump to a merge that lands between the last bump and the release commit', () => {
  const { tmp, remote } = makeOrigin();
  runBump(clone(remote, path.join(tmp, 'seed-run')), 'push', 'main');
  merge(remote, tmp, 'before-release');
  releaseCommit(remote, tmp, 'stable', '0.9.0');
  const result = runBump(clone(remote, path.join(tmp, 'run')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originLog(tmp, remote).version, '0.9.0', 'the merge before the release is not bumped past it');
});

function releasePr(remote, tmp, name, version, extra, tamper) {
  const dir = clone(remote, path.join(tmp, `pr-${name}`));
  execFileSync(process.execPath, ['scripts/release-version.mjs', version], { cwd: dir, env: ENV });
  if (extra) fs.writeFileSync(path.join(dir, extra), 'x\n');
  if (tamper) tamper(dir);
  git(dir, 'add', '--', ...RELEASE_FILES, ...(extra ? [extra] : []));
  git(dir, 'commit', '-q', '-m', `Release ${version}`);
  git(dir, 'push', '-q', 'origin', `HEAD:refs/pull/${name}/head`);
  const trusted = clone(remote, path.join(tmp, `trusted-${name}`));
  git(trusted, 'fetch', '-q', '--no-tags', 'origin', `refs/pull/${name}/head:refs/pr/head`);
  return runBump(trusted, 'guard', 'origin/main', 'refs/pr/head');
}

test('guard passes a pull request that only sets a higher stable version in the release files', () => {
  const { tmp, remote } = makeOrigin();
  const result = releasePr(remote, tmp, '1', '0.9.0');
  assert.equal(result.status, 0, result.stderr);
});

test('guard still fails a release-shaped pull request that is not a plain stable release', () => {
  const { tmp, remote } = makeOrigin();
  assert.equal(releasePr(remote, tmp, '1', '0.9.0', 'README.md').status, 1, 'extra file');
  assert.equal(releasePr(remote, tmp, '2', '0.9.0-beta.10').status, 1, 'beta');
  assert.equal(releasePr(remote, tmp, '3', '0.8.0').status, 1, 'downgrade');
  const edit = (file, change) => (dir) => {
    const target = path.join(dir, file);
    fs.writeFileSync(target, change(fs.readFileSync(target, 'utf8')));
  };
  assert.equal(releasePr(remote, tmp, '5', '0.9.0', null, edit('plugins/concord/.claude-plugin/plugin.json', (text) => text.replace(/"name": "concord"/, '"name": "other"'))).status, 1, 'manifest field other than version');
  assert.equal(releasePr(remote, tmp, '6', '0.9.0', null, edit('plugins/concord-copilot/plugin.json', (text) => text.replace(/"version": "0\.9\.0"/, '"version": "0.9.1"'))).status, 1, 'manifest version differing from VERSION');
  assert.equal(releasePr(remote, tmp, '7', '0.9.0', null, (dir) => fs.rmSync(path.join(dir, 'VERSION'))).status, 1, 'VERSION deleted');
});

test('isStableUpgrade accepts only a stable version above the base by SemVer precedence', async () => {
  const { isStableUpgrade } = await loadBump();
  assert.equal(isStableUpgrade('0.9.0-beta.9', '0.9.0'), true);
  assert.equal(isStableUpgrade('0.9.0', '0.9.1'), true, 'a patch release from a maintenance branch');
  assert.equal(isStableUpgrade('0.10.0-beta.3', '0.9.1'), false, 'a patch release from main');
  for (const [base, head] of [['0.9.0', '0.9.0'], ['0.9.0', '0.8.9'], ['0.9.0-beta.9', '0.9.0-beta.10'], ['0.9.0', '1.0.0-rc.1'], ['0.9.0', '1.0.0+b'], ['0.9.0', '']]) {
    assert.equal(isStableUpgrade(base, head), false, `${base} -> ${head}`);
  }
});
