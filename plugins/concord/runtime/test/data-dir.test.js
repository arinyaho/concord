'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir } = require('../../hooks/test/temp-dir');
const { dataDir, ensureDataDir, sessionRoot } = require('../data-dir');

test('dataDir picks the named harness base, for any skill', () => {
  const both = { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h' };
  assert.equal(dataDir('explain-pr', 'claude', both), '/c/concord/explain-pr');
  assert.equal(dataDir('explain-pr', 'codex', both), '/h/concord/explain-pr');
  assert.equal(dataDir('pr-to-merge', 'claude', {}), path.join(os.homedir(), '.claude/concord/pr-to-merge'));
  assert.equal(dataDir('review-until-approve', 'codex', { CLAUDE_CODE_SESSION_ID: 's' }), path.join(os.homedir(), '.codex/concord/review-until-approve'));
  assert.equal(sessionRoot('codex', both), '/h/concord/pr-to-merge/sessions');
});

test('EXPLAIN_PR_DIR overrides explain-pr only', () => {
  const env = { EXPLAIN_PR_DIR: '/x', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h' };
  assert.equal(dataDir('explain-pr', 'claude', env), '/x');
  assert.equal(dataDir('explain-pr', 'codex', env), '/x');
  assert.equal(dataDir('pr-to-merge', 'codex', env), '/h/concord/pr-to-merge');
});

test('ensureDataDir creates the directory and its concord parent owner-only', { skip: process.platform === 'win32' }, () => {
  const base = tempDir('dd-');
  const env = { CLAUDE_CONFIG_DIR: base };
  const dir = ensureDataDir('review-until-approve', 'claude', env);
  assert.equal(dir, path.join(base, 'concord', 'review-until-approve'));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(base, 'concord')).mode & 0o777, 0o700);
  // An existing directory with a wider mode is narrowed.
  fs.chmodSync(dir, 0o755);
  ensureDataDir('review-until-approve', 'claude', env);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
