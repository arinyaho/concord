#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { readStdinEvent } = require('../engine/event');
const { readNorthStar, mergeSessions, renderCharter } = require('../engine/charter');
const { resolveStateDirFromCwd } = require('../engine/statedir');

const CONVENTION =
  'Tag durable decisions and open items inline so a hook can persist them across sessions: ' +
  '`DECISION:` / `OPEN-LOOP:` / `NEXT:` / `RESOLVED:`.';

// The background watchers' pending lines, shown to the user (see the pr-to-merge skill's watcher.js).
function withNotices(context) {
  try {
    return require('../skills/pr-to-merge/scripts/watcher').sessionStartOutput(context, 'codex');
  } catch {
    return context;
  }
}

function main() {
  const { sessionId, transcriptPath } = readStdinEvent();
  if (!transcriptPath) {
    process.stdout.write(withNotices(''));
    return;
  }
  const sid = path.basename(String(sessionId || ''));
  const stateDir = resolveStateDirFromCwd();

  // catchUpSessions is not wired here: it guesses an abandoned session's transcript
  // at `dirname(stateDir)/<sid>.jsonl`, a Claude-Code colocated layout. Codex rollouts
  // live at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, unrelated to the cwd-derived
  // stateDir, so that guess always misses and the call would silently no-op. Each
  // session's own Stop hook persists its state as it goes, and mergeSessions below
  // still reads all persisted session states -- so catch-up just isn't needed/available
  // on this harness.

  const northStar = readNorthStar(stateDir);
  const merged = mergeSessions(stateDir); // include self: on resume/compact we WANT the resuming session own decisions back — dedup absorbs the overlap
  const hasContent = northStar || merged.openLoops.length || merged.decisions.length || merged.nexts.length;

  const parts = [];
  if (hasContent) {
    const header = '# Prior task context in this project — verify relevance before relying on it\n';
    parts.push(header + '\n' + renderCharter(northStar, merged));
  }
  parts.push(CONVENTION);
  process.stdout.write(withNotices(parts.join('\n\n')));
}

try {
  main();
} catch (e) {
  /* never block session start */
}
process.exit(0);
