'use strict';
// One initiative run spans every repository its plan declares, under one
// shared launch and round budget and one dependency graph.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const plugins = path.resolve(__dirname, '../../..');
const runtimes = [
  ['native', require('../../core/initiative-review-run')],
  ['Codex', require('../../../concord-codex/engine/initiative-review-run')],
  ['Copilot', require('../../../concord-copilot/engine/initiative-review-run')],
];

function repository(prefix) {
  const repo = tempDir(prefix);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('commit', '-qam', 'change');
  return repo;
}

for (const [provider, cli] of [
  ['claude', 'concord/hooks/review-cli.js'],
  ['codex', 'concord-codex/bin/review-cli.js'],
  ['copilot', 'concord-copilot/bin/review-cli.js'],
]) {
  test(`${provider}: a two-repository initiative runs file and diff reviews under one shared budget`, () => {
    const api = repository('multi-repo-api-');
    const web = repository('multi-repo-web-');
    const initiative = tempDir('multi-repo-initiative-');
    const flags = ['--initiative-run-key', 'key', '--initiative-id', 'initiative',
      '--initiative-state-dir', initiative, '--initiative-max-launches', '4', '--initiative-max-rounds', '10'];
    // Each checkout keeps its own target review state; only the run ledger is shared.
    const targetState = new Map();
    const run = (repo, args) => {
      if (!targetState.has(repo)) targetState.set(repo, tempDir('multi-repo-target-'));
      return spawnSync(process.execPath, [path.join(plugins, cli), ...args, ...flags], {
        cwd: repo, env: { ...process.env, REVIEW_STATE_DIR: targetState.get(repo), REVIEW_REPO_ROOT: repo }, encoding: 'utf8',
      });
    };
    const ok = (repo, args) => { const out = run(repo, args); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); };
    const planFile = path.join(initiative, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ version: 2, repositories: { api, web }, targets: [
      { repository: 'api', ref: 'file:notes.md', dependsOn: [] },
      { repository: 'web', ref: 'file:notes.md', dependsOn: [] },
      { repository: 'api', ref: 'feature/x', dependsOn: [] },
      { repository: 'web', ref: 'feature/x', dependsOn: ['api:feature/x'] },
    ] }));
    assert.equal(ok(api, ['initiative-plan', planFile]).status, 'registered');

    // Equal file and branch names in the two repositories are distinct targets.
    for (const repo of [api, web]) {
      ok(repo, ['round-start', 'file:notes.md', '--no-broad']);
      assert.equal(ok(repo, ['reserve', 'file:notes.md', 'correctness']).status, 'granted');
      ok(repo, ['round-start', 'feature/x', 'HEAD~1', '--no-broad']);
      assert.equal(ok(repo, ['reserve', 'feature/x', 'correctness']).status, 'granted');
    }
    const ledgerFile = path.join(initiative, fs.readdirSync(initiative).find((f) => /^initiative-review-[0-9a-f]{64}\.json$/.test(f)));
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.deepEqual(Object.keys(ledger.repositories), ['api', 'web']);
    assert.deepEqual(ledger.launches.map((launch) => `${launch.repository}:${launch.target}`),
      ['api:file:notes.md', 'api:feature/x', 'web:file:notes.md', 'web:feature/x']);
    assert.equal(ledger.rounds.length, 4);
    assert.equal(new Set(ledger.targets.map((target) => target.repository)).size, 2);

    // The fifth launch is refused in either repository: the budget is aggregate.
    const denied = ok(web, ['reserve', 'feature/x', 'verify']);
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'budget-exhausted');

    // A repository the plan does not declare fails closed and changes nothing.
    const stranger = repository('multi-repo-stranger-');
    const before = fs.readFileSync(ledgerFile, 'utf8');
    const refused = run(stranger, ['round-start', 'feature/x', 'HEAD~1', '--no-broad']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /does not declare this repository/);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);
  });
}

for (const [name, runtime] of runtimes) {
  const fixture = () => {
    const api = tempDir('multi-repo-api-'), web = tempDir('multi-repo-web-'), stateDir = tempDir('multi-repo-state-');
    const open = (repository, plan = null) => runtime.openInitiativeRun({ stateDir, key: 'k', repository, maxLaunches: 6, maxRounds: 3, plan: plan && runtime.normalizedInitiativePlan(plan) });
    const plan = { version: 2, repositories: { api, web }, targets: [
      { repository: 'api', ref: 'feature/x', dependsOn: [] },
      { repository: 'web', ref: 'feature/x', dependsOn: ['api:feature/x'] },
      { repository: 'web', ref: 'feature/y', dependsOn: [] },
    ] };
    const ledger = (run) => JSON.parse(fs.readFileSync(run.path, 'utf8'));
    return { api, web, stateDir, open, plan, ledger };
  };
  const revision = (ref) => ({ ref, base: 'b'.repeat(40), head_sha: 'a'.repeat(40) });
  const launch = (ref, attemptId, round = 1) => ({ role: 'correctness', target: ref, revision: revision(ref), attemptId, round });

  test(`${name}: a repository the plan declares registers it even when another repository opened the run`, () => {
    const h = fixture();
    h.open(h.api);
    assert.throws(() => h.open(h.web), /does not declare this repository/);
    const web = h.open(h.web, h.plan);
    assert.equal(web.repository, 'web');
    assert.equal(h.open(h.api).repository, 'api');
    assert.throws(() => h.open(tempDir('multi-repo-other-')), /does not declare this repository/);
  });

  test(`${name}: equal refs and revision pairs in two repositories do not alias`, () => {
    const h = fixture();
    const api = h.open(h.api, h.plan), web = h.open(h.web);
    assert.ok(runtime.recordDisposition(api, { target: 'feature/x', revision: revision('feature/x'), result: { decision: { converged: true } } }));
    assert.equal(runtime.terminalTarget(api, 'feature/x', revision('feature/x')).kind, 'terminal');
    assert.equal(runtime.terminalTarget(web, 'feature/x', revision('feature/x')), false);
    assert.equal(runtime.denialReason(api, launch('feature/x', 'a1')), 'target-terminal');
    assert.equal(runtime.denialReason(web, launch('feature/x', 'w1')), null);
  });

  test(`${name}: a pending hold in one repository blocks its dependents in another`, () => {
    const h = fixture();
    const api = h.open(h.api, h.plan), web = h.open(h.web);
    assert.ok(runtime.recordDisposition(api, { target: 'feature/x', revision: revision('feature/x'), occurrence: { attemptId: 'a1', round: 1 }, result: { reconciliation: { finding: 'gate:contract' } } }));
    assert.equal(runtime.denialReason(web, launch('feature/x', 'w1')), 'reconciliation-required');
    assert.equal(runtime.pairRefusal(web, 'feature/x', revision('feature/x')), 'reconciliation-required');
    assert.equal(runtime.denialReason(web, launch('feature/y', 'y1')), null, 'an independent target in another repository continues');
    assert.equal(runtime.denialReason(web, launch('feature/z', 'z1')), 'reconciliation-required', 'a target the plan does not name stays held');
    const claim = h.ledger(api).dispositions.at(-1).packet.delivery.claim;
    assert.throws(() => runtime.reconcileInitiativeRun(web, { target: 'feature/x', claim, by: 'human', decision: 'resume', contract: 'unchanged' }), /one matching pending/, 'a hold is reconciled from its own repository');
    assert.ok(runtime.reconcileInitiativeRun(api, { target: 'feature/x', claim, by: 'human', decision: 'resume', contract: 'unchanged' }));
    assert.equal(runtime.denialReason(web, launch('feature/x', 'w1')), null);
  });

  test(`${name}: launches and rounds are charged once across repositories and survive resume`, () => {
    const h = fixture();
    let api = h.open(h.api, h.plan), web = h.open(h.web);
    assert.ok(runtime.reserveLaunchBatch(api, launch('feature/x', 'a1'), 2));
    assert.ok(runtime.reserveLaunchBatch(web, launch('feature/x', 'w1'), 2));
    assert.ok(runtime.reserveLaunch(web, launch('feature/y', 'y1')));
    assert.equal(runtime.denialReason(api, launch('feature/x', 'a1'), 2), 'budget-exhausted', 'the launch budget is shared');
    assert.equal(runtime.denialReason(api, { ...launch('feature/x', 'a1', 2) }), 'budget-exhausted', 'the round budget is shared');
    const before = h.ledger(api);
    api = h.open(h.api); web = h.open(h.web);
    assert.deepEqual(h.ledger(web), before, 'reopening from either repository preserves charged launches and rounds');
    assert.ok(runtime.reserveLaunch(web, launch('feature/y', 'y1')), 'the same round of a resumed target charges no new round');
    assert.equal(h.ledger(web).rounds.length, 3);
    assert.equal(runtime.launchBudgetUsage(h.ledger(web)).launches, 6);
  });

  test(`${name}: a ledger without declared repositories is refused alike by open, escalate and the shared lookup`, () => {
    const h = fixture();
    const api = h.open(h.api);
    const legacy = h.ledger(api);
    delete legacy.repositories;
    fs.writeFileSync(api.path, JSON.stringify(legacy));
    const refusal = /predates declared repositories and is not migrated/;
    assert.throws(() => h.open(h.api), refusal);
    assert.throws(() => runtime.escalateInitiativeRun({ stateDir: h.stateDir, key: 'k', repository: h.api, trigger: 'schema', maxLaunches: 6, maxRounds: 3 }), refusal);
    assert.throws(() => runtime.declaredRepository(legacy, api.identity), refusal);
    assert.doesNotMatch(String(refusal), /register/);
  });
}
