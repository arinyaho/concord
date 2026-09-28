'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openInitiativeRun, reserveLaunch, recordDisposition, normalizeDisposition, consumeDispositionDelivery, finaliseInitiativeRun, publicInitiativeSummary, terminalTarget } = require('../../core/initiative-review-run');
const RUNTIMES = [
  require('../../core/initiative-review-run'),
  require('../../../concord-codex/engine/initiative-review-run'),
  require('../../../concord-copilot/engine/initiative-review-run'),
];

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'initiative-review-run-')); }
function open(options) { return openInitiativeRun({ repository: '/repo', ...options }); }

test('keyed runs use a hashed separate ledger and atomically consume launch budget', () => {
  const dir = temp();
  const run = open({ stateDir: dir, key: 'opaque key', maxLaunches: 1, maxRounds: 2 });
  assert.match(path.basename(run.path), /^initiative-review-[0-9a-f]{64}\.json$/);
  assert.ok(reserveLaunch(run, { role: 'correctness', round: 1 }));
  assert.strictEqual(reserveLaunch(run, { role: 'fix', round: 1 }), false);
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assert.deepStrictEqual(ledger.launches, [{ role: 'correctness', round: 1 }]);
  assert.strictEqual(ledger.key, undefined);
});

test('v3 terminal dispositions are normalized and recorded exactly once', () => {
  const run = open({ stateDir: temp(), key: 'terminal-disposition', maxLaunches: 1, maxRounds: 1 });
  const revision = { ref: 'feature/x', base: 'main', head_sha: 'head' };
  const packet = { trigger: 'terminal', exit: { code: 0, signal: null }, dod: { status: 'passed' }, telemetry: { complete: true }, nextAction: 'replay' };
  assert.ok(recordDisposition(run, { target: 'feature/x', revision, result: { decision: { converged: true } }, packet }));
  assert.strictEqual(recordDisposition(run, { target: 'feature/x', revision, result: { decision: { converged: true } }, packet }), false);
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assert.strictEqual(ledger.version, 3);
  assert.deepStrictEqual(ledger.dispositions, [{ target: 'feature/x', revision, kind: 'terminal', reason: 'clean', sequence: 1, packet: { ...packet, outcome: { kind: 'terminal', reason: 'clean' }, ledger: { version: 3, status: 'active' }, budget: { maxLaunches: 1, maxRounds: 1, launches: 0, rounds: 0 }, delivery: { claim: 'feature/x:1', continuation: 'replay', consumed: false } } }]);
});

test('normalizeDisposition classifies gate-pending and intent-review as escape, not terminal', () => {
  // round-start treats gate-pending/intent-review as its own re-runnable
  // stop states (a fresh round-start clears them once a human resolves the
  // finding), so they must not get 'terminal' kind's permanent same-revision
  // block -- 'escape' only blocks replay while its packet is unconsumed.
  assert.deepStrictEqual(normalizeDisposition({ decision: { continue: false, gatePending: true } }), { kind: 'escape', reason: 'gate-pending' });
  assert.deepStrictEqual(normalizeDisposition({ decision: { continue: false, intentReview: true } }), { kind: 'escape', reason: 'intent-review' });
  // A material finding's reconciliation still takes precedence and stays
  // genuinely terminal, matching the existing reconciliation tests.
  assert.deepStrictEqual(normalizeDisposition({ decision: { continue: false, intentReview: true }, reconciliation: { finding: 'intent:missing' } }), { kind: 'terminal', reason: 'reconciliation-required' });
});

test('a consumed gate-pending disposition lets a target resume at the same revision', () => {
  const run = open({ stateDir: temp(), key: 'gate-pending-consumed', maxLaunches: 1, maxRounds: 1 });
  const revision = { ref: 'feature/x', base: 'main', head_sha: 'head' };
  assert.ok(recordDisposition(run, { target: 'feature/x', revision, result: { decision: { continue: false, gatePending: true } } }));
  // Unconsumed: still blocks replay, matching escape's own semantics.
  const beforeConsume = terminalTarget(run, 'feature/x', revision, ['terminal', 'escape']);
  assert.strictEqual(beforeConsume.kind, 'escape');
  const ledgerPath = run.path;
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.dispositions[0].packet.delivery.consumed = true;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  // Consumed: no longer blocks -- a human dismissed/resolved the finding
  // and a fresh round-start at the same revision must be allowed to run.
  assert.strictEqual(terminalTarget(run, 'feature/x', revision, ['terminal', 'escape']), false);
});

test('terminalTarget does not suppress a retry when an escape disposition\'s revision changed', () => {
  const run = open({ stateDir: temp(), key: 'escape-revision-changed', maxLaunches: 1, maxRounds: 1 });
  recordDisposition(run, { target: 'feature/x', revision: { ref: 'feature/x', base: 'main', head_sha: 'old-head' }, result: { decision: 'escape' } });
  assert.strictEqual(terminalTarget(run, 'feature/x', { ref: 'feature/x', base: 'main', head_sha: 'new-head' }, ['terminal', 'escape']), false);
});

test('terminalTarget finds an older still-pending escape when the head reverts past a newer one', () => {
  const run = open({ stateDir: temp(), key: 'escape-revert', maxLaunches: 2, maxRounds: 2 });
  const olderRevision = { ref: 'feature/x', base: 'main', head_sha: 'older-head' };
  const newerRevision = { ref: 'feature/x', base: 'main', head_sha: 'newer-head' };
  assert.ok(recordDisposition(run, { target: 'feature/x', revision: olderRevision, result: { decision: 'escape' } }));
  assert.ok(recordDisposition(run, { target: 'feature/x', revision: newerRevision, result: { decision: 'escape' } }));
  // selectDisposition would pick the newer (most-recently-written) entry
  // first; a query for the reverted-to older revision must still find the
  // older entry's still-unconsumed packet instead of returning false.
  const matched = terminalTarget(run, 'feature/x', olderRevision, ['terminal', 'escape']);
  assert.strictEqual(matched.kind, 'escape');
  assert.deepStrictEqual(matched.revision, olderRevision);
});

test('terminalTarget prefers a terminal disposition over a later-appended escape', () => {
  const run = open({ stateDir: temp(), key: 'terminal-then-escape', maxLaunches: 1, maxRounds: 1 });
  const terminalRevision = { ref: 'feature/x', base: 'main', head_sha: 'terminal-head' };
  assert.ok(recordDisposition(run, { target: 'feature/x', revision: terminalRevision, result: { decision: { converged: true } } }));
  assert.ok(recordDisposition(run, { target: 'feature/x', revision: { ref: 'feature/x', base: 'main', head_sha: 'escape-head' }, result: { decision: 'escape' } }));
  const matched = terminalTarget(run, 'feature/x', terminalRevision, ['terminal', 'escape']);
  assert.strictEqual(matched.kind, 'terminal');
  assert.deepStrictEqual(matched.revision, terminalRevision);
});

test('a disposition delivery claim is atomically consumed once', () => {
  const run = open({ stateDir: temp(), key: 'delivery-claim', maxLaunches: 1, maxRounds: 1 });
  recordDisposition(run, { target: 'feature/x', revision: { ref: 'feature/x', head_sha: 'head' }, result: { decision: { converged: true } } });
  assert.strictEqual(consumeDispositionDelivery(run, 'feature/x:1'), true);
  assert.strictEqual(consumeDispositionDelivery(run, 'feature/x:1'), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(run.path, 'utf8')).dispositions[0].packet.delivery.consumed, true);
});

test('interleaved initializations cannot overwrite a consumed launch reservation', () => {
  const dir = temp();
  const originalWrite = fs.writeFileSync;
  let interleaved = false;
  let secondReserved = false;
  fs.writeFileSync = function (file, ...args) {
    if (!interleaved && String(file).endsWith('.tmp')) {
      interleaved = true;
      try {
        const second = open({ stateDir: dir, key: 'shared key', maxLaunches: 1, maxRounds: 1 });
        secondReserved = reserveLaunch(second, { role: 'second', round: 1 });
      } catch (error) {
        assert.match(error.message, /initialization was contended/);
      }
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    const first = open({ stateDir: dir, key: 'shared key', maxLaunches: 1, maxRounds: 1 });
    const firstReserved = reserveLaunch(first, { role: 'first', round: 1 });
    assert.ok(interleaved);
    assert.strictEqual(firstReserved, true);
    assert.strictEqual(secondReserved, false);
  } finally {
    fs.writeFileSync = originalWrite;
  }
});

test('a keyed run cannot be reconfigured or reopened after terminal state', () => {
  const dir = temp();
  const run = open({ stateDir: dir, key: 'opaque key', maxLaunches: 2, maxRounds: 1 });
  fs.writeFileSync(run.path, JSON.stringify({ ...JSON.parse(fs.readFileSync(run.path, 'utf8')), status: 'terminal' }));
  assert.throws(() => open({ stateDir: dir, key: 'opaque key', maxLaunches: 3, maxRounds: 1 }), /immutable|terminal/);
});

test('v2 initiative ledgers fail closed', () => {
  const dir = temp();
  const run = open({ stateDir: dir, key: 'legacy-v2', maxLaunches: 1, maxRounds: 1 });
  fs.writeFileSync(run.path, JSON.stringify({ ...JSON.parse(fs.readFileSync(run.path, 'utf8')), version: 2 }));
  assert.throws(() => open({ stateDir: dir, key: 'legacy-v2', maxLaunches: 1, maxRounds: 1 }), /schemaVersion must be 3/);
});

test('Claude, Codex, and Copilot runtimes produce the same disposition packet', () => {
  const ledgers = RUNTIMES.map((runtime, index) => {
    const run = runtime.openInitiativeRun({ stateDir: temp(), key: `parity-${index}`, repository: '/repo', maxLaunches: 1, maxRounds: 1 });
    runtime.recordDisposition(run, { target: 'feature/x', revision: { ref: 'feature/x', base: 'main', head_sha: 'head' }, result: { decision: { converged: true } }, packet: { trigger: 'terminal', exit: { code: 0, signal: null }, dod: { status: 'passed' }, telemetry: { complete: true }, nextAction: 'replay' } });
    return JSON.parse(fs.readFileSync(run.path, 'utf8')).dispositions;
  });
  assert.deepStrictEqual(ledgers[1], ledgers[0]);
  assert.deepStrictEqual(ledgers[2], ledgers[0]);
});

test('a keyed run cannot cross repository identities', () => {
  const dir = temp();
  open({ stateDir: dir, key: 'opaque key', maxLaunches: 2, maxRounds: 1 });
  assert.throws(() => openInitiativeRun({ stateDir: dir, key: 'opaque key', repository: '/other-repo', maxLaunches: 2, maxRounds: 1 }), /different repository/);
});

test('linked worktrees share a git-common-dir identity while other repositories do not', () => {
  const root = temp();
  const linked = temp();
  const stateDir = temp();
  fs.writeFileSync(path.join(root, 'tracked'), 'x');
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: root });
  require('node:child_process').execFileSync('git', ['add', 'tracked'], { cwd: root });
  require('node:child_process').execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'], { cwd: root });
  require('node:child_process').execFileSync('git', ['worktree', 'add', '-q', linked], { cwd: root });
  openInitiativeRun({ stateDir, key: 'shared', repository: root, maxLaunches: 2, maxRounds: 1 });
  assert.doesNotThrow(() => openInitiativeRun({ stateDir, key: 'shared', repository: linked, maxLaunches: 2, maxRounds: 1 }));
  assert.throws(() => openInitiativeRun({ stateDir, key: 'shared', repository: temp(), maxLaunches: 2, maxRounds: 1 }), /different repository/);
});

test('new target attempts consume distinct global round slots', () => {
  const run = open({ stateDir: temp(), key: 'attempts', maxLaunches: 3, maxRounds: 1 });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'feature/x', attemptId: 'first', round: 1 }));
  assert.strictEqual(reserveLaunch(run, { role: 'correctness', target: 'feature/x', attemptId: 'second', round: 1 }), false);
});

test('the first reconciliation hint stays attached to the first material target', () => {
  const run = open({ stateDir: temp(), key: 'hints', maxLaunches: 3, maxRounds: 3 });
  assert.ok(recordDisposition(run, { target: 'first', revision: { ref: 'first', head_sha: 'first-head' }, result: { status: 'reconciliation-required' }, finding: 'intent:first', stage: 'record', avoidedLaunches: 2 }));
  assert.ok(recordDisposition(run, { target: 'second', revision: { ref: 'second', head_sha: 'second-head' }, result: { status: 'reconciliation-required' }, finding: 'intent:second', stage: 'record', avoidedLaunches: 1 }));
  assert.strictEqual(JSON.parse(fs.readFileSync(run.path, 'utf8')).reconciliation.hint.firstMaterialFinding, 'intent:first');
});

test('keyed runs stay active per target, require absolute state, charge rounds globally, and persist safe reconciliation evidence', () => {
  const dir = temp();
  assert.throws(() => open({ stateDir: 'relative-state', key: 'opaque key', maxLaunches: 4, maxRounds: 1 }), /absolute/);
  const run = open({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'first-ref', revision: { ref: 'first-ref', base: 'main' }, round: 1 }));
  recordDisposition(run, { target: 'first-ref', revision: { ref: 'first-ref', base: 'main', head_sha: 'first-head' }, result: { status: 'target-terminal' }, telemetry: [{ role: 'correctness', round: 1, elapsedMs: 1, totalTokens: null, prompt: 'secret', artifact: 'source' }] });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'second-ref', revision: { ref: 'second-ref', base: 'main' }, round: 1 }));
  assert.strictEqual(reserveLaunch(run, { role: 'correctness', target: 'third-ref', revision: { ref: 'third-ref', base: 'main' }, round: 1 }), false);
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assert.deepStrictEqual(ledger.targets, [{ ref: 'first-ref', base: 'main' }, { ref: 'first-ref', base: 'main', head_sha: 'first-head' }, { ref: 'second-ref', base: 'main' }]);
  assert.strictEqual(ledger.rounds.length, 2);
  assert.deepStrictEqual(ledger.reconciliation.hint, {
    trigger: 'target-terminal', firstMaterialFinding: null, stage: null, avoidedLaunches: 0,
    preflight: ['confirm target revisions', 'confirm checks', 'choose resume, revise, or split'],
    options: ['resume', 'revise', 'split'],
  });
  assert.deepStrictEqual(ledger.telemetry, [{ role: 'correctness', round: 1, elapsedMs: 1, totalTokens: null }]);
  assert.ok(finaliseInitiativeRun(run));
  assert.throws(() => open({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 }), /immutable|terminal/);
});

test('initiative aggregate output hashes local target revisions and exposes counts only', () => {
  const dir = temp();
  const run = open({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'private-ref', revision: { ref: 'private-ref', base: 'private-base', head: 'private-head' }, round: 1 }));
  recordDisposition(run, { target: 'private-ref', revision: { ref: 'private-ref', base: 'private-base', head_sha: 'private-head' }, result: { status: 'target-terminal' }, findings: { intent: 1 }, checks: [{ name: 'check', status: 'passed' }] });
  const summary = publicInitiativeSummary(run);
  assert.deepStrictEqual(summary, {
    targetIds: [require('node:crypto').createHash('sha256').update(JSON.stringify({ ref: 'private-ref', base: 'private-base', head_sha: 'private-head' })).digest('hex')],
    counts: { targets: 1, launches: 1, rounds: 1, findings: { intent: 1 }, checks: 1, telemetry: 0 },
  });
  assert.doesNotMatch(JSON.stringify(summary), /private-(?:ref|base|head)/);
});

test('initiative state directories initialize recursively and terminal targets stay immutable', () => {
  const dir = path.join(temp(), 'new', 'state');
  const run = open({ stateDir: dir, key: 'opaque key', maxLaunches: 4, maxRounds: 2 });
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'first-ref', revision: { ref: 'first-ref', base: 'main' }, round: 1 }));
  assert.ok(recordDisposition(run, { target: 'first-ref', revision: { ref: 'first-ref', base: 'main', head_sha: 'first-head' }, result: { status: 'target-terminal' } }));
  assert.strictEqual(reserveLaunch(run, { role: 'fix', target: 'first-ref', revision: { ref: 'first-ref', base: 'main' }, round: 1 }), false);
  assert.strictEqual(recordDisposition(run, { target: 'first-ref', result: { status: 'target-terminal' } }), false);
  assert.ok(reserveLaunch(run, { role: 'correctness', target: 'second-ref', revision: { ref: 'second-ref', base: 'main' }, round: 1 }));
});

test('initiative state paths are canonicalized through a symlink', () => {
  const root = temp();
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias);
  const run = open({ stateDir: path.join(alias, 'new', 'state'), key: 'canonical', maxLaunches: 1, maxRounds: 1 });
  assert.strictEqual(run.path, path.join(fs.realpathSync(actual), 'new', 'state', path.basename(run.path)));
});
