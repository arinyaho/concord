'use strict';
const fs = require('node:fs');
const path = require('node:path');

// One counter file per session, since resolveStateDirFromTranscript resolves to a
// directory shared by every session under the same project transcript folder.
function counterPath(stateDir, sessionId) {
  return path.join(stateDir, `grep-sweep-count-${path.basename(String(sessionId || 'unknown'))}.json`);
}

function incrementCount(stateDir, sessionId) {
  const file = counterPath(stateDir, sessionId);
  let count = 0;
  try {
    count = JSON.parse(fs.readFileSync(file, 'utf8')).count || 0;
  } catch {
    // No counter yet, or unreadable -- start fresh.
  }
  count += 1;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ count }));
  return count;
}

module.exports = { counterPath, incrementCount };
