'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractFacts, extractRationale } = require('../lib/extract');

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

test('rationale: tagged lines routed by tag', () => {
  const r = extractRationale(loadFixture());
  assert.deepEqual(r.decisions, ['[scope] chose A over B']);
  assert.deepEqual(r.openLoops, ['verify the injector']);
  assert.deepEqual(r.nexts, ['wire settings.json']);
});

test('rationale: RESOLVED captured, untagged text ignored', () => {
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'just prose, no tag\nRESOLVED: verify the injector' },
    ] } },
  ];
  const r = extractRationale(entries);
  assert.deepEqual(r.resolved, ['verify the injector']);
  assert.equal(r.decisions.length, 0);
});

test('task tool_use becomes a task fact', () => {
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'TaskUpdate', input: { title: 'Build writer', status: 'completed' } },
    ] } },
  ];
  assert.deepEqual(extractFacts(entries), ['task: Build writer [completed]']);
});
