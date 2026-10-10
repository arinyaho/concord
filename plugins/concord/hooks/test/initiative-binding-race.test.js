'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const review = require('../../core/review');
const { tempDir } = require('./temp-dir');

const plugins = path.resolve(__dirname, '../../..');
const providers = {
  claude: path.join(plugins, 'concord/hooks/review-cli.js'),
  copilot: path.join(plugins, 'concord-copilot/bin/review-cli.js'),
};

// Pause only git acquisition, preserving the real CLI and ledger operations.
// The second process announces its lock attempt before mkdir succeeds or waits.
const preloader = `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const mkdir = fs.mkdirSync;
fs.mkdirSync = function(file, ...args) {
  if (process.env.RACE_LOCK_ATTEMPT && String(file).endsWith('.json.lock')) {
    fs.writeFileSync(process.env.RACE_LOCK_ATTEMPT, 'attempted');
  }
  return mkdir.call(this, file, ...args);
};
const exec = cp.execFileSync;
let paused = false;
cp.execFileSync = function(bin, args, ...options) {
  if (process.env.RACE_PAUSED && !paused && path.basename(bin) === 'git' && args[0] === 'diff') {
    paused = true;
    fs.writeFileSync(process.env.RACE_PAUSED, 'paused');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(process.env.RACE_RELEASE)) {
      if (Date.now() > deadline) throw new Error('race test: release timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return exec.call(this, bin, args, ...options);
};
`;

async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const [provider, entry] of Object.entries(providers)) {
  // Unlike the sibling race test below, the loser here has no pause/release
  // coordination: it genuinely waits out withTargetLock's own (10s) lock-wait
  // window before refusing. Under full-suite load that wait plus two real node
  // process spawns can approach the sibling test's 15s cap on an otherwise
  // passing run, so this one gets more headroom.
  test(`${provider}: concurrent carries from the same blocked target -- exactly one succeeds (AC4)`, { timeout: 30000 }, async (t) => {
    const root = tempDir('carry-race-');
    const repo = path.join(root, 'repo');
    const state = path.join(root, 'state');
    const runs = path.join(root, 'runs');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'initial');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'change');
    const env = { ...process.env, REVIEW_STATE_DIR: state, REVIEW_REPO_ROOT: repo };
    const run = (args) => execFileSync('node', [entry, ...args], { cwd: repo, env, encoding: 'utf8' });
    const keyed = (key, maxLaunches = 1) => ['--initiative-run-key', key, '--initiative-state-dir', runs, '--initiative-max-launches', String(maxLaunches), '--initiative-max-rounds', '5'];
    run(['round-start', 'feat/x', 'HEAD~1', '--no-broad']); // unbound: unkeyed first call
    run(['reserve', 'feat/x', 'correctness', ...keyed('key-1', 1)]); // establishes the binding, exhausts the budget
    const denied = JSON.parse(run(['reserve', 'feat/x', 'verify', ...keyed('key-1', 1)]));
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'budget-exhausted');
    const spawnOne = (toKey) => {
      const child = spawn(process.execPath, [entry, 'carry', 'feat/x', '--from-run-key', 'key-1', ...keyed(toKey, 10)], { cwd: repo, env });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
    };
    const [toB, toC] = await Promise.all([spawnOne('key-2'), spawnOne('key-3')]);
    const results = [toB, toC];
    const succeeded = results.filter((r) => r.status === 0);
    const refused = results.filter((r) => r.status !== 0);
    assert.equal(succeeded.length, 1, 'exactly one concurrent carry should succeed');
    assert.equal(refused.length, 1);
    assert.match(refused[0].stderr, /not bound to --from-run-key/);
    const ledger = review.readLedger(state, review.targetSlug('feat/x'));
    const winner = JSON.parse(succeeded[0].stdout).to;
    assert.equal(ledger.initiative_binding.key, winner);
    assert.equal(ledger.initiative_carries.length, 1);
  });

  test(`${provider}: first initiative binding survives an overlapping unkeyed mutation`, { timeout: 15000 }, async (t) => {
    const root = tempDir('initiative-binding-race-');
    const repo = path.join(root, 'repo');
    const state = path.join(root, 'state');
    const runs = path.join(root, 'runs');
    const hook = path.join(root, 'pause-cli.cjs');
    const paused = path.join(root, 'paused');
    const release = path.join(root, 'release');
    const lockAttempt = path.join(root, 'lock-attempt');
    const children = [];
    t.after(async () => {
      fs.writeFileSync(release, 'release');
      for (const child of children) {
        if (child.process.exitCode === null) child.process.kill('SIGKILL');
      }
      await Promise.all(children.map((child) => child.done));
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(repo);
    fs.writeFileSync(hook, preloader);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'initial');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'change');
    const env = { ...process.env, REVIEW_STATE_DIR: state, REVIEW_REPO_ROOT: repo };
    const flags = ['--initiative-run-key', 'key-1', '--initiative-state-dir', runs,
      '--initiative-max-launches', '1', '--initiative-max-rounds', '5'];
    function start(args, extraEnv = {}) {
      const process = spawn(global.process.execPath, ['--require', hook, entry, ...args], {
        cwd: repo, env: { ...env, ...extraEnv }, timeout: 7000,
      });
      let stdout = '';
      let stderr = '';
      process.stdout.on('data', (data) => { stdout += data; });
      process.stderr.on('data', (data) => { stderr += data; });
      const done = new Promise((resolve) => {
        process.on('error', (error) => { stderr += error.message; });
        process.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
      const child = { process, done };
      children.push(child);
      return child;
    }
    const roundArgs = ['round-start', 'feat/x', 'HEAD~1', '--no-broad'];
    const initial = await start(roundArgs).done;
    assert.equal(initial.status, 0, initial.stderr);
    const first = start(roundArgs, { RACE_PAUSED: paused, RACE_RELEASE: release });
    await waitForFile(paused);
    const ledgerFile = review.ledgerPath(state, review.targetSlug('feat/x'));
    const firstHoldsLock = fs.existsSync(`${ledgerFile}.lock`);
    const second = start(['reserve', 'feat/x', 'correctness', ...flags], { RACE_LOCK_ATTEMPT: lockAttempt });
    await waitForFile(lockAttempt);
    // With serialization, release the holder so reserve can continue. Without
    // it, make reserve finish first to deterministically expose the stale write.
    if (!firstHoldsLock) {
      const reserved = await second.done;
      assert.equal(reserved.status, 0, reserved.stderr);
      assert.equal(JSON.parse(reserved.stdout).status, 'granted');
    }
    fs.writeFileSync(release, 'release');
    const [resumed, reserved] = await Promise.all([first.done, second.done]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(reserved.status, 0, reserved.stderr);
    assert.equal(JSON.parse(reserved.stdout).status, 'granted');
    const ledger = review.readLedger(state, review.targetSlug('feat/x'));
    assert.equal(ledger.initiative_binding?.key, 'key-1', 'overlapping mutation erased the initiative binding');
    assert.equal(ledger.initiative_reservations.length, 1, 'overlapping mutation erased the paid reservation');
    const unkeyed = await start(['reserve', 'feat/x', 'verify']).done;
    assert.notEqual(unkeyed.status, 0, 'bound target granted an unkeyed reservation');
    assert.match(unkeyed.stderr, /initiative.*flags/i);
  });
}
