'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'charter-cli.js');

test('charter-cli set: writes north-star from stdin; show: renders it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  execFileSync('node', [CLI, 'set'], { input: 'the crystallized framing', env: { ...process.env, CHARTER_STATE_DIR: dir } });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'charter.md'), 'utf8').trim(), 'the crystallized framing');
  const out = execFileSync('node', [CLI, 'show'], { env: { ...process.env, CHARTER_STATE_DIR: dir }, encoding: 'utf8' });
  assert.ok(out.includes('# Task charter'));
  assert.ok(out.includes('the crystallized framing'));
});
