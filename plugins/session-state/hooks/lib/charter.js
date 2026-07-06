'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { NORTH_STAR_MAX } = require('./config');

function charterPath(stateDir) {
  return path.join(stateDir, 'charter.md');
}

// Returns the north-star text, or null if the file is absent/empty.
function readNorthStar(stateDir) {
  try {
    const t = fs.readFileSync(charterPath(stateDir), 'utf8').trim();
    return t ? t : null;
  } catch (e) {
    return null;
  }
}

// Write the draft with an atomic create-exclusive open (flag 'wx'): if charter.md
// does not exist, exactly one parallel fresh session wins the create and the rest
// get EEXIST -> false. This closes the cross-process TOCTOU a read-then-write leaves
// open. If the file exists but is empty/whitespace (a degenerate state — this
// function never writes an empty body), treat it as absent and overwrite.
function writeNorthStarIfAbsent(stateDir, text) {
  const body = String(text || '').trim();
  if (!body) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  const capped = body.slice(0, NORTH_STAR_MAX);
  try {
    fs.writeFileSync(charterPath(stateDir), capped, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
    if (readNorthStar(stateDir) === null) {
      fs.writeFileSync(charterPath(stateDir), capped);
      return true;
    }
    return false;
  }
}

// Deliberate overwrite (from the /charter command). LWW is safe here: rare, user-driven.
function setNorthStar(stateDir, text) {
  const body = String(text || '').trim();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(charterPath(stateDir), body.slice(0, NORTH_STAR_MAX));
}

module.exports = { charterPath, readNorthStar, writeNorthStarIfAbsent, setNorthStar };
