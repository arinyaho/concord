'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishDirectoryAtomic } = require('../../core/atomic-write');
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-archive-'));
  const staging = path.join(parent, 'archive.pending'), destination = path.join(parent, 'archive');
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.writeFileSync(path.join(staging, 'manifest.json'), '{"complete":true}\n', { mode: 0o600 });
  return { parent, staging, destination };
}
test('shared helper atomically publishes a complete private sibling directory', () => {
  assert.equal(typeof publishDirectoryAtomic, 'function');
  const f = fixture(); publishDirectoryAtomic(f.staging, f.destination);
  assert.equal(fs.existsSync(f.staging), false);
  assert.equal(fs.readFileSync(path.join(f.destination, 'manifest.json'), 'utf8'), '{"complete":true}\n');
  assert.equal(fs.statSync(f.destination).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.destination, 'manifest.json')).mode & 0o777, 0o600);
});
test('private directory publication refuses an existing destination without replacing it', () => {
  const f = fixture(); fs.mkdirSync(f.destination, { mode: 0o700 });
  assert.throws(() => publishDirectoryAtomic(f.staging, f.destination), /destination already exists/);
  assert.deepEqual(fs.readdirSync(f.destination), []);
  assert.equal(fs.existsSync(path.join(f.staging, 'manifest.json')), true);
});
test('directory publication rejects a non-sibling destination before touching evidence', () => {
  const f = fixture(), elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-elsewhere-'));
  assert.throws(() => publishDirectoryAtomic(f.staging, path.join(elsewhere, 'archive')), /same parent/);
  assert.equal(fs.existsSync(path.join(f.staging, 'manifest.json')), true);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
test('directory publication retries transient rename errors and preserves staging after permanent failure', () => {
  const f = fixture(), real = fs.renameSync; let attempts = 0;
  fs.renameSync = (from, to) => { if (++attempts < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return real(from, to); };
  try { publishDirectoryAtomic(f.staging, f.destination); } finally { fs.renameSync = real; }
  assert.equal(attempts, 3); assert.equal(fs.existsSync(path.join(f.destination, 'manifest.json')), true);
  const failed = fixture(); attempts = 0;
  fs.renameSync = () => { attempts++; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  try { assert.throws(() => publishDirectoryAtomic(failed.staging, failed.destination), /ENOSPC/); } finally { fs.renameSync = real; }
  assert.equal(attempts, 1); assert.equal(fs.existsSync(failed.destination), false);
  assert.equal(fs.readFileSync(path.join(failed.staging, 'manifest.json'), 'utf8'), '{"complete":true}\n');
});
test('publication recovers a lock left by a dead publisher', () => {
  const f = fixture(), lock = `${f.destination}.publish-lock`;
  fs.mkdirSync(lock, { mode: 0o700 }); fs.writeFileSync(path.join(lock, 'owner'), '999999999\n');
  publishDirectoryAtomic(f.staging, f.destination);
  assert.equal(fs.existsSync(path.join(f.destination, 'manifest.json')), true);
  assert.equal(fs.existsSync(lock), false);
});
test('publication preserves a live publisher lock and its pending evidence', () => {
  const f = fixture(), lock = `${f.destination}.publish-lock`;
  fs.mkdirSync(lock, { mode: 0o700 }); fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
  assert.throws(() => publishDirectoryAtomic(f.staging, f.destination), /publication lock is held/);
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), `${process.pid}\n`);
  assert.equal(fs.existsSync(path.join(f.staging, 'manifest.json')), true);
  assert.equal(fs.existsSync(f.destination), false);
});
test('publication preserves a fresh ownerless lock', () => {
  const fresh = fixture(), freshLock = `${fresh.destination}.publish-lock`;
  fs.mkdirSync(freshLock, { mode: 0o700 });
  assert.throws(() => publishDirectoryAtomic(fresh.staging, fresh.destination), /publication lock is held/);
  assert.equal(fs.existsSync(freshLock), true); assert.equal(fs.existsSync(fresh.staging), true);
});
test('publication recovers an aged ownerless lock', () => {
  const aged = fixture(), agedLock = `${aged.destination}.publish-lock`;
  fs.mkdirSync(agedLock, { mode: 0o700 });
  const old = new Date(Date.now() - 120000); fs.utimesSync(agedLock, old, old);
  publishDirectoryAtomic(aged.staging, aged.destination);
  assert.equal(fs.existsSync(path.join(aged.destination, 'manifest.json')), true);
  assert.equal(fs.existsSync(agedLock), false);
});
test('publisher records its owner and never removes a lock that changed owner', () => {
  const f = fixture(), lock = `${f.destination}.publish-lock`, real = fs.renameSync;
  fs.renameSync = (from, to) => {
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), `${process.pid}\n`);
    fs.writeFileSync(path.join(lock, 'owner'), '999999999\n');
    return real(from, to);
  };
  try { publishDirectoryAtomic(f.staging, f.destination); } finally { fs.renameSync = real; }
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), '999999999\n');
  assert.equal(fs.existsSync(path.join(f.destination, 'manifest.json')), true);
});
test('an owner-record write failure releases only the newly acquired publication lock', () => {
  const f = fixture(), lock = `${f.destination}.publish-lock`, real = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (file === path.join(lock, 'owner')) throw Object.assign(new Error('owner ENOSPC'), { code: 'ENOSPC' });
    return real(file, ...args);
  };
  try { assert.throws(() => publishDirectoryAtomic(f.staging, f.destination), /owner ENOSPC/); } finally { fs.writeFileSync = real; }
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(f.staging, 'manifest.json')), true);
  assert.equal(fs.existsSync(f.destination), false);
});
