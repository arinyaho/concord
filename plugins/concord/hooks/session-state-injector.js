#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readNorthStar, mergeSessions, renderCharter, catchUpSessions } = require('./lib/charter');

const CONVENTION =
  'Tag durable decisions and open items inline so a hook can persist them across sessions: ' +
  '`DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:`.';

function main() {
  const { session_id, transcript_path, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!transcript_path) return;
  const sid = path.basename(String(session_id || ''));
  const stateDir = path.join(path.dirname(transcript_path), 'state');

  // Durability: fold any abandoned session's un-watermarked tail before reading.
  catchUpSessions(stateDir, { currentSid: sid });

  const northStar = readNorthStar(stateDir);
  const merged = mergeSessions(stateDir); // include self: on resume/compact we WANT the resuming session own decisions back — dedup absorbs the overlap
  const hasContent = northStar || merged.openLoops.length || merged.decisions.length || merged.nexts.length;

  const parts = [];
  if (hasContent) {
    const header = '# Prior task context in this project — verify relevance before relying on it\n';
    parts.push(header + '\n' + renderCharter(northStar, merged));
  }
  parts.push(CONVENTION);
  process.stdout.write(parts.join('\n\n'));
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
