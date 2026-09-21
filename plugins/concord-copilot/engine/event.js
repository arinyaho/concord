'use strict';
const fs = require('node:fs');

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

function toNeutralEvent(payload) {
  const event = payload || {};
  return {
    sessionId: String(event.session_id || ''),
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    source: typeof event.source === 'string' ? event.source : undefined,
    prompt: typeof event.prompt === 'string' ? event.prompt : undefined,
  };
}

function readStdinEvent() {
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > MAX_HOOK_INPUT_BYTES) {
    throw new Error('Copilot hook input exceeds 1 MiB');
  }
  return toNeutralEvent(JSON.parse(input));
}

module.exports = { MAX_HOOK_INPUT_BYTES, toNeutralEvent, readStdinEvent };