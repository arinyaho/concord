'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../lib/engine');
const review = require('../lib/review');

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
}

// No test in this file spawns a real process or calls a real LLM -- every
// runGate/runDodExec/gitOps dependency is a fake.

// ---------------------------------------------------------------------------
// Gate output contract: parse + validate
// ---------------------------------------------------------------------------

test('isValidFindingId: accepts "gate:stable-slug" shapes', () => {
  assert.ok(engine.isValidFindingId('correctness:off-by-one-sum-range'));
  assert.ok(engine.isValidFindingId('dod:leftover-debug-log'));
});

test('isValidFindingId: rejects missing colon, uppercase, spaces, or non-strings', () => {
  assert.ok(!engine.isValidFindingId('no-colon-here'));
  assert.ok(!engine.isValidFindingId('Gate:Slug'));
  assert.ok(!engine.isValidFindingId('gate: slug with spaces'));
  assert.ok(!engine.isValidFindingId(42));
  assert.ok(!engine.isValidFindingId(undefined));
});

test('parseGateFindings: parses a well-formed JSON array', () => {
  const raw = JSON.stringify([
    { id: 'correctness:off-by-one', gate: 'correctness', file: 'a.js', span: 'i < b', summary: 'excludes upper bound' },
  ]);
  const findings = engine.parseGateFindings(raw);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].id, 'correctness:off-by-one');
  assert.strictEqual(findings[0].status, 'confirmed');
});

test('parseGateFindings: strips a markdown code fence around the JSON', () => {
  const raw = '```json\n[{"id":"correctness:x","file":"a.js","summary":"bug"}]\n```';
  const findings = engine.parseGateFindings(raw);
  assert.strictEqual(findings.length, 1);
});

test('parseGateFindings: an empty array means "nothing to report"', () => {
  assert.deepStrictEqual(engine.parseGateFindings('[]'), []);
});

test('parseGateFindings: throws on non-JSON output', () => {
  assert.throws(() => engine.parseGateFindings('not json at all'), /valid JSON/);
});

test('parseGateFindings: throws when the payload is not a JSON array', () => {
  assert.throws(() => engine.parseGateFindings('{"id":"a:b"}'), /must be a JSON array/);
});

test('parseGateFindings: throws on a missing/invalid stable id -- the gate output contract', () => {
  assert.throws(() => engine.parseGateFindings(JSON.stringify([{ file: 'a.js', summary: 'bug' }])), /stable "gate:slug" id/);
  assert.throws(() => engine.parseGateFindings(JSON.stringify([{ id: 'not-a-slug', file: 'a.js', summary: 'bug' }])), /stable "gate:slug" id/);
});

test('parseGateFindings: throws when file or summary is missing', () => {
  assert.throws(() => engine.parseGateFindings(JSON.stringify([{ id: 'g:s', summary: 'bug' }])), /missing "file"/);
  assert.throws(() => engine.parseGateFindings(JSON.stringify([{ id: 'g:s', file: 'a.js' }])), /missing "summary"/);
});

test('parseVerifyVerdict: keeps only rejected ids that were actually candidates', () => {
  const candidates = [{ id: 'g:a' }, { id: 'g:b' }];
  const verdict = engine.parseVerifyVerdict(JSON.stringify({ rejected: ['g:a', 'g:not-a-candidate'] }), candidates);
  assert.deepStrictEqual(verdict.rejectedIds, ['g:a']);
});

test('parseVerifyVerdict: throws on non-JSON output', () => {
  assert.throws(() => engine.parseVerifyVerdict('nope', []), /valid JSON/);
});

// ---------------------------------------------------------------------------
// Prompt builders: sanity checks, not snapshot tests
// ---------------------------------------------------------------------------

test('buildCorrectnessPrompt: folds in the distrust-green instruction and the diff', () => {
  const prompt = engine.buildCorrectnessPrompt({ diff: 'diff --git a b', dod: { passed: true, results: [] } });
  assert.match(prompt, /distrust a green run/i);
  assert.match(prompt, /dead-code matcher/i);
  assert.match(prompt, /diff --git a b/);
  assert.match(prompt, /"id"/); // id-format instruction present
  assert.match(prompt, /STABLE slug/);
});

test('buildFixPrompt: names the finding id and file so the fix call is scoped', () => {
  const prompt = engine.buildFixPrompt({ id: 'correctness:x', file: 'a.js', summary: 'bug', span: 'bad' }, '/repo');
  assert.match(prompt, /correctness:x/);
  assert.match(prompt, /a\.js/);
  assert.match(prompt, /\/repo/);
});

// ---------------------------------------------------------------------------
// Cost aggregation
// ---------------------------------------------------------------------------

test('createCostAccumulator: sums cost across calls and counts calls', () => {
  const acc = engine.createCostAccumulator();
  acc.add(0.05);
  acc.add(0.03);
  assert.strictEqual(acc.calls(), 2);
  assert.ok(Math.abs(acc.totalUsd() - 0.08) < 1e-9);
});

test('createCostAccumulator: a non-numeric/undefined cost counts as a call but adds 0', () => {
  const acc = engine.createCostAccumulator();
  acc.add(undefined);
  acc.add(NaN);
  acc.add('garbage');
  assert.strictEqual(acc.calls(), 3);
  assert.strictEqual(acc.totalUsd(), 0);
});

// ---------------------------------------------------------------------------
// Park-reason taxonomy
// ---------------------------------------------------------------------------

test('validateParkReason: accepts needs-decision and harness-failure kinds', () => {
  assert.deepStrictEqual(engine.validateParkReason({ kind: 'needs-decision', text: 'ambiguous fix' }), {
    kind: 'needs-decision',
    text: 'ambiguous fix',
  });
  assert.deepStrictEqual(engine.validateParkReason({ kind: 'harness-failure', text: 'auth broken' }), {
    kind: 'harness-failure',
    text: 'auth broken',
  });
});

test('validateParkReason: rejects an unknown kind', () => {
  assert.throws(() => engine.validateParkReason({ kind: 'whatever', text: 'x' }), /kind must be one of/);
});

test('validateParkReason: rejects a missing/empty text', () => {
  assert.throws(() => engine.validateParkReason({ kind: 'needs-decision', text: '' }), /non-empty string/);
  assert.throws(() => engine.validateParkReason({ kind: 'needs-decision' }), /non-empty string/);
});

test('countNeedsDecisionParks / parkBudgetExceeded: only counts needs-decision parks, trips at threshold', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings.push({ id: 'f1', status: 'parked', park_reason: { kind: 'needs-decision', text: 'a' } });
  ledger.findings.push({ id: 'f2', status: 'parked', park_reason: { kind: 'needs-decision', text: 'b' } });
  ledger.findings.push({ id: 'f3', status: 'open' }); // not parked, not counted
  assert.strictEqual(engine.countNeedsDecisionParks(ledger), 2);
  assert.strictEqual(engine.parkBudgetExceeded(ledger, 3), false);
  assert.strictEqual(engine.parkBudgetExceeded(ledger, 2), true);
});

// ---------------------------------------------------------------------------
// Resume git-reachability
// ---------------------------------------------------------------------------

test('checkResumeReachability: no head_sha recorded -> reachable, ledger untouched', async () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const gitOps = { isReachable: async () => { throw new Error('should not be called'); } };
  const result = await engine.checkResumeReachability(ledger, gitOps);
  assert.strictEqual(result.reachable, true);
  assert.strictEqual(result.suspect, false);
  assert.strictEqual(result.ledger, ledger);
});

test('checkResumeReachability: reachable head_sha leaves the ledger untouched', async () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x', head_sha: 'abc123' });
  const gitOps = { isReachable: async (sha) => sha === 'abc123' };
  const result = await engine.checkResumeReachability(ledger, gitOps);
  assert.strictEqual(result.reachable, true);
  assert.strictEqual(result.suspect, false);
});

test('checkResumeReachability: an unreachable head_sha resets fixed/parked findings to open and drops their seen entries', async () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x', head_sha: 'stale-sha' });
  ledger.findings = [
    { id: 'f1', status: 'fixed', fix_commit: 'deadbeef', park_reason: null },
    { id: 'f2', status: 'parked', fix_commit: null, park_reason: { kind: 'needs-decision', text: 'x' } },
    { id: 'f3', status: 'open' },
  ];
  ledger.seen = [
    { id: 'f1', hash: 'h1', status: 'fixed' },
    { id: 'f2', hash: 'h2', status: 'parked' },
  ];
  const gitOps = { isReachable: async () => false }; // rebased/force-pushed away
  const result = await engine.checkResumeReachability(ledger, gitOps);
  assert.strictEqual(result.reachable, false);
  assert.strictEqual(result.suspect, true);
  const f1 = result.ledger.findings.find((f) => f.id === 'f1');
  const f2 = result.ledger.findings.find((f) => f.id === 'f2');
  const f3 = result.ledger.findings.find((f) => f.id === 'f3');
  assert.strictEqual(f1.status, 'open');
  assert.strictEqual(f1.fix_commit, null);
  assert.strictEqual(f2.status, 'open');
  assert.strictEqual(f2.park_reason, null);
  assert.strictEqual(f3.status, 'open'); // untouched, was already open
  assert.deepStrictEqual(result.ledger.seen, []); // both reset findings' seen entries dropped
  assert.strictEqual(result.ledger.status, 'converging');
});

// ---------------------------------------------------------------------------
// runRound: one round of DoD-exec + correctness gate + verify + fixer
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  return {
    repoRoot: '/repo',
    costAcc: engine.createCostAccumulator(),
    runDodExec: async () => ({ passed: true, results: [{ cmd: 'node --test', passed: true, exitCode: 0, output: 'ok' }] }),
    runGate: async () => ({ text: '[]', costUsd: 0.01 }),
    gitOps: { commitFix: async () => 'deadbeef' },
    spanStillPresent: async () => true,
    ...overrides,
  };
}

test('runRound: DoD passes, correctness gate reports nothing -> clean-shaped outcome', async () => {
  const deps = makeDeps();
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const outcome = await engine.runRound(deps, ledger, { diff: 'diff --git a b' });
  assert.strictEqual(outcome.dodPassed, true);
  assert.deepStrictEqual(outcome.findings, []);
  assert.deepStrictEqual(outcome.fixedIds, []);
  assert.deepStrictEqual(outcome.parkedIds, []);
});

test('runRound: a confirmed finding gets fixed via runGate + gitOps.commitFix', async () => {
  let calls = [];
  const finding = { id: 'correctness:off-by-one', gate: 'correctness', file: 'sum.js', span: 'i < b', summary: 'excludes upper bound' };
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async (prompt, opts) => {
      calls.push(opts.mode);
      if (opts.mode === 'review') return { text: JSON.stringify([finding]), costUsd: 0.02 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 };
      if (opts.mode === 'fix') return { text: '{"edited":true}', costUsd: 0.03 };
      throw new Error(`unexpected mode ${opts.mode}`);
    },
    gitOps: { commitFix: async (id) => `commit-for-${id}` },
    spanStillPresent: async () => true,
  });
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const outcome = await engine.runRound(deps, ledger, { diff: 'diff --git a b' });
  assert.deepStrictEqual(calls, ['review', 'verify', 'fix']);
  assert.deepStrictEqual(outcome.fixedIds, ['correctness:off-by-one']);
  assert.strictEqual(outcome.fixCommits['correctness:off-by-one'], 'commit-for-correctness:off-by-one');
  assert.ok(deps.costAcc.totalUsd() > 0.05);
  assert.strictEqual(deps.costAcc.calls(), 3);
});

test('runRound: the verify gate rejecting a finding marks it killed, not fixed', async () => {
  const finding = { id: 'correctness:false-positive', gate: 'correctness', file: 'a.js', span: 'x', summary: 'looks buggy but is not' };
  let fixCalled = false;
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: JSON.stringify([finding]), costUsd: 0.01 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [finding.id] }), costUsd: 0.01 };
      fixCalled = true;
      return { text: '{"edited":true}', costUsd: 0.01 };
    },
  });
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const outcome = await engine.runRound(deps, ledger, { diff: 'd' });
  assert.deepStrictEqual(outcome.killedIds, [finding.id]);
  assert.deepStrictEqual(outcome.fixedIds, []);
  assert.strictEqual(fixCalled, false); // never attempted a fix for a killed finding
});

test('runRound: a failing fix call parks the finding as needs-decision rather than aborting the round', async () => {
  const finding = { id: 'correctness:hard-fix', gate: 'correctness', file: 'a.js', span: 'x', summary: 'tricky bug' };
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: JSON.stringify([finding]), costUsd: 0.01 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 };
      throw new Error('fix call timed out');
    },
  });
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const outcome = await engine.runRound(deps, ledger, { diff: 'd' });
  assert.deepStrictEqual(outcome.parkedIds, [finding.id]);
  assert.strictEqual(outcome.parkReasons[finding.id].kind, 'needs-decision');
  assert.match(outcome.parkReasons[finding.id].text, /fix call timed out/);
});

test('runRound: a malformed correctness-gate response throws HarnessFailureError (fail-closed, not "no findings")', async () => {
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async () => ({ text: 'not json', costUsd: 0.01 }),
  });
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  await assert.rejects(() => engine.runRound(deps, ledger, { diff: 'd' }), engine.HarnessFailureError);
});

test('runRound: runDodExec throwing (tool cannot run) surfaces as HarnessFailureError', async () => {
  const deps = makeDeps({ runDodExec: async () => { throw new Error('node not found'); } });
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  await assert.rejects(() => engine.runRound(deps, ledger, { diff: 'd' }), engine.HarnessFailureError);
});

test('runRound: runGate throwing on the review call surfaces as HarnessFailureError (fail-closed)', async () => {
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async () => { throw new Error('auth failure'); },
  });
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  await assert.rejects(() => engine.runRound(deps, ledger, { diff: 'd' }), engine.HarnessFailureError);
});

test('runRound: idempotent replay -- a finding whose span is already absent is marked fixed without calling runGate\'s fix mode or gitOps.commitFix again', async () => {
  const finding = { id: 'correctness:already-fixed', gate: 'correctness', file: 'a.js', span: 'i < b', summary: 'stale finding' };
  let commitCalled = false;
  let fixGateCalled = false;
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: JSON.stringify([finding]), costUsd: 0.01 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 };
      fixGateCalled = true;
      return { text: '{"edited":true}', costUsd: 0.01 };
    },
    gitOps: { commitFix: async () => { commitCalled = true; return 'sha'; } },
    spanStillPresent: async () => false, // the code no longer contains the flagged span -- already fixed
  });
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings.push({ id: finding.id, status: 'open', fix_commit: null });
  const outcome = await engine.runRound(deps, ledger, { diff: 'd' });
  assert.deepStrictEqual(outcome.fixedIds, [finding.id]);
  assert.strictEqual(fixGateCalled, false);
  assert.strictEqual(commitCalled, false);
  assert.match(outcome.fixCommits[finding.id], /idempotent replay/);
});

test('runRound: a finding the ledger already concluded (e.g. previously killed) is not re-attempted even if the gate re-reports it', async () => {
  const finding = { id: 'correctness:already-killed', gate: 'correctness', file: 'a.js', span: 'x', summary: 'already adjudicated' };
  let fixGateCalled = false;
  const deps = makeDeps({
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: JSON.stringify([finding]), costUsd: 0.01 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 }; // gate confirms it again
      fixGateCalled = true;
      return { text: '{"edited":true}', costUsd: 0.01 };
    },
  });
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings.push({ id: finding.id, status: 'killed' }); // already concluded by a prior round
  const outcome = await engine.runRound(deps, ledger, { diff: 'd' });
  assert.deepStrictEqual(outcome.fixedIds, []);
  assert.strictEqual(fixGateCalled, false);
});

// ---------------------------------------------------------------------------
// runLoop: the full loop over rounds
// ---------------------------------------------------------------------------

function makeLoopDeps(stateDir, overrides = {}) {
  return {
    repoRoot: '/repo',
    stateDir,
    gitOps: {
      diff: async () => 'diff --git a b',
      commitFix: async (id) => `commit-${id}`,
      isReachable: async () => true,
    },
    spanStillPresent: async () => true,
    runDodExec: async () => ({ passed: true, results: [] }),
    runGate: async () => ({ text: '[]', costUsd: 0.01 }),
    ...overrides,
  };
}

test('runLoop: converges to clean in one round when DoD passes and there is nothing to report', async () => {
  const stateDir = tmpStateDir();
  const deps = makeLoopDeps(stateDir);
  const result = await engine.runLoop(deps, { kind: 'local', ref: 'feat/x', base: 'main' });
  assert.strictEqual(result.ledger.status, 'clean');
  assert.strictEqual(result.aborted, null);
  assert.strictEqual(result.rounds.length, 1);
  assert.ok(result.cost.totalUsd > 0);
});

test('runLoop: a fixable finding converges within a few rounds and aggregates cost across every runGate call', async () => {
  const stateDir = tmpStateDir();
  const finding = { id: 'correctness:bug', gate: 'correctness', file: 'a.js', span: 'buggy', summary: 'a bug' };
  let dodPassed = false;
  let fixApplied = false;
  const deps = makeLoopDeps(stateDir, {
    runDodExec: async () => ({ passed: dodPassed, results: [] }),
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: fixApplied ? '[]' : JSON.stringify([finding]), costUsd: 0.02 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 };
      if (opts.mode === 'fix') {
        fixApplied = true;
        dodPassed = true;
        return { text: '{"edited":true}', costUsd: 0.03 };
      }
      throw new Error('unexpected mode');
    },
    // diff changes every round so beginRound never treats it as a no-op
    gitOps: {
      diff: (() => {
        let n = 0;
        return async () => `diff-round-${n++}`;
      })(),
      commitFix: async (id) => `commit-${id}`,
      isReachable: async () => true,
    },
  });
  const result = await engine.runLoop(deps, { kind: 'local', ref: 'feat/y', base: 'main' });
  assert.strictEqual(result.ledger.status, 'clean');
  assert.strictEqual(result.aborted, null);
  assert.ok(result.rounds.length >= 1 && result.rounds.length <= 5);
  assert.ok(result.cost.calls >= 3); // review + verify + fix, at least once
});

test('runLoop: a HarnessFailureError from a gate aborts the run immediately with aborted.kind "harness-failure"', async () => {
  const stateDir = tmpStateDir();
  const deps = makeLoopDeps(stateDir, {
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async () => { throw new Error('claude -p invocation failed: auth error'); },
  });
  const result = await engine.runLoop(deps, { kind: 'local', ref: 'feat/z', base: 'main' });
  assert.strictEqual(result.aborted.kind, 'harness-failure');
  assert.match(result.aborted.message, /auth error/);
  assert.notStrictEqual(result.ledger.status, 'clean');
});

test('runLoop: the park-budget circuit breaker stops early once needs-decision parks cross the threshold', async () => {
  const stateDir = tmpStateDir();
  // All 3 findings are discovered and parked in the SAME round (rather than
  // accumulating one-per-round) so the circuit breaker -- not the ordinary
  // no-progress termination -- is unambiguously what stops the run.
  const findings = ['a', 'b', 'c'].map((s) => ({ id: `correctness:unfixable-${s}`, gate: 'correctness', file: 'x.js', span: s, summary: `hard bug ${s}` }));
  const deps = makeLoopDeps(stateDir, {
    runDodExec: async () => ({ passed: false, results: [] }),
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: JSON.stringify(findings), costUsd: 0.01 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 };
      throw new Error('cannot auto-fix this one'); // every fix attempt fails -> parks all 3
    },
  });
  const result = await engine.runLoop(deps, { kind: 'local', ref: 'feat/w', base: 'main' }, { parkBudget: 2 });
  assert.strictEqual(result.aborted.kind, 'park-budget');
  assert.strictEqual(engine.countNeedsDecisionParks(result.ledger), 3);
  assert.strictEqual(result.rounds.length, 1); // stopped after the very round that crossed the threshold
});

test('runLoop: resuming with an unreachable recorded head_sha resets a stale "fixed" finding back to open before the round runs', async () => {
  const stateDir = tmpStateDir();
  const staleTarget = { kind: 'local', ref: 'feat/resume', base: 'main', head_sha: 'stale-sha' };
  let seeded = review.emptyLedger(staleTarget);
  seeded.findings = [{ id: 'correctness:was-fixed', status: 'fixed', fix_commit: 'old-sha', park_reason: null }];
  seeded.seen = [{ id: 'correctness:was-fixed', hash: 'h', status: 'fixed' }];
  review.writeLedger(stateDir, review.targetSlug(staleTarget.ref), seeded);

  const reachabilityChecks = [];
  const deps = makeLoopDeps(stateDir, {
    gitOps: {
      diff: async () => 'diff --git a b',
      commitFix: async (id) => `commit-${id}`,
      isReachable: async (sha) => {
        reachabilityChecks.push(sha);
        return sha !== 'stale-sha'; // only the OLD recorded sha is unreachable
      },
    },
    runDodExec: async () => ({ passed: false, results: [] }),
    // The gate re-detects the SAME finding fresh (this is the point of the reset:
    // it's no longer suppressed as a stale "fixed" seen entry) and it fails to
    // auto-fix again, ending in a needs-decision park -- proving the reset
    // finding went through a REAL round rather than staying invisibly "fixed".
    runGate: async (prompt, opts) => {
      if (opts.mode === 'review') return { text: JSON.stringify([{ id: 'correctness:was-fixed', gate: 'correctness', file: 'a.js', span: 'x', summary: 'still broken' }]), costUsd: 0.01 };
      if (opts.mode === 'verify') return { text: JSON.stringify({ rejected: [] }), costUsd: 0.01 };
      throw new Error('cannot re-fix automatically');
    },
  });
  // Invoked with a FRESH head_sha (as review-engine.js would after the rebase) --
  // distinct from the stale one recorded in the seeded ledger.
  const result = await engine.runLoop(deps, { ...staleTarget, head_sha: 'fresh-sha' });
  assert.ok(reachabilityChecks.includes('stale-sha'));
  const finding = result.ledger.findings.find((f) => f.id === 'correctness:was-fixed');
  // It must NOT still read "fixed" off untrusted stale bookkeeping -- the reset
  // ran, the finding was re-detected fresh, and (since the fix failed again)
  // concluded this round as a needs-decision park rather than silently staying
  // "fixed".
  assert.strictEqual(finding.status, 'parked');
  assert.strictEqual(finding.park_reason.kind, 'needs-decision');
});
