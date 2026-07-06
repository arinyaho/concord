'use strict';
const fs = require('node:fs');

// Read new JSONL entries appended since `offset` bytes. Advances the offset only
// to the last complete line, so a partial line mid-write is re-read next time.
// Treats a file smaller than `offset` as rewritten and re-reads from 0.
function readDelta(transcriptPath, offset) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (e) {
    return { entries: [], newOffset: offset };
  }
  const start = offset > stat.size ? 0 : offset;
  if (stat.size - start <= 0) return { entries: [], newOffset: stat.size };

  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { entries: [], newOffset: start };
    const complete = text.slice(0, lastNl + 1);
    const consumed = Buffer.byteLength(complete, 'utf8');
    const entries = [];
    for (const line of complete.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch (e) {
        /* skip malformed line */
      }
    }
    return { entries, newOffset: start + consumed };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readDelta };
