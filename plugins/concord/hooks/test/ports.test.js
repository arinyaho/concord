// plugins/concord/hooks/test/ports.test.js
const test = require('node:test');
const assert = require('node:assert');
const { PORT_NAMES, normalizeEntry } = require('../../core/ports');

test('PORT_NAMES lists the five seams', () => {
  assert.deepStrictEqual(
    [...PORT_NAMES].sort(),
    ['command', 'lifecycle', 'reviewer', 'statedir', 'transcript']
  );
});

test('normalizeEntry fills defaults and preserves fields', () => {
  assert.deepStrictEqual(
    normalizeEntry({ role: 'assistant', text: 'hi', toolCalls: [{ name: 'Read', input: { file_path: '/a' } }] }),
    { role: 'assistant', text: 'hi', toolCalls: [{ name: 'Read', input: { file_path: '/a' } }] }
  );
  assert.deepStrictEqual(normalizeEntry({ role: 'user' }), { role: 'user', text: '', toolCalls: [] });
});

test('normalizeEntry rejects a bad role', () => {
  assert.throws(() => normalizeEntry({ role: 'system', text: 'x' }), /role/);
});
