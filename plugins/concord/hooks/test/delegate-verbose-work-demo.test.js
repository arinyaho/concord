'use strict';
// Demonstrates the scenario named by the "delegate-verbose-work" ticket item: a session
// answering one broad question (e.g. "every caller of X across the repo") either issues
// many grep calls itself on the main thread (the observed anti-pattern — up to 58 in one
// recorded session) or routes the whole sweep to a subagent and keeps only its conclusion,
// per plugins/concord/skills/delegate-verbose-work/SKILL.md.
//
// This does not drive a real LLM; it models the two policies mechanically so the
// before/after reduction in main-thread tool calls is deterministic and repo-local.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins/concord/skills/delegate-verbose-work/SKILL.md');

// A sweep needing this many grep calls to answer one question (mirrors the observed
// 32-58 direct grep calls in a session that had no delegation guidance).
const SWEEP_SIZE = 40;

function runSession({ delegate }) {
  let mainThreadToolCalls = 0;
  function grep() {
    mainThreadToolCalls += 1;
  }

  if (delegate) {
    // The whole sweep runs on a subagent's thread; the main thread only spends one
    // call dispatching it and absorbs none of the individual greps.
    mainThreadToolCalls += 1;
  } else {
    for (let i = 0; i < SWEEP_SIZE; i += 1) grep();
  }

  return mainThreadToolCalls;
}

test('baseline session runs the full sweep on the main thread', () => {
  const before = runSession({ delegate: false });
  assert.equal(before, SWEEP_SIZE);
});

test('delegating the sweep reduces main-thread tool calls', () => {
  const before = runSession({ delegate: false });
  const after = runSession({ delegate: true });
  assert.equal(before, SWEEP_SIZE);
  assert.equal(after, 1);
  assert.ok(after < before, `expected fewer main-thread calls after delegating (${after} >= ${before})`);
});

test('the delegation trigger the demo models is actually documented', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /roughly 10 or more/);
  assert.match(skill, /already been Read this session/);
});
