#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { dataDir } = require('../runtime/data-dir');
const { readMode, readAllowedTools, allToolNames, decideClaude, DENY_REASON } = require('../core/read-only');

// null for a session without a mode file, which this hook must never break; otherwise a decision. Once a mode file
// is found, any error denies.
function decide() {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
  if (!event || typeof event.session_id !== 'string') return null;
  let mode = null;
  try {
    const dir = dataDir('explain-pr', 'claude');
    mode = readMode(dir, event.session_id);
    if (mode === null) return null;
    const decision = decideClaude(event, mode, mode.kind === 'read' ? allToolNames(readAllowedTools(dir)) : []);
    // A confined kind's allowed call is allowed explicitly: its agent runs where nothing else allows it.
    return { ...decision, explicit: mode.kind !== 'read' };
  } catch {
    return { allow: false, reason: DENY_REASON(mode?.dir || 'the prepared directory') };
  }
}

const decision = decide();
if (decision && (!decision.allow || decision.explicit)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      ...(decision.allow ? {} : { permissionDecisionReason: decision.reason }),
    },
  }));
}
process.exit(0);
