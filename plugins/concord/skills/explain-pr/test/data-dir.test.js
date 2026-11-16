'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { dataDir } = require('../scripts/data-dir');

test('dataDir', () => {
  assert.equal(dataDir({ EXPLAIN_PR_DIR: '/x' }), '/x');
  assert.equal(dataDir({ EXPLAIN_PR_DIR: '/x', CLAUDE_CODE_SESSION_ID: 's' }), '/x');
  assert.equal(dataDir({ CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: '/c' }), '/c/concord/explain-pr');
  assert.equal(dataDir({ CLAUDE_CODE_SESSION_ID: 's' }), path.join(os.homedir(), '.claude/concord/explain-pr'));
  assert.equal(dataDir({ CODEX_HOME: '/h' }), '/h/concord/explain-pr');
  assert.equal(dataDir({}), path.join(os.homedir(), '.codex/concord/explain-pr'));
});
