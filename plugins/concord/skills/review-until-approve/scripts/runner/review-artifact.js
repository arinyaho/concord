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

module.exports = { artifactDestinationFromPrompt };
