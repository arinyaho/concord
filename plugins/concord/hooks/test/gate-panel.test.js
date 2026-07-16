'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const gatePanel = require('../../core/gate-panel');

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

test('mergePanelIntoGate: a panel-confirmed id already in dismissedIds is dropped, not merged in', () => {
  const gateFindings = [];
  const panelConfirmed = [
    { id: 'gate:threat-model:already-dismissed', class: 'threat-model', file: 'a.js', evidence: '', requirement: '', summary: 's1' },
    { id: 'gate:threat-model:still-live', class: 'threat-model', file: 'b.js', evidence: '', requirement: '', summary: 's2' },
  ];
  const out = gatePanel.mergePanelIntoGate(gateFindings, panelConfirmed, ['gate:threat-model:already-dismissed']);
  assert.deepStrictEqual(out.map((f) => f.id), ['gate:threat-model:still-live']);
});

test('foldPanelRound: two roundFindings entries sharing the same id, both surviving, produce only ONE confirmed entry', () => {
  const result = gatePanel.foldPanelRound({
    gatePanel: gatePanel.emptyGatePanel(),
    roundFindings: [
      { id: 'gate:threat-model:dup-in-round', file: 'a.js', summary: 's' },
      { id: 'gate:threat-model:dup-in-round', file: 'a.js', summary: 's' },
    ],
    survivedIds: ['gate:threat-model:dup-in-round'],
  });
  assert.strictEqual(result.newlyConfirmedCount, 1);
  assert.strictEqual(result.confirmed.length, 1);
});
