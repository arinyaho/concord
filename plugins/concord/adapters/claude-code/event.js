'use strict';
const fs = require('node:fs');

// Claude Code hook stdin payload -> NeutralEvent. `source` is the caller's
// classification (the hook that fired); Stop -> 'stop', SessionStart passes
// through the payload's own source (startup|resume|compact).
function toNeutralEvent(payload, source) {
  const p = payload || {};
  const ev = {
    sessionId: String(p.session_id || ''),
    transcriptPath: p.transcript_path || '',
    source: source || p.source,
  };
  if (typeof p.last_assistant_message === 'string') ev.lastAssistantMessage = p.last_assistant_message;
  return ev;
}

function readStdinEvent(source) {
  return toNeutralEvent(JSON.parse(fs.readFileSync(0, 'utf8')), source);
}

module.exports = { toNeutralEvent, readStdinEvent };
