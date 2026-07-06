'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const charter = require('../lib/charter');

function tmpStateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-'));
  return d;
}

test('north-star: writeIfAbsent creates when absent, refuses when present (CS1 guard)', () => {
  const dir = tmpStateDir();
  assert.strictEqual(charter.readNorthStar(dir), null);
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'draft framing'), true);
  assert.strictEqual(charter.readNorthStar(dir), 'draft framing');
  // second writer (parallel fresh session) must NOT clobber
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'other draft'), false);
  assert.strictEqual(charter.readNorthStar(dir), 'draft framing');
});

test('north-star: setNorthStar overwrites', () => {
  const dir = tmpStateDir();
  charter.writeNorthStarIfAbsent(dir, 'draft');
  charter.setNorthStar(dir, 'the real crystallized framing');
  assert.strictEqual(charter.readNorthStar(dir), 'the real crystallized framing');
});

test('north-star: empty/whitespace file counts as absent', () => {
  const dir = tmpStateDir();
  fs.writeFileSync(charter.charterPath(dir), '   \n');
  assert.strictEqual(charter.readNorthStar(dir), null);
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'framing'), true);
});

test('north-star: writes are capped at NORTH_STAR_MAX', () => {
  const dir = tmpStateDir();
  charter.setNorthStar(dir, 'x'.repeat(5000));
  assert.strictEqual(charter.readNorthStar(dir).length, 4000);
});

test('firstSubstantiveUserMessage: skips boilerplate, returns first real user message', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: '<system-reminder>hi</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: 'Base directory for this skill: /x/y' } },
    { type: 'user', message: { role: 'user', content: 'Caveat: local command output below' } },
    { type: 'user', message: { role: 'user', content: 'ok' } }, // too short
    { type: 'user', message: { role: 'user', content: 'Start the D-track charter work: preserve founding context.' } },
    { type: 'user', message: { role: 'user', content: 'a later message' } },
  ];
  assert.strictEqual(
    charter.firstSubstantiveUserMessage(entries),
    'Start the D-track charter work: preserve founding context.'
  );
});

test('firstSubstantiveUserMessage: array content, all-boilerplate returns null', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'CAVEMAN MODE ACTIVE (lite)' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'SessionStart hook fired' }] } },
  ];
  assert.strictEqual(charter.firstSubstantiveUserMessage(entries), null);
});
