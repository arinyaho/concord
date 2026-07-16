'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toNeutralEvent } = require('../../adapters/claude-code/event');

test('toNeutralEvent maps Claude Stop payload', () => {
  assert.deepStrictEqual(
    toNeutralEvent({ session_id: 's1', transcript_path: '/t.jsonl', last_assistant_message: 'hi' }, 'stop'),
    { sessionId: 's1', transcriptPath: '/t.jsonl', lastAssistantMessage: 'hi', source: 'stop' }
  );
});

test('toNeutralEvent maps SessionStart source through', () => {
  const ev = toNeutralEvent({ session_id: 's2', transcript_path: '/t.jsonl', source: 'resume' }, 'resume');
  assert.strictEqual(ev.source, 'resume');
  assert.strictEqual(ev.sessionId, 's2');
});
