# GATE Holistic Adversarial Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, one-shot, self-verifying 5-lens "holistic panel" stage to `review-until-green`'s GATE, triggered only at the round where the diff-local loop and lightweight GATE would otherwise converge clean, with CLI-owned dedup/termination (never prose-only).

**Architecture:** Two new `review-cli.js` verbs (`gate-panel-round-start`, `gate-panel-round-record`) drive a self-contained loop-until-dry sub-state-machine (`ledger.gate_panel`), mirroring the existing round-start/plan-fixes/record pattern. `record`'s existing `decideTermination` gains a `panelPending` branch, checked only once the diff-local loop and lightweight GATE are both already clean. The panel's confirmed findings merge into the existing `gate:<class>:<slug>` finding contract via a new pure `lib/gate-panel.js` module, so `plan-fixes`'s GATE-fold logic (`lib/gate.js`) does not change at all.

**Tech Stack:** Node.js (`node:test`, `node:assert`, `node:child_process`), no new dependencies.

## Global Constraints

- No new npm dependencies.
- All new pure logic (dedup, fold, termination) lives in `lib/*.js` with zero `fs`/`child_process`/git access, per the existing `lib/gate.js` / `lib/review.js` purity split. Impure I/O (reading panel round artifacts, writing the ledger) lives only in `review-cli.js`, per the file's own header comment (`plugins/concord/hooks/review-cli.js:27-30`).
- Every new/changed CLI-facing failure mode that should be loud uses the exact string `harness-failure:` as a prefix (existing convention throughout `review-cli.js` and `lib/gate.js`), so callers' `/harness-failure/` regex assertions keep working uniformly.
- Existing tests must keep passing after every task; run the full suite (`node --test plugins/concord/hooks/test/`) at the end of each task, not just the file you touched, since Task 1 changes an existing test's expected output.
- Design source of truth: `docs/superpowers/specs/2026-07-15-gate-holistic-panel-design.md`. Decisions referenced below (e.g. "decision 4", "decision 5") are that document's numbered list.

---

### Task 1: `gate.panel` config flag + shared finding-shape helper

**Files:**
- Modify: `plugins/concord/hooks/lib/gate.js`
- Modify: `plugins/concord/hooks/test/gate.test.js`

**Interfaces:**
- Consumes: nothing new (extends `loadGateConfig`, already exported).
- Produces: `gate.loadGateConfig(...)` now returns `{ enabled: true, panel: <boolean> }` instead of `{ enabled: true }`. New export `gate.toGateFinding(f)` — `(f: {id, file, span?, requirement?, summary}) => {id, class, file, evidence, requirement, summary}` — the same per-item mapping `foldGateFindings` already did inline, now shared so Task 2's panel fold can reuse it instead of duplicating the class-from-id derivation.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/concord/hooks/test/gate.test.js`, replacing the existing `'loadGateConfig: "gate": {} -> enabled'` test (its expected value changes shape) and adding two new ones right after it:

```javascript
test('loadGateConfig: "gate": {} -> enabled, panel defaults to false', () => {
  assert.deepStrictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{}}' })), { enabled: true, panel: false });
});

test('loadGateConfig: "gate": {"panel": true} -> panel enabled', () => {
  assert.deepStrictEqual(gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{"panel":true}}' })), { enabled: true, panel: true });
});

test('loadGateConfig: "gate": {"panel": "yes"} (not a boolean) -> harness-failure', () => {
  assert.throws(() => gate.loadGateConfig('/repo', reader({ 'review.config.json': '{"gate":{"panel":"yes"}}' })), /harness-failure/);
});
```

Also add, near the bottom of the file:

```javascript
test('toGateFinding: derives class from the id\'s middle segment', () => {
  const out = gate.toGateFinding({ id: 'gate:threat-model:sk-exposure', file: 'a.js', span: 'x', requirement: 'r', summary: 's' });
  assert.deepStrictEqual(out, { id: 'gate:threat-model:sk-exposure', class: 'threat-model', file: 'a.js', evidence: 'x', requirement: 'r', summary: 's' });
});

test('toGateFinding: id with only two segments defaults class to cross-context', () => {
  const out = gate.toGateFinding({ id: 'gate:only-two-segments', file: 'a.js', summary: 's' });
  assert.strictEqual(out.class, 'cross-context');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/concord/hooks/test/gate.test.js`
Expected: the `"gate": {}` test FAILs (actual `{enabled:true}` !== expected `{enabled:true, panel:false}`); the two new `panel` tests and both `toGateFinding` tests FAIL with "gate.toGateFinding is not a function" / assertion mismatches.

- [ ] **Step 3: Implement**

In `plugins/concord/hooks/lib/gate.js`, replace:

```javascript
  if (!parsed || typeof parsed !== 'object' || parsed.gate === undefined || parsed.gate === null) return null;
  if (typeof parsed.gate !== 'object' || Array.isArray(parsed.gate)) {
    throw new Error(`harness-failure: ${CONFIG_FILENAME} "gate" must be an object (e.g. {} to enable) or null to disable`);
  }
  return { enabled: true };
}
```

with:

```javascript
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
```

Then replace the `foldGateFindings` function:

```javascript
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
```

with:

```javascript
// Shared with lib/gate-panel.js's foldPanelRound -- both need to turn a raw
// gate-contract-shape finding ({id, file, span, requirement, summary}) into
// the folded ledger shape ({id, class, file, evidence, requirement,
// summary}). One derivation, two callers, so they can never drift apart.
function toGateFinding(f) {
  const seg = String(f.id).split(':');
  const cls = seg.length >= 3 && seg[1] ? seg[1] : 'cross-context';
  return { id: f.id, class: cls, file: f.file, evidence: f.span || '', requirement: f.requirement || '', summary: f.summary };
}

function foldGateFindings({ gateFindings, verifyRejectedIds, dismissedIds }) {
  const rejected = new Set(verifyRejectedIds || []);
  const dismissed = new Set(dismissedIds || []);
  return (gateFindings || [])
    .filter((f) => !rejected.has(f.id) && !dismissed.has(f.id))
    .map(toGateFinding);
}
```

Finally, update the `module.exports` line at the bottom of the file:

```javascript
module.exports = { CONFIG_FILENAME, loadGateConfig, foldGateFindings, carryForwardGateFindings, toGateFinding };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/concord/hooks/test/gate.test.js`
Expected: all pass, including the pre-existing `foldGateFindings`/`carryForwardGateFindings` tests (unaffected — `toGateFinding` is a pure extraction of code that was already there).

- [ ] **Step 5: Run the full suite to confirm no other test depended on the old `{enabled:true}` shape**

Run: `node --test plugins/concord/hooks/test/`
Expected: all pass. If anything outside `gate.test.js` asserted `loadGateConfig(...)` returns exactly `{enabled:true}`, fix that assertion to include `panel: false` too.

- [ ] **Step 6: Commit**

```bash
git add plugins/concord/hooks/lib/gate.js plugins/concord/hooks/test/gate.test.js
git commit -m "feat(review-gate): add gate.panel config flag and shared toGateFinding helper"
```

---

### Task 2: `lib/gate-panel.js` — pure panel state machine

**Files:**
- Create: `plugins/concord/hooks/lib/gate-panel.js`
- Test: `plugins/concord/hooks/test/gate-panel.test.js`

**Interfaces:**
- Consumes: `gate.toGateFinding` from Task 1.
- Produces:
  - `emptyGatePanel(): {status: 'idle', round: 0, dryStreak: 0, confirmed: [], rejectedIds: []}`
  - `foldPanelRound({gatePanel, roundFindings, survivedIds}): {status: 'running'|'done', round: number, dryStreak: number, confirmed: Array, rejectedIds: string[], newlyConfirmedCount: number}` — `roundFindings` is an array of raw contract-shape findings (`{id, file, span?, requirement?, summary}`, gate-contract's `parseGateFindings` output); `survivedIds` is the subset of those ids that survived this round's adversarial-verify.
  - `mergePanelIntoGate(gateFindings, panelConfirmed): Array` — both arrays already in the folded `{id, class, file, evidence, requirement, summary}` shape; dedups by id, `gateFindings` wins on collision.
- These three functions are consumed by Task 4/6 (`review-cli.js`'s `record` and `gate-panel-round-record` verbs).

- [ ] **Step 1: Write the failing tests**

Create `plugins/concord/hooks/test/gate-panel.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const gatePanel = require('../lib/gate-panel');

test('emptyGatePanel: starting state', () => {
  assert.deepStrictEqual(gatePanel.emptyGatePanel(), { status: 'idle', round: 0, dryStreak: 0, confirmed: [], rejectedIds: [] });
});

test('foldPanelRound: a survived finding is newly confirmed, folded to the gate-open shape', () => {
  const result = gatePanel.foldPanelRound({
    gatePanel: gatePanel.emptyGatePanel(),
    roundFindings: [{ id: 'gate:threat-model:sk-exposure', file: 'a.js', span: 'x', requirement: 'r', summary: 's' }],
    survivedIds: ['gate:threat-model:sk-exposure'],
  });
  assert.strictEqual(result.status, 'running'); // 1 round of real progress -- dryStreak 0, not done yet
  assert.strictEqual(result.round, 1);
  assert.strictEqual(result.dryStreak, 0);
  assert.strictEqual(result.newlyConfirmedCount, 1);
  assert.deepStrictEqual(result.confirmed, [{ id: 'gate:threat-model:sk-exposure', class: 'threat-model', file: 'a.js', evidence: 'x', requirement: 'r', summary: 's' }]);
  assert.deepStrictEqual(result.rejectedIds, []);
});

test('foldPanelRound: a finding that did not survive is added to rejectedIds, not confirmed', () => {
  const result = gatePanel.foldPanelRound({
    gatePanel: gatePanel.emptyGatePanel(),
    roundFindings: [{ id: 'gate:silent-gap:false-lead', file: 'a.js', summary: 's' }],
    survivedIds: [],
  });
  assert.strictEqual(result.newlyConfirmedCount, 0);
  assert.deepStrictEqual(result.confirmed, []);
  assert.deepStrictEqual(result.rejectedIds, ['gate:silent-gap:false-lead']);
  assert.strictEqual(result.dryStreak, 1); // zero new confirmed this round -- first dry round
});

test('foldPanelRound: dryStreak resets to 0 the moment a round confirms something new', () => {
  const afterDry = gatePanel.foldPanelRound({ gatePanel: gatePanel.emptyGatePanel(), roundFindings: [], survivedIds: [] });
  assert.strictEqual(afterDry.dryStreak, 1);
  const afterProgress = gatePanel.foldPanelRound({
    gatePanel: afterDry,
    roundFindings: [{ id: 'gate:ac-coverage:gap', file: 'b.js', summary: 's' }],
    survivedIds: ['gate:ac-coverage:gap'],
  });
  assert.strictEqual(afterProgress.dryStreak, 0);
});

test('foldPanelRound: status flips to "done" only after 2 CONSECUTIVE dry rounds (one dry round alone is not enough)', () => {
  let gp = gatePanel.emptyGatePanel();
  gp = gatePanel.foldPanelRound({ gatePanel: gp, roundFindings: [], survivedIds: [] });
  assert.strictEqual(gp.status, 'running'); // 1st dry round -- not done yet
  gp = gatePanel.foldPanelRound({ gatePanel: gp, roundFindings: [], survivedIds: [] });
  assert.strictEqual(gp.status, 'done'); // 2nd consecutive dry round -- done
  assert.strictEqual(gp.round, 2);
});

test('foldPanelRound: re-raising an already-confirmed id does not double-count or duplicate in confirmed', () => {
  let gp = gatePanel.foldPanelRound({
    gatePanel: gatePanel.emptyGatePanel(),
    roundFindings: [{ id: 'gate:threat-model:dup', file: 'a.js', summary: 's' }],
    survivedIds: ['gate:threat-model:dup'],
  });
  assert.strictEqual(gp.newlyConfirmedCount, 1);
  gp = gatePanel.foldPanelRound({
    gatePanel: gp,
    roundFindings: [{ id: 'gate:threat-model:dup', file: 'a.js', summary: 's' }], // finder re-raised the same id
    survivedIds: ['gate:threat-model:dup'],
  });
  assert.strictEqual(gp.newlyConfirmedCount, 0); // already confirmed -- not newly confirmed again
  assert.strictEqual(gp.confirmed.length, 1); // not duplicated
  assert.strictEqual(gp.dryStreak, 1); // counts as a dry round -- nothing NEW this round
});

test('mergePanelIntoGate: appends panel findings not already present by id', () => {
  const gateFindings = [{ id: 'gate:ac-coverage:existing', class: 'ac-coverage', file: 'a.js', evidence: '', requirement: '', summary: 's1' }];
  const panelConfirmed = [{ id: 'gate:threat-model:new', class: 'threat-model', file: 'b.js', evidence: '', requirement: '', summary: 's2' }];
  const out = gatePanel.mergePanelIntoGate(gateFindings, panelConfirmed);
  assert.deepStrictEqual(out.map((f) => f.id), ['gate:ac-coverage:existing', 'gate:threat-model:new']);
});

test('mergePanelIntoGate: on an id collision, the existing gate finding wins (panel entry dropped)', () => {
  const gateFindings = [{ id: 'gate:cross-context:shared', class: 'cross-context', file: 'a.js', evidence: 'gate-review version', requirement: '', summary: 's1' }];
  const panelConfirmed = [{ id: 'gate:cross-context:shared', class: 'cross-context', file: 'a.js', evidence: 'panel version', requirement: '', summary: 's2' }];
  const out = gatePanel.mergePanelIntoGate(gateFindings, panelConfirmed);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].evidence, 'gate-review version');
});

test('mergePanelIntoGate: empty panelConfirmed is a no-op', () => {
  const gateFindings = [{ id: 'gate:ac-coverage:x', class: 'ac-coverage', file: 'a.js', evidence: '', requirement: '', summary: 's' }];
  assert.deepStrictEqual(gatePanel.mergePanelIntoGate(gateFindings, []), gateFindings);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/concord/hooks/test/gate-panel.test.js`
Expected: FAIL with "Cannot find module '../lib/gate-panel'".

- [ ] **Step 3: Implement**

Create `plugins/concord/hooks/lib/gate-panel.js`:

```javascript
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
      if (!priorConfirmedIds.has(f.id)) newlyConfirmed.push(toGateFinding(f));
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
// panel's output into it, as plain data).
function mergePanelIntoGate(gateFindings, panelConfirmed) {
  const existingIds = new Set((gateFindings || []).map((f) => f.id));
  const extra = (panelConfirmed || []).filter((f) => !existingIds.has(f.id));
  return (gateFindings || []).concat(extra);
}

module.exports = { emptyGatePanel, foldPanelRound, mergePanelIntoGate };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/concord/hooks/test/gate-panel.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/hooks/lib/gate-panel.js plugins/concord/hooks/test/gate-panel.test.js
git commit -m "feat(review-gate): add lib/gate-panel.js, the panel's pure loop-until-dry state machine"
```

---

### Task 3: `decideTermination` gains the `panelPending` branch

**Files:**
- Modify: `plugins/concord/hooks/lib/review.js`
- Modify: `plugins/concord/hooks/test/review.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `decideTermination(roundOutcome)` now accepts two new optional `roundOutcome` fields, `panelConfigured` and `panelDone` (both default `false`), and can return `{..., panelPending: true}`. `applyRoundOutcome`'s ledger `status` string gains `'gate-panel-pending'`. Task 4 passes these two new fields through from `review-cli.js`'s `record` verb.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/concord/hooks/test/review.test.js`, near the other `decideTermination` tests (after the `outcome()` helper is defined around line 200):

```javascript
test('decideTermination: dod passed, zero open findings, gate.panel configured and not yet run -> panelPending (not converged)', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, panelConfigured: true, panelDone: false }));
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, panelPending: d.panelPending },
    { continue: false, converged: false, panelPending: true }
  );
});

test('decideTermination: panelConfigured but panelDone -> falls through to normal clean check, no panelPending', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, panelConfigured: true, panelDone: true }));
  assert.strictEqual(d.panelPending, undefined);
  assert.strictEqual(d.converged, true);
});

test('decideTermination: panel NOT configured -> normal clean check unaffected, no panelPending', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, panelConfigured: false }));
  assert.strictEqual(d.panelPending, undefined);
  assert.strictEqual(d.converged, true);
});

test('decideTermination: open lightweight GATE findings take priority over panelPending (gatePending wins)', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, gateOpenCount: 1, panelConfigured: true, panelDone: false }));
  assert.strictEqual(d.gatePending, true);
  assert.strictEqual(d.panelPending, undefined);
});
```

Also add, near the `applyRoundOutcome` tests (search the file for an existing `applyRoundOutcome` test to place this next to):

```javascript
test('applyRoundOutcome: panelPending decision sets ledger status to "gate-panel-pending"', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: next } = review.applyRoundOutcome(
    { ...ledger, budget: { max_rounds: 5, spent: 0 }, phase: 'fixes' },
    { dodPassed: true, findings: [], fixedIds: [], parkedIds: [], killedIds: [], panelConfigured: true, panelDone: false }
  );
  assert.strictEqual(next.status, 'gate-panel-pending');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/concord/hooks/test/review.test.js`
Expected: the four `decideTermination` tests FAIL (`panelPending` is `undefined` where `true` expected, or the panel-configured case falls through to `converged:true` incorrectly). The `applyRoundOutcome` test FAILs (`status` is `'clean'`, not `'gate-panel-pending'`).

- [ ] **Step 3: Implement**

In `plugins/concord/hooks/lib/review.js`, in `decideTermination`, replace:

```javascript
function decideTermination(roundOutcome) {
  const { dodPassed, openFindingsCount, specDoubtScope, noProgress, budgetSpent, maxRounds, fixedCount = 0, parkedCount = 0, intentReviewCount = 0, gateOpenCount = 0 } = roundOutcome;
```

with:

```javascript
function decideTermination(roundOutcome) {
  const { dodPassed, openFindingsCount, specDoubtScope, noProgress, budgetSpent, maxRounds, fixedCount = 0, parkedCount = 0, intentReviewCount = 0, gateOpenCount = 0, panelConfigured = false, panelDone = false } = roundOutcome;
```

Then replace:

```javascript
  if (dodPassed && openFindingsCount === 0 && fixedCount === 0) {
    if (gateOpenCount > 0) {
      // Convergence-boundary block: the diff-local loop is clean, but the GATE
      // still has open advisory findings. Do NOT converge; hand back for a human
      // decision. This is the ONLY place the gate gates -- never mid-loop, so the
      // correctness/DoD auto-fix flow is never halted early by a design finding.
      return { continue: false, converged: false, parked: false, abandoned: false, gatePending: true, reason: 'diff-local clean, but open GATE finding(s) need a human decision (design/AC/cross-context)' };
    }
    return { continue: false, converged: true, parked: false, abandoned: false, reason: 'DoD-exec ran and passed, zero open findings, and no fixes this round (stable)' };
  }
```

with:

```javascript
  if (dodPassed && openFindingsCount === 0 && fixedCount === 0) {
    if (gateOpenCount > 0) {
      // Convergence-boundary block: the diff-local loop is clean, but the GATE
      // still has open advisory findings. Do NOT converge; hand back for a human
      // decision. This is the ONLY place the gate gates -- never mid-loop, so the
      // correctness/DoD auto-fix flow is never halted early by a design finding.
      return { continue: false, converged: false, parked: false, abandoned: false, gatePending: true, reason: 'diff-local clean, but open GATE finding(s) need a human decision (design/AC/cross-context)' };
    }
    // Convergence-boundary hook for the holistic GATE panel (spec:
    // 2026-07-15-gate-holistic-panel-design.md decision 4): the panel is
    // expensive (measured ~1.9M tokens/round average), so it triggers
    // exactly once, only once everything else that would keep changing the
    // diff has already gone quiet -- never speculatively on a round that
    // still has open findings. panelDone is sticky per convergence attempt,
    // so a repeat record() call after the panel finishes falls through to
    // the normal clean check below instead of looping the panel forever.
    if (panelConfigured && !panelDone) {
      return { continue: false, converged: false, parked: false, abandoned: false, panelPending: true, reason: 'diff-local clean and no open GATE findings, but the holistic GATE panel has not run yet this convergence attempt' };
    }
    return { continue: false, converged: true, parked: false, abandoned: false, reason: 'DoD-exec ran and passed, zero open findings, and no fixes this round (stable)' };
  }
```

Next, in `applyRoundOutcome`, replace:

```javascript
  const decision = decideTermination({
    dodPassed: !!outcome.dodPassed,
    openFindingsCount,
    specDoubtScope: outcome.specDoubtScope || 'none',
    noProgress,
    budgetSpent: ledger.budget.spent,
    maxRounds: ledger.budget.max_rounds,
    fixedCount: (outcome.fixedIds || []).length, // COUNT, not the in-scope Set named fixedIds
    parkedCount: (outcome.parkedIds || []).length, // COUNT, not the in-scope Set named parkedIds
    intentReviewCount: outcome.intentReviewCount || 0,
    gateOpenCount: outcome.gateOpenCount || 0,
  });
```

with:

```javascript
  const decision = decideTermination({
    dodPassed: !!outcome.dodPassed,
    openFindingsCount,
    specDoubtScope: outcome.specDoubtScope || 'none',
    noProgress,
    budgetSpent: ledger.budget.spent,
    maxRounds: ledger.budget.max_rounds,
    fixedCount: (outcome.fixedIds || []).length, // COUNT, not the in-scope Set named fixedIds
    parkedCount: (outcome.parkedIds || []).length, // COUNT, not the in-scope Set named parkedIds
    intentReviewCount: outcome.intentReviewCount || 0,
    gateOpenCount: outcome.gateOpenCount || 0,
    panelConfigured: !!outcome.panelConfigured,
    panelDone: !!outcome.panelDone,
  });
```

Finally, replace the `status` line:

```javascript
  const status = decision.converged ? 'clean' : decision.parked ? 'parked' : decision.abandoned ? 'abandoned' : decision.intentReview ? 'intent-review' : decision.gatePending ? 'gate-pending' : 'converging';
```

with:

```javascript
  const status = decision.converged ? 'clean' : decision.parked ? 'parked' : decision.abandoned ? 'abandoned' : decision.intentReview ? 'intent-review' : decision.gatePending ? 'gate-pending' : decision.panelPending ? 'gate-panel-pending' : 'converging';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/concord/hooks/test/review.test.js`
Expected: all pass, including every pre-existing `decideTermination`/`applyRoundOutcome` test (the new params default to `false`, so the added branch is unreachable unless a caller explicitly opts in).

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/hooks/lib/review.js plugins/concord/hooks/test/review.test.js
git commit -m "feat(review-gate): decideTermination gains the panelPending convergence-boundary branch"
```

---

### Task 4: wire panel config + merge into `review-cli.js`'s `record` verb

**Files:**
- Modify: `plugins/concord/hooks/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

**Interfaces:**
- Consumes: `gateLib.loadGateConfig` (existing), `gatePanelLib.mergePanelIntoGate` (Task 2), `review.decideTermination`'s new `panelConfigured`/`panelDone` fields (Task 3).
- Produces: `record <ref>`'s stdout JSON `decision` object now includes `panelPending: true` on the round where the panel should run, and (after the panel finishes) folds `ledger.gate_panel.confirmed` into `ledger.gate_open` before computing the final decision.

- [ ] **Step 1: Write the failing test**

Add to `plugins/concord/hooks/test/review-cli.test.js`, near the other `record`-related tests:

```javascript
test('record: gate.panel enabled and diff-local + lightweight-gate clean -> panelPending, not converged', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  const planOut = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(planOut.fixes, []);
  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec.decision.panelPending, true);
  assert.strictEqual(rec.decision.converged, false);
});

test('record: gate.panel enabled but NOT configured (absent gate.panel) -> converges clean as before (no behavior change)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec.decision.converged, true);
  assert.strictEqual(rec.decision.panelPending, undefined);
});

test('record: after gate_panel.status is "done" with a confirmed finding, record merges it into gate_open -> gatePending, not clean', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const rec1 = JSON.parse(run(['record', 'feat/x'], { env })); // -> panelPending, phase flips to 'done'
  assert.strictEqual(rec1.decision.panelPending, true);

  // Simulate the panel having already converged with one confirmed finding
  // (Task 6 covers actually driving this state via the CLI verbs) --
  // directly seed the ledger state record() is contracted to read.
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = {
    ...ledger,
    phase: 'fixes', // reverted by gate-panel-round-record when the panel finishes (Task 6)
    gate_panel: {
      status: 'done', round: 2, dryStreak: 2,
      confirmed: [{ id: 'gate:threat-model:sk-exposure', class: 'threat-model', file: 'a.txt', evidence: '', requirement: '', summary: 'a real gap the panel found' }],
      rejectedIds: [],
    },
  };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);

  const rec2 = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec2.decision.panelPending, undefined);
  assert.strictEqual(rec2.decision.gatePending, true);
  const finalLedger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(finalLedger.gate_open.map((f) => f.id), ['gate:threat-model:sk-exposure']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: all three new tests FAIL — the first two because `decision.panelPending` is always `undefined` (record doesn't know about `gate.panel` yet), the third because `gate_open` never gets the panel's finding merged in (stays `[]`, so `rec2.decision.converged` is `true` instead of `gatePending`).

- [ ] **Step 3: Implement**

At the top of `plugins/concord/hooks/review-cli.js`, add the new lib import next to the existing `gateLib` require:

```javascript
const gateLib = require('./lib/gate');
const gatePanelLib = require('./lib/gate-panel');
```

In the `record` verb body, replace:

```javascript
    const cJson = readArtifact(stateDir, n, 'correctness');
    const vJson = readArtifact(stateDir, n, 'verify');
    requireArtifactAfter(stateDir, n, 'correctness', 'verify');
    const candidates = gc.parseGateFindings(JSON.stringify(cJson.findings || []));
    const killedIds = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates).rejectedIds;
```

with:

```javascript
    const cJson = readArtifact(stateDir, n, 'correctness');
    const vJson = readArtifact(stateDir, n, 'verify');
    requireArtifactAfter(stateDir, n, 'correctness', 'verify');
    const candidates = gc.parseGateFindings(JSON.stringify(cJson.findings || []));
    const killedIds = gc.parseVerifyVerdict(JSON.stringify({ rejected: vJson.rejected || [] }), candidates).rejectedIds;

    // Holistic GATE panel (spec: 2026-07-15-gate-holistic-panel-design.md):
    // once the panel has finished (gate-panel-round-record set gate_panel.status
    // to 'done' and reverted phase to 'fixes' so this call could even happen),
    // fold its confirmed findings into gate_open BEFORE computing gateOpenCount
    // below -- same merge every repeat call, mergePanelIntoGate is idempotent
    // by construction (dedup by id).
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    let gateOpen = ledger.gate_open || [];
    if (ledger.gate_panel && ledger.gate_panel.status === 'done') {
      gateOpen = gatePanelLib.mergePanelIntoGate(gateOpen, ledger.gate_panel.confirmed || []);
      ledger = { ...ledger, gate_open: gateOpen };
    }
```

Then replace the `outcome` object:

```javascript
    const outcome = { dodPassed: !!(ledger.dod && ledger.dod.passed), findings: candidates, fixedIds, parkedIds, killedIds, specDoubtScope: 'none', fixCommits, parkReasons, intentReviewCount: (ledger.intent_parked || []).length, gateOpenCount: (ledger.gate_open || []).length };
```

with:

```javascript
    const outcome = {
      dodPassed: !!(ledger.dod && ledger.dod.passed), findings: candidates, fixedIds, parkedIds, killedIds, specDoubtScope: 'none', fixCommits, parkReasons,
      intentReviewCount: (ledger.intent_parked || []).length,
      gateOpenCount: gateOpen.length,
      panelConfigured: !!(gateCfg && gateCfg.panel),
      panelDone: !!(ledger.gate_panel && ledger.gate_panel.status === 'done'),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: all pass, including the 3 new tests and every pre-existing `record` test (repos without `gate.panel` configured get `panelConfigured: false`, so `decideTermination`'s new branch never triggers for them — identical behavior to before this task).

- [ ] **Step 5: Run the full suite**

Run: `node --test plugins/concord/hooks/test/`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/concord/hooks/review-cli.js plugins/concord/hooks/test/review-cli.test.js
git commit -m "feat(review-gate): record verb wires gate.panel config and merges panel findings into gate_open"
```

---

### Task 5: `gate-panel-round-start` verb

**Files:**
- Modify: `plugins/concord/hooks/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

**Interfaces:**
- Consumes: `gateLib.loadGateConfig`, `gatePanelLib.emptyGatePanel` (Task 2).
- Produces: CLI verb `gate-panel-round-start <ref>` -> stdout JSON `{round: number, rejectedIds: string[], stateDir: string}`. Read-only (writes nothing to the ledger) — Task 6's `gate-panel-round-record` is the only verb that mutates `gate_panel`.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/concord/hooks/test/review-cli.test.js`:

```javascript
test('gate-panel-round-start: gate.panel not configured -> harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  assert.throws(() => run(['gate-panel-round-start', 'feat/x'], { env }), /harness-failure/);
});

test('gate-panel-round-start: first call -> round 1, empty rejectedIds', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  const out = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(out.round, 1);
  assert.deepStrictEqual(out.rejectedIds, []);
  assert.strictEqual(out.stateDir, dir);
});

test('gate-panel-round-start: reports the NEXT round number and the accumulated rejectedIds from ledger.gate_panel', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = { ...ledger, gate_panel: { status: 'running', round: 2, dryStreak: 1, confirmed: [], rejectedIds: ['gate:threat-model:false-lead'] } };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);
  const out = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(out.round, 3);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:false-lead']);
});

test('gate-panel-round-start: panel already "done" -> harness-failure (call record, not another panel round)', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = { ...ledger, gate_panel: { status: 'done', round: 2, dryStreak: 2, confirmed: [], rejectedIds: [] } };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);
  assert.throws(() => run(['gate-panel-round-start', 'feat/x'], { env }), /harness-failure/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: all 4 new tests FAIL with `review-cli: unknown verb "gate-panel-round-start"`.

- [ ] **Step 3: Implement**

In `plugins/concord/hooks/review-cli.js`, add a new verb block. Insert it right after the closing `}` of the `show` verb block (before the `round-start` block), so the ordering in the file matches the ordering of the eventual usage-string update in Task 7:

```javascript
  if (verb === 'gate-panel-round-start') {
    requireRef(ref, 'gate-panel-round-start');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    if (!gateCfg || !gateCfg.panel) throw new Error('harness-failure: gate-panel-round-start: gate.panel is not enabled in review.config.json');
    const slug = targetSlug(ref);
    const ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`harness-failure: gate-panel-round-start: no ledger for ref "${ref}"`);
    const gp = ledger.gate_panel || gatePanelLib.emptyGatePanel();
    if (gp.status === 'done') throw new Error('harness-failure: gate-panel-round-start: the panel already finished this convergence attempt -- call record, not another panel round');
    const round = (gp.round || 0) + 1;
    process.stdout.write(JSON.stringify({ round, rejectedIds: gp.rejectedIds || [], stateDir }) + '\n');
    return;
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: all 4 new tests pass, plus the full pre-existing suite.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/hooks/review-cli.js plugins/concord/hooks/test/review-cli.test.js
git commit -m "feat(review-gate): add gate-panel-round-start verb"
```

---

### Task 6: `gate-panel-round-record` verb

**Files:**
- Modify: `plugins/concord/hooks/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

**Interfaces:**
- Consumes: `gc.parseGateFindings` (`lib/gate-contract.js`, existing), `gatePanelLib.foldPanelRound` (Task 2).
- Produces: CLI verb `gate-panel-round-record <ref>` -> stdout JSON `{status: 'running'|'done', round, dryStreak, newlyConfirmedCount, rejectedIds}`. Reads `round-<n>-gate-panel-<m>-<lens>.json` for each of 5 lenses and `round-<n>-gate-panel-<m>-verify.json`; writes `ledger.gate_panel`, and on `status: 'done'` also reverts `ledger.phase` to `'fixes'` so a subsequent `record <ref>` call (Task 4) passes its phase guard instead of hitting the done-idempotency short-circuit from the earlier `panelPending` call.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/concord/hooks/test/review-cli.test.js`:

```javascript
function seedPanelRoundConfig(repo) {
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
}

test('gate-panel-round-record: gate.panel not configured -> harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure/);
});

test('gate-panel-round-record: a lens finding that survives verify is confirmed; status stays "running" (only 1 round in)', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:sk-exposure', file: 'a.txt', span: '', requirement: '', summary: 'a real gap' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-ac-coverage.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-design-conformance.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-cross-context.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-silent-gap.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.status, 'running');
  assert.strictEqual(out.round, 1);
  assert.strictEqual(out.newlyConfirmedCount, 1);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(ledger.gate_panel.confirmed.map((f) => f.id), ['gate:threat-model:sk-exposure']);
});

test('gate-panel-round-record: a lens finding rejected by verify is NOT confirmed and appears in rejectedIds', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:false-lead', file: 'a.txt', summary: 'not actually real' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: ['gate:threat-model:false-lead'] }));
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:false-lead']);
});

test('gate-panel-round-record: missing verify artifact -> nothing survives (fail-closed toward not-confirming)', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:unverified', file: 'a.txt', summary: 'no verify ran' }] }));
  // no round-<n>-gate-panel-1-verify.json written at all
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:unverified']);
});

test('gate-panel-round-record: a missing/malformed lens file contributes zero findings, not a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  // No lens files at all, no verify file.
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.status, 'running'); // 1st dry round -- not an error
  assert.strictEqual(out.newlyConfirmedCount, 0);
});

test('gate-panel-round-record: a finding whose id class does not match its lens filename is a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:ac-coverage:mislabeled', file: 'a.txt', summary: 'wrong lens' }] }));
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure/);
});

test('gate-panel-round-record: a finding whose id was already human-dismissed is dropped before verify, never confirmed', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = { ...ledger, gate_dismissed: ['gate:threat-model:already-dismissed'] };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:already-dismissed', file: 'a.txt', summary: 'a human already dismissed this' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] })); // would survive verify if it reached it
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  const finalLedger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(finalLedger.gate_panel.confirmed, []);
});

test('gate-panel-round-record: two consecutive dry rounds -> status "done" and ledger.phase reverts to "fixes"', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['record', 'feat/x'], { env }); // -> panelPending, phase flips to 'done'

  run(['gate-panel-round-start', 'feat/x'], { env }); // round 1
  const out1 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env })); // no findings -- dry round 1
  assert.strictEqual(out1.status, 'running');

  run(['gate-panel-round-start', 'feat/x'], { env }); // round 2
  const out2 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env })); // dry round 2 -- done
  assert.strictEqual(out2.status, 'done');

  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.phase, 'fixes');
  assert.strictEqual(ledger.gate_panel.status, 'done');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: all new tests FAIL with `review-cli: unknown verb "gate-panel-round-record"`.

- [ ] **Step 3: Implement**

In `plugins/concord/hooks/review-cli.js`, add a module-level constant right after the existing top-level requires (near `function resolveStateDir()`):

```javascript
const GATE_PANEL_LENSES = ['ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model'];
```

Then add the verb block, right after the `gate-panel-round-start` block from Task 5:

```javascript
  if (verb === 'gate-panel-round-record') {
    requireRef(ref, 'gate-panel-round-record');
    const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
    const gc = require('./lib/gate-contract');
    const gateCfg = gateLib.loadGateConfig(repoRoot);
    if (!gateCfg || !gateCfg.panel) throw new Error('harness-failure: gate-panel-round-record: gate.panel is not enabled in review.config.json');
    const slug = targetSlug(ref);
    let ledger = readLedger(stateDir, slug);
    if (!ledger) throw new Error(`harness-failure: gate-panel-round-record: no ledger for ref "${ref}"`);
    const gp = ledger.gate_panel || gatePanelLib.emptyGatePanel();
    if (gp.status === 'done') throw new Error('harness-failure: gate-panel-round-record: the panel already finished this convergence attempt');
    const n = ledger.round;
    const m = (gp.round || 0) + 1;

    // Each lens is read leniently (missing/malformed -> zero findings this
    // round) -- a single flaky lens subagent must not blow up a
    // multi-million-token panel round. Contrast with correctness/verify's
    // fail-closed readArtifact: those gate an auto-fixing loop where a
    // manufactured "zero findings" is dangerous; the panel is report-only
    // and self-verifying, so a missing lens just means fewer candidates.
    let allCandidates = [];
    for (const lens of GATE_PANEL_LENSES) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-gate-panel-${m}-${lens}.json`), 'utf8'));
      } catch (e) {
        continue;
      }
      let findings;
      try {
        findings = gc.parseGateFindings(JSON.stringify(raw.findings || []));
      } catch (e) {
        continue; // malformed lens output -- treated as zero findings, not a harness-failure
      }
      for (const f of findings) {
        const seg = f.id.split(':');
        if (seg[1] !== lens) {
          throw new Error(`harness-failure: gate-panel-round-record: finding "${f.id}" from the "${lens}" lens file must use the "${lens}" class in its id`);
        }
      }
      allCandidates = allCandidates.concat(findings);
    }

    // A human-dismissed id (review-cli.js dismiss verb, existing gate_dismissed
    // set) must never re-enter the panel's confirmed set -- mergePanelIntoGate
    // (lib/gate-panel.js) only dedupes against the CURRENT gate_open, it does
    // not know about gate_dismissed, so a dismissed finding a lens re-raises
    // would otherwise silently reappear once the panel completes. Drop it here,
    // at the earliest point it's known, same as foldGateFindings/
    // carryForwardGateFindings already do for the lightweight GATE (lib/gate.js).
    const dismissed = new Set(ledger.gate_dismissed || []);
    allCandidates = allCandidates.filter((f) => !dismissed.has(f.id));

    // The verify pass is the opposite lenience direction: missing/malformed
    // means nothing is confirmed to have survived, NOT that everything
    // survived -- promoting unverified findings by default would defeat the
    // entire point of an adversarial-verify pass (distrust-green).
    let survivedIds;
    try {
      const vRaw = JSON.parse(fs.readFileSync(path.join(stateDir, `round-${n}-gate-panel-${m}-verify.json`), 'utf8'));
      const rejected = new Set(Array.isArray(vRaw.rejected) ? vRaw.rejected : []);
      survivedIds = allCandidates.map((f) => f.id).filter((id) => !rejected.has(id));
    } catch (e) {
      survivedIds = []; // missing/malformed verify artifact -- nothing survives this round
    }

    const result = gatePanelLib.foldPanelRound({ gatePanel: gp, roundFindings: allCandidates, survivedIds });
    ledger = { ...ledger, gate_panel: result };
    if (result.status === 'done') {
      // Revert phase so a subsequent `record` call passes its `phase ===
      // 'fixes'` guard and re-runs normally instead of hitting record's
      // done-idempotency short-circuit left over from the earlier
      // panelPending call (Task 4).
      ledger = { ...ledger, phase: 'fixes' };
    }
    writeLedger(stateDir, slug, ledger);
    process.stdout.write(JSON.stringify({ status: result.status, round: result.round, dryStreak: result.dryStreak, newlyConfirmedCount: result.newlyConfirmedCount, rejectedIds: result.rejectedIds }) + '\n');
    return;
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: all new tests pass, plus the full pre-existing suite.

- [ ] **Step 5: Commit**

```bash
git add plugins/concord/hooks/review-cli.js plugins/concord/hooks/test/review-cli.test.js
git commit -m "feat(review-gate): add gate-panel-round-record verb"
```

---

### Task 7: usage-error message + verb list

**Files:**
- Modify: `plugins/concord/hooks/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — cosmetic/discoverability only.

- [ ] **Step 1: Write the failing test**

Add to `plugins/concord/hooks/test/review-cli.test.js`:

```javascript
test('review-cli: unknown verb error message lists the two new gate-panel verbs', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const { stderr, status } = runCapture(['bogus-verb'], { env });
  assert.notStrictEqual(status, 0);
  assert.match(stderr, /gate-panel-round-start/);
  assert.match(stderr, /gate-panel-round-record/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: FAIL — the current unknown-verb message doesn't mention either new verb.

- [ ] **Step 3: Implement**

Find and replace the unknown-verb error at the bottom of `main()`:

```javascript
  throw new Error(`review-cli: unknown verb "${verb}" (expected show | round-start | plan-fixes | commit-fix | record | unpark | dismiss | reset)`);
```

with:

```javascript
  throw new Error(`review-cli: unknown verb "${verb}" (expected show | round-start | plan-fixes | commit-fix | record | gate-panel-round-start | gate-panel-round-record | unpark | dismiss | reset)`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: pass.

- [ ] **Step 5: Run the full suite**

Run: `node --test plugins/concord/hooks/test/`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/concord/hooks/review-cli.js plugins/concord/hooks/test/review-cli.test.js
git commit -m "chore(review-gate): list the gate-panel verbs in the unknown-verb usage message"
```

---

### Task 8: end-to-end integration test (full panel cycle through the public CLI surface)

**Files:**
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing new — this is a regression-locking test exercising the full `round-start` -> `plan-fixes` -> `record` (panelPending) -> `gate-panel-round-start`/`gate-panel-round-record` loop -> `record` (final) sequence through the CLI's actual stdout/exit-code surface, not internal function calls. This is the test that would have caught an integration seam Tasks 1-7's narrower tests miss (e.g. a mismatched field name between `gate-panel-round-record`'s output and what the next `gate-panel-round-start` call reads back from the ledger).

- [ ] **Step 1: Write the test**

Add to `plugins/concord/hooks/test/review-cli.test.js`:

```javascript
test('e2e: gate.panel enabled -- full cycle: record signals panelPending, 3 panel rounds converge (1 confirmed then 2 dry), final record merges into gate_open', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));

  const planOut = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(planOut.fixes, []); // nothing to fix -- would otherwise go clean

  const rec1 = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec1.decision.panelPending, true);

  // Panel round 1: the threat-model lens raises a real finding, verify lets it survive.
  const start1 = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(start1.round, 1);
  assert.deepStrictEqual(start1.rejectedIds, []);
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:sk-exposure', file: 'a.txt', span: '', requirement: '', summary: 'a real gap' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const round1 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(round1.status, 'running'); // real progress -- dryStreak reset to 0

  // Panel round 2: nothing new -- 1st dry round. rejectedIds carries forward from round 1 (empty here).
  const start2 = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(start2.round, 2);
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-2-threat-model.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-2-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const round2 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(round2.status, 'running'); // 1 dry round so far -- needs 2 consecutive

  // Panel round 3: still nothing -- 2nd consecutive dry round -> done.
  const start3 = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(start3.round, 3);
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-3-threat-model.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-3-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const round3 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(round3.status, 'done');

  // record again -- panel is done, its confirmed finding merges into gate_open -> gate-pending, not clean.
  const rec2 = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec2.decision.panelPending, undefined);
  assert.strictEqual(rec2.decision.gatePending, true);
  const finalLedger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(finalLedger.gate_open.map((f) => f.id), ['gate:threat-model:sk-exposure']);
  assert.strictEqual(finalLedger.status, 'gate-pending');
});
```

- [ ] **Step 2: Run the test**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: PASS immediately (Tasks 1-7 already implement everything this test exercises). If it fails, that means Tasks 1-7 have an integration seam their own narrower tests didn't catch — fix the implementation, not the test, unless the test itself has a bug.

- [ ] **Step 3: Run the full suite one more time**

Run: `node --test plugins/concord/hooks/test/`
Expected: all pass (should now be the pre-existing 69 + all tests added across Tasks 1-8).

- [ ] **Step 4: Commit**

```bash
git add plugins/concord/hooks/test/review-cli.test.js
git commit -m "test(review-gate): end-to-end coverage for the full gate-panel cycle through the CLI surface"
```

---

### Task 9: `review-until-green.md` — panel execution model

**Files:**
- Modify: `plugins/concord/commands/review-until-green.md`

**Interfaces:**
- Consumes: the two new verbs from Tasks 5-6 and `decision.panelPending` from Task 4 (prose-only task — no code interface).
- Produces: nothing machine-checkable. Self-review this task's prose against the same "wait for the file" cross-referencing convention PR #32 already established (`plugins/concord/commands/review-until-green.md:20,32`) — new prose introducing a similar ordering constraint (finder subagents must finish before their adversarial-verify subagents run) should follow the same pattern, not invent new wording for the same concept.

- [ ] **Step 1: Add the panelPending bullet to step 6**

In `plugins/concord/commands/review-until-green.md`, find:

```
6. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" record <ref>` -> `{ decision, handoff }`.
   - `decision.continue: true` -> go to step 1 for the next round.
   - If `record` returns `decision.intentReview`, print the handoff and stop: the run found changed lines that contradict stated requirements. These are reported, never auto-fixed. Resolve by editing the code (or correcting the design source) and re-running `/review-until-green <ref>`; the re-run re-fetches the intent and re-reviews. A finding you judge a false positive needs no command -- read it, and merge by hand if you choose (concord never merges anything itself).
   - If `record` returns `decision.gatePending`, print the handoff and stop: the diff-local loop is clean, but the GATE has open advisory findings (design/AC/cross-context) for a human. These are never auto-fixed. Resolve by fixing the code or the design source and re-running `/review-until-green <ref>` (a fresh run re-evaluates the gate), or, for a finding you accept as out-of-scope/deferred, `review-cli.js dismiss <ref> <gateId>` so it stops surfacing. `gate-pending`, like a parked ledger, does not auto-clear -- re-run or dismiss.
   - Otherwise, `decision.continue: false` -> print the `handoff` verbatim and stop.
```

Replace with:

```
6. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" record <ref>` -> `{ decision, handoff }`.
   - `decision.continue: true` -> go to step 1 for the next round.
   - If `record` returns `decision.intentReview`, print the handoff and stop: the run found changed lines that contradict stated requirements. These are reported, never auto-fixed. Resolve by editing the code (or correcting the design source) and re-running `/review-until-green <ref>`; the re-run re-fetches the intent and re-reviews. A finding you judge a false positive needs no command -- read it, and merge by hand if you choose (concord never merges anything itself).
   - If `record` returns `decision.gatePending`, print the handoff and stop: the diff-local loop is clean, but the GATE has open advisory findings (design/AC/cross-context) for a human. These are never auto-fixed. Resolve by fixing the code or the design source and re-running `/review-until-green <ref>` (a fresh run re-evaluates the gate), or, for a finding you accept as out-of-scope/deferred, `review-cli.js dismiss <ref> <gateId>` so it stops surfacing. `gate-pending`, like a parked ledger, does not auto-clear -- re-run or dismiss.
   - If `record` returns `decision.panelPending`, the diff-local loop and the lightweight GATE are both clean, but this repo has the holistic GATE panel enabled (`gate.panel: true` in `review.config.json`) and it has not run yet this convergence attempt. Do NOT stop -- run the panel now, in THIS session, then call `record` again:
     a. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" gate-panel-round-start <ref>` -> `{ round: m, rejectedIds: [...], stateDir }`.
     b. Spawn 5 lens subagents in PARALLEL (Task tool, general-purpose, clean context each), one per class: `ac-coverage`, `design-conformance`, `cross-context`, `silent-gap`, `threat-model`. Each MAY Read/Grep the whole repository and MUST read `intent-<slug>.md` if present, same access as gate-review above. Tell each one the `rejectedIds` list from step (a) verbatim: "these were already raised and rejected in an earlier round without new evidence -- do not re-raise them unless you have found something the earlier round didn't." Each writes ONLY `{ "status":"ok", "findings":[ {"id":"gate:<lens>:<slug>","file":"<path, may be unchanged>","span":"<anchor>","requirement":"<the design/AC text it fails, if any>","summary":"<one sentence>"} ] }` to `<stateDir>/round-<n>-gate-panel-<m>-<lens>.json` -- `<lens>` MUST be the exact class name this subagent was assigned (`gate-panel-round-record` rejects a mismatch as a harness-failure).
     c. Only after ALL 5 lens subagents from step (b) have finished -- never in parallel with them, since verify's input is their combined output, the same "wait for the file" pattern as correctness -> verify (step 3) and gate-review -> gate-verify above -- for EACH candidate finding they raised, spawn 3 independent adversarial-verify subagents (clean context, prompted to REFUTE the finding, default to "refuted" if uncertain) and take the majority vote. Write ONLY `{ "status":"ok", "rejected":["<id>", ...] }` (the ids that did NOT get a majority "survives" vote) to `<stateDir>/round-<n>-gate-panel-<m>-verify.json`.
     d. `node "${CLAUDE_PLUGIN_ROOT}/hooks/review-cli.js" gate-panel-round-record <ref>` -> `{ status: "running"|"done", round, dryStreak, newlyConfirmedCount, rejectedIds }`.
     e. If `status: "running"`, go back to (a) for the next panel round -- do not track round numbers or the rejected-ids list yourself, `gate-panel-round-start` reports both fresh each time. If `status: "done"` (2 consecutive rounds contributed nothing new), the panel has converged: call `record <ref>` again (back to the top of this step); it folds the panel's confirmed findings into the normal GATE flow and returns a real terminal decision (`clean` or `gatePending`), never `panelPending` again for this convergence attempt.
   - Otherwise, `decision.continue: false` -> print the `handoff` verbatim and stop.
```

- [ ] **Step 2: Verify no test depends on the exact prose (none do -- this file is not parsed by any test)**

Run: `grep -rn "review-until-green.md" plugins/concord/hooks/test/`
Expected: no output (confirmed already true as of PR #32 — re-verify it's still true after this edit, since the edit only touched the `.md` file, not any test).

- [ ] **Step 3: Run the full test suite as a final sanity check**

Run: `node --test plugins/concord/hooks/test/`
Expected: all pass (this task touched no code).

- [ ] **Step 4: Commit**

```bash
git add plugins/concord/commands/review-until-green.md
git commit -m "docs(review-gate): add the holistic GATE panel execution model to review-until-green.md step 6"
```

---

### Task 10: report panel round/confirmed count in the handoff

**Files:**
- Modify: `plugins/concord/hooks/review-cli.js`
- Modify: `plugins/concord/hooks/test/review-cli.test.js`

**Interfaces:**
- Consumes: `ledger.gate_panel` (Task 2/6).
- Produces: nothing new — extends `renderHandoff`'s output string. Note a deliberate scope narrowing versus spec decision 9: the design says the handoff should report "round count, total tokens, confirmed-finding count". `review-cli.js` has no visibility into subagent token usage at all -- that data exists only in the orchestrating session's Task-tool results, never written to any file the CLI reads. This task reports round count + confirmed count (both real ledger data) and explicitly does NOT attempt a tokens field; inventing one from data the CLI doesn't have would be worse than omitting it.

- [ ] **Step 1: Write the failing test**

Add to `plugins/concord/hooks/test/review-cli.test.js`, reusing the same setup shape as the Task 8 e2e test but only through to a single confirmed finding (no need to re-run the full dry-round sequence -- this test is about the handoff string, not the convergence mechanics Task 8 already covers):

```javascript
test('renderHandoff (via record): reports GATE panel round count and confirmed count once the panel is done', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  run(['record', 'feat/x'], { env }); // -> panelPending

  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = {
    ...ledger,
    phase: 'fixes',
    gate_panel: {
      status: 'done', round: 3, dryStreak: 2,
      confirmed: [{ id: 'gate:threat-model:sk-exposure', class: 'threat-model', file: 'a.txt', evidence: '', requirement: '', summary: 's' }],
      rejectedIds: [],
    },
  };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);

  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(rec.handoff, /GATE panel: 3 round\(s\), 1 confirmed/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: FAIL — `rec.handoff` has no "GATE panel" line yet.

- [ ] **Step 3: Implement**

In `plugins/concord/hooks/review-cli.js`, in `renderHandoff`, find:

```javascript
  const gateOpen = ledger.gate_open || [];
  if (gateOpen.length) {
```

Replace with:

```javascript
  if (ledger.gate_panel && ledger.gate_panel.status === 'done' && ledger.gate_panel.round > 0) {
    lines.push(`GATE panel: ${ledger.gate_panel.round} round(s), ${(ledger.gate_panel.confirmed || []).length} confirmed`);
  }
  const gateOpen = ledger.gate_open || [];
  if (gateOpen.length) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test plugins/concord/hooks/test/review-cli.test.js`
Expected: pass, plus the full pre-existing suite (the new line only appears when `gate_panel.status === 'done'`, which no pre-existing test's ledger has -- `gate_panel` is `undefined` for every ledger created before this plan).

- [ ] **Step 5: Run the full suite**

Run: `node --test plugins/concord/hooks/test/`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/concord/hooks/review-cli.js plugins/concord/hooks/test/review-cli.test.js
git commit -m "feat(review-gate): report GATE panel round/confirmed count in the handoff"
```

---

## Post-plan note

This plan implements the panel's mechanics (opt-in config, 5-lens fan-out, CLI-owned loop-until-dry, merge into the existing GATE contract) but deliberately leaves the three items the design spec already flagged as open/deferred:

- Exact adversarial-verify vote count/quorum (this plan hardcodes 3 skeptics/majority in the `.md` prompt text, matching the measured practice — not configurable).
- `gate.panel` as a plain boolean only, no lens-subset option.
- No interaction changes with the intent detector (unaffected, confirmed by Task 9's diff touching only the `record` bullet list).

Do not add these without a new brainstorming pass -- YAGNI until a real repo needs them.
