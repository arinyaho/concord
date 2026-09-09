'use strict';
// Pure report-only planning and folding. No fs, no child_process, no git --
// same purity split as lib/gate.js and lib/gate-panel.js, so the verbs own the
// I/O and this file stays testable as plain data in, plain data out.
const { isValidFindingId } = require('./gate-contract');

// The five panel lenses, in the order report-emit reads their artifacts. The
// first four are also the gate pair's classes; threat-model exists only here.
const PANEL_LENSES = ['ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model'];

// The panel's three-adversarial-verifier fan-out (review-driver.md step (c):
// spawn 3 refute-by-default verifiers per candidate, take the majority) is the
// driver's concern, not a role this module plans. All three verdicts fold into
// ONE artifact, read by the single 'gate-panel-verify' role below -- do not
// read this list as "one role per verifier".
const DEPTH_ROLES = {
  correctness: ['correctness', 'verify'],
  gate: ['correctness', 'verify', 'gate', 'gate-verify'],
  panel: ['correctness', 'verify', ...PANEL_LENSES, 'gate-panel-verify'],
};

const DEPTHS = Object.keys(DEPTH_ROLES);

function planRoles(depth, opts = {}) {
  if (!Object.hasOwn(DEPTH_ROLES, depth)) {
    throw new Error(`harness-failure: report: unknown depth "${depth}" (expected ${DEPTHS.join(', ')})`);
  }
  const roles = DEPTH_ROLES[depth];
  return opts.intent ? [...roles, 'intent'] : [...roles];
}

// Maps a SPAWN role name to the artifact-contract SHAPE its artifact must
// validate against. The five lenses and 'gate' all write gate:-prefixed
// findings, so they share the 'gate' shape; the two verifier roles share
// 'gate-verify'. correctness/verify/intent are already contract names.
const ROLE_SHAPES = {
  'ac-coverage': 'gate',
  'design-conformance': 'gate',
  'cross-context': 'gate',
  'silent-gap': 'gate',
  'threat-model': 'gate',
  gate: 'gate',
  'gate-panel-verify': 'gate-verify',
  'gate-verify': 'gate-verify',
  correctness: 'correctness',
  verify: 'verify',
  intent: 'intent',
};

function artifactShape(role) {
  if (!Object.hasOwn(ROLE_SHAPES, role)) {
    throw new Error(`harness-failure: report: unknown role "${role}" has no artifact shape`);
  }
  return ROLE_SHAPES[role];
}

// Normalize one finder artifact entry into the report's finding shape. Missing
// optional text becomes '' rather than undefined so the emitted JSON has a
// stable set of keys -- a consumer should not have to distinguish "absent" from
// "empty" for a field the contract always carries. `file` and `summary` are
// required upstream by artifact-contract.js (a finding missing either is
// fatal there), so silently coercing them to '' here would publish a report
// finding artifact-contract would have rejected -- fail loudly instead.
function toReportFinding(f) {
  if (!isValidFindingId(f && f.id)) {
    throw new Error(`harness-failure: report: finding id ${JSON.stringify(f && f.id)} is not a valid finding id`);
  }
  if (typeof f.file !== 'string' || !f.file) {
    throw new Error(`harness-failure: report: finding ${f.id} is missing "file"`);
  }
  if (typeof f.summary !== 'string' || !f.summary) {
    throw new Error(`harness-failure: report: finding ${f.id} is missing "summary"`);
  }
  // `class`: NOT reused from gate.js's toGateFinding, whose 'cross-context'
  // fallback for a class-less id is a gate-namespace default that is wrong
  // here -- a two-segment `correctness:` or `intent:` id has no gate class at
  // all, and mislabeling it cross-context would be a fabricated fact, not a
  // sane default. Derive it directly: a three-segment `gate:<class>:<slug>`
  // id's class is its middle segment; any other (two-segment) id's class is
  // its prefix.
  const seg = String(f.id).split(':');
  const cls = seg.length >= 3 ? seg[1] : seg[0];
  return {
    id: f.id,
    class: cls,
    file: f.file,
    span: typeof f.span === 'string' ? f.span : '',
    requirement: typeof f.requirement === 'string' ? f.requirement : '',
    summary: f.summary,
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
    if (!raised.has(id) || killed.has(id)) continue;
    if (typeof r.reason !== 'string' || !r.reason.trim()) {
      throw new Error(`harness-failure: report: rejection of ${id} is missing "reason"`);
    }
    killed.set(id, { id, reason: r.reason });
  }
  return {
    findings: [...raised.values()].filter((f) => !killed.has(f.id)),
    rejected: [...killed.values()],
  };
}

const SCHEMA = 'concord.report/1';

// The intent role's findings bypass the fold on purpose: a contradiction
// between a stated intent and the code has no known correct side, so there is
// nothing for a verifier to adjudicate. They are reported unfiltered under
// `advisory`, and a rejection naming one is ignored rather than honoured.
// `intentFindings` is its own argument rather than sniffed out of `candidates`
// by an `intent:` prefix -- a prefix sniff would route ANY reviewer's
// `intent:`-prefixed id to advisory and exempt it from verification, which is
// a routing decision that belongs to whoever assembled `candidates`
// (knowing which artifact came from the intent role), not to a string match.
function buildReport({ target, depth, intent, examined, candidates, rejections, intentFindings = [] }) {
  // Advisory entries have no gate class -- they are never folded against a
  // verifier, so `class` (a fold-and-verify concept) would be a key the
  // design's advisory schema does not declare. Strip it here rather than
  // giving toReportFinding an options flag for one caller.
  const advisory = intentFindings.map((f) => {
    const { class: _cls, ...rest } = toReportFinding(f);
    return rest;
  });
  if (intent == null && advisory.length) {
    throw new Error('harness-failure: report: advisory findings present but intent is null (the intent role did not run)');
  }
  const folded = foldFindings({ candidates: candidates || [], rejections });
  return {
    schema: SCHEMA,
    target,
    depth,
    intent: intent == null ? null : intent,
    examined: [...new Set(examined || [])].sort(),
    findings: folded.findings,
    advisory,
    rejected: folded.rejected,
  };
}

function buildFailure(what) {
  if (typeof what !== 'string' || !what) {
    throw new Error(`harness-failure: report: buildFailure requires a non-empty string, got ${JSON.stringify(what)}`);
  }
  return { schema: SCHEMA, failed: what };
}

module.exports = { SCHEMA, PANEL_LENSES, DEPTHS, planRoles, artifactShape, foldFindings, buildReport, buildFailure };
