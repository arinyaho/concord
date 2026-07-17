'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts/release-version.mjs');

function version(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

function manifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('VERSION and both plugin manifests use the same release version', () => {
  const shared = version(path.join(REPO, 'VERSION'));

  assert.equal(manifest(path.join(REPO, 'plugins/concord/.claude-plugin/plugin.json')).version, shared);
  assert.equal(manifest(path.join(REPO, 'plugins/concord-codex/.codex-plugin/plugin.json')).version, shared);
});

test('release script updates an isolated canonical version and both manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-version-'));
  const claude = path.join(root, 'plugins/concord/.claude-plugin');
  const codex = path.join(root, 'plugins/concord-codex/.codex-plugin');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0-alpha.1\n');

  for (const [dir, name] of [[claude, 'concord'], [codex, 'concord-codex']]) {
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      `${JSON.stringify({ name, version: '0.1.0-alpha.1', preserve: true }, null, 2)}\n`
    );
  }

  try {
    execFileSync(process.execPath, [SCRIPT, '0.9.0-alpha.2'], {
      env: { ...process.env, CONCORD_VERSION_ROOT: root },
    });

    assert.equal(version(path.join(root, 'VERSION')), '0.9.0-alpha.2');
    for (const file of [path.join(claude, 'plugin.json'), path.join(codex, 'plugin.json')]) {
      assert.equal(manifest(file).version, '0.9.0-alpha.2');
      assert.equal(manifest(file).preserve, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release script leaves existing files unchanged when a manifest is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-version-'));
  const claude = path.join(root, 'plugins/concord/.claude-plugin');
  const versionFile = path.join(root, 'VERSION');
  const claudeManifest = path.join(claude, 'plugin.json');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(versionFile, '0.1.0-alpha.1\n');
  fs.writeFileSync(
    claudeManifest,
    `${JSON.stringify({ name: 'concord', version: '0.1.0-alpha.1', preserve: true }, null, 2)}\n`
  );

  try {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, '0.9.0-alpha.2'], {
        env: { ...process.env, CONCORD_VERSION_ROOT: root },
        stdio: 'pipe',
      });
    });

    assert.equal(version(versionFile), '0.1.0-alpha.1');
    assert.deepEqual(manifest(claudeManifest), {
      name: 'concord',
      version: '0.1.0-alpha.1',
      preserve: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release script leaves existing files unchanged when a later manifest is unwritable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-version-'));
  const claude = path.join(root, 'plugins/concord/.claude-plugin');
  const codex = path.join(root, 'plugins/concord-codex/.codex-plugin');
  const versionFile = path.join(root, 'VERSION');
  const claudeManifest = path.join(claude, 'plugin.json');
  const codexManifest = path.join(codex, 'plugin.json');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(versionFile, '0.1.0-alpha.1\n');
  fs.writeFileSync(
    claudeManifest,
    `${JSON.stringify({ name: 'concord', version: '0.1.0-alpha.1', preserve: true }, null, 2)}\n`
  );
  fs.writeFileSync(
    codexManifest,
    `${JSON.stringify({ name: 'concord-codex', version: '0.1.0-alpha.1' }, null, 2)}\n`
  );
  fs.chmodSync(codexManifest, 0o444);

  try {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, '0.9.0-alpha.2'], {
        env: { ...process.env, CONCORD_VERSION_ROOT: root },
        stdio: 'pipe',
      });
    });

    assert.equal(version(versionFile), '0.1.0-alpha.1');
    assert.deepEqual(manifest(claudeManifest), {
      name: 'concord',
      version: '0.1.0-alpha.1',
      preserve: true,
    });
  } finally {
    fs.chmodSync(codexManifest, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
