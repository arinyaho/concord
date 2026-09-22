'use strict';
// Demonstrates the scenario named by the "워크트리 재시작 시 조사 손실 방지" ticket item: a
// worktree-isolated investigative subagent (Agent tool, isolation: "worktree") loses its
// worktree and is relaunched or resumed. Without guidance, the resumed subagent has no
// record of what the prior run already found and re-runs the same expensive sweep from
// scratch. With the "Investigation reuse on relaunch" discipline in
// initiative-to-prs/references/handoff-contract.md, the orchestrator hands the resumed
// subagent the prior run's conclusion first, and the subagent only re-sweeps when that
// conclusion is missing, stale, or contradicted.
//
// This does not drive a real LLM; it models the two policies mechanically so the
// before/after reduction in sweep re-runs is deterministic and repo-local.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const HANDOFF_CONTRACT = path.join(REPO, 'plugins/concord/skills/initiative-to-prs/references/handoff-contract.md');

const SWEEP_COST = 40; // grep calls a from-scratch terminology sweep costs, as observed

function relaunchSubagent({ reuseFindings, priorConclusion }) {
  let sweepCalls = 0;
  function sweep() {
    sweepCalls += SWEEP_COST;
    return 'conclusion from a fresh sweep';
  }

  let conclusion;
  if (reuseFindings && priorConclusion) {
    conclusion = priorConclusion; // orchestrator handed forward the earlier notification's result
  } else {
    conclusion = sweep(); // resumed blind: redo the whole sweep
  }

  return { sweepCalls, conclusion };
}

test('a blind relaunch re-runs the full sweep even though it already ran once', () => {
  const first = relaunchSubagent({ reuseFindings: false, priorConclusion: null });
  const second = relaunchSubagent({ reuseFindings: false, priorConclusion: first.conclusion });
  assert.equal(first.sweepCalls, SWEEP_COST);
  assert.equal(second.sweepCalls, SWEEP_COST); // redone from scratch, same cost twice
});

test('handing forward the prior conclusion avoids repeating the sweep on relaunch', () => {
  const first = relaunchSubagent({ reuseFindings: false, priorConclusion: null });
  const second = relaunchSubagent({ reuseFindings: true, priorConclusion: first.conclusion });
  assert.equal(first.sweepCalls, SWEEP_COST);
  assert.equal(second.sweepCalls, 0);
  assert.equal(second.conclusion, first.conclusion);
  assert.ok(second.sweepCalls < first.sweepCalls, `expected fewer sweep calls on relaunch (${second.sweepCalls} >= ${first.sweepCalls})`);
});

test('the investigation-reuse discipline the demo models is actually documented', () => {
  const handoff = fs.readFileSync(HANDOFF_CONTRACT, 'utf8');
  assert.match(handoff, /## Investigation reuse on relaunch/);
  assert.match(handoff, /report what it already found.*before it redoes the sweep/s);
});
