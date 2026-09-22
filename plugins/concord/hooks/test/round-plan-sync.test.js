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
const { GATE_SWEEP_CLAUSE, reviewerPrompt } = require(path.join(CORE, 'round-plan'));
const driverText = fs.readFileSync(path.join(CORE, 'review-driver.md'), 'utf8');
// plugins/concord/commands/review-until-green.md is a hand-composed copy of
// review-driver.md (composed with the Claude Code spawn-include) that the
// live `/review-until-green` slash command actually reads -- not generated
// by any build step, so it drifts silently unless a test checks it directly.
const composedCommandText = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'review-until-green.md'), 'utf8');

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

test('composed commands/review-until-green.md embeds GATE_SWEEP_CLAUSE byte-for-byte in the gate-review prompt', () => {
  assert.ok(
    composedCommandText.includes(GATE_SWEEP_CLAUSE),
    'commands/review-until-green.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- recompose it from review-driver.md',
  );
});

test('round-plan.js reviewerPrompt("gate", ...) embeds GATE_SWEEP_CLAUSE byte-for-byte', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
  assert.ok(
    prompt.includes(GATE_SWEEP_CLAUSE),
    'round-plan.js reviewerPrompt("gate") has drifted from its own exported GATE_SWEEP_CLAUSE constant',
  );
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
  // the same way core/review-driver.md and commands/review-until-green.md are.
  const REPO = path.join(__dirname, '..', '..', '..', '..');
  const copilotDriverText = fs.readFileSync(
    path.join(REPO, 'plugins/concord-copilot/skills/review-until-green/references/review-driver.md'),
    'utf8',
  );
  assert.ok(
    copilotDriverText.includes(GATE_SWEEP_CLAUSE),
    'plugins/concord-copilot/skills/review-until-green/references/review-driver.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- re-run node plugins/concord-copilot/bin/bundle.mjs',
  );
});
