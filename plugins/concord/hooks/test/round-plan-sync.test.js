'use strict';
// Drift guard: plugins/concord/core/review-driver.md (prose the Claude Code
// session follows itself) and plugins/concord/core/round-plan.js (the prompt
// text codex-review-runner.js spawns) must stay byte-identical on every
// instruction they both carry. Without this test the two can silently drift
// apart, as review-driver.md and codex-review-runner.js's hand-written
// reviewerPrompt() already had before this file existed -- see the round-plan
// extraction PR's design note. A future edit to one side that is not mirrored
// to the other must fail here, loudly, not slip through unnoticed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'core');
const { GATE_SWEEP_CLAUSE, GATE_VERIFY_OWNERSHIP_CLAUSE, GATE_VERIFY_ADDED_CLAUSE, reviewerPrompt } = require(path.join(CORE, 'round-plan'));
const { allowedFindingPrefixes } = require(path.join(CORE, 'artifact-contract'));
const roundPlanText = fs.readFileSync(path.join(CORE, 'round-plan.js'), 'utf8');
const driverText = fs.readFileSync(path.join(CORE, 'review-driver.md'), 'utf8');
// plugins/concord/commands/review-and-fix.md is a hand-composed copy of
// review-driver.md (composed with the Claude Code spawn-include) that the
// live `/review-and-fix` slash command actually reads -- not generated
// by any build step, so it drifts silently unless a test checks it directly.
const composedCommandText = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'review-and-fix.md'), 'utf8');
const REPO = path.join(__dirname, '..', '..', '..', '..');
const codexCommandText = fs.readFileSync(path.join(REPO, 'plugins/concord-codex/commands/review-and-fix.md'), 'utf8');
const copilotDriverText = fs.readFileSync(
  path.join(REPO, 'plugins/concord-copilot/skills/review-and-fix/references/review-driver.md'),
  'utf8',
);

test('GATE_SWEEP_CLAUSE is non-trivial and role-agnostic text', () => {
  assert.equal(typeof GATE_SWEEP_CLAUSE, 'string');
  assert.ok(GATE_SWEEP_CLAUSE.length > 40, 'GATE_SWEEP_CLAUSE should be a real instruction, not a stub');
});

test('review-driver.md embeds GATE_SWEEP_CLAUSE byte-for-byte in the gate-review prompt', () => {
  assert.ok(
    driverText.includes(GATE_SWEEP_CLAUSE),
    'review-driver.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- update review-driver.md to embed the exact same text',
  );
});

test('composed commands/review-and-fix.md embeds GATE_SWEEP_CLAUSE byte-for-byte in the gate-review prompt', () => {
  assert.ok(
    composedCommandText.includes(GATE_SWEEP_CLAUSE),
    'commands/review-and-fix.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- recompose it from review-driver.md',
  );
});

test('round-plan.js reviewerPrompt("gate", ...) embeds GATE_SWEEP_CLAUSE byte-for-byte', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
  assert.ok(
    prompt.includes(GATE_SWEEP_CLAUSE),
    'round-plan.js reviewerPrompt("gate") has drifted from its own exported GATE_SWEEP_CLAUSE constant',
  );
});

test('every gate verifier prompt embeds the namespace ownership clause byte-for-byte', () => {
  assert.match(roundPlanText, /allowedFindingPrefixes\('correctness'\)/, 'gate-verify context namespaces must come from the artifact registry');
  for (const prefix of allowedFindingPrefixes('correctness')) assert.ok(GATE_VERIFY_OWNERSHIP_CLAUSE.includes(`${prefix}*`));
  const generated = reviewerPrompt('gate-verify', { stateDir: '/state', round: 3, targetType: 'git', slug: 'feat-x' });
  assert.ok(generated.includes(GATE_VERIFY_OWNERSHIP_CLAUSE));
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(GATE_VERIFY_OWNERSHIP_CLAUSE.trim()), `${name} gate-verify prompt has drifted from round-plan.js`);
  }
});

test('manual review drivers normalize gate-verify artifacts through the bounded retry contract', () => {
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    const boundary = text.match(/Immediately after every fail-closed reviewer[\s\S]*?(?:A failed, missing, or non-preserving candidate and any|A second retry response or any) `harness-failure` (?:is|are) terminal\.[^\n]*/)?.[0] || '';
    assert.match(boundary, /`gate-verify`/, `${name} does not normalize the gate-verify role`);
    assert.doesNotMatch(boundary, /Do not normalize `gate-verify`/, `${name} bypasses strict gate-verify normalization`);
  }
});

test('codex-review-runner.js re-exports the exact same reviewerPrompt as round-plan.js (no second hand-written copy)', () => {
  const runner = require(path.join(CORE, 'codex-review-runner'));
  assert.equal(runner.reviewerPrompt, reviewerPrompt, 'codex-review-runner.js must delegate to round-plan.js, not redefine reviewerPrompt itself');
});

test('the vendored Codex engine copy of round-plan.js is byte-identical to core (run bin/bundle.mjs if this fails)', () => {
  const REPO = path.join(__dirname, '..', '..', '..', '..');
  const vendored = path.join(REPO, 'plugins/concord-codex/engine/round-plan.js');
  const src = fs.readFileSync(path.join(CORE, 'round-plan.js'));
  assert.ok(fs.readFileSync(vendored).equals(src), 'plugins/concord-codex/engine/round-plan.js drifted -- re-run node plugins/concord-codex/bin/bundle.mjs');
});

test('the Copilot-vendored review-driver.md copy embeds GATE_SWEEP_CLAUSE byte-for-byte', () => {
  // Unlike round-plan.js (a generic byte-identity test in copilot-package.test.js
  // already covers its vendored copies), this file is produced by a plain
  // fs.copyFileSync in plugins/concord-copilot/bin/bundle.mjs with no
  // byte-identity guard of its own -- so it must be checked directly here,
  // the same way core/review-driver.md and commands/review-and-fix.md are.
  assert.ok(
    copilotDriverText.includes(GATE_SWEEP_CLAUSE),
    'plugins/concord-copilot/skills/review-and-fix/references/review-driver.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- re-run node plugins/concord-copilot/bin/bundle.mjs',
  );
});

test('review instructions do not terminalize foreground silence or a nested skill path', () => {
  for (const text of [driverText, composedCommandText, codexCommandText, copilotDriverText]) {
    assert.match(text, /30-second foreground wait or empty output is not a terminal result/);
    assert.match(text, /non-terminal ledger without a live driver is a stopped driver/);
    assert.match(text, /durable terminal disposition or the ledger's bounded no-progress decision/);
    assert.match(text, /resolve the installed skill path recursively to the actual `SKILL\.md`/);
  }
});

test('manual fix instructions use the same filesystem-safe ID as commit-fix', () => {
  for (const text of [driverText, composedCommandText]) {
    assert.match(text, /fix-<safe-group-id>\.json/);
    assert.match(text, /exact `groupId`/);
  }
});

test('every review driver artifact embeds the lite design-conformance gate prompt that round-plan.js builds', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '<stateDir>', round: '<n>', slug: '<slug>', gateMode: 'design-conformance', targetType: 'git', dodPassed: true }).replaceAll('\\', '/');
  const shared = prompt.slice(0, prompt.indexOf(' Write ONLY'));
  assert.match(shared, /design-conformance gaps only/);
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(shared), `${name} lite gate prompt has drifted from round-plan.js`);
  }
});

test('lite correctness verification does not depend on the concurrently running design-conformance gate', () => {
  const lite = reviewerPrompt('verify', {
    stateDir: '/state', round: 1, targetType: 'git', gateMode: 'design-conformance', gateApplied: true,
  });
  const base = reviewerPrompt('verify', {
    stateDir: '/state', round: 1, targetType: 'git', gateMode: 'pair', gateApplied: true,
  });

  assert.doesNotMatch(lite, /round-1-gate\.json/);
  assert.match(base, /round-1-gate\.json/);
});

test('the composed Claude command preserves pending final DoD semantics', () => {
  assert.match(composedCommandText, /`dodPending:true` means the configured DoD is reserved for the final clean boundary/);
  assert.match(composedCommandText, /If `round-start` reported `dodPending:true`, tell it the configured DoD will run once after review convergence/);
  assert.doesNotMatch(composedCommandText, /If `dodPassed` is `false`, tell it DoD failed this round/);
});

test('manual drivers certify every authorized transaction before commit', () => {
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.match(text, /reserve one `fix` launch/i, name);
    assert.match(text, /independent `certify` launch/i, name);
    assert.match(text, /A partial or stale certificate never commits/, name);
    assert.doesNotMatch(text, /fix --count <number of fixes>/, name);
  }
});

test('every changeClass/action pair the plan prompt offers is accepted by the plan validator, and each driver carries the reconcile rule', () => {
  const { normalizeArtifact } = require(path.join(CORE, 'artifact-contract'));
  const prompt = reviewerPrompt('plan', { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', intentHash: 'h' });
  const offered = (key) => prompt.match(new RegExp(`"${key}":"([a-z|]+)"`))[1].split('|');
  for (const changeClass of offered('changeClass')) for (const action of offered('action')) {
    const group = {
      groupId: 'g', findingIds: ['correctness:a'], rootCause: 'r', invariants: ['i'], changeClass, action,
      ...(changeClass === 'structural' ? { structuralEffects: ['identity'] } : {}),
      ...(action === 'reconcile' ? { reason: 'unsettled decision' } : {}),
      ...(changeClass === 'structural' && action === 'fix' ? { designEvidence: { source: 'intent-feat-x.md', sourceHash: 'h', requirements: ['q'], uniqueness: 'u' } } : {}),
    };
    assert.doesNotThrow(() => normalizeArtifact('plan', JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [group] })), `${changeClass}+${action} is offered by the plan prompt but rejected by the validator`);
  }
  assert.match(prompt, /local group[^.]*may also use action:"reconcile"/);
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot driver', copilotDriverText]]) {
    assert.match(text, /local group[^.]*may also use `?action:"reconcile"`?/, `${name} plan step does not state that a local group may reconcile`);
  }
});

test('gate-verify records a gate candidate that restates a correctness candidate as a duplicate, not a rejection', () => {
  assert.match(GATE_VERIFY_OWNERSHIP_CLAUSE, /restates the same defect .* correctness candidate/);
  assert.match(GATE_VERIFY_OWNERSHIP_CLAUSE, /"duplicates" as \{"id":"<gate id>","of":"<correctness id>"\}/);
  assert.doesNotMatch(GATE_VERIFY_OWNERSHIP_CLAUSE, /Reject a gate candidate that restates/);
});

test('the correctness verifier given the gate batch may disposition only correctness ids', () => {
  const base = reviewerPrompt('verify', { stateDir: '/state', round: 1, targetType: 'git', gateMode: 'pair', gateApplied: true });
  for (const prefix of allowedFindingPrefixes('correctness')) assert.ok(base.includes(`${prefix}*`), `verify prompt must name ${prefix}* as its own namespace`);
  assert.match(base, /Do not copy, accept, or reject gate:\* IDs in this artifact; their disposition belongs to the gate verifier\./);
  const alone = reviewerPrompt('verify', { stateDir: '/state', round: 2, targetType: 'git', gateMode: 'pair', gateApplied: false });
  assert.doesNotMatch(alone, /gate verifier/, 'without the gate batch there is nothing to keep out');
});

test('every gate verifier prompt asks an added finding for its follow-up classification byte-for-byte', () => {
  assert.match(GATE_VERIFY_ADDED_CLAUSE, /releaseBlocking.*rationale/);
  for (const word of ['acceptance-criterion', 'unproven-premise', 'stage-exit', 'rationale', 'approved outcome']) assert.ok(GATE_VERIFY_ADDED_CLAUSE.includes(word), `the verifier clause lacks ${word}`);
  const generated = reviewerPrompt('gate-verify', { stateDir: '/state', round: 3, targetType: 'git', slug: 'feat-x' });
  assert.ok(generated.includes(GATE_VERIFY_ADDED_CLAUSE));
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(GATE_VERIFY_ADDED_CLAUSE.trim()), `${name} gate-verify prompt has drifted from round-plan.js`);
  }
});
