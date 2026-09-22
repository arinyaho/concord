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
const DELEGATE_VERBOSE_WORK = path.join(REPO, 'plugins/concord/skills/delegate-verbose-work/SKILL.md');

// handoff-contract.md must stay byte-identical across concord/concord-codex/concord-copilot
// (enforced elsewhere), and delegate-verbose-work is Claude-Code-only, so neither file can
// cross-reference the other -- each carries its own full copy of this discipline instead.
// That duplication needs its own guard so an edit to one copy can't silently desync the other.
// Whitespace (including line-wrap differences between the two files) is normalized before
// comparing; the wording itself must still match exactly.
const normalizeWhitespace = (text) => text.replace(/\s+/g, ' ').trim();

const SHARED_PASSAGES = [
  'If an earlier notification from that subagent already reported a conclusion, pass that conclusion forward in the resume prompt instead of a bare re-dispatch, and instruct the subagent to use it unless it finds the conclusion stale or contradicted.',
  'If no conclusion was received yet, ask the resumed subagent to report what it already found — including any note it can recover from its own prior output — before it redoes the sweep, and have it redo only the portion that report cannot answer.',
  "Losing worktree state is the harness's; redoing the investigation without checking for what survived is the orchestrator's. The orchestrator, not the resumed subagent, is the one holding the last notification, so the orchestrator is the one obligated to hand it forward.",
];

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

test('the shared resume-discipline text stays identical between handoff-contract.md and delegate-verbose-work/SKILL.md', () => {
  const handoff = normalizeWhitespace(fs.readFileSync(HANDOFF_CONTRACT, 'utf8'));
  const delegateVerboseWork = normalizeWhitespace(fs.readFileSync(DELEGATE_VERBOSE_WORK, 'utf8'));
  for (const passage of SHARED_PASSAGES) {
    const normalized = normalizeWhitespace(passage);
    assert.ok(handoff.includes(normalized), `handoff-contract.md is missing or has drifted from: ${normalized.slice(0, 60)}...`);
    assert.ok(
      delegateVerboseWork.includes(normalized),
      `delegate-verbose-work/SKILL.md is missing or has drifted from: ${normalized.slice(0, 60)}...`,
    );
  }
});
