'use strict';
const fs = require('node:fs');

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

module.exports = { writeFileAtomic };
