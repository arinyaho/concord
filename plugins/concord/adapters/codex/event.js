'use strict';
const fs = require('node:fs');
// Codex hook stdin payload -> NeutralEvent. Payload keys match Claude Code's;
// additionally carries `cwd` (Codex resolves its state dir from the session cwd).
function toNeutralEvent(payload, source) {
  const p = payload || {};
  const ev = {
    sessionId: String(p.session_id || ''),
    transcriptPath: p.transcript_path || '',
    cwd: p.cwd || '',
    source: source || p.source,
  };
  if (typeof p.last_assistant_message === 'string') ev.lastAssistantMessage = p.last_assistant_message;
  return ev;
}
function readStdinEvent(source) {
  return toNeutralEvent(JSON.parse(fs.readFileSync(0, 'utf8')), source);
}
module.exports = { toNeutralEvent, readStdinEvent };
