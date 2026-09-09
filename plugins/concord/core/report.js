'use strict';
// Pure report-only planning and folding. No fs, no child_process, no git --
// same purity split as lib/gate.js and lib/gate-panel.js, so the verbs own the
// I/O and this file stays testable as plain data in, plain data out.
const { isValidFindingId } = require('./gate-contract');

// The five panel lenses, in the order report-emit reads their artifacts. The
// first four are also the gate pair's classes; threat-model exists only here.
const PANEL_LENSES = ['ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model'];

const DEPTH_ROLES = {
  correctness: ['correctness', 'verify'],
  gate: ['correctness', 'verify', 'gate', 'gate-verify'],
  panel: ['correctness', 'verify', ...PANEL_LENSES, 'panel-verify'],
};

function planRoles(depth, opts = {}) {
  const roles = DEPTH_ROLES[depth];
  if (!roles) throw new Error(`harness-failure: report: unknown depth "${depth}" (expected correctness, gate or panel)`);
  return opts.intent ? [...roles, 'intent'] : [...roles];
}

// Normalize one finder artifact entry into the report's finding shape. Missing
// optional text becomes '' rather than undefined so the emitted JSON has a
// stable set of keys -- a consumer should not have to distinguish "absent" from
// "empty" for a field the contract always carries.
function toReportFinding(f) {
  if (!isValidFindingId(f && f.id)) {
    throw new Error(`harness-failure: report: finding id ${JSON.stringify(f && f.id)} is not a valid finding id`);
  }
  return {
    id: f.id,
    file: typeof f.file === 'string' ? f.file : '',
    span: typeof f.span === 'string' ? f.span : '',
    requirement: typeof f.requirement === 'string' ? f.requirement : '',
    summary: typeof f.summary === 'string' ? f.summary : '',
  };
}

// A rejection kills a finding, so it is only meaningful against one that was
// actually raised: a rejection naming an id nobody raised is dropped rather
// than published, which would otherwise let a verifier pad `rejected` with
// findings that never existed.
function foldFindings({ candidates, rejections }) {
  const raised = new Map();
  for (const c of candidates || []) {
    const f = toReportFinding(c);
    if (!raised.has(f.id)) raised.set(f.id, f);
  }
  const killed = new Map();
  for (const r of rejections || []) {
    const id = r && r.id;
    if (raised.has(id) && !killed.has(id)) killed.set(id, { id, reason: typeof r.reason === 'string' ? r.reason : '' });
  }
  return {
    findings: [...raised.values()].filter((f) => !killed.has(f.id)),
    rejected: [...killed.values()],
  };
}

module.exports = { PANEL_LENSES, planRoles, foldFindings };
