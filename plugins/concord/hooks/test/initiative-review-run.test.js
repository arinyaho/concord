'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openInitiativeRun, reserveLaunch, recordTargetTerminal, finaliseInitiativeRun, publicInitiativeSummary } = require('../../core/initiative-review-run');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'initiative-review-run-')); }

test('keyed runs use a hashed separate ledger and atomically consume launch budget', () => {
  const dir = temp();
  const run = openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 1, maxRounds: 2 });
  assert.match(path.basename(run.path), /^initiative-review-[0-9a-f]{64}\.json$/);
  assert.ok(reserveLaunch(run, { role: 'correctness', round: 1 }));
  assert.strictEqual(reserveLaunch(run, { role: 'fix', round: 1 }), false);
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assert.deepStrictEqual(ledger.launches, [{ role: 'correctness', round: 1 }]);
  assert.strictEqual(ledger.key, undefined);
});

test('a keyed run cannot be reconfigured or reopened after terminal state', () => {
  const dir = temp();
  const run = openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 2, maxRounds: 1 });
  fs.writeFileSync(run.path, JSON.stringify({ ...JSON.parse(fs.readFileSync(run.path, 'utf8')), status: 'terminal' }));
  assert.throws(() => openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 3, maxRounds: 1 }), /immutable|terminal/);
});

test('keyed runs stay active per target, require absolute state, charge rounds globally, and persist safe reconciliation evidence', () => {
  const dir = temp();
  assert.throws(() => openInitiativeRun({ stateDir: 'relative-state', key: 'opaque key', maxLaunches: 4, maxRounds: 1 }), /absolute/);
  const run = openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'first-ref', revision: { ref: 'first-ref', base: 'main' }, round: 1 }));
  recordTargetTerminal(run, { target: 'first-ref', telemetry: [{ role: 'correctness', elapsedMs: 1, totalTokens: null, prompt: 'secret', artifact: 'source' }] });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'second-ref', revision: { ref: 'second-ref', base: 'main' }, round: 1 }));
  assert.strictEqual(reserveLaunch(run, { role: 'correctness', target: 'third-ref', revision: { ref: 'third-ref', base: 'main' }, round: 1 }), false);
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assert.deepStrictEqual(ledger.targets, [{ ref: 'first-ref', base: 'main' }, { ref: 'second-ref', base: 'main' }]);
  assert.strictEqual(ledger.rounds.length, 2);
  assert.deepStrictEqual(ledger.reconciliation.hint, {
    trigger: 'target-terminal', firstMaterialFinding: null, stage: null, avoidedLaunches: 0,
    preflight: ['confirm target revisions', 'confirm checks', 'choose resume, revise, or split'],
    options: ['resume', 'revise', 'split'],
  });
  assert.deepStrictEqual(ledger.telemetry, [{ role: 'correctness', elapsedMs: 1, totalTokens: null }]);
  assert.ok(finaliseInitiativeRun(run));
  assert.throws(() => openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 }), /immutable|terminal/);
});

test('initiative aggregate output hashes local target revisions and exposes counts only', () => {
  const dir = temp();
  const run = openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'private-ref', revision: { ref: 'private-ref', base: 'private-base', head: 'private-head' }, round: 1 }));
  recordTargetTerminal(run, { target: 'private-ref', findings: { intent: 1 }, checks: [{ name: 'check', status: 'passed' }] });
  const summary = publicInitiativeSummary(run);
  assert.deepStrictEqual(summary, {
    targetIds: [require('node:crypto').createHash('sha256').update(JSON.stringify({ ref: 'private-ref', base: 'private-base', head: 'private-head' })).digest('hex')],
    counts: { targets: 1, launches: 1, rounds: 1, findings: { intent: 1 }, checks: 1, telemetry: 0 },
  });
  assert.doesNotMatch(JSON.stringify(summary), /private-(?:ref|base|head)/);
});
