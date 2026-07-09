'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadIntentConfig } = require('../lib/intent');

// readFileFn stub: maps the config path to a string, or throws ENOENT.
function reader(contentByPath) {
  return (p) => {
    if (Object.prototype.hasOwnProperty.call(contentByPath, p)) return contentByPath[p];
    const e = new Error('no such file');
    e.code = 'ENOENT';
    throw e;
  };
}
const CFG = require('path').join('/repo', 'review.config.json');

test('loadIntentConfig: absent file -> null (benign opt-out)', () => {
  assert.strictEqual(loadIntentConfig('/repo', reader({})), null);
});

test('loadIntentConfig: file present but no intent key -> null', () => {
  assert.strictEqual(loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ dod: ['x'] }) })), null);
});

test('loadIntentConfig: valid intent -> { command }', () => {
  const r = loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ intent: { command: 'cat spec.md' } }) }));
  assert.deepStrictEqual(r, { command: 'cat spec.md' });
});

test('loadIntentConfig: malformed JSON -> harness-failure', () => {
  assert.throws(() => loadIntentConfig('/repo', reader({ [CFG]: '{not json' })), /harness-failure/);
});

test('loadIntentConfig: intent without a string command -> harness-failure', () => {
  assert.throws(() => loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ intent: {} }) })), /harness-failure/);
  assert.throws(() => loadIntentConfig('/repo', reader({ [CFG]: JSON.stringify({ intent: { command: '   ' } }) })), /harness-failure/);
});
