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

test('mapEntries normalizes an exec custom_tool_call to Bash', () => {
  const raw = [
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'ls -la' },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: '', toolCalls: [{ name: 'Bash', input: { command: 'ls -la' } }] },
  ]);
});

test('mapEntries normalizes a local_shell_call to Bash', () => {
  const raw = [
    {
      type: 'response_item',
      payload: { type: 'local_shell_call', name: 'local_shell_call', input: { command: 'git status' } },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: '', toolCalls: [{ name: 'Bash', input: { command: 'git status' } }] },
  ]);
});

test('mapEntries joins an argv-array local_shell_call command (real Codex shape)', () => {
  const raw = [
    {
      type: 'response_item',
      payload: { type: 'local_shell_call', action: { command: ['bash', '-lc', 'echo hi'] } },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: '', toolCalls: [{ name: 'Bash', input: { command: 'bash -lc echo hi' } }] },
  ]);
});

test('mapEntries passes through a non-shell tool call (e.g. apply_patch) best-effort', () => {
  const raw = [
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', input: { patch: '*** Begin Patch' } },
    },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: '', toolCalls: [{ name: 'apply_patch', input: { patch: '*** Begin Patch' } }] },
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
