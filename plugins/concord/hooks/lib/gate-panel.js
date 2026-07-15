'use strict';
const { toGateFinding } = require('./gate');

// Pure holistic-panel state machine. No fs, no child_process, no git --
// mirrors lib/gate.js's purity split (impure I/O lives in review-cli.js).
//
// The panel (design: docs/superpowers/specs/2026-07-15-gate-holistic-panel-design.md)
// is a heavier, opt-in GATE extension that fans out 5 lenses (the existing
// GATE's 4 classes plus a new "threat-model" lens) and loops until 2
// consecutive rounds contribute zero NEW confirmed findings (decision 5:
// dedup carry-forward, not a hard round cap). A finding only counts once
// its own round's adversarial-verify pass has let it survive.

function emptyGatePanel() {
  return { status: 'idle', round: 0, dryStreak: 0, confirmed: [], rejectedIds: [] };
}

// Folds one panel round's candidate findings + which ids survived that
// round's adversarial-verify into the cumulative panel state.
//
// - A finding that survived and is NOT already in `confirmed` (deduped by
//   id) counts as newly confirmed this round, and is stored in the SAME
//   folded shape lib/gate.js's foldGateFindings already produces for
//   gate-review findings (toGateFinding) -- so mergePanelIntoGate below
//   never needs to reshape anything.
// - A finding that did NOT survive is added to `rejectedIds` so the next
//   round's finder prompts can be told not to re-raise it without new
//   evidence (decision 5's dedup carry-forward -- the mechanism that stops
//   raised-but-rejected findings bouncing back every round, the pattern
//   that made the un-deduped ES2-2203 panel take 5 rounds instead of
//   converging quickly).
// - dryStreak increments when a round contributes zero NEW confirmed
//   findings (including a finding re-raised that was already confirmed --
//   nothing NEW happened), resets to 0 otherwise. status flips to 'done'
//   once dryStreak reaches 2 -- one dry round alone risks a lucky-early
//   stop (decision 5).
function foldPanelRound({ gatePanel, roundFindings, survivedIds }) {
  const gp = gatePanel || emptyGatePanel();
  const survived = new Set(survivedIds || []);
  const priorConfirmedIds = new Set((gp.confirmed || []).map((f) => f.id));
  const newlyConfirmed = [];
  const newlyRejectedIds = [];
  for (const f of roundFindings || []) {
    if (survived.has(f.id)) {
      if (!priorConfirmedIds.has(f.id) && !newlyConfirmed.some((c) => c.id === f.id)) newlyConfirmed.push(toGateFinding(f));
    } else {
      newlyRejectedIds.push(f.id);
    }
  }
  const confirmed = (gp.confirmed || []).concat(newlyConfirmed);
  const rejectedIds = Array.from(new Set((gp.rejectedIds || []).concat(newlyRejectedIds)));
  const dryStreak = newlyConfirmed.length === 0 ? (gp.dryStreak || 0) + 1 : 0;
  const round = (gp.round || 0) + 1;
  const done = dryStreak >= 2;
  return {
    status: done ? 'done' : 'running',
    round,
    dryStreak,
    confirmed,
    rejectedIds,
    newlyConfirmedCount: newlyConfirmed.length,
  };
}

// Merges the panel's cumulative confirmed findings (already in the folded
// {id, class, file, evidence, requirement, summary} shape) into a round's
// existing GATE findings array (same shape), deduped by id. gate-review's
// own findings win on a rare id collision (decision 8: review-cli.js's fold
// logic itself does not change -- this is the one seam that feeds the
// panel's output into it, as plain data). dismissedIds filters out any
// panel-confirmed finding a human has already dismissed via the `dismiss`
// verb -- mirrors lib/gate.js's foldGateFindings/carryForwardGateFindings,
// which already exclude dismissed ids from the lightweight GATE's own flow.
function mergePanelIntoGate(gateFindings, panelConfirmed, dismissedIds) {
  const existingIds = new Set((gateFindings || []).map((f) => f.id));
  const dismissed = new Set(dismissedIds || []);
  const extra = (panelConfirmed || []).filter((f) => !existingIds.has(f.id) && !dismissed.has(f.id));
  return (gateFindings || []).concat(extra);
}

module.exports = { emptyGatePanel, foldPanelRound, mergePanelIntoGate };
