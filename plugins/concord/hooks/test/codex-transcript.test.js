'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mapEntries } = require('../../adapters/codex/transcript');

test('mapEntries lifts a rollout assistant message', () => {
  const raw = [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'DECISION: use X' }],
      },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [{ role: 'assistant', text: 'DECISION: use X', toolCalls: [] }]);
});

test('mapEntries lifts a custom_tool_call', () => {
  const raw = [
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'shell', input: { command: 'ls' } },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: '', toolCalls: [{ name: 'shell', input: { command: 'ls' } }] },
  ]);
});

test('mapEntries skips a session_meta / event_msg entry', () => {
  const raw = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'event_msg', payload: { type: 'foo' } },
  ];
  assert.deepStrictEqual(mapEntries(raw), []);
});

test('mapEntries lifts a rollout user message', () => {
  const raw = [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello there' }],
      },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [{ role: 'user', text: 'hello there', toolCalls: [] }]);
});
