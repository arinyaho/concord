'use strict';
// Demonstrates the scenario named by the "repeated re-Read caching" ticket item:
// a single session that needs the same document's content at several points
// (evidence stage, design note, PR body) and either re-issues a Read each time
// (the observed anti-pattern) or notes what it read once and reuses that note
// (the read-once discipline documented in initiative-to-prs/references/handoff-contract.md).
//
// This does not drive a real LLM; it models the two policies mechanically so the
// before/after reduction in Read calls is deterministic and repo-local.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const HANDOFF_CONTRACT = path.join(REPO, 'plugins/concord/skills/initiative-to-prs/references/handoff-contract.md');
const HANDOFF_CONTRACT_CODEX = path.join(REPO, 'plugins/concord-codex/skills/initiative-to-prs/references/handoff-contract.md');
const HANDOFF_CONTRACT_COPILOT = path.join(REPO, 'plugins/concord-copilot/skills/initiative-to-prs/references/handoff-contract.md');

// A session touches the same document at each of these points while doing
// unrelated work in between (mirrors ticket-to-pr stages 1, 3, and 9 all
// needing facts from the same source ticket/design doc).
const TOUCHPOINTS = ['evidence-gathering', 'design-note', 'pr-body'];

function runSession({ cacheReads }) {
  const scratchpad = new Map(); // path -> noted content, only used when cacheReads is true
  let readCalls = 0;
  const docPath = 'ticket.md';
  const docContent = 'acceptance criteria and DoD';

  function read(pathArg) {
    if (cacheReads && scratchpad.has(pathArg)) {
      return scratchpad.get(pathArg); // consult the note instead of re-reading
    }
    readCalls += 1;
    const content = docContent;
    if (cacheReads) scratchpad.set(pathArg, content);
    return content;
  }

  for (const _touchpoint of TOUCHPOINTS) {
    read(docPath); // each stage needs the same facts from the same document
  }

  return readCalls;
}

test('baseline session re-Reads the same document once per touchpoint', () => {
  const before = runSession({ cacheReads: false });
  assert.equal(before, TOUCHPOINTS.length);
});

test('read-once discipline reduces repeated re-Reads of the same document', () => {
  const before = runSession({ cacheReads: false });
  const after = runSession({ cacheReads: true });
  assert.equal(before, TOUCHPOINTS.length);
  assert.equal(after, 1);
  assert.ok(after < before, `expected fewer Read calls after caching (${after} >= ${before})`);
});

test('the read-once discipline the demo models is actually documented', () => {
  const claude = fs.readFileSync(HANDOFF_CONTRACT, 'utf8');
  const codex = fs.readFileSync(HANDOFF_CONTRACT_CODEX, 'utf8');
  const copilot = fs.readFileSync(HANDOFF_CONTRACT_COPILOT, 'utf8');
  assert.match(claude, /## Read-once discipline/);
  assert.match(claude, /consult the note first/);
  assert.equal(codex, claude, 'concord-codex handoff-contract.md drifted from the shared source');
  assert.equal(copilot, claude, 'concord-copilot handoff-contract.md drifted from the shared source');
});
