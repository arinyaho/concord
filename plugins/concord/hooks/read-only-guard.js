#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { dataDir } = require('../skills/explain-pr/scripts/data-dir');
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
  let preparedDir = null;
  try {
    const dir = dataDir(process.env, 'claude');
    preparedDir = readMode(dir, event.session_id);
    if (preparedDir === null) return null;
    return decideClaude(event, { preparedDir, allowedTools: allToolNames(readAllowedTools(dir)) });
  } catch {
    return { allow: false, reason: DENY_REASON(preparedDir || 'the prepared directory') };
  }
}

const decision = decide();
if (decision && !decision.allow) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  }));
}
process.exit(0);
