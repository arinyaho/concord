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
  'VERSION',
  'plugins/concord-codex/.codex-plugin/plugin.json',
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
function makeOrigin(seedVersion = '0.9.0-beta.9') {
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
  fs.writeFileSync(path.join(seed, 'VERSION'), `${seedVersion}\n`);
  execFileSync(process.execPath, ['scripts/release-version.mjs', seedVersion], { cwd: seed, env: ENV });
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
  assert.equal(nextVersion('0.9.0'), '0.9.1-beta.1');
  assert.equal(nextVersion('0.9.1-beta.1'), '0.9.1-beta.2');
  assert.equal(nextVersion('1.2.3'), '1.2.4-beta.1');
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

test('version-guard fetches the event head without requiring a pull ref and runs trusted base code', () => {
  const { tmp, remote } = makeOrigin();
  const trusted = clone(remote, path.join(tmp, 'trusted'));
  const pr = clone(remote, path.join(tmp, 'pr'));
  fs.writeFileSync(path.join(pr, 'VERSION'), '0.9.0-beta.10\n');
  fs.writeFileSync(path.join(pr, 'scripts/release-bump.mjs'), 'process.exit(0);\n');
  git(pr, 'commit', '-q', '-am', 'untrusted head');
  const head = git(pr, 'rev-parse', 'HEAD');
  git(pr, 'push', '-q', 'origin', 'HEAD:refs/heads/worker');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', head], { cwd: trusted, env: ENV }).status, 0,
    'the event commit must be absent before the workflow fetch');
  // A newer branch tip must not replace the commit from the event being checked.
  git(pr, 'reset', '--hard', 'origin/main');
  fs.writeFileSync(path.join(pr, 'README.md'), 'later harmless revision\n');
  git(pr, 'add', 'README.md');
  git(pr, 'commit', '-q', '-m', 'later revision');
  git(pr, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/worker');
  const missing = spawnSync('git', ['fetch', 'origin', 'refs/pull/1/head:refs/pr/head'], { cwd: trusted, env: ENV });
  assert.notEqual(missing.status, 0, 'fixture must have no synthetic pull ref');
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/version-guard.yml'), 'utf8');
  assert.match(workflow, /HEAD_SHA: \$\{\{ github.event.pull_request.head.sha \}\}/);
  const commands = workflow.split('        run: |\n')[1].replace(/^          /gm, '');
  const result = spawnSync('bash', ['-e', '-c', commands], {
    cwd: trusted, env: { ...ENV, BASE_REF: 'main', HEAD_SHA: head, PR: '1' }, encoding: 'utf8',
  });
  assert.equal(git(trusted, 'rev-parse', 'refs/pr/head'), head);
  assert.equal(git(trusted, 'rev-parse', 'HEAD'), git(trusted, 'rev-parse', 'origin/main'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Pull requests do not change the version/);
});

// The release commit a maintainer merges: a human-authored change that sets a stable version in every release file.
function releaseCommit(remote, tmp, name, version) {
  const dir = clone(remote, path.join(tmp, `release-${name}`));
  execFileSync(process.execPath, ['scripts/release-version.mjs', version], { cwd: dir, env: ENV });
  git(dir, 'add', '--', ...RELEASE_FILES);
  git(dir, 'commit', '-q', '-m', `Release ${version} (#1)`);
  git(dir, 'push', '-q', 'origin', 'main');
}

test('push does not bump the stable release commit and bumps the next merge to the next patch beta', () => {
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
  assert.deepEqual(botVersions(tmp, remote).slice(-2), ['0.9.1-beta.1', '0.9.1-beta.2']);
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

test('guard passes a patch release against a base at the patch beta and a new minor release against the same base', () => {
  const { tmp, remote } = makeOrigin('0.9.1-beta.3');
  assert.equal(releasePr(remote, tmp, '1', '0.9.1').status, 0, 'patch release');
  assert.equal(releasePr(remote, tmp, '2', '0.10.0').status, 0, 'new minor release');
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
  assert.equal(releasePr(remote, tmp, '6', '0.9.0', null, edit('plugins/concord-codex/.codex-plugin/plugin.json', (text) => text.replace(/"version": "0\.9\.0"/, '"version": "0.9.1"'))).status, 1, 'manifest version differing from VERSION');
  assert.equal(releasePr(remote, tmp, '7', '0.9.0', null, (dir) => fs.rmSync(path.join(dir, 'VERSION'))).status, 1, 'VERSION deleted');
});

test('guard passes a pull request that deletes files outside the version-file set, even when they hold a version field', () => {
  const { tmp, remote } = makeOrigin();
  const files = ['tools/example/plugin.json', 'tools/example/marketplace.json'];
  const base = clone(remote, path.join(tmp, 'base'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    fs.writeFileSync(path.join(base, file), '{"version": "0.9.0-beta.9"}\n');
  }
  git(base, 'add', '-A');
  git(base, 'commit', '-q', '-m', 'add example files');
  git(base, 'push', '-q', 'origin', 'HEAD:main');
  const dir = clone(remote, path.join(tmp, 'pr-delete'));
  git(dir, 'rm', '-q', ...files);
  git(dir, 'commit', '-q', '-m', 'Delete example files');
  git(dir, 'push', '-q', 'origin', 'HEAD:refs/pull/9/head');
  const trusted = clone(remote, path.join(tmp, 'trusted-delete'));
  git(trusted, 'fetch', '-q', '--no-tags', 'origin', 'refs/pull/9/head:refs/pr/head');
  const result = runBump(trusted, 'guard', 'origin/main', 'refs/pr/head');
  assert.equal(result.status, 0, result.stderr);
});

test('isStableUpgrade accepts only a stable version above the base by SemVer precedence', async () => {
  const { isStableUpgrade } = await loadBump();
  assert.equal(isStableUpgrade('0.9.0-beta.9', '0.9.0'), true);
  assert.equal(isStableUpgrade('0.9.0', '0.9.1'), true, 'a patch release above the previous stable');
  assert.equal(isStableUpgrade('0.9.1-beta.3', '0.9.1'), true, 'a patch release from main');
  assert.equal(isStableUpgrade('0.9.1-beta.3', '0.10.0'), true, 'a new minor release from main');
  assert.equal(isStableUpgrade('0.9.1-beta.3', '0.9.0'), false, 'a release below the beta line');
  for (const [base, head] of [['0.9.0', '0.9.0'], ['0.9.0', '0.8.9'], ['0.9.0-beta.9', '0.9.0-beta.10'], ['0.9.0', '1.0.0-rc.1'], ['0.9.0', '1.0.0+b'], ['0.9.0', '']]) {
    assert.equal(isStableUpgrade(base, head), false, `${base} -> ${head}`);
  }
});

const CLAUDE = 'plugins/concord/.claude-plugin/plugin.json';
const CODEX = 'plugins/concord-codex/.codex-plugin/plugin.json';

// Runs the trusted guard against a pull request head made by `mutate` on a checkout of origin/main.
function guardPr(remote, tmp, name, mutate) {
  const dir = clone(remote, path.join(tmp, `pr-${name}`));
  mutate(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', name);
  git(dir, 'push', '-q', 'origin', `HEAD:refs/pull/${name}/head`);
  const trusted = clone(remote, path.join(tmp, `trusted-${name}`));
  git(trusted, 'fetch', '-q', '--no-tags', 'origin', `refs/pull/${name}/head:refs/pr/head`);
  return runBump(trusted, 'guard', 'origin/main', 'refs/pr/head');
}

const editFile = (file, change) => (dir) => {
  const target = path.join(dir, file);
  fs.writeFileSync(target, change(fs.readFileSync(target, 'utf8')));
};
const editDescription = (file) => editFile(file, (text) => {
  const manifest = JSON.parse(text);
  manifest.description = 'A corrected description';
  return `${JSON.stringify(manifest, null, 2)}\n`;
});

test('guard passes a pull request that edits only a manifest description, alone or with unrelated files', () => {
  const { tmp, remote } = makeOrigin();
  assert.equal(guardPr(remote, tmp, '1', editDescription(CLAUDE)).status, 0);
  assert.equal(guardPr(remote, tmp, '2', (dir) => {
    editDescription(CODEX)(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'docs\n');
  }).status, 0);
});

test('guard passes a description edit made before a bump landed on the base, and fails one that also reverts that bump', () => {
  const { tmp, remote } = makeOrigin();
  const bump = (dir) => {
    for (const file of [CLAUDE, CODEX]) editFile(file, (text) => text.replace(/"version": "[^"]*"/, '"version": "0.9.0-beta.10"'))(dir);
    fs.writeFileSync(path.join(dir, 'VERSION'), '0.9.0-beta.10\n');
  };
  // The pull request head is made first, from the base as it was; then the base moves.
  const pr = clone(remote, path.join(tmp, 'pr-early'));
  editDescription(CLAUDE)(pr);
  git(pr, 'commit', '-q', '-am', 'edit description');
  git(pr, 'push', '-q', 'origin', 'HEAD:refs/pull/early/head');
  const base = clone(remote, path.join(tmp, 'base-bump'));
  bump(base);
  git(base, 'commit', '-q', '-am', 'bump');
  git(base, 'push', '-q', 'origin', 'HEAD:main');
  const trusted = clone(remote, path.join(tmp, 'trusted-early'));
  git(trusted, 'fetch', '-q', '--no-tags', 'origin', 'refs/pull/early/head:refs/pr/head');
  assert.equal(runBump(trusted, 'guard', 'origin/main', 'refs/pr/head').status, 0, 'the bump on the base is not the pull request\'s change');
  // A head that branches after the bump and sets the version back changes the version.
  assert.equal(guardPr(remote, tmp, 'revert', editFile(CLAUDE, (text) => text.replace(/"version": "[^"]*"/, '"version": "0.9.0-beta.9"'))).status, 1);
});

test('guard fails a pull request that changes a manifest or VERSION version, with or without a description edit', () => {
  const { tmp, remote } = makeOrigin();
  const setVersion = (file) => editFile(file, (text) => text.replace(/"version": "[^"]*"/, '"version": "0.9.0-beta.10"'));
  assert.equal(guardPr(remote, tmp, '1', (dir) => {
    editDescription(CLAUDE)(dir);
    setVersion(CLAUDE)(dir);
  }).status, 1, 'description and version');
  assert.equal(guardPr(remote, tmp, '2', setVersion(CLAUDE)).status, 1, 'manifest version only');
  const result = guardPr(remote, tmp, '3', editFile('VERSION', () => '0.9.0-beta.10\n'));
  assert.equal(result.status, 1, 'VERSION only');
  assert.match(result.stderr, /VERSION/);
});

test('guard fails a release that also edits a description and a manifest that is not valid JSON or has no string version', () => {
  const { tmp, remote } = makeOrigin();
  assert.equal(releasePr(remote, tmp, '1', '0.9.0', null, editDescription(CLAUDE)).status, 1, 'release with description edit');
  assert.equal(guardPr(remote, tmp, '2', editFile(CLAUDE, (text) => `${text}}`)).status, 1, 'invalid JSON');
  assert.equal(guardPr(remote, tmp, '3', editFile(CLAUDE, (text) => text.replace(/"version": "[^"]*"/, '"version": 9'))).status, 1, 'non-string version');
  assert.equal(guardPr(remote, tmp, '4', (dir) => fs.rmSync(path.join(dir, CODEX))).status, 1, 'manifest deleted');
});

test('guard fails a manifest that is a symlink, has a duplicated version key, is renamed away, or is not in the written form', () => {
  const { tmp, remote } = makeOrigin();
  // A symlink's blob is its target text. Here that text is the unchanged manifest in the written form, so only the file-type check can reject it.
  const asSymlink = (dir) => {
    const manifest = path.join(dir, CLAUDE);
    const text = fs.readFileSync(manifest, 'utf8');
    fs.rmSync(manifest);
    fs.symlinkSync(text, manifest);
  };
  const symlinked = guardPr(remote, tmp, '1', asSymlink);
  assert.equal(symlinked.status, 1, 'symlink');
  assert.match(symlinked.stderr, /plugin\.json: not a regular file/);
  // A release whose manifest blob is byte-identical to the release script's output, but is a symlink, is not a release.
  assert.equal(releasePr(remote, tmp, 'release-link', '0.9.0', null, asSymlink).status, 1, 'release with a symlinked manifest');
  const before = (extra) => editFile(CLAUDE, (text) => text.replace(/(\n\s*)"version":/, `$1${extra},$1"version":`));
  assert.equal(guardPr(remote, tmp, '2', before('"version": "99.0.0"')).status, 1, 'duplicated string version');
  assert.equal(guardPr(remote, tmp, '3', before('"version": 9')).status, 1, 'duplicated non-string version');
  assert.equal(guardPr(remote, tmp, '4', (dir) => fs.renameSync(path.join(dir, CODEX), path.join(dir, `${CODEX}.bak`))).status, 1, 'renamed away');
  const compact = guardPr(remote, tmp, '5', editFile(CLAUDE, (text) => JSON.stringify(JSON.parse(text))));
  assert.equal(compact.status, 1, 'not in the written form');
  assert.match(compact.stderr, /plugin\.json: not in the form the release script writes/);
});

test('push bumps a manifest whose description was edited by a merged pull request and changes only version fields', () => {
  const { tmp, remote } = makeOrigin();
  const dir = clone(remote, path.join(tmp, 'edit'));
  editDescription(CLAUDE)(dir);
  git(dir, 'commit', '-q', '-am', 'edit description');
  git(dir, 'push', '-q', 'origin', 'main');
  const result = runBump(clone(remote, path.join(tmp, 'run')), 'push', 'main');
  assert.equal(result.status, 0, result.stderr);
  const log = originLog(tmp, remote);
  assert.deepEqual(log.files, RELEASE_FILES);
  const view = clone(remote, path.join(tmp, 'view'));
  const manifest = JSON.parse(fs.readFileSync(path.join(view, CLAUDE), 'utf8'));
  assert.equal(manifest.version, '0.9.0-beta.11'); // the seed commit and the edit are two merges
  assert.equal(manifest.description, 'A corrected description');
});
