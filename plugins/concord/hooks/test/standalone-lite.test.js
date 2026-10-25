'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const review = require('../../core/review');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');

const CLI = path.join(__dirname, '..', 'review-cli.js');
const CODEX_LAUNCHER = path.join(__dirname, '../../../../plugins/concord-codex/bin/review-and-fix.js');

function repoFixture() {
  const repo = tempDir('standalone-lite-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'codex@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Codex Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'note.md'), 'before\n');
  execFileSync('git', ['add', 'note.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'note.md'), 'after\n');
  execFileSync('git', ['add', 'note.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'change'], { cwd: repo });
  return repo;
}

function invoke(repo, stateDir, args) {
  return spawnSync('node', [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir },
  });
}

function successfulStart(repo, stateDir, args) {
  const result = invoke(repo, stateDir, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function targetLedger(stateDir, ref) {
  return review.readLedger(stateDir, review.targetSlug(ref));
}

function fencedProviders() {
  const bin = tempDir('standalone-lite-fake-providers-');
  const logPath = path.join(bin, 'provider.log');
  for (const name of ['codex', 'claude', 'copilot']) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "fake-provider\\n"; exit 0; fi\nprintf "%s\\n" "$0 $*" >> "$FAKE_PROVIDER_LOG"\nexit 86\n');
    fs.chmodSync(executable, 0o755);
  }
  return { bin, logPath, env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    CODEX_CLI_PATH: path.join(bin, 'codex'),
    CONCORD_CODEX_BIN: path.join(bin, 'codex'),
    FAKE_PROVIDER_LOG: logPath,
  } };
}

test('standalone --lite starts a git-only three-round review without gate reservations', () => {
  const repo = repoFixture();
  const stateDir = tempDir('standalone-lite-state-');
  const started = successfulStart(repo, stateDir, ['round-start', 'feature/lite', 'HEAD~1', '--lite']);

  assert.equal(started.mode, 'standalone-lite');
  assert.equal(started.gateApplied, false);
  assert.equal(started.gateMode, 'none');
  assert.equal(started.budget.max_rounds, 3);
  assert.equal(started.dodDeferred, true);
  const ledger = targetLedger(stateDir, 'feature/lite');
  assert.equal(ledger.reviewMode, 'standalone-lite');
  assert.equal(ledger.budget.max_rounds, 3);
  assert.equal(ledger.gateApplied, false);
  assert.deepEqual((ledger.initiative_reservations || []).filter((row) => row.role === 'gate' || row.role === 'gate-verify'), []);
});

test('standalone lite mode and its three-round budget survive resume without --lite', () => {
  const repo = repoFixture();
  const stateDir = tempDir('standalone-lite-resume-');
  successfulStart(repo, stateDir, ['round-start', 'feature/lite-resume', 'HEAD~1', '--lite']);

  const resumed = successfulStart(repo, stateDir, ['round-start', 'feature/lite-resume']);
  const ledger = targetLedger(stateDir, 'feature/lite-resume');
  assert.equal(resumed.mode, 'standalone-lite');
  assert.equal(resumed.budget.max_rounds, 3);
  assert.equal(ledger.reviewMode, 'standalone-lite');
  assert.equal(ledger.budget.max_rounds, 3);
  assert.equal(ledger.gateApplied, false);
});

test('explicit --lite cannot switch an active base ledger and refusal preserves its bytes', () => {
  const repo = repoFixture();
  const stateDir = tempDir('standalone-lite-base-conflict-');
  successfulStart(repo, stateDir, ['round-start', 'feature/base', 'HEAD~1', '--no-broad']);
  const file = review.ledgerPath(stateDir, review.targetSlug('feature/base'));
  const before = fs.readFileSync(file);

  const rejected = invoke(repo, stateDir, ['round-start', 'feature/base', '--lite']);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mode differs|cannot switch|base ledger/i);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('invalid standalone-lite combinations and named exclusions refuse before target or initiative writes', () => {
  const repo = repoFixture();
  const cases = [
    { args: ['round-start', 'feature/broad', 'HEAD~1', '--lite', '--broad'], message: /--lite.*--broad|--broad.*--lite/i },
    { args: ['round-start', 'feature/gate', 'HEAD~1', '--lite', '--gate'], message: /--lite.*--gate|--gate.*--lite/i },
    { args: ['round-start', 'file:note.md', '--lite'], message: /git-only|file target/i },
    { args: ['round-start', 'feature/trigger', 'HEAD~1', '--lite', '--lite-exclusion', 'security'], message: /excluded.*security|security.*excluded/i },
    { args: ['round-start', 'feature/unknown', 'HEAD~1', '--lite', '--lite-exclusion', 'large-diff'], message: /invalid.*trigger|unknown.*trigger/i },
    { args: ['round-start', 'feature/no-lite', 'HEAD~1', '--lite-exclusion', 'security'], message: /requires.*--lite|only.*--lite/i },
  ];
  for (const [index, fixture] of cases.entries()) {
    const stateDir = path.join(tempDir('standalone-lite-refusal-'), 'state');
    const rejected = invoke(repo, stateDir, fixture.args);
    assert.notEqual(rejected.status, 0, `case ${index} unexpectedly succeeded`);
    assert.match(rejected.stderr, fixture.message, `case ${index}: ${rejected.stderr}`);
    assert.equal(fs.existsSync(stateDir), false, `case ${index} wrote a target ledger directory`);
  }

  const initiativeStateDir = path.join(tempDir('standalone-lite-initiative-refusal-'), 'state');
  const rejectedInitiative = invoke(repo, initiativeStateDir, [
    'round-start', 'feature/initiative-conflict', 'HEAD~1', '--lite',
    '--initiative-run-key', 'lite-conflict', '--initiative-id', 'lite-conflict',
    '--initiative-state-dir', initiativeStateDir, '--initiative-max-launches', '5', '--initiative-max-rounds', '3',
  ]);
  assert.notEqual(rejectedInitiative.status, 0);
  assert.match(rejectedInitiative.stderr, /standalone.*initiative|initiative.*standalone/i);
  assert.equal(fs.existsSync(initiativeStateDir), false);
});

test('default base and existing initiative lite behavior remain distinct', () => {
  const repo = repoFixture();
  const stateDir = tempDir('standalone-lite-default-base-');
  const base = successfulStart(repo, stateDir, ['round-start', 'feature/default', 'HEAD~1']);
  assert.equal(base.mode, undefined);
  assert.notEqual(targetLedger(stateDir, 'feature/default').reviewMode, 'standalone-lite');

  const initiativeStateDir = tempDir('standalone-lite-initiative-mode-');
  const initiative = successfulStart(repo, stateDir, [
    'round-start', 'feature/initiative-lite', 'HEAD~1',
    '--initiative-run-key', 'existing-lite', '--initiative-id', 'existing-lite',
    '--initiative-state-dir', initiativeStateDir, '--initiative-max-launches', '8', '--initiative-max-rounds', '3', '--initiative-mode', 'lite',
  ]);
  assert.equal(initiative.mode, 'lite');
  assert.equal(initiative.gateMode, 'design-conformance');
  assert.equal(initiative.gateApplied, true);
  assert.equal(targetLedger(stateDir, 'feature/initiative-lite').reviewMode, undefined);
});

test('native Codex runner forwards standalone lite and retains it on its continuation packet', async () => {
  const repo = repoFixture();
  const stateDir = tempDir('standalone-lite-runner-');
  const calls = [];
  const result = await runReviewUntilGreen({
    ref: 'feature/runner-lite', base: 'HEAD~1', repoRoot: repo, reviewStateDir: stateDir,
    lite: true, targetIdentity: () => 'runner-head',
    runCli: (args) => {
      calls.push(args);
      if (args[0] === 'round-start') return { decision: 'terminal', status: 'clean', ref: args[1], base: 'HEAD~1', head: 'runner-head', stateDir, mode: 'standalone-lite' };
      return {};
    },
  });
  assert.ok(calls.some((args) => args[0] === 'round-start' && args.includes('--lite')));
  assert.equal(result.decision, 'terminal');

  let failure;
  await assert.rejects(runReviewUntilGreen({
    ref: 'feature/runner-lite-failure', base: 'HEAD~1', repoRoot: repo, reviewStateDir: stateDir,
    lite: true, targetIdentity: () => 'failure-head',
    runCli: (args) => {
      if (args[0] === 'round-start') return { decision: 'work', mode: 'standalone-lite', round: 1, base: 'HEAD~1', head: 'failure-head', stateDir, targetType: 'git', dodPassed: false, dodDeferred: true, intentApplied: false, gateApplied: false };
      if (args[0] === 'show') return { reviewMode: 'standalone-lite', status: 'converging' };
      if (args[0] === 'artifact-normalize') return { status: 'ok' };
      return {};
    },
    spawn: async () => { throw new Error('fixture provider launch failed'); },
  }), (error) => { failure = error; return /fixture provider launch failed|Provider execution failed/.test(error.message); });
  assert.equal(failure?.continuationPacket?.reviewMode, 'standalone-lite');
});

test('terminal CLI handoff names standalone-lite mode', () => {
  const repo = repoFixture();
  const stateDir = tempDir('standalone-lite-handoff-');
  const ref = 'feature/lite-handoff';
  const ledger = review.emptyLedger({ kind: 'local', ref });
  review.writeLedger(stateDir, review.targetSlug(ref), {
    ...ledger, reviewMode: 'standalone-lite', round: 1, phase: 'done', last_recorded_round: 1,
    status: 'clean', target: { kind: 'local', ref, type: 'git', base: 'HEAD~1', head_sha: 'test-head' },
    budget: { ...ledger.budget, max_rounds: 3, spent: 1 }, _lastDecision: { continue: false, converged: true, reason: 'clean' },
  });
  const result = invoke(repo, stateDir, ['record', ref]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).handoff, /review mode: standalone-lite/);
});

test('Codex launcher advertises lite and forwards it into runner validation', () => {
  const help = spawnSync('node', [CODEX_LAUNCHER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--lite \[--lite-exclusion <trigger>\]/);

  const repo = repoFixture();
  const fenced = fencedProviders();
  const reviewStateDir = path.join(tempDir('standalone-lite-launcher-target-'), 'state');
  const safeLaunch = spawnSync('node', [CODEX_LAUNCHER, 'feature/launcher-lite', 'HEAD~1', '--lite', '--no-broad', '--reviewer', 'codex'], {
    cwd: repo, encoding: 'utf8', env: { ...fenced.env, REVIEW_STATE_DIR: reviewStateDir },
  });
  assert.notEqual(safeLaunch.status, 0, 'the fake provider intentionally fails before a model turn');
  assert.match(fs.readFileSync(fenced.logPath, 'utf8'), /\/codex exec /);
  assert.equal(targetLedger(reviewStateDir, 'feature/launcher-lite').reviewMode, 'standalone-lite');
  assert.equal(targetLedger(reviewStateDir, 'feature/launcher-lite').gateApplied, false);
  const providerDispatchCount = fs.readFileSync(fenced.logPath, 'utf8').split('\n').filter(Boolean).length;

  const initiativeStateDir = path.join(tempDir('standalone-lite-launcher-refusal-'), 'state');
  const conflict = spawnSync('node', [CODEX_LAUNCHER,
    'feature/launcher-conflict', 'HEAD~1', '--lite',
    '--initiative-run-key', 'launcher-conflict', '--initiative-id', 'launcher-conflict',
    '--initiative-state-dir', initiativeStateDir, '--initiative-max-launches', '5', '--initiative-max-rounds', '3',
  ], { cwd: repo, encoding: 'utf8', env: { ...fenced.env, REVIEW_STATE_DIR: reviewStateDir } });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /standalone --lite cannot be combined with initiative flags/);
  assert.equal(fs.existsSync(initiativeStateDir), false);
  const dispatched = fs.readFileSync(fenced.logPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(dispatched.length, providerDispatchCount, `conflicting request is refused before another provider dispatch: ${dispatched.join(' | ')}`);
});
