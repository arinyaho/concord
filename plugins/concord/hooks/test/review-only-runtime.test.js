'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { snapshotRunEngine } = require('../../core/run-snapshot');

for (const layout of ['claude', 'codex']) test(`review runtime snapshot executes the ${layout} CLI after its installed package disappears`, () => {
  const root = tempDir('review-runtime-source-');
  const engine = path.join(root, layout === 'claude' ? 'core' : 'engine');
  const adapter = layout === 'claude' ? path.join(root, 'adapters', 'claude-code') : engine;
  fs.mkdirSync(engine, { recursive: true });
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(path.join(engine, 'review-cli.js'), 'exports.runMain = (resolve) => console.log(resolve());\n');
  fs.writeFileSync(path.join(adapter, 'statedir.js'), 'exports.resolveStateDirFromCwd = () => "SNAPSHOT_OK";\n');
  if (layout === 'codex') {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'review-cli.js'), 'require("../engine/review-cli").runMain(require("../engine/statedir").resolveStateDirFromCwd);\n');
  }
  const repo = tempDir('review-runtime-checkout-');
  const snapshot = snapshotRunEngine(root, repo);
  try {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(execFileSync(process.execPath, [snapshot.cliPath, '--help'], { cwd: repo, encoding: 'utf8' }).trim(), 'SNAPSHOT_OK');
    assert.equal(fs.statSync(snapshot.cliPath).mode & 0o222, 0);
    assert.equal(fs.existsSync(path.join(snapshot.root, 'engine', 'review-cli.js')), true);
  } finally { snapshot.remove(); }
  assert.equal(fs.existsSync(snapshot.root), false);
});

test('Codex sandbox executes the snapshot CLI while keeping its code and account credentials protected', (t) => {
  const { spawnSync } = require('node:child_process');
  const { reviewCodexConfig } = require('../../core/codex-review-runner');
  const probe = spawnSync('codex', ['sandbox', 'true'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('codex sandbox is not usable here');
  const accountHome = fs.realpathSync(tempDir('review-runtime-account-'));
  const accountCodex = path.join(accountHome, '.codex');
  fs.mkdirSync(accountCodex);
  const secret = path.join(accountCodex, 'auth.json');
  const sidecar = path.join(accountCodex, 'memories_1.sqlite-shm');
  fs.writeFileSync(secret, 'DECOY_SECRET');
  fs.writeFileSync(sidecar, 'volatile');
  const home = fs.realpathSync(tempDir('review-runtime-config-'));
  const repo = fs.realpathSync(tempDir('review-runtime-repo-'));
  const snapshot = snapshotRunEngine(path.resolve(__dirname, '../..'), repo);
  try {
    const config = path.join(home, 'config.toml');
    fs.writeFileSync(config, reviewCodexConfig({ home, sourceAuth: secret, checkout: repo, denyRead: [], realHome: accountHome, runtimeDir: snapshot.root }));
    // Sidecars can disappear after profile generation; only the stable parent is mounted.
    fs.unlinkSync(sidecar);
    // Codex can drop direct Node stdout; a pipe captures it and pipefail preserves errors.
    const sandbox = (args) => spawnSync('codex', ['sandbox', '--', 'bash', '-o', 'pipefail', '-c', '"$@" | cat', 'bash', ...args], { cwd: repo, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' });
    const help = sandbox([process.execPath, snapshot.cliPath, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout + help.stderr, /usage: review-cli\.js/);
    assert.notEqual(sandbox(['cat', secret]).status, 0, 'account credentials remain denied');
    const before = fs.readFileSync(snapshot.cliPath, 'utf8');
    assert.notEqual(sandbox([process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "changed")', snapshot.cliPath]).status, 0, 'snapshot cannot be rewritten');
    assert.equal(fs.readFileSync(snapshot.cliPath, 'utf8'), before);
  } finally { snapshot.remove(); }
});
