'use strict';
// A planner that groups a gate: finding next to a correctness: finding must not end the round as a terminal harness failure (#440).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { repairCandidate, preservesArtifact } = require('../../core/artifact-contract');

const ref = 'feature/plan-gate-ids';
const CLI = path.resolve(__dirname, '../review-cli.js');
const REPO = path.resolve(__dirname, '../../../..');
const group = { groupId: 'g', findingIds: ['correctness:x', 'gate:y'], rootCause: 'r', invariants: ['i'], changeClass: 'local', structuralEffects: [], action: 'fix' };

test('repair drops a gate: id from a mixed plan group and keeps the group', () => {
  const raw = JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [group] });
  const candidate = repairCandidate('plan', raw);
  assert.deepEqual(candidate.groups, [{ ...group, findingIds: ['correctness:x'] }]);
  assert.ok(preservesArtifact('plan', raw, candidate));
  const widened = { ...candidate, groups: [{ ...candidate.groups[0], rootCause: 'other' }] };
  assert.equal(preservesArtifact('plan', raw, widened), false);
});

test('a plan grouping a gate: finding with a correctness: finding is repaired by artifact-normalize and accepted by plan-fixes', () => {
  const root = tempDir('plan-gate-ids-');
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
  write('gate', { status: 'ok', findings: [{ id: 'gate:y', gate: 'gate', file: 'a.txt', span: 'two', summary: 's' }] });
  for (const role of ['correctness', 'gate']) assert.equal(cli('artifact-normalize', ref, role).status, 'ok');
  write('verify', { status: 'ok', rejected: [], findings: [] });
  write('gate-verify', { status: 'ok', rejected: [], findings: [] });
  for (const role of ['verify', 'gate-verify']) assert.equal(cli('artifact-normalize', ref, role).status, 'ok');
  write('plan', { status: 'ok', protocolVersion: 2, groups: [group] });
  const repair = cli('artifact-normalize', ref, 'plan');
  assert.equal(repair.status, 'repair');
  cli('artifact-repair-dispatch', ref, 'plan');
  cli('artifact-repair-candidate', ref, 'plan');
  assert.equal(cli('artifact-normalize', ref, 'plan', '--candidate', repair.repair.candidatePath).status, 'ok');
  assert.deepEqual(cli('plan-fixes', ref).fixGroups.map((g) => g.findingIds), [['correctness:x']]);
});

test('every plan step states that a plan group carries only correctness: and docreview: ids', () => {
  for (const file of ['plugins/concord/core/review-driver.md', 'plugins/concord/commands/review-and-fix.md', 'plugins/concord-copilot/skills/review-and-fix/references/review-driver.md']) {
    const step = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').find((line) => line.startsWith('4. Only when step 3 answered'));
    assert.match(step, /only `correctness:` and `docreview:` ids/, file);
    assert.match(step, /`gate:` findings are never planned/, file);
  }
});
