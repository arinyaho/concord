'use strict';

const REQUIRED_ENGINES = ['claude-code', 'codex'];
const PAIRING_KEYS = ['targetSnapshot', 'targetDiff', 'intent', 'model', 'reasoningEffort', 'reviewConfig', 'engine', 'provider', 'providerSchema', 'corpusRevision', 'evaluationMode'];
const CODEX_CONFIG_FIELDS = ['model', 'reasoningEffort', 'serviceTier'];
const RUN_PAIRING_KEYS = ['targetDiffIdentity', 'targetDiffHash', 'intentIdentity', 'intentHash'];
const REMOVED_PARENT_FIELDS = ['parentProxyContents', 'parentProxyTokenizerVersion', 'parentProxyContentHash', 'parentProxyTokens'];
const TERMINALS = ['clean', 'parked', 'abandoned', 'intent-review', 'gate-pending', 'budget-stopped', 'harness-failure'];
const DOD_RESULTS = ['passed', 'failed', 'deferred', 'not-run'];
const HOLISTIC_DEFECTS = ['ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model']
  .map((lens) => `holistic::gate:${lens}:gap`);
function frozenScenario({ seededDefects = [], confirmedDefects = [], nonDefects = [], requiredFixes = [], allowedTerminalOutcomes = ['clean'], hasExecutableDoD = true } = {}) {
  const defectIds = [...new Set([...seededDefects, ...confirmedDefects, ...requiredFixes])];
  const expectedProbes = defectIds.map((id) => `probe:${id}`);
  return {
    behaviorPreserving: true, confirmedDefects, seededDefects, nonDefects, requiredFixes, expectedProbes,
    allowedTerminalOutcomes, hasExecutableDoD,
    probesByFinding: Object.fromEntries(defectIds.map((id) => [id, [`probe:${id}`]])),
  };
}
const FROZEN_CORPORA = {
  'review-eval-v2': {
    clean: frozenScenario({ nonDefects: ['clean::correctness:clean-diff'] }),
    seeded: frozenScenario({
      seededDefects: ['seeded::correctness:seeded-bug'], nonDefects: ['seeded::correctness:not-a-bug'],
      allowedTerminalOutcomes: ['clean', 'parked'],
    }),
    'false-positive': frozenScenario({ nonDefects: [
      'false-positive::correctness:false-positive-candidate',
      'false-positive::gate:ac-coverage:false-positive-candidate',
      'false-positive::gate:design-conformance:false-positive-candidate',
      'false-positive::gate:cross-context:false-positive-candidate',
      'false-positive::gate:silent-gap:false-positive-candidate',
      'false-positive::gate:threat-model:false-positive-candidate',
    ] }),
    'malformed-blocked': frozenScenario({ allowedTerminalOutcomes: ['harness-failure'], hasExecutableDoD: false }),
    'fix-round': frozenScenario({
      seededDefects: ['fix-round::correctness:fix-round-bug'], confirmedDefects: ['fix-round::correctness:fix-round-bug'],
      requiredFixes: ['fix-round::correctness:fix-round-bug'],
    }),
    holistic: frozenScenario({ seededDefects: HOLISTIC_DEFECTS, requiredFixes: HOLISTIC_DEFECTS }),
  },
};

function sorted(values) { return [...new Set(values || [])].sort(); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function runKey(run) { return `${run?.scenarioId}#${run?.repetition}`; }
function validId(id, scenarioId) { return typeof id === 'string' && id.startsWith(`${scenarioId}::`) && id.length > scenarioId.length + 2; }
function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0; }
function nonemptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function tCritical95(df) {
  const z = 1.959963984540054; const z2 = z * z; const z3 = z2 * z; const z5 = z3 * z2; const z7 = z5 * z2;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}
function interval(values) {
  if (!values.length) return { sampleSize: 0, mean: null, lowerBound: null, upperBound: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { sampleSize: 1, mean, lowerBound: mean, upperBound: mean };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = tCritical95(values.length - 1) * Math.sqrt(variance / values.length);
  return { sampleSize: values.length, mean, lowerBound: mean - margin, upperBound: mean + margin };
}
function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function expectedSchedule(repetition) {
  return { scheduleBlock: Math.floor(repetition / 6) + 1, schedulePosition: repetition % 6 + 1, firstSide: repetition % 2 === 0 ? 'baseline' : 'candidate' };
}

function validateTelemetry(name, pairKey, engine, run, note) {
  for (const field of REMOVED_PARENT_FIELDS) if (Object.hasOwn(run, field)) note(`${name} removed parent proxy field: ${pairKey}:${field}`);
  const telemetry = run.telemetry;
  if (!telemetry || telemetry.partialCalls !== 0) note(`${name} partial usage: ${pairKey}`);
  if (!nonnegative(telemetry?.calls) || telemetry.calls === 0) note(`${name} subprocess count invalid: ${pairKey}`);
  if (!nonnegative(telemetry?.elapsedMs)) note(`${name} elapsed time invalid: ${pairKey}`);
  const fields = ['inputTokens', 'cacheWriteInputTokens', 'cachedInputTokens', 'outputTokens'];
  if (engine === 'codex') fields.push('reasoningOutputTokens');
  if (fields.some((field) => !nonnegative(telemetry?.[field])) || !nonnegative(telemetry?.totalTokens)) note(`${name} token components invalid: ${pairKey}`);
  else if (fields.reduce((sum, field) => sum + telemetry[field], 0) !== telemetry.totalTokens) note(`${name} token total mismatch: ${pairKey}`);
  if (engine === 'claude-code' && telemetry?.reasoningOutputTokens !== null) note(`${name} Claude reasoning output must be null: ${pairKey}`);
}

function compareReviewResults(baseline, candidate, options = {}) {
  const engine = options.engine || baseline?.pairing?.engine;
  const unevaluable = []; const note = (message) => { if (!unevaluable.includes(message)) unevaluable.push(message); };
  for (const [name, manifest] of [['baseline', baseline], ['candidate', candidate]]) {
    if (manifest?.schemaVersion !== 2) note(`${name} manifest schemaVersion must be 2`);
    if (typeof manifest?.toolRevision !== 'string' || !manifest.toolRevision) note(`${name} tool revision is missing`);
    if (manifest?.repetitions !== 30) note('calibrated repetition count must be 30');
    if (!manifest?.scenarios || typeof manifest.scenarios !== 'object' || Array.isArray(manifest.scenarios)) note(`${name} scenarios are missing`);
    if (!Array.isArray(manifest?.runs)) note(`${name} runs are missing`);
    for (const field of REMOVED_PARENT_FIELDS) if (Object.hasOwn(manifest || {}, field)) note(`${name} removed parent proxy field: manifest:${field}`);
  }
  for (const field of engine === 'codex' ? [...PAIRING_KEYS, 'serviceTier'] : PAIRING_KEYS) {
    if (!nonemptyString(baseline?.pairing?.[field]) || !nonemptyString(candidate?.pairing?.[field])) note(`pairing identity missing: ${field}`);
    else if (baseline.pairing[field] !== candidate.pairing[field]) note(`pairing identity mismatch: ${field}`);
  }
  if (baseline?.pairing?.engine !== engine || candidate?.pairing?.engine !== engine) note('pairing identity mismatch: engine');
  const expectedSchema = engine === 'claude-code' ? 'claude-subagent-transcript-2.1.268-v1' : 'codex-exec-json-v1';
  if (baseline?.pairing?.providerSchema !== expectedSchema || candidate?.pairing?.providerSchema !== expectedSchema) note(`provider schema does not match engine: ${engine}`);
  if (!['live', 'replay'].includes(baseline?.pairing?.evaluationMode)) note(`unsupported evaluation mode: ${baseline?.pairing?.evaluationMode}`);

  const baselineScenarios = baseline?.scenarios || {}; const candidateScenarios = candidate?.scenarios || {};
  for (const [name, manifest] of [['baseline', baseline], ['candidate', candidate]]) {
    const revision = manifest?.pairing?.corpusRevision; const corpus = FROZEN_CORPORA[revision];
    if (!nonemptyString(revision)) continue;
    if (!corpus) { note(`${name} unsupported frozen corpus revision: ${revision}`); continue; }
    if (!same(manifest?.scenarios, corpus)) note(`${name} frozen corpus metadata mismatch: ${revision}`);
  }
  const scenarioIds = sorted([...Object.keys(baselineScenarios), ...Object.keys(candidateScenarios)]);
  const frozenTerminals = new Set();
  for (const scenarioId of scenarioIds) {
    const scenario = baselineScenarios[scenarioId]; const other = candidateScenarios[scenarioId];
    if (!scenario || !other) { note(`scenario missing from one manifest: ${scenarioId}`); continue; }
    if (!same(scenario, other)) note(`scenario metadata mismatch: ${scenarioId}`);
    if (typeof scenario.behaviorPreserving !== 'boolean') note(`scenario behavior-preserving flag missing: ${scenarioId}`);
    if (typeof scenario.hasExecutableDoD !== 'boolean') note(`scenario hasExecutableDoD invalid: ${scenarioId}`);
    for (const field of ['seededDefects', 'confirmedDefects', 'nonDefects', 'requiredFixes', 'expectedProbes', 'allowedTerminalOutcomes']) {
      if (!Array.isArray(scenario[field]) || scenario[field].some((value) => typeof value !== 'string')) note(`scenario ${field} is invalid: ${scenarioId}`);
    }
    for (const metadata of [scenario, other]) {
      const classifications = ['seededDefects', 'confirmedDefects', 'requiredFixes', 'nonDefects'];
      const identities = sorted(classifications.flatMap((field) => metadata[field] || []));
      for (const id of identities) if (!validId(id, scenarioId)) note(`scenario identity is not qualified: ${scenarioId}:${id}`);
      const defects = new Set(['seededDefects', 'confirmedDefects', 'requiredFixes'].flatMap((field) => metadata[field] || []));
      for (const id of metadata.nonDefects || []) if (defects.has(id)) note(`scenario finding classifications overlap: ${scenarioId}:${id}`);
      const expectedProbes = new Set(metadata.expectedProbes || []);
      const mappedIdentities = sorted([...(metadata.seededDefects || []), ...(metadata.confirmedDefects || []), ...(metadata.requiredFixes || [])]);
      for (const id of mappedIdentities) {
        const probes = metadata.probesByFinding?.[id];
        if (!Array.isArray(probes) || !probes.length) note(`scenario probesByFinding missing: ${scenarioId}:${id}`);
        else if (probes.some((probe) => !expectedProbes.has(probe))) note(`scenario probesByFinding unknown probe: ${scenarioId}:${id}`);
      }
      for (const id of Object.keys(metadata.probesByFinding || {})) if (!mappedIdentities.includes(id)) note(`scenario probesByFinding has unknown identity: ${scenarioId}:${id}`);
      for (const terminal of metadata.allowedTerminalOutcomes || []) if (!TERMINALS.includes(terminal)) note(`scenario terminal is invalid: ${scenarioId}:${terminal}`);
    }
    for (const terminal of scenario.allowedTerminalOutcomes || []) frozenTerminals.add(terminal);
  }

  function index(manifest, name) {
    const result = new Map(); const seeds = new Set();
    const isolated = Object.fromEntries(['parentSessionId', 'checkoutId', 'artifactDirectoryId'].map((field) => [field, new Set()]));
    for (const run of manifest?.runs || []) {
      if (!run || typeof run !== 'object') { note(`${name} run is invalid`); continue; }
      const key = runKey(run);
      if (!(run.scenarioId in (manifest.scenarios || {})) || !Number.isInteger(run.repetition) || run.repetition < 0 || run.repetition >= 30) note(`${name} run identity is invalid: ${key}`);
      for (const field of engine === 'codex' ? CODEX_CONFIG_FIELDS : ['requestedModel']) {
        if (!nonemptyString(run[field])) note(`${name} requested configuration missing: ${key}:${field}`);
        else if (run[field] !== manifest.pairing?.[field === 'requestedModel' ? 'model' : field]) note(`${name} requested configuration mismatch: ${key}:${field}`);
      }
      if (result.has(key)) note(`${name} duplicate run: ${key}`); else result.set(key, run);
      if (run.independent !== true || typeof run.randomSeed !== 'string' || !run.randomSeed) note(`${name} run is not independently identified: ${key}`);
      else if (seeds.has(run.randomSeed)) note(`${name} random seed is reused: ${run.randomSeed}`); else seeds.add(run.randomSeed);
      const schedule = expectedSchedule(run.repetition);
      if (Object.keys(schedule).some((field) => run[field] !== schedule[field])) note(`${name} frozen schedule mismatch: ${key}`);
      for (const [field, seen] of Object.entries(isolated)) {
        if (typeof run[field] !== 'string' || !run[field]) note(`${name} isolation identity is missing: ${key}:${field}`);
        else if (seen.has(run[field])) note(`${name} isolation identity is reused: ${run[field]}`); else seen.add(run[field]);
      }
      const expectedProbes = manifest.scenarios?.[run.scenarioId]?.expectedProbes || [];
      if (!run.expectedProbeResults || typeof run.expectedProbeResults !== 'object' || Array.isArray(run.expectedProbeResults) ||
          !same(Object.keys(run.expectedProbeResults).sort(), [...expectedProbes].sort()) || Object.values(run.expectedProbeResults).some((value) => typeof value !== 'boolean')) note(`${name} probe results mismatch: ${key}`);
      if (!DOD_RESULTS.includes(run.dod)) note(`${name} DoD result invalid: ${key}`);
      validateTelemetry(name, key, engine, run, note);
    }
    return { runs: result, seeds, isolated };
  }
  const baseIndex = index(baseline, 'baseline'); const candidateIndex = index(candidate, 'candidate');
  const baseModels = new Set([...baseIndex.runs.values()].map((run) => run.resolvedModel));
  const candidateModels = new Set([...candidateIndex.runs.values()].map((run) => run.resolvedModel));
  if (engine === 'claude-code' && (baseModels.size !== 1 || candidateModels.size !== 1)) note('resolved model identity is mixed');
  if (engine === 'codex' && ([...baseModels, ...candidateModels].some((model) => model !== 'unavailable'))) note('Codex resolved model identity must be unavailable');
  for (const seed of candidateIndex.seeds) if (baseIndex.seeds.has(seed)) note(`paired random seed is reused: ${seed}`);
  for (const field of Object.keys(baseIndex.isolated)) for (const value of candidateIndex.isolated[field]) if (baseIndex.isolated[field].has(value)) note(`isolation identity is reused across sides: ${value}`);

  const baselineFalseClean = []; const candidateFalseClean = []; const confirmedFailures = { baseline: [], candidate: [] }; const behaviorMismatches = [];
  const repetitions = new Map(); const accepted = { baseline: new Set(), candidate: new Set() };
  for (let repetition = 0; repetition < 30; repetition++) repetitions.set(repetition, {
    scenarios: new Set(), seeded: 0, baselineHits: 0, candidateHits: 0, nonDefects: 0, baselineFalsePositives: 0, candidateFalsePositives: 0,
    fixes: 0, baselineFixes: 0, candidateFixes: 0, baselineTerminals: {}, candidateTerminals: {}, baselineTokens: 0, candidateTokens: 0,
  });

  const allKeys = sorted([...baseIndex.runs.keys(), ...candidateIndex.runs.keys()]);
  for (const key of allKeys) {
    const base = baseIndex.runs.get(key); const cand = candidateIndex.runs.get(key);
    if (!base || !cand) { note(`missing paired run: ${key}`); continue; }
    const scenario = baselineScenarios[base.scenarioId]; if (!scenario) continue;
    for (const field of RUN_PAIRING_KEYS) {
      if (typeof base[field] !== 'string' || !base[field] || typeof cand[field] !== 'string' || !cand[field]) note(`scenario pairing identity missing: ${key}:${field}`);
      else if (base[field] !== cand[field]) note(`scenario pairing mismatch: ${key}:${field}`);
    }
    for (const field of ['scheduleBlock', 'schedulePosition', 'firstSide']) if (base[field] !== cand[field]) note(`paired schedule mismatch: ${key}:${field}`);
    if (engine === 'claude-code') {
      if (!base.resolvedModel || !cand.resolvedModel || base.resolvedModel === 'unavailable' || cand.resolvedModel === 'unavailable') note(`resolved model missing: ${key}`);
      else if (base.resolvedModel !== cand.resolvedModel) note(`resolved model mismatch: ${key}`);
    } else if (base.resolvedModel !== cand.resolvedModel) note(`resolved model mismatch: ${key}`);

    const declared = new Set([...(scenario.seededDefects || []), ...(scenario.confirmedDefects || []), ...(scenario.requiredFixes || []), ...(scenario.nonDefects || [])]);
    const adjudicatedBase = sorted(base.adjudicatedNonDefects || []); const adjudicatedCandidate = sorted(cand.adjudicatedNonDefects || []);
    if (!same(adjudicatedBase, adjudicatedCandidate)) note(`adjudicated non-defects mismatch: ${key}`);
    for (const id of [...adjudicatedBase, ...adjudicatedCandidate]) if (!validId(id, base.scenarioId)) note(`adjudicated non-defect identity is not qualified: ${key}:${id}`);
    const defectIds = new Set([...(scenario.seededDefects || []), ...(scenario.confirmedDefects || []), ...(scenario.requiredFixes || [])]);
    for (const id of [...adjudicatedBase, ...adjudicatedCandidate]) if (defectIds.has(id)) note(`adjudicated non-defect overlaps defect: ${key}:${id}`);
    const nonDefects = sorted([...(scenario.nonDefects || []), ...adjudicatedBase]);
    for (const id of nonDefects) declared.add(id);
    const fixed = { baseline: [], candidate: [] };
    for (const [name, run] of [['baseline', base], ['candidate', cand]]) {
      if (!Array.isArray(run.acceptedFindings)) note(`${name} accepted findings missing: ${key}`);
      for (const id of run.acceptedFindings || []) { accepted[name].add(id); if (!declared.has(id)) note(`unadjudicated accepted identity: ${key}:${id}`); }
      if (!Array.isArray(run.fixedFindings)) note(`${name} fixed findings missing: ${key}`);
      for (const id of run.fixedFindings || []) {
        if (!declared.has(id)) note(`unadjudicated fixed identity: ${key}:${id}`);
        else if (!(run.acceptedFindings || []).includes(id)) note(`${name} fixed finding was not accepted: ${key}:${id}`);
        else if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run.fixCommits?.[id] || '')) note(`${name} fixed finding lacks commit evidence: ${key}:${id}`);
        else if (!Array.isArray(run.confirmationFindings) || run.confirmationFindings.includes(id)) note(`${name} fixed finding recurred in confirmation: ${key}:${id}`);
        else fixed[name].push(id);
      }
      if (!TERMINALS.includes(run.terminal)) note(`${name} terminal outcome invalid: ${key}`);
      else if (!(scenario.allowedTerminalOutcomes || []).includes(run.terminal)) note(`${name} terminal outcome is not allowed: ${key}:${run.terminal}`);
      const expectedDod = scenario.hasExecutableDoD ? 'passed' : 'deferred';
      if (run.terminal === 'clean' && run.dod !== expectedDod) note(`${name} clean DoD mismatch: ${key}`);
    }
    const probesPass = (run, identity) => (scenario.probesByFinding?.[identity] || []).every((probe) => run.expectedProbeResults?.[probe] === true);
    const allProbesPass = (run) => (scenario.expectedProbes || []).every((probe) => run.expectedProbeResults?.[probe] === true);
    const resolved = (run, name, identity) => (run.acceptedFindings || []).includes(identity) && fixed[name].includes(identity) && probesPass(run, identity);
    for (const identity of scenario.confirmedDefects || []) for (const [name, run] of [['baseline', base], ['candidate', cand]]) if (!resolved(run, name, identity)) confirmedFailures[name].push(`${key}:${identity}`);
    const falseClean = (run, name) => run.terminal === 'clean' && (
      !(scenario.allowedTerminalOutcomes || []).includes('clean') || run.dod !== (scenario.hasExecutableDoD ? 'passed' : 'deferred') ||
      [...new Set([...(scenario.seededDefects || []), ...(scenario.confirmedDefects || []), ...(scenario.requiredFixes || [])])].some((identity) => !resolved(run, name, identity)) || !allProbesPass(run)
    );
    if (falseClean(base, 'baseline')) baselineFalseClean.push(key); if (falseClean(cand, 'candidate')) candidateFalseClean.push(key);
    if (scenario.behaviorPreserving && baseline.pairing?.evaluationMode === 'replay') {
      const tuple = (run, name) => [sorted(run.acceptedFindings), sorted(fixed[name]), run.dod, run.terminal, run.expectedProbeResults || {}];
      if (!same(tuple(base, 'baseline'), tuple(cand, 'candidate'))) behaviorMismatches.push(key);
    }
    const repetition = repetitions.get(base.repetition);
    if (!repetition) continue;
    repetition.scenarios.add(base.scenarioId);
    const seeded = scenario.seededDefects || []; const fixes = scenario.requiredFixes || [];
    repetition.seeded += seeded.length; repetition.baselineHits += seeded.filter((id) => (base.acceptedFindings || []).includes(id)).length; repetition.candidateHits += seeded.filter((id) => (cand.acceptedFindings || []).includes(id)).length;
    repetition.nonDefects += nonDefects.length; repetition.baselineFalsePositives += nonDefects.filter((id) => (base.acceptedFindings || []).includes(id)).length; repetition.candidateFalsePositives += nonDefects.filter((id) => (cand.acceptedFindings || []).includes(id)).length;
    repetition.fixes += fixes.length; repetition.baselineFixes += fixes.filter((id) => resolved(base, 'baseline', id)).length; repetition.candidateFixes += fixes.filter((id) => resolved(cand, 'candidate', id)).length;
    repetition.baselineTerminals[base.terminal] = (repetition.baselineTerminals[base.terminal] || 0) + 1; repetition.candidateTerminals[cand.terminal] = (repetition.candidateTerminals[cand.terminal] || 0) + 1;
    repetition.baselineTokens += base.telemetry?.totalTokens || 0; repetition.candidateTokens += cand.telemetry?.totalTokens || 0;
  }
  if (baseIndex.runs.size !== 30 * scenarioIds.length) note(`baseline run count mismatch: expected ${30 * scenarioIds.length}, got ${baseIndex.runs.size}`);
  if (candidateIndex.runs.size !== 30 * scenarioIds.length) note(`candidate run count mismatch: expected ${30 * scenarioIds.length}, got ${candidateIndex.runs.size}`);

  const recall = []; const falsePositive = []; const successfulFix = []; const tokenChanges = [];
  for (const [repetitionId, repetition] of repetitions) {
    if (repetition.scenarios.size !== scenarioIds.length) note(`incomplete corpus repetition: ${repetitionId}`);
    if (!repetition.seeded) note(`no seeded defects in repetition: ${repetitionId}`); else recall.push((repetition.candidateHits - repetition.baselineHits) / repetition.seeded);
    if (!repetition.nonDefects) note(`no non-defects in repetition: ${repetitionId}`); else falsePositive.push((repetition.candidateFalsePositives - repetition.baselineFalsePositives) / repetition.nonDefects);
    if (!repetition.fixes) note(`no required fixes in repetition: ${repetitionId}`); else successfulFix.push((repetition.candidateFixes - repetition.baselineFixes) / repetition.fixes);
    if (repetition.baselineTokens <= 0) note(`baseline token total is zero: ${repetitionId}`); else tokenChanges.push((repetition.candidateTokens - repetition.baselineTokens) / repetition.baselineTokens);
  }
  const terminalValues = Object.fromEntries([...frozenTerminals].map((terminal) => {
    const values = [...repetitions.values()].map((repetition) => ((repetition.candidateTerminals[terminal] || 0) - (repetition.baselineTerminals[terminal] || 0)) / scenarioIds.length);
    const bounds = interval(values); return [terminal, { pass: bounds.lowerBound >= -0.05 && bounds.upperBound <= 0.05, ...bounds }];
  }));
  const recallBounds = interval(recall); const falsePositiveBounds = interval(falsePositive); const successfulFixBounds = interval(successfulFix);
  const baselineTotal = [...repetitions.values()].reduce((sum, value) => sum + value.baselineTokens, 0); const candidateTotal = [...repetitions.values()].reduce((sum, value) => sum + value.candidateTokens, 0);
  const tokenMedian = median(tokenChanges);
  const gates = {
    falseClean: { pass: !baselineFalseClean.length && !candidateFalseClean.length, baselinePairs: baselineFalseClean, candidatePairs: candidateFalseClean, additionalPairs: candidateFalseClean.filter((key) => !baselineFalseClean.includes(key)) },
    confirmedDefects: { pass: !confirmedFailures.baseline.length && !confirmedFailures.candidate.length, baselinePairs: confirmedFailures.baseline, candidatePairs: confirmedFailures.candidate },
    recall: { pass: recallBounds.lowerBound !== null && recallBounds.lowerBound >= -0.05, ...recallBounds },
    falsePositive: { pass: falsePositiveBounds.upperBound !== null && falsePositiveBounds.upperBound <= 0.05, ...falsePositiveBounds },
    successfulFix: { pass: successfulFixBounds.lowerBound !== null && successfulFixBounds.lowerBound >= -0.05, ...successfulFixBounds },
    terminals: { pass: Object.keys(terminalValues).length > 0 && Object.values(terminalValues).every((value) => value.pass), values: terminalValues },
    behavior: { applied: baseline.pairing?.evaluationMode === 'replay', pass: baseline.pairing?.evaluationMode !== 'replay' || !behaviorMismatches.length, mismatchedPairs: behaviorMismatches },
    tokens: { pass: tokenMedian !== null && tokenMedian <= -0.30 && candidateTotal <= 0.70 * baselineTotal, medianPairedChange: tokenMedian, baselineTotal, candidateTotal },
  };
  const qualityPass = ['falseClean', 'confirmedDefects', 'recall', 'falsePositive', 'successfulFix', 'terminals', 'behavior'].every((name) => gates[name].pass);
  return {
    pass: !unevaluable.length && qualityPass && gates.tokens.pass, evaluable: !unevaluable.length, qualityPass, tokenPass: gates.tokens.pass,
    unevaluable, repetitions: repetitions.size, gates,
    identities: { acceptedBaseline: sorted(accepted.baseline), acceptedCandidate: sorted(accepted.candidate) },
    secondary: {
      baseline: { calls: [...baseIndex.runs.values()].reduce((sum, run) => sum + (run.telemetry?.calls || 0), 0), elapsedMs: [...baseIndex.runs.values()].reduce((sum, run) => sum + (run.telemetry?.elapsedMs || 0), 0) },
      candidate: { calls: [...candidateIndex.runs.values()].reduce((sum, run) => sum + (run.telemetry?.calls || 0), 0), elapsedMs: [...candidateIndex.runs.values()].reduce((sum, run) => sum + (run.telemetry?.elapsedMs || 0), 0) },
    },
    limitations: engine === 'codex' ? ['actual model identity unavailable', 'actual reasoning effort and service tier unavailable', 'unobservable child work cannot be scored'] : [],
  };
}

function compareReviewMatrix(baseline, candidate) {
  const unevaluable = []; const engines = {};
  if (baseline?.schemaVersion !== 2) unevaluable.push('baseline matrix schemaVersion must be 2');
  if (candidate?.schemaVersion !== 2) unevaluable.push('candidate matrix schemaVersion must be 2');
  for (const engine of REQUIRED_ENGINES) {
    if (!baseline?.engines?.[engine]) unevaluable.push(`baseline engine is missing: ${engine}`);
    if (!candidate?.engines?.[engine]) unevaluable.push(`candidate engine is missing: ${engine}`);
    if (baseline?.engines?.[engine] && candidate?.engines?.[engine]) engines[engine] = compareReviewResults(baseline.engines[engine], candidate.engines[engine], { engine });
  }
  const qualityPass = !unevaluable.length && REQUIRED_ENGINES.every((engine) => engines[engine]?.evaluable && engines[engine]?.qualityPass);
  const tokenPass = !unevaluable.length && REQUIRED_ENGINES.every((engine) => engines[engine]?.tokenPass);
  return { pass: qualityPass && tokenPass, evaluable: !unevaluable.length && REQUIRED_ENGINES.every((engine) => engines[engine]?.evaluable), qualityPass, tokenPass, unevaluable, engines };
}

function matrixRevision(matrix) {
  const revisions = REQUIRED_ENGINES.map((engine) => matrix?.engines?.[engine]?.toolRevision);
  return revisions.every((revision) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) && new Set(revisions).size === 1 ? revisions[0] : null;
}

function compareReviewStage(stage, pr1, previous, candidate) {
  if (stage === 'pr1') {
    const replay = previous;
    const validation = compareReviewMatrix(pr1, replay);
    const unevaluable = [...validation.unevaluable];
    const pr1Revision = matrixRevision(pr1); const replayRevision = matrixRevision(replay);
    if (!pr1Revision) unevaluable.push('PR1 revision is missing or inconsistent across engines');
    if (!replayRevision) unevaluable.push('PR1 replay revision is missing or inconsistent across engines');
    else if (pr1Revision && replayRevision !== pr1Revision) unevaluable.push('PR1 replay revision must match the measured PR1 revision');
    return { pass: !unevaluable.length && validation.evaluable && validation.qualityPass, finalThresholdApplied: false, unevaluable, validation };
  }
  if (!/^pr[2-5]$/.test(stage)) return { pass: false, unevaluable: [`unsupported comparison stage: ${stage}`] };
  const number = Number(stage.slice(2));
  const unevaluable = [];
  const pr1Revision = matrixRevision(pr1); const previousRevision = matrixRevision(previous); const candidateRevision = matrixRevision(candidate);
  const candidatePrecedingRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate?.precedingRevision) ? candidate.precedingRevision : null;
  if (!pr1Revision) unevaluable.push('PR1 revision is missing or inconsistent across engines');
  if (!previousRevision) unevaluable.push('preceding revision is missing or inconsistent across engines');
  if (!candidateRevision) unevaluable.push('candidate revision is missing or inconsistent across engines');
  if (!candidatePrecedingRevision) unevaluable.push('candidate preceding revision is missing or invalid');
  if (number === 2 && pr1Revision && previousRevision && pr1Revision !== previousRevision) unevaluable.push('PR2 preceding revision must match the frozen PR1 revision');
  if (candidateRevision && previousRevision && candidateRevision === previousRevision) unevaluable.push('candidate revision must differ from the preceding revision');
  if (candidatePrecedingRevision && previousRevision && candidatePrecedingRevision !== previousRevision) unevaluable.push('candidate preceding revision does not match the measured preceding revision');
  const adjacent = compareReviewMatrix(previous, candidate); const final = compareReviewMatrix(pr1, candidate);
  const comparisonPass = (report) => report.evaluable && report.qualityPass;
  const pass = !unevaluable.length && comparisonPass(adjacent) && comparisonPass(final) && (stage !== 'pr5' || final.tokenPass);
  return { pass, finalThresholdApplied: stage === 'pr5', unevaluable, adjacent, final };
}

module.exports = { compareReviewResults, compareReviewMatrix, compareReviewStage, interval, median };
