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

test('dataDir with a harness picks that harness base without looking at the Claude session id', () => {
  const both = { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h' };
  assert.equal(dataDir(both, 'codex'), '/h/concord/explain-pr');
  assert.equal(dataDir({ CODEX_HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }, 'claude'), '/c/concord/explain-pr');
  assert.equal(dataDir({}, 'claude'), path.join(os.homedir(), '.claude/concord/explain-pr'));
  assert.equal(dataDir({ CLAUDE_CODE_SESSION_ID: 's' }, 'codex'), path.join(os.homedir(), '.codex/concord/explain-pr'));
  assert.equal(dataDir({ ...both, EXPLAIN_PR_DIR: '/x' }, 'codex'), '/x');
  assert.equal(dataDir({ ...both, EXPLAIN_PR_DIR: '/x' }, 'claude'), '/x');
});
