'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compareReviewResults } = require('../../core/review-eval');

const fixtures = path.join(__dirname, 'fixtures', 'review-eval');
const read = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

test('paired evaluator passes identity-preserving telemetry fixture', () => {
  const report = compareReviewResults(read('baseline.json'), read('candidate.json'));
  assert.strictEqual(report.pass, true);
  assert.deepStrictEqual(report.unevaluable, []);
  assert.deepStrictEqual(report.gates.falseClean.additionalPairs, []);
  assert.strictEqual(report.gates.recall.lowerBound, 0);
  assert.strictEqual(report.gates.recall.upperBound, 0);
  assert.strictEqual(report.gates.falsePositive.lowerBound, 0);
  assert.strictEqual(report.gates.falsePositive.upperBound, 0);
  assert.deepStrictEqual(report.gates.behavior.mismatchedPairs, []);
  assert.ok(report.gates.tokens.medianPairedChange <= -0.30);
  assert.deepStrictEqual(report.identities.acceptedBaseline, ['correctness:seeded-bug']);
  assert.deepStrictEqual(report.identities.acceptedCandidate, ['correctness:seeded-bug']);
  assert.strictEqual(report.secondary.baseline.calls, 60);
  assert.strictEqual(report.secondary.candidate.calls, 60);
});

test('paired evaluator fails closed on mismatched pairing identity and partial usage', () => {
  const baseline = read('baseline.json');
  const candidate = read('candidate.json');
  candidate.pairing.model = 'different-model';
  candidate.runs[0].telemetry.partialCalls = 1;
  const report = compareReviewResults(baseline, candidate);
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('pairing identity mismatch: model'));
  assert.ok(report.unevaluable.includes('partial usage: seeded#0'));
});

test('paired evaluator rejects parent proxy tokens without provenance', () => {
  for (const field of ['parentProxyTokenizerVersion', 'parentProxyContentHash']) {
    const baseline = read('baseline.json');
    const candidate = read('candidate.json');
    delete candidate.runs[0][field];

    const report = compareReviewResults(baseline, candidate);

    assert.strictEqual(report.pass, false);
    assert.ok(report.unevaluable.includes('candidate parent proxy provenance invalid: seeded#0'));
  }
});

test('paired evaluator fails closed on malformed runs', () => {
  for (const malformed of [null, 1]) {
    const baseline = read('baseline.json');
    baseline.runs[0] = malformed;
    const report = compareReviewResults(baseline, read('candidate.json'));
    assert.strictEqual(report.pass, false);
    assert.ok(report.unevaluable.includes('baseline run is invalid'));
  }
});

test('paired evaluator rejects non-string random seeds', () => {
  for (const seed of [{ replayed: true }, ['replayed']]) {
    const baseline = read('baseline.json');
    baseline.runs[0].randomSeed = structuredClone(seed);
    baseline.runs[1].randomSeed = structuredClone(seed);
    const report = compareReviewResults(baseline, read('candidate.json'));
    assert.strictEqual(report.pass, false);
    assert.deepStrictEqual(report.unevaluable, [
      'baseline run is not independently identified: seeded#0',
      'baseline run is not independently identified: seeded#1',
    ]);
  }
});

test('paired evaluator rejects fabricated fixed finding identities', () => {
  const baseline = read('baseline.json');
  const candidate = read('candidate.json');
  baseline.runs[0].fixedFindings = ['correctness:fabricated-repair'];
  candidate.runs[0].fixedFindings = ['correctness:fabricated-repair'];
  const report = compareReviewResults(baseline, candidate);
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('unadjudicated fixed identity: seeded#0:correctness:fabricated-repair'));
});

test('paired evaluator rejects a candidate-only false clean by pair identity', () => {
  const baseline = read('baseline.json');
  const candidate = read('candidate.json');
  baseline.runs[0].terminal = 'parked';
  candidate.runs[0].terminal = 'clean';
  baseline.scenarios.seeded.allowedTerminalOutcomes = ['parked'];
  candidate.scenarios.seeded.allowedTerminalOutcomes = ['parked'];
  const report = compareReviewResults(baseline, candidate);
  assert.strictEqual(report.pass, false);
  assert.deepStrictEqual(report.gates.falseClean.additionalPairs, ['seeded#0']);
});

test('review-eval CLI prints JSON and exits according to the gates', () => {
  const cli = path.resolve(__dirname, '../../../concord-codex/bin/review-eval.js');
  const result = spawnSync(process.execPath, [cli, path.join(fixtures, 'baseline.json'), path.join(fixtures, 'candidate.json')], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(result.stdout).pass, true);
});
