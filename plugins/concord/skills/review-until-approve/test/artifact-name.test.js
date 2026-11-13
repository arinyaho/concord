'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { safeIdForFilename } = require('../scripts/runner/artifact-name');

test('safeIdForFilename: replaces Windows-illegal characters, keeps the rest', () => {
  assert.strictEqual(safeIdForFilename('correctness:login-errors'), 'correctness_login-errors');
  assert.strictEqual(safeIdForFilename('gate:cross-context:a/b\\c?d*e'), 'gate_cross-context_a_b_c_d_e');
  assert.strictEqual(safeIdForFilename('correctness:한글-슬러그'), 'correctness_한글-슬러그');
});
