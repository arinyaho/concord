'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../../core/review');
const { tempDir } = require('./temp-dir');

const plugins = path.resolve(__dirname, '../../..');
for (const [provider, cli] of [
  ['claude', 'concord/hooks/review-cli.js'],
  ['codex', 'concord-codex/bin/review-cli.js'],
  ['copilot', 'concord-copilot/bin/review-cli.js'],
]) {
  test(`${provider}: rerun cannot silently skip a prior attempt's unfinished broad claim`, () => {
    const repo = tempDir('unfinished-broad-repo-');
    const state = tempDir('unfinished-broad-state-');
    const initiative = tempDir('unfinished-broad-initiative-');
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
    git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'change');
    const flags = ['--initiative-run-key', 'key', '--initiative-id', 'initiative',
      '--initiative-state-dir', initiative, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'];
    const run = (args) => spawnSync(process.execPath, [path.join(plugins, cli), ...args, ...flags], {
      cwd: repo, env: { ...process.env, REVIEW_STATE_DIR: state, REVIEW_REPO_ROOT: repo }, encoding: 'utf8',
    });
    const planFile = path.join(state, 'initiative-plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ version: 1, targets: [{ ref: 'feature/x', dependsOn: [] }] }));
    const planned = run(['initiative-plan', planFile]);
    assert.equal(planned.status, 0, planned.stderr);
    const first = run(['round-start', 'feature/x', 'HEAD~1']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).gateApplied, true);
    const slug = review.targetSlug('feature/x');
    const firstLedger = review.readLedger(state, slug);
    const resumed = run(['round-start', 'feature/x', 'HEAD~1']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).gateApplied, true);
    assert.equal(JSON.parse(resumed.stdout).attemptId, firstLedger.attemptId);
    const reservation = run(['reserve', 'feature/x', 'gate-review']);
    assert.equal(reservation.status, 0, reservation.stderr);
    assert.equal(JSON.parse(reservation.stdout).status, 'granted');
    const failed = run(['round-failure', 'feature/x', JSON.stringify({
      role: 'gate', kind: 'blocked-method', message: 'fixture gate could not execute its check', retryable: false,
    })]);
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).nextAction, 'terminal-handoff');
    assert.deepEqual(review.readLedger(state, slug).history, []);
    const claimFile = path.join(initiative, fs.readdirSync(initiative).find((f) => f.startsWith('initiative-broad-')));
    const claimBefore = fs.readFileSync(claimFile);
    const rerun = run(['rerun', 'feature/x']);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).run, 2);
    const fresh = review.readLedger(state, slug);
    assert.notEqual(fresh.attemptId, firstLedger.attemptId);
    assert.equal(fresh.broad_reuse, undefined);
    const initiativeFile = path.join(initiative, fs.readdirSync(initiative).find((f) => /^initiative-review-.*\.json$/.test(f)));
    const budgetBefore = JSON.parse(fs.readFileSync(initiativeFile));
    assert.deepEqual(budgetBefore.launches.map(({ role, target, attemptId }) => ({ role, target, attemptId })),
      [{ role: 'gate-review', target: 'feature/x', attemptId: firstLedger.attemptId }]);
    const retry = run(['round-start', 'feature/x', 'HEAD~1']);
    assert.notEqual(retry.status, 0, `must stop rather than silently disarm broad review: ${retry.stdout}`);
    assert.match(retry.stderr, /broad-sweep.*prior attempt.*reconcile/i);
    assert.deepEqual(fs.readFileSync(claimFile), claimBefore);
    const budgetAfter = JSON.parse(fs.readFileSync(initiativeFile));
    assert.deepEqual(budgetAfter.launches, budgetBefore.launches);
    assert.deepEqual(budgetAfter.rounds, budgetBefore.rounds);
    assert.deepEqual(budgetAfter.budget, budgetBefore.budget);
    assert.notEqual(review.readLedger(state, slug).status, 'clean');
    assert.ok(fs.existsSync(JSON.parse(rerun.stdout).archived.archive.manifestPath));
  });
}
