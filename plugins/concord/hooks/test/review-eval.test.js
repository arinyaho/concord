'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compareReviewMatrix, compareReviewStage } = require('../../core/review-eval');

function scenario({ defects = [], confirmed = [], nonDefects = [], fixes = [], probes = [], allowed = ['clean'], executable = true } = {}) {
  return {
    behaviorPreserving: true, hasExecutableDoD: executable,
    seededDefects: defects, confirmedDefects: confirmed, nonDefects, requiredFixes: fixes,
    expectedProbes: probes,
    probesByFinding: Object.fromEntries([...new Set([...defects, ...confirmed, ...fixes])].map((id) => [id, probes.length ? probes : [`probe:${id}`]])),
    allowedTerminalOutcomes: allowed,
  };
}

const SCENARIOS = {
  clean: scenario(),
  seeded: scenario({ defects: ['seeded::bug'], fixes: ['seeded::bug'], probes: ['probe:seeded'] }),
  'false-positive': scenario({ nonDefects: ['false-positive::trap'] }),
  'malformed-blocked': scenario({ allowed: ['harness-failure'], executable: false }),
  holistic: scenario({ defects: ['holistic::gap'], fixes: ['holistic::gap'], probes: ['probe:holistic'] }),
  'fix-round': scenario({ defects: ['fix-round::bug'], confirmed: ['fix-round::bug'], fixes: ['fix-round::bug'], probes: ['probe:fix'] }),
};

function telemetry(engine, total) {
  return engine === 'claude-code'
    ? { calls: 2, partialCalls: 0, inputTokens: total - 30, cacheWriteInputTokens: 10, cachedInputTokens: 10, reasoningOutputTokens: null, outputTokens: 10, totalTokens: total, elapsedMs: 100 }
    : { calls: 2, partialCalls: 0, inputTokens: total - 30, cacheWriteInputTokens: 0, cachedInputTokens: 10, reasoningOutputTokens: 10, outputTokens: 10, totalTokens: total, elapsedMs: 100 };
}

function manifest(engine, side, revision, total = side === 'baseline' ? 100 : 60) {
  const runs = [];
  for (let repetition = 0; repetition < 30; repetition++) {
    for (const [scenarioId, metadata] of Object.entries(SCENARIOS)) {
      const fixes = [...new Set([...metadata.seededDefects, ...metadata.confirmedDefects, ...metadata.requiredFixes])];
      runs.push({
        scenarioId, repetition, independent: true, randomSeed: `${engine}-${side}-${scenarioId}-${repetition}`,
        parentSessionId: `session-${engine}-${side}-${scenarioId}-${repetition}`,
        checkoutId: `checkout-${engine}-${side}-${scenarioId}-${repetition}`,
        artifactDirectoryId: `artifacts-${engine}-${side}-${scenarioId}-${repetition}`,
        scheduleBlock: Math.floor(repetition / 6) + 1, schedulePosition: repetition % 6 + 1,
        firstSide: repetition % 2 === 0 ? 'baseline' : 'candidate',
        targetDiffIdentity: `diff-${scenarioId}`, targetDiffHash: `hash-diff-${scenarioId}`,
        intentIdentity: 'none', intentHash: 'none', acceptedFindings: fixes, fixedFindings: fixes,
        fixCommits: Object.fromEntries(fixes.map((id) => [id, 'a'.repeat(40)])), confirmationFindings: [],
        expectedProbeResults: Object.fromEntries(metadata.expectedProbes.map((id) => [id, true])),
        dod: metadata.hasExecutableDoD ? 'passed' : 'deferred', terminal: metadata.allowedTerminalOutcomes[0],
        telemetry: telemetry(engine, total), resolvedModel: engine === 'claude-code' ? 'claude-sonnet-4-5-20250929' : 'unavailable',
      });
    }
  }
  return {
    schemaVersion: 2, toolRevision: revision, repetitions: 30,
    pairing: {
      targetSnapshot: 'snapshot-1', targetDiff: 'diff-corpus-1', intent: 'intent-1', model: 'pinned-model', reasoningEffort: 'high', reviewConfig: 'config-1',
      engine, provider: engine === 'claude-code' ? 'anthropic' : 'openai',
      providerSchema: engine === 'claude-code' ? 'claude-subagent-transcript-2.1.268-v1' : 'codex-exec-json-v1',
      corpusRevision: 'review-eval-v2', evaluationMode: 'replay',
    },
    scenarios: structuredClone(SCENARIOS), runs,
  };
}

function matrix(side, revision, total, precedingRevision) {
  return { schemaVersion: 2, ...(precedingRevision ? { precedingRevision } : {}), engines: {
    'claude-code': manifest('claude-code', side, revision, total),
    codex: manifest('codex', side, revision, total),
  } };
}

test('schema v2 paired evaluator passes both engines independently', () => {
  const report = compareReviewMatrix(matrix('baseline', 'pr1'), matrix('candidate', 'pr5'));
  assert.strictEqual(report.pass, true);
  for (const engine of ['claude-code', 'codex']) {
    assert.deepStrictEqual(report.engines[engine].unevaluable, []);
    assert.strictEqual(report.engines[engine].gates.falseClean.pass, true);
    assert.strictEqual(report.engines[engine].gates.confirmedDefects.pass, true);
    assert.strictEqual(report.engines[engine].gates.tokens.medianPairedChange, -0.4);
    assert.strictEqual(report.engines[engine].gates.tokens.pass, true);
    assert.strictEqual(report.engines[engine].gates.terminals.values.clean.sampleSize, 30);
  }
});

test('rejects version 1 and every removed parent-proxy field', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  baseline.schemaVersion = 1; candidate.engines.codex.runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).parentProxyTokens = 10;
  const report = compareReviewMatrix(baseline, candidate);
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('baseline matrix schemaVersion must be 2'));
  assert.ok(report.engines.codex.unevaluable.includes('candidate removed parent proxy field: seeded#0:parentProxyTokens'));
});

test('requires the frozen 30-repetition alternating block schedule', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  candidate.engines.codex.runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).firstSide = 'candidate'; candidate.engines.codex.runs.pop();
  const report = compareReviewMatrix(baseline, candidate).engines.codex;
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.some((message) => message.includes('frozen schedule mismatch: seeded#0')));
  assert.ok(report.unevaluable.some((message) => message.includes('missing paired run')));
});

test('requires exact per-scenario target diff and intent identities', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  candidate.engines.codex.runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).targetDiffHash = 'different';
  const report = compareReviewMatrix(baseline, candidate).engines.codex;
  assert.ok(report.unevaluable.includes('scenario pairing mismatch: seeded#0:targetDiffHash'));
});

test('provider component equations are engine-specific', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  candidate.engines['claude-code'].runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).telemetry.reasoningOutputTokens = 1;
  candidate.engines.codex.runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).telemetry.cacheWriteInputTokens = 2;
  const report = compareReviewMatrix(baseline, candidate);
  assert.ok(report.engines['claude-code'].unevaluable.includes('candidate Claude reasoning output must be null: seeded#0'));
  assert.ok(report.engines.codex.unevaluable.includes('candidate token total mismatch: seeded#0'));
});

test('rejects zero-call telemetry even when every aggregate is internally consistent', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  Object.assign(candidate.engines.codex.runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).telemetry, {
    calls: 0, partialCalls: 0, inputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0,
    reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0,
  });

  const report = compareReviewMatrix(baseline, candidate).engines.codex;

  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('candidate subprocess count invalid: seeded#0'));
});

test('a false clean fails on both sides and confirmed defects fail even when non-clean', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  for (const side of [baseline, candidate]) {
    const run = side.engines.codex.runs.find((item) => item.scenarioId === 'seeded' && item.repetition === 0);
    Object.assign(run, { acceptedFindings: [], fixedFindings: [], fixCommits: {} });
  }
  let report = compareReviewMatrix(baseline, candidate).engines.codex;
  assert.deepStrictEqual(report.gates.falseClean.baselinePairs, ['seeded#0']);
  assert.deepStrictEqual(report.gates.falseClean.candidatePairs, ['seeded#0']);

  const base2 = matrix('baseline', 'pr1'); const cand2 = matrix('candidate', 'pr5');
  for (const side of [base2, cand2]) {
    const run = side.engines.codex.runs.find((item) => item.scenarioId === 'fix-round' && item.repetition === 0);
    run.terminal = 'parked'; run.acceptedFindings = [];
    side.engines.codex.scenarios['fix-round'].allowedTerminalOutcomes.push('parked');
  }
  report = compareReviewMatrix(base2, cand2).engines.codex;
  assert.strictEqual(report.gates.confirmedDefects.pass, false);
});

test('hasExecutableDoD false is the sole exemption and probesByFinding is total', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  candidate.engines.codex.runs.find((run) => run.scenarioId === 'clean').dod = 'deferred';
  delete candidate.engines.codex.scenarios.seeded.probesByFinding['seeded::bug'];
  const report = compareReviewMatrix(baseline, candidate).engines.codex;
  assert.ok(report.unevaluable.includes('candidate clean DoD mismatch: clean#0'));
  assert.ok(report.unevaluable.includes('scenario probesByFinding missing: seeded:seeded::bug'));
});

test('rejects an invalid DoD result on matching non-clean runs', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  for (const side of [baseline, candidate]) side.engines.codex.runs.find((run) => run.scenarioId === 'malformed-blocked' && run.repetition === 0).dod = 'garbage';

  const report = compareReviewMatrix(baseline, candidate).engines.codex;
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('baseline DoD result invalid: malformed-blocked#0'));
  assert.ok(report.unevaluable.includes('candidate DoD result invalid: malformed-blocked#0'));
});

test('scenario classifications, terminal enums, mappings, and probe results are strict', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  for (const side of [baseline, candidate]) {
    const scenario = side.engines.codex.scenarios.seeded;
    scenario.nonDefects.push('seeded::bug');
    scenario.allowedTerminalOutcomes.push('typo-terminal');
    scenario.probesByFinding['seeded::extra'] = ['probe:seeded'];
    const run = side.engines.codex.runs.find((item) => item.scenarioId === 'seeded' && item.repetition === 0);
    run.expectedProbeResults.extra = true;
  }
  const report = compareReviewMatrix(baseline, candidate).engines.codex;
  assert.ok(report.unevaluable.includes('scenario finding classifications overlap: seeded:seeded::bug'));
  assert.ok(report.unevaluable.includes('scenario terminal is invalid: seeded:typo-terminal'));
  assert.ok(report.unevaluable.includes('scenario probesByFinding has unknown identity: seeded:seeded::extra'));
  assert.ok(report.unevaluable.includes('baseline probe results mismatch: seeded#0'));
});

test('resolved model disagreement is unevaluable while Codex unavailable is disclosed', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  candidate.engines['claude-code'].runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).resolvedModel = 'different';
  const report = compareReviewMatrix(baseline, candidate);
  assert.ok(report.engines['claude-code'].unevaluable.includes('resolved model mismatch: seeded#0'));
  assert.ok(report.engines.codex.limitations.includes('actual model identity unavailable'));
});

test('an exposed requested configuration resolves to one model identity across all invocations', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  for (const side of [baseline, candidate]) {
    for (const run of side.engines['claude-code'].runs.filter((item) => item.repetition === 1)) run.resolvedModel = 'claude-sonnet-rerouted';
  }
  const report = compareReviewMatrix(baseline, candidate).engines['claude-code'];
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('resolved model identity is mixed'));
});

test('a strong Codex result cannot hide a Claude regression or missing engine', () => {
  const baseline = matrix('baseline', 'pr1'); const candidate = matrix('candidate', 'pr5');
  candidate.engines['claude-code'].runs[0].telemetry.partialCalls = 1;
  let report = compareReviewMatrix(baseline, candidate);
  assert.strictEqual(report.engines.codex.pass, true); assert.strictEqual(report.pass, false);
  delete candidate.engines['claude-code']; report = compareReviewMatrix(baseline, candidate);
  assert.ok(report.unevaluable.includes('candidate engine is missing: claude-code'));
});

test('PR2-4 report token progress after adjacent and PR1 quality gates', () => {
  const pr1Revision = 'a'.repeat(40);
  const report = compareReviewStage('pr2', matrix('baseline', pr1Revision, 100), matrix('baseline', pr1Revision, 100), matrix('candidate', 'b'.repeat(40), 95, pr1Revision));
  assert.strictEqual(report.pass, true); assert.strictEqual(report.finalThresholdApplied, false);
  assert.strictEqual(report.adjacent.engines.codex.gates.tokens.medianPairedChange, -0.05);
});

test('stage comparisons accept exact commit revisions rather than PR labels', () => {
  const pr1Revision = 'a'.repeat(40);
  const pr1 = matrix('baseline', pr1Revision);
  const candidate = matrix('candidate', 'b'.repeat(40), undefined, pr1Revision);
  assert.strictEqual(compareReviewStage('pr2', pr1, structuredClone(pr1), candidate).pass, true);
  const repeated = compareReviewStage('pr2', pr1, structuredClone(pr1), matrix('candidate', pr1Revision, undefined, pr1Revision));
  assert.ok(repeated.unevaluable.includes('candidate revision must differ from the preceding revision'));
  const labelled = compareReviewStage('pr2', matrix('baseline', 'pr1'), matrix('baseline', 'pr1'), matrix('candidate', 'pr2', undefined, 'pr1'));
  assert.ok(labelled.unevaluable.includes('PR1 revision is missing or inconsistent across engines'));
});

test('stage comparison rejects a previous matrix unrelated to the candidate chain', () => {
  const pr1 = matrix('baseline', 'a'.repeat(40));
  const candidate = matrix('candidate', 'c'.repeat(40));
  candidate.precedingRevision = 'b'.repeat(40);

  const report = compareReviewStage('pr3', pr1, matrix('baseline', 'd'.repeat(40)), candidate);
  assert.strictEqual(report.pass, false);
  assert.ok(report.unevaluable.includes('candidate preceding revision does not match the measured preceding revision'));
});

test('PR5 applies final thresholds only against exact PR1', () => {
  const pr4Revision = 'd'.repeat(40);
  const report = compareReviewStage('pr5', matrix('baseline', 'a'.repeat(40), 100), matrix('baseline', pr4Revision, 65), matrix('candidate', 'e'.repeat(40), 60, pr4Revision));
  assert.strictEqual(report.pass, true);
  assert.strictEqual(report.adjacent.engines.codex.gates.tokens.pass, false);
  assert.strictEqual(report.final.engines.codex.gates.tokens.pass, true);
});

test('PR1 validates a separately recorded deterministic replay', () => {
  const revision = 'a'.repeat(40);
  const pr1 = matrix('baseline', revision, 100);
  const replay = matrix('candidate', revision, 100);
  assert.strictEqual(compareReviewStage('pr1', pr1, replay).pass, true);
  replay.engines.codex.runs.find((run) => run.scenarioId === 'seeded' && run.repetition === 0).acceptedFindings = [];

  assert.strictEqual(compareReviewStage('pr1', pr1, replay).pass, false);
  assert.strictEqual(compareReviewStage('pr1', pr1).pass, false);
});

test('review-eval CLI requires stage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-'));
  const pr1Revision = 'a'.repeat(40);
  const pr4Revision = 'd'.repeat(40);
  for (const [name, value] of [['pr1', matrix('baseline', pr1Revision, 100)], ['pr1-replay', matrix('candidate', pr1Revision, 100)], ['pr4', matrix('baseline', pr4Revision, 65)], ['pr5', matrix('candidate', 'e'.repeat(40), 60, pr4Revision)]]) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
  const cli = path.resolve(__dirname, '../../../concord-codex/bin/review-eval.js');
  const result = spawnSync(process.execPath, [cli, '--stage', 'pr5', path.join(dir, 'pr1.json'), path.join(dir, 'pr4.json'), path.join(dir, 'pr5.json')], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr); assert.strictEqual(JSON.parse(result.stdout).pass, true);
  assert.notStrictEqual(spawnSync(process.execPath, [cli, path.join(dir, 'pr1.json'), path.join(dir, 'pr5.json')]).status, 0);
  const pr1Validation = spawnSync(process.execPath, [cli, '--stage', 'pr1', path.join(dir, 'pr1.json'), path.join(dir, 'pr1-replay.json')], { encoding: 'utf8' });
  assert.strictEqual(pr1Validation.status, 0, pr1Validation.stderr);
  assert.strictEqual(JSON.parse(pr1Validation.stdout).pass, true);
  assert.notStrictEqual(spawnSync(process.execPath, [cli, '--stage', 'pr1', path.join(dir, 'pr1.json')]).status, 0);
});
