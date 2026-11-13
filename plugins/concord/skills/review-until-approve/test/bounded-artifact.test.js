'use strict';
// The bounded reader the runner hashes and reads reviewer artifacts with: a FIFO, an oversized file or a replaced inode is refused instead of read.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

function temp() { return tempDir('bounded-artifact-'); }

test('bounded review hash accepts missing future output and refuses a FIFO without hanging', { skip: process.platform === 'win32' }, () => {
  const directory = temp();
  const root = require('../scripts/runner/bounded-artifact').captureArtifactRoot(directory);
  const { hashArtifact } = require('../scripts/runner/bounded-artifact');
  assert.strictEqual(hashArtifact(path.join(directory, 'future.json'), root, { allowMissing: true }), null);
  fs.writeFileSync(path.join(directory, 'ordinary.json'), '{}\n');
  assert.match(hashArtifact(path.join(directory, 'ordinary.json'), root), /^[0-9a-f]{64}$/);
  const pipe = path.join(directory, 'pipe.json');
  assert.strictEqual(spawnSync('mkfifo', [pipe]).status, 0);
  const child = spawnSync(process.execPath, ['-e',
    'const h=require(process.argv[1]);try{h.hashArtifact(process.argv[2],h.captureArtifactRoot(process.argv[3]));process.exit(2)}catch(e){if(/unsafe or oversized/.test(e.message))process.exit(0);process.exit(3)}',
    require.resolve('../scripts/runner/bounded-artifact'), pipe, directory], { timeout: 3000 });
  assert.strictEqual(child.status, 0, `FIFO hash stalled or failed unsafely: ${child.error || child.stderr}`);
});

test('bounded review hash rejects a same-path inode replacement during its read', () => {
  const directory = temp(); const file = path.join(directory, 'artifact.json');
  fs.writeFileSync(file, 'original\n');
  const script = [
    'const fs=require("node:fs"),path=require("node:path"),h=require(process.argv[1]),file=process.argv[2];',
    'const read=fs.readSync;let swapped=false;',
    'fs.readSync=function(...args){const n=read.apply(this,args);if(!swapped){swapped=true;fs.unlinkSync(file);fs.writeFileSync(file,"replaced\\n")}return n};',
    'try{h.hashArtifact(file,h.captureArtifactRoot(path.dirname(file)));process.exit(2)}catch(e){process.exit(/unsafe or oversized/.test(e.message)?0:3)}',
  ].join('');
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../scripts/runner/bounded-artifact'), file], { timeout: 3000 });
  assert.strictEqual(child.status, 0, `replacement was not rejected: ${child.error || child.stderr}`);
});
