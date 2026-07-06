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

// Write the draft ONLY if no non-empty north-star exists (first-writer-wins).
// Returns whether it wrote. Parallel fresh sessions cannot clobber each other.
function writeNorthStarIfAbsent(stateDir, text) {
  if (readNorthStar(stateDir) !== null) return false;
  const body = String(text || '').trim();
  if (!body) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(charterPath(stateDir), body.slice(0, NORTH_STAR_MAX));
  return true;
}

// Deliberate overwrite (from the /charter command). LWW is safe here: rare, user-driven.
function setNorthStar(stateDir, text) {
  const body = String(text || '').trim();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(charterPath(stateDir), body.slice(0, NORTH_STAR_MAX));
}

module.exports = { charterPath, readNorthStar, writeNorthStarIfAbsent, setNorthStar };
