#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { RECENCY_HOURS } = require('./lib/config');

const CONVENTION =
  'Tag durable decisions and open items inline so a hook can persist them across sessions: ' +
  '`DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:`.';

function pickState(stateDir, sessionId, source) {
  if (source === 'resume' || source === 'compact') {
    const p = path.join(stateDir, `${sessionId}.md`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  if (source === 'startup') {
    const p = path.join(stateDir, '_latest.md');
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      return '';
    }
    if ((Date.now() - stat.mtimeMs) / 3.6e6 > RECENCY_HOURS) return '';
    const header =
      '# Prior session state in this project — verify relevance before relying on it\n\n';
    return header + fs.readFileSync(p, 'utf8');
  }
  return '';
}

function main() {
  const { session_id, transcript_path, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!transcript_path) return;
  const stateDir = path.join(path.dirname(transcript_path), 'state');
  const state = pickState(stateDir, session_id, source);
  const parts = [];
  if (state) parts.push(state);
  parts.push(CONVENTION);
  process.stdout.write(parts.join('\n\n'));
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
