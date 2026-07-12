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
  return { enabled: true };
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
    .map((f) => {
      const seg = String(f.id).split(':');
      const cls = seg.length >= 3 && seg[1] ? seg[1] : 'cross-context';
      return { id: f.id, class: cls, file: f.file, evidence: f.span || '', requirement: f.requirement || '', summary: f.summary };
    });
}

module.exports = { CONFIG_FILENAME, loadGateConfig, foldGateFindings };
