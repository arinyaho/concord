'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toNeutralEvent } = require('../../adapters/codex/event');

test('toNeutralEvent maps a Codex SessionStart payload', () => {
  assert.deepStrictEqual(
    toNeutralEvent({ session_id: 's1', transcript_path: '/r.jsonl', cwd: '/proj', source: 'startup' }),
    { sessionId: 's1', transcriptPath: '/r.jsonl', cwd: '/proj', source: 'startup' }
  );
});

test('toNeutralEvent(payload, "stop") overrides source', () => {
  const ev = toNeutralEvent({ session_id: 's1', transcript_path: '/r.jsonl', cwd: '/proj', source: 'startup' }, 'stop');
  assert.strictEqual(ev.source, 'stop');
  assert.strictEqual(ev.sessionId, 's1');
  assert.strictEqual(ev.cwd, '/proj');
});
