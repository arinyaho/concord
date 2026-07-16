const test = require('node:test');
const assert = require('node:assert');
const { mapEntries } = require('../../adapters/claude-code/transcript');

test('mapEntries lifts assistant text + tool calls into NeutralEntry', () => {
  const raw = [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'DECISION: use X' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
  ];
  assert.deepStrictEqual(mapEntries(raw), [
    { role: 'assistant', text: 'DECISION: use X', toolCalls: [{ name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', text: 'do it', toolCalls: [] },
  ]);
});

test('mapEntries skips entries with no message', () => {
  assert.deepStrictEqual(mapEntries([{ type: 'system' }, {}]), []);
});
