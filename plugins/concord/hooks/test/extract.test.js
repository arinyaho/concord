'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractFacts, extractRationale } = require('../../core/extract');

function loadFixture() {
  const p = path.join(__dirname, 'fixtures', 'sample.jsonl');
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('facts: edits and meaningful commands, noise filtered', () => {
  const facts = extractFacts(loadFixture());
  assert.ok(facts.includes('edited /repo/a.js'));
  assert.ok(facts.includes('ran: git commit -m "x"'));
  assert.ok(!facts.some((f) => f.includes('ls -la'))); // noise dropped
});

test('facts: allowlist captures infra tools, drops noise and variable-assignment setup', () => {
  const entries = [
    { role: 'assistant', text: '', toolCalls: [
      { name: 'Bash', input: { command: 'docker build -t x .' } },
      { name: 'Bash', input: { command: 'terraform apply' } },
      { name: 'Bash', input: { command: 'ls -la' } },
      { name: 'Bash', input: { command: 'F=/some/long/path' } },
      { name: 'Bash', input: { command: 'cd /w && git commit -m x' } },
      { name: 'Bash', input: { command: 'HAT="uv run --project /p hat"' } },
    ] },
  ];
  const facts = extractFacts(entries);
  assert.ok(facts.includes('ran: docker build -t x .')); // recall: infra tool captured
  assert.ok(facts.includes('ran: terraform apply'));
  assert.ok(facts.includes('ran: cd /w && git commit -m x')); // captured via segment split
  assert.ok(!facts.some((f) => f.includes('ls -la'))); // noise dropped
  assert.ok(!facts.some((f) => f.startsWith('ran: F='))); // variable-assignment setup dropped
  assert.ok(!facts.some((f) => f.includes('HAT='))); // tool name only inside a value -> dropped
});

test('rationale: tagged lines routed by tag', () => {
  const r = extractRationale(loadFixture());
  assert.deepEqual(r.decisions, ['[scope] chose A over B']);
  assert.deepEqual(r.openLoops, ['verify the injector']);
  assert.deepEqual(r.nexts, ['wire settings.json']);
});

test('rationale: RESOLVED captured, untagged text ignored', () => {
  const entries = [
    { role: 'assistant', text: 'just prose, no tag\nRESOLVED: verify the injector', toolCalls: [] },
  ];
  const r = extractRationale(entries);
  assert.deepEqual(r.resolved, ['verify the injector']);
  assert.equal(r.decisions.length, 0);
});

test('task tool_use becomes a task fact', () => {
  const entries = [
    { role: 'assistant', text: '', toolCalls: [
      { name: 'TaskUpdate', input: { title: 'Build writer', status: 'completed' } },
    ] },
  ];
  assert.deepEqual(extractFacts(entries), ['task: Build writer [completed]']);
});
