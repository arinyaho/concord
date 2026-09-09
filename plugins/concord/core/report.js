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

module.exports = { PANEL_LENSES, planRoles };
