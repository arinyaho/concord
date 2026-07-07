'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const statedir = require('../lib/statedir');

test('resolveStateDirFromCwd: mirrors Claude Code project-dir encoding under CLAUDE_CONFIG_DIR', () => {
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevCwd = process.cwd();
  process.env.CLAUDE_CONFIG_DIR = '/home/x/.claude';
  process.chdir('/tmp');
  try {
    const dir = statedir.resolveStateDirFromCwd();
    const expectedSlug = process.cwd().replace(/[/.]/g, '-');
    assert.strictEqual(dir, path.join('/home/x/.claude', 'projects', expectedSlug, 'state'));
  } finally {
    process.chdir(prevCwd);
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  }
});

test('resolveStateDirFromCwd: falls back to ~/.claude when CLAUDE_CONFIG_DIR unset', () => {
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const dir = statedir.resolveStateDirFromCwd();
    assert.ok(dir.includes(path.join('.claude', 'projects')));
    assert.ok(dir.endsWith('state'));
  } finally {
    if (prevConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = prevConfig;
  }
});

test('resolveStateDirFromTranscript: sibling "state" dir next to the transcript file', () => {
  const dir = statedir.resolveStateDirFromTranscript('/foo/bar/proj/sess123.jsonl');
  assert.strictEqual(dir, path.join('/foo/bar/proj', 'state'));
});
