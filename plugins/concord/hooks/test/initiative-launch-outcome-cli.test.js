'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { runPath, launchAccounting } = require('../../core/initiative-review-run');
const cli = path.resolve(__dirname, '../review-cli.js');

function fixture() {
  const repo = tempDir('outcome-cli-repo-'), state = tempDir('outcome-cli-state-'), initiativeState = tempDir('outcome-cli-run-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); git('commit', '-aqm', 'head');
  const ref = 'feature/refund';
  const flags = ['--initiative-run-key', 'outcome', '--initiative-state-dir', initiativeState, '--initiative-max-launches', '1', '--initiative-max-rounds', '3'];
  const invoke = (args) => spawnSync(process.execPath, [cli, ...args, ...flags], { cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: state }, encoding: 'utf8' });
  const run = (...args) => { const out = invoke(args); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); };
  run('round-start', ref, 'HEAD~1', '--no-broad');
  const reserve = () => run('reserve', ref, 'correctness');
  const receipt = (reservation, override = {}) => ({ reservationId: reservation.reservationIds[0], invocationId: reservation.token.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'), provider: 'codex', lifecycle: 'not-started', reason: 'spawn-enoent', failed: true, ...override });
  const file = runPath(initiativeState, 'outcome');
  return { ref, run, invoke, reserve, receipt, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('CLI binds a pre-turn refund to the exact reservation and permits an explicit budget retry', () => {
  const f = fixture(), reservation = f.reserve();
  assert.equal(reservation.status, 'granted');
  assert.equal(reservation.reservationIds.length, 1);
  assert.match(reservation.reservationIds[0], /^[0-9a-f]{32}:0$/);
  assert.equal(JSON.stringify(f.read()).includes(reservation.token), false, 'grant tokens stay only in the target ledger');
  const outcome = f.run('launch-outcome', f.ref, JSON.stringify(f.receipt(reservation)));
  assert.equal(outcome.refunded, true);
  assert.equal(outcome.limitReached, false);
  assert.equal(launchAccounting(f.read()).charged, 0);
  const prior = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.run('launch-outcome', f.ref, JSON.stringify(f.receipt(reservation))).status, 'duplicate');
  assert.equal(fs.readFileSync(f.file, 'utf8'), prior);
  assert.equal(f.reserve().status, 'granted');
  assert.equal(f.read().rounds.length, 1);
});

test('CLI refuses unknown reservation IDs and caller-supplied identity overrides', () => {
  const f = fixture(), reservation = f.reserve(), prior = fs.readFileSync(f.file, 'utf8');
  for (const override of [{ reservationId: `${'f'.repeat(32)}:0` }, { role: 'gate' }, { revision: { head_sha: 'other' } }]) {
    const result = f.invoke(['launch-outcome', f.ref, JSON.stringify(f.receipt(reservation, override))]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reservation|identity|field|key/i);
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), prior);
});

test('CLI leaves unknown lifecycle failures charged', () => {
  const f = fixture(), reservation = f.reserve();
  const outcome = f.run('launch-outcome', f.ref, JSON.stringify(f.receipt(reservation, { lifecycle: 'unknown', reason: 'unsupported-model' })));
  assert.equal(outcome.refunded, false);
  const denied = f.reserve();
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'budget-exhausted');
});

test('CLI stops after three refunds without silently resetting budget or history', () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) {
    const reservation = f.reserve();
    const outcome = f.run('launch-outcome', f.ref, JSON.stringify(f.receipt(reservation)));
    assert.equal(outcome.refunded, true);
    assert.equal(outcome.limitReached, n === 2);
  }
  const denied = f.reserve();
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'environment-failure-limit');
  assert.equal(f.read().launches.length, 3);
  assert.equal(f.read().rounds.length, 1);
});
