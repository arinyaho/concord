'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { lockOwner, reclaimStaleLock } = require('./run-lock');

// Windows can fail a rename over a file another process holds open (antivirus, indexer, sync client).
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const ATTEMPTS = 6;
const BASE_DELAY_MS = 10;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Temp file + rename so a reader never sees partial content. Retries transient
// rename failures with doubling backoff; on giving up it removes the temp file and throws.
function writeFileAtomic(file, data, options) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, options);
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (error) {
        if (!error || !RETRYABLE.has(error.code) || attempt >= ATTEMPTS) throw error;
        sleepSync(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) { /* temp may not exist */ }
    throw error;
  }
}

// Publish an already-complete private directory in one rename. Serialize
// competing publishers, reject replacement, and leave failed staging cleanup
// to the caller so its original evidence remains available.
function publishDirectoryAtomic(staging, destination) {
  staging = path.resolve(staging);
  destination = path.resolve(destination);
  if (path.dirname(staging) !== path.dirname(destination)) throw new Error('atomic directory: staging and destination must have the same parent');
  if (!fs.lstatSync(staging).isDirectory()) throw new Error('atomic directory: staging must be a regular directory');
  const lock = `${destination}.publish-lock`;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reclaimStaleLock(lock)) continue;
      throw new Error(`atomic directory: publication lock is held: ${lock} (owner ${lockOwner(lock) || 'unknown'})`);
    }
  }
  const acquired = fs.statSync(lock);
  let ownerRecorded = false;
  try {
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`, { mode: 0o600 });
    ownerRecorded = true;
    for (let attempt = 1; ; attempt++) {
      if (fs.existsSync(destination)) throw new Error('atomic directory: destination already exists');
      try {
        fs.renameSync(staging, destination);
        return;
      } catch (error) {
        if (!error || !RETRYABLE.has(error.code) || attempt >= ATTEMPTS) throw error;
        sleepSync(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  } finally {
    let stillOurs = false;
    try {
      const current = fs.statSync(lock), owner = lockOwner(lock);
      stillOurs = current.dev === acquired.dev && current.ino === acquired.ino && (owner === process.pid || (!ownerRecorded && owner === null));
    } catch {}
    if (stillOurs) fs.rmSync(lock, { recursive: true, force: true });
  }
}

module.exports = { writeFileAtomic, publishDirectoryAtomic };
