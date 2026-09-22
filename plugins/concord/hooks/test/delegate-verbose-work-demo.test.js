'use strict';
// Demonstrates the scenario named by the "delegate-verbose-work" ticket item: a session
// answering one broad question (e.g. "every caller of X across the repo") either issues
// many grep calls itself on the main thread (the anti-pattern this skill guards against)
// or routes the whole sweep to a subagent and keeps only its conclusion, per
// plugins/concord/skills/delegate-verbose-work/SKILL.md.
//
// This does not drive a real LLM; it models the two policies mechanically so the
// before/after reduction in main-thread tool calls is deterministic and repo-local.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins/concord/skills/delegate-verbose-work/SKILL.md');

// Models a broad sweep needing many grep calls to answer one question.
const SWEEP_SIZE = 40;

// Two independent ledgers stand in for "main thread" and "dispatched subagent": the
// reduction the tests assert falls out of which ledger the sweep's greps land on, not
// from a hand-picked return value. Non-delegating runs the sweep itself, charging every
// grep to its own ledger. Delegating runs the *same* sweep loop inside a nested
// subagentSession() closure that keeps its own ledger; the main thread only ever charges
// itself for the single dispatch call that crosses into it.
function runSession({ delegate }) {
  let mainThreadToolCalls = 0;

  function sweep() {
    let calls = 0;
    function grep() {
      calls += 1;
    }
    for (let i = 0; i < SWEEP_SIZE; i += 1) grep();
    return calls;
  }

  function subagentSession() {
    // Runs on the subagent's own ledger; nothing here touches mainThreadToolCalls.
    return sweep();
  }

  let subagentToolCalls = 0;
  if (delegate) {
    mainThreadToolCalls += 1; // the one dispatch call that crosses into the subagent
    subagentToolCalls = subagentSession();
  } else {
    mainThreadToolCalls = sweep();
  }

  return { mainThreadToolCalls, subagentToolCalls };
}

test('baseline session runs the full sweep on the main thread', () => {
  const before = runSession({ delegate: false });
  assert.equal(before.mainThreadToolCalls, SWEEP_SIZE);
  assert.equal(before.subagentToolCalls, 0);
});

test('delegating the sweep moves it off the main thread ledger', () => {
  const before = runSession({ delegate: false });
  const after = runSession({ delegate: true });
  // The sweep still happens in full — it just lands on the subagent's ledger instead
  // of the main thread's, so the "reduction" isn't a discarded return value.
  assert.equal(after.subagentToolCalls, SWEEP_SIZE);
  assert.equal(after.mainThreadToolCalls, 1);
  assert.ok(
    after.mainThreadToolCalls < before.mainThreadToolCalls,
    `expected fewer main-thread calls after delegating (${after.mainThreadToolCalls} >= ${before.mainThreadToolCalls})`
  );
});

test('the delegation trigger the demo models is actually documented', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /roughly 10 or more/);
  assert.match(skill, /already been Read this session/);
});
