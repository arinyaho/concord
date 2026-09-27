'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { safeIdForFilename } = require('../../core/artifact-name');
const { reviewerPrompt } = require('../../core/round-plan');

test('safeIdForFilename: replaces Windows-illegal characters, keeps the rest', () => {
  assert.strictEqual(safeIdForFilename('correctness:login-errors'), 'correctness_login-errors');
  assert.strictEqual(safeIdForFilename('gate:cross-context:a/b\\c?d*e'), 'gate_cross-context_a_b_c_d_e');
  assert.strictEqual(safeIdForFilename('correctness:한글-슬러그'), 'correctness_한글-슬러그');
});

test('fix reviewer prompt names an artifact path with no colon in the filename', () => {
  const prompt = reviewerPrompt('fix', {
    stateDir: '/state', round: 1, targetType: 'git',
    finding: { id: 'correctness:some-bug', file: 'a.js', span: 'x', summary: 's' },
  });
  assert.ok(prompt.includes('round-1-fix-correctness_some-bug.json'), prompt);
  assert.ok(!prompt.includes('fix-correctness:'));
});
