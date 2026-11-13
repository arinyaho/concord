'use strict';
// The stale-lock reclaim approve.js uses for the ledger lock: of two contenders for the same stale lock, only one reclaims it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { reclaimStaleLock, lockIsStale } = require('../scripts/runner/run-lock');
const { tempDir } = require('../../../hooks/test/temp-dir');

function deadLock() {
  const lock = path.join(tempDir('run-lock-'), 'run.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), '999999\n');
  return lock;
}

test('two contenders cannot both reclaim the same stale lock (correctness:stale-lock-reclaim-toctou)', () => {
  const lock = deadLock();
  const realRead = fs.readFileSync;
  let second = null;
  let armed = true;
  fs.readFileSync = function (file, ...rest) {
    const value = realRead.call(this, file, ...rest);
    if (armed && String(file) === path.join(lock, 'owner')) { armed = false; second = reclaimStaleLock(lock); }
    return value;
  };
  let first;
  try { first = reclaimStaleLock(lock); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(first, true);
  assert.strictEqual(second, false, 'a concurrent contender must not also reclaim the lock');
  assert.strictEqual(fs.existsSync(lock), false);
  assert.strictEqual(fs.existsSync(`${lock}.reclaim`), false);
});

test('a lock held by a running process is not stale and is not reclaimed', () => {
  const lock = deadLock();
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
  assert.strictEqual(lockIsStale(lock), false);
  assert.strictEqual(reclaimStaleLock(lock), false);
  assert.strictEqual(fs.existsSync(lock), true);
});
