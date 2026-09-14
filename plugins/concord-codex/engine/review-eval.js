'use strict';

const PAIRING_KEYS = ['targetSnapshot', 'targetDiff', 'intent', 'model', 'reasoningEffort', 'reviewConfig'];

function sorted(values) { return Array.from(new Set(values || [])).sort(); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function key(run) { return `${run.scenarioId}#${run.repetition}`; }

// Cornish-Fisher expansion for the two-sided 95% Student t critical value.
// The evaluator rejects n < 30, where this expansion is comfortably accurate.
function tCritical95(df) {
  const z = 1.959963984540054;
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  return z + (z3 + z) / (4 * df)
    + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

function interval(values) {
  if (!values.length) return { mean: null, lowerBound: null, upperBound: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { mean, lowerBound: mean, upperBound: mean };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = tCritical95(values.length - 1) * Math.sqrt(variance / values.length);
  return { mean, lowerBound: mean - margin, upperBound: mean + margin };
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function compareReviewResults(baseline, candidate) {
  const unevaluable = [];
  const note = (message) => { if (!unevaluable.includes(message)) unevaluable.push(message); };
  for (const [name, manifest] of [['baseline', baseline], ['candidate', candidate]]) {
    if (!manifest || manifest.version !== 1) note(`${name} manifest version must be 1`);
    if (!manifest || !manifest.toolRevision) note(`${name} tool revision is missing`);
    if (!manifest || !manifest.scenarios || typeof manifest.scenarios !== 'object') note(`${name} scenarios are missing`);
    if (!manifest || !Array.isArray(manifest.runs)) note(`${name} runs are missing`);
  }
  for (const field of PAIRING_KEYS) {
    if (!baseline?.pairing?.[field] || !candidate?.pairing?.[field]) note(`pairing identity missing: ${field}`);
    else if (baseline.pairing[field] !== candidate.pairing[field]) note(`pairing identity mismatch: ${field}`);
  }

  const baselineScenarios = baseline?.scenarios || {};
  const candidateScenarios = candidate?.scenarios || {};
  const scenarioIds = sorted([...Object.keys(baselineScenarios), ...Object.keys(candidateScenarios)]);
  for (const id of scenarioIds) {
    if (!baselineScenarios[id] || !candidateScenarios[id]) note(`scenario missing from one manifest: ${id}`);
    else if (!same(baselineScenarios[id], candidateScenarios[id])) note(`scenario metadata mismatch: ${id}`);
    const scenario = baselineScenarios[id];
    if (scenario && typeof scenario.behaviorPreserving !== 'boolean') note(`behavior-preserving flag missing: ${id}`);
    for (const field of ['seededDefects', 'nonDefects', 'allowedTerminalOutcomes']) {
      if (!Array.isArray(scenario?.[field]) || scenario[field].some((value) => typeof value !== 'string')) note(`scenario ${field} is invalid: ${id}`);
    }
  }

  const index = (manifest, name) => {
    const result = new Map();
    const seeds = new Set();
    for (const run of manifest?.runs || []) {
      if (!run || typeof run !== 'object') { note(`${name} run is invalid`); continue; }
      const runKey = key(run);
      if (!run.scenarioId || !Number.isInteger(run.repetition) || run.repetition < 0) note(`${name} run identity is invalid: ${runKey}`);
      if (result.has(runKey)) note(`${name} duplicate run: ${runKey}`);
      result.set(runKey, run);
      if (run.independent !== true || !run.randomSeed) note(`${name} run is not independently identified: ${runKey}`);
      else if (seeds.has(run.randomSeed)) note(`${name} random seed is reused: ${run.randomSeed}`);
      seeds.add(run.randomSeed);
    }
    return result;
  };
  const baselineRuns = index(baseline, 'baseline');
  const candidateRuns = index(candidate, 'candidate');
  const baselineSeeds = new Set(Array.from(baselineRuns.values(), (run) => run.randomSeed));
  for (const run of candidateRuns.values()) if (baselineSeeds.has(run.randomSeed)) note(`paired random seed is reused: ${run.randomSeed}`);
  const pairKeys = sorted([...baselineRuns.keys(), ...candidateRuns.keys()]);
  const repetitions = new Map();
  const additionalFalseClean = [];
  const behaviorMismatches = [];
  const acceptedBaseline = new Set();
  const acceptedCandidate = new Set();
  const tokenChanges = [];
  const secondary = {
    baseline: { calls: 0, elapsedMs: 0 },
    candidate: { calls: 0, elapsedMs: 0 },
  };

  for (const pairKey of pairKeys) {
    const base = baselineRuns.get(pairKey);
    const cand = candidateRuns.get(pairKey);
    if (!base || !cand) { note(`missing paired run: ${pairKey}`); continue; }
    const scenario = baselineScenarios[base.scenarioId];
    if (!scenario) { note(`unknown scenario: ${pairKey}`); continue; }
    const allowed = Array.isArray(scenario.allowedTerminalOutcomes) ? scenario.allowedTerminalOutcomes : [];
    if (!allowed.length) note(`allowed terminal outcomes missing: ${pairKey}`);
    const baseFalseClean = base.terminal === 'clean' && !allowed.includes('clean');
    const candidateFalseClean = cand.terminal === 'clean' && !allowed.includes('clean');
    if (candidateFalseClean && !baseFalseClean) additionalFalseClean.push(pairKey);

    const seeded = sorted(scenario.seededDefects);
    const nonDefects = sorted(scenario.nonDefects);
    const declared = new Set([...seeded, ...nonDefects]);
    for (const [name, run, destination] of [['baseline', base, acceptedBaseline], ['candidate', cand, acceptedCandidate]]) {
      if (!Array.isArray(run.acceptedFindings)) note(`${name} accepted findings missing: ${pairKey}`);
      for (const id of run.acceptedFindings || []) {
        destination.add(id);
        if (!declared.has(id)) note(`unadjudicated accepted identity: ${pairKey}:${id}`);
      }
      if (!['passed', 'failed', 'deferred', 'not-run'].includes(run.dod)) note(`${name} DoD result invalid: ${pairKey}`);
      if (!['clean', 'parked', 'abandoned', 'intent-review', 'gate-pending', 'budget-stopped', 'harness-failure'].includes(run.terminal)) note(`${name} terminal outcome invalid: ${pairKey}`);
      if (!Array.isArray(run.fixedFindings) || run.fixedFindings.some((id) => typeof id !== 'string')) note(`${name} fixed findings missing: ${pairKey}`);
      else for (const id of run.fixedFindings) if (!declared.has(id)) note(`unadjudicated fixed identity: ${pairKey}:${id}`);
      if (!run.telemetry || run.telemetry.partialCalls !== 0) note(`partial usage: ${pairKey}`);
      if (!Number.isFinite(run.telemetry?.totalTokens) || run.telemetry.totalTokens < 0 || !Number.isFinite(run.parentProxyTokens) || run.parentProxyTokens < 0) note(`token total invalid: ${pairKey}`);
      if (!Number.isSafeInteger(run.telemetry?.calls) || run.telemetry.calls < 0) note(`${name} subprocess count invalid: ${pairKey}`);
      else secondary[name].calls += run.telemetry.calls;
      if (!Number.isFinite(run.telemetry?.elapsedMs) || run.telemetry.elapsedMs < 0) note(`${name} elapsed time invalid: ${pairKey}`);
      else secondary[name].elapsedMs += run.telemetry.elapsedMs;
    }

    if (scenario.behaviorPreserving === true) {
      const baseTuple = [sorted(base.fixedFindings), base.dod, base.terminal];
      const candidateTuple = [sorted(cand.fixedFindings), cand.dod, cand.terminal];
      if (!same(baseTuple, candidateTuple)) behaviorMismatches.push(pairKey);
    }

    const repetition = repetitions.get(base.repetition) || {
      scenarios: new Set(), seeded: 0, baseHits: 0, candidateHits: 0,
      nonDefects: 0, baseFalsePositives: 0, candidateFalsePositives: 0,
      baseTokens: 0, candidateTokens: 0,
    };
    repetition.scenarios.add(base.scenarioId);
    repetition.seeded += seeded.length;
    repetition.baseHits += seeded.filter((id) => (base.acceptedFindings || []).includes(id)).length;
    repetition.candidateHits += seeded.filter((id) => (cand.acceptedFindings || []).includes(id)).length;
    repetition.nonDefects += nonDefects.length;
    repetition.baseFalsePositives += nonDefects.filter((id) => (base.acceptedFindings || []).includes(id)).length;
    repetition.candidateFalsePositives += nonDefects.filter((id) => (cand.acceptedFindings || []).includes(id)).length;
    repetition.baseTokens += (base.telemetry?.totalTokens || 0) + (base.parentProxyTokens || 0);
    repetition.candidateTokens += (cand.telemetry?.totalTokens || 0) + (cand.parentProxyTokens || 0);
    repetitions.set(base.repetition, repetition);
    if (base.telemetry?.partialCalls === 0 && cand.telemetry?.partialCalls === 0) {
      const baseTokens = base.telemetry.totalTokens + base.parentProxyTokens;
      const candidateTokens = cand.telemetry.totalTokens + cand.parentProxyTokens;
      if (baseTokens > 0) tokenChanges.push((candidateTokens - baseTokens) / baseTokens);
    }
  }

  const recallDifferences = [];
  const falsePositiveDifferences = [];
  for (const [repetitionId, repetition] of repetitions) {
    if (repetition.scenarios.size !== scenarioIds.length) note(`incomplete corpus repetition: ${repetitionId}`);
    if (!repetition.seeded) note(`no seeded defects in repetition: ${repetitionId}`);
    else recallDifferences.push((repetition.candidateHits - repetition.baseHits) / repetition.seeded);
    if (!repetition.nonDefects) note(`no non-defects in repetition: ${repetitionId}`);
    else falsePositiveDifferences.push((repetition.candidateFalsePositives - repetition.baseFalsePositives) / repetition.nonDefects);
    if (repetition.baseTokens <= 0) note(`baseline token total is zero: ${repetitionId}`);
  }
  if (repetitions.size < 30) note(`fewer than 30 paired repetitions: ${repetitions.size}`);

  const recall = interval(recallDifferences);
  const falsePositive = interval(falsePositiveDifferences);
  const tokenMedian = median(tokenChanges);
  const gates = {
    falseClean: { pass: additionalFalseClean.length === 0, additionalPairs: additionalFalseClean },
    recall: { pass: recall.lowerBound !== null && recall.lowerBound >= -0.05, ...recall },
    falsePositive: { pass: falsePositive.upperBound !== null && falsePositive.upperBound <= 0.05, ...falsePositive },
    behavior: { pass: behaviorMismatches.length === 0, mismatchedPairs: behaviorMismatches },
    tokens: { pass: tokenMedian !== null && tokenMedian <= -0.30, medianPairedChange: tokenMedian },
  };
  return {
    pass: unevaluable.length === 0 && Object.values(gates).every((gate) => gate.pass),
    unevaluable,
    repetitions: repetitions.size,
    gates,
    identities: { acceptedBaseline: sorted(acceptedBaseline), acceptedCandidate: sorted(acceptedCandidate) },
    secondary,
  };
}

module.exports = { compareReviewResults, interval, median };
