'use strict';
// A planner that follows the driver's plan step must produce an artifact that artifact-normalize and plan-fixes accept (#367).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const ref = 'feature/plan-envelope';
const CLI = path.resolve(__dirname, '../review-cli.js');
const REPO = path.resolve(__dirname, '../../../..');
const drivers = {
  'review-driver.md': 'plugins/concord/core/review-driver.md',
  'commands/review-and-fix.md': 'plugins/concord/commands/review-and-fix.md',
  'copilot review-driver.md': 'plugins/concord-copilot/skills/review-and-fix/references/review-driver.md',
};
const group = { groupId: 'g', findingIds: ['correctness:x'], rootCause: 'r', invariants: ['i'], changeClass: 'local', structuralEffects: [], action: 'fix' };

for (const [name, file] of Object.entries(drivers)) {
  test(`a plan written in the envelope ${name} names is accepted by artifact-normalize and plan-fixes`, () => {
    const envelope = /ONLY the v2 plan JSON `(\{[^`]*\})`/.exec(fs.readFileSync(path.join(REPO, file), 'utf8'));
    assert.ok(envelope, `${name} plan step must spell the plan JSON envelope`);
    const plan = { ...JSON.parse(envelope[1]), groups: [group] };

    const root = tempDir('plan-envelope-');
    const repo = path.join(root, 'repo');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(repo); fs.mkdirSync(stateDir);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
    git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', ref);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'change');
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir }, encoding: 'utf8', stdio: 'pipe' }));
    const write = (role, value) => fs.writeFileSync(path.join(stateDir, `round-1-${role}.json`), JSON.stringify(value));

    cli('round-start', ref, 'main');
    write('correctness', { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:x', gate: 'correctness', file: 'a.txt', span: 'two', summary: 's' }] });
    write('gate', { status: 'ok', findings: [] });
    for (const role of ['correctness', 'gate']) assert.equal(cli('artifact-normalize', ref, role).status, 'ok');
    write('verify', { status: 'ok', rejected: [], findings: [] });
    write('gate-verify', { status: 'ok', rejected: [], findings: [] });
    for (const role of ['verify', 'gate-verify']) assert.equal(cli('artifact-normalize', ref, role).status, 'ok');
    write('plan', plan);
    assert.equal(cli('artifact-normalize', ref, 'plan').status, 'ok');
    assert.deepEqual(cli('plan-fixes', ref).fixGroups.map((g) => g.groupId), ['g']);
  });
}
