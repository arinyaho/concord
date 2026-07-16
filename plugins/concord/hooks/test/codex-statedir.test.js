'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const statedir = require('../../adapters/codex/statedir');

test('resolveStateDirFromCwd: ~/.codex-rooted, concord-namespaced, cwd-slug encoded (CODEX_HOME set)', () => {
  const prev = process.env.CODEX_HOME;
  const prevCwd = process.cwd();
  process.env.CODEX_HOME = '/home/x/.codex';
  process.chdir('/tmp');
  try {
    const dir = statedir.resolveStateDirFromCwd();
    const slug = process.cwd().replace(/[/.]/g, '-');
    assert.strictEqual(dir, path.join('/home/x/.codex', 'concord', 'projects', slug, 'state'));
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('resolveStateDirFromCwd: falls back to ~/.codex when CODEX_HOME unset', () => {
  const prev = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const dir = statedir.resolveStateDirFromCwd();
    assert.ok(dir.includes(path.join('.codex', 'concord', 'projects')));
    assert.ok(dir.endsWith('state'));
  } finally {
    if (prev !== undefined) process.env.CODEX_HOME = prev;
  }
});
