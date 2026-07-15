'use strict';
const fs = require('node:fs');
const path = require('node:path');

// GATE config gating. Trust model mirrors lib/intent.js (benign-on-absent, so a
// repo with no `gate` block keeps the diff-local loop unchanged), NOT dod-exec
// (whose absent config fails closed). A present-but-broken `gate` fails closed:
// silently skipping a gate the user asked for would manufacture a false
// "the design was reviewed" signal.
const CONFIG_FILENAME = 'review.config.json';

function loadGateConfig(repoRoot, readFileFn = fs.readFileSync) {
  let raw;
  try {
    raw = readFileFn(path.join(repoRoot, CONFIG_FILENAME), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but unreadable: ${e && e.message ? e.message : e}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} is present but malformed: ${e && e.message ? e.message : e}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.gate === undefined || parsed.gate === null) return null;
  if (typeof parsed.gate !== 'object' || Array.isArray(parsed.gate)) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} "gate" must be an object (e.g. {} to enable) or null to disable`);
  }
  if (parsed.gate.panel !== undefined && typeof parsed.gate.panel !== 'boolean') {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} "gate.panel" must be a boolean`);
  }
  // panel (spec: 2026-07-15-gate-holistic-panel-design.md decision 7): opt-in,
  // no hardcoded file-path/keyword heuristic in the shared plugin -- a repo
  // that wants the heavier 5-lens panel declares it explicitly, the same way
  // DoD commands are already repo-declared.
  return { enabled: true, panel: !!parsed.gate.panel };
}

// Shared with lib/gate-panel.js's foldPanelRound -- both need to turn a raw
// gate-contract-shape finding ({id, file, span, requirement, summary}) into
// the folded ledger shape ({id, class, file, evidence, requirement,
// summary}). One derivation, two callers, so they can never drift apart.
function toGateFinding(f) {
  const seg = String(f.id).split(':');
  const cls = seg.length >= 3 && seg[1] ? seg[1] : 'cross-context';
  return { id: f.id, class: cls, file: f.file, evidence: f.span || '', requirement: f.requirement || '', summary: f.summary };
}

// Fold a round's gate-review candidates + gate-verify verdict + the ledger's
// dismissed set into the open gate findings for this round. Report-only:
// deliberately NOT filtered to changed files (the cross-context case is an
// UNCHANGED sibling that a changed line's guarantee depends on -- filtering to
// changed files, as the intent detector does, would drop exactly the class the
// gate exists to catch). Each finding is re-derived fresh every round, so a
// later fix that resolves a gap simply stops the gate raising it.
function foldGateFindings({ gateFindings, verifyRejectedIds, dismissedIds }) {
  const rejected = new Set(verifyRejectedIds || []);
  const dismissed = new Set(dismissedIds || []);
  return (gateFindings || [])
    .filter((f) => !rejected.has(f.id) && !dismissed.has(f.id))
    .map(toGateFinding);
}

// Cross-round persistence retire rule (spec decision 4): gate findings must
// PERSIST across rounds -- a round where the gate subagent nondeterministically
// fails to re-report a real finding must not silently erase it and let the run
// converge clean. `priorGateOpen` (the ledger's gate_open going into this
// round) carries forward everything NOT already covered by `thisRoundIds`
// (this round's own folded findings) UNLESS it is plausibly resolved:
// dismissed, rejected by this round's gate-verify, or its file was touched by
// the diff since base (a fix plausibly addressed it -- trust the silence). A
// finding on a file the diff never touched gets no such benefit of the doubt:
// the gate's silence on it is untrusted (flaky), so it is kept. Callers union
// the result with `thisRound` (foldGateFindings' own output); the two are
// disjoint by construction since carried excludes thisRoundIds.
function carryForwardGateFindings({ priorGateOpen, thisRoundIds, verifyRejectedIds, dismissedIds, changedFiles }) {
  const thisRound = new Set(thisRoundIds || []);
  const rejected = new Set(verifyRejectedIds || []);
  const dismissed = new Set(dismissedIds || []);
  const changed = new Set(changedFiles || []);
  return (priorGateOpen || []).filter(
    (f) => !thisRound.has(f.id) && !dismissed.has(f.id) && !rejected.has(f.id) && !changed.has(f.file),
  );
}

module.exports = { CONFIG_FILENAME, loadGateConfig, foldGateFindings, carryForwardGateFindings, toGateFinding };
