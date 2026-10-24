'use strict';
const path = require('node:path');

function artifactDestinationFromPrompt(prompt, stateDir) {
  if (typeof prompt !== 'string' || typeof stateDir !== 'string') return null;
  const root = path.resolve(stateDir);
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directive = new RegExp(`(?:\\bwrites?\\s+ONLY\\b[\\s\\S]{0,1000}?\\bto|\\bwrite\\s+a\\s+JSON\\s+file\\s+to)\\s+(?:its\\s+own\\s+)?[\`'"]?(${escaped}[/\\\\]round-\\d+-[A-Za-z0-9:._-]+\\.json)[\`'"]?`, 'gi');
  const matches = [...prompt.matchAll(directive)];
  if (matches.length !== 1) return null;
  const destination = path.resolve(matches[0][1]);
  return path.dirname(destination) === root ? destination : null;
}

// The single absolute `round-N-<suffix>.json` destination a prompt directs a reviewer to
// write, whatever directory it names. The caller must verify that directory before
// trusting it; this only parses.
function artifactDestinationAnyDir(prompt) {
  if (typeof prompt !== 'string') return null;
  const directive = /(?:\bwrites?\s+ONLY\b[\s\S]{0,1000}?\bto|\bwrite\s+a\s+JSON\s+file\s+to)\s+(?:its\s+own\s+)?[`'"]?([^\s`'"]+[/\\]round-\d+-[A-Za-z0-9:._-]+\.json)[`'"]?/gi;
  const matches = [...prompt.matchAll(directive)];
  if (matches.length !== 1 || !path.isAbsolute(matches[0][1])) return null;
  return path.resolve(matches[0][1]);
}

module.exports = { artifactDestinationFromPrompt, artifactDestinationAnyDir };
