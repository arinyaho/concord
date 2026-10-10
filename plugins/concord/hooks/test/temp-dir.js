'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];
process.once('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// Creates a directory under the system temp directory and removes it when the test process exits.
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

module.exports = { tempDir };
