#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { resolveStateDirFromTranscript } = require('../adapters/claude-code/statedir');
const { incrementCount } = require('../adapters/claude-code/grep-sweep-reminder');
const { isSearchSweepCommand, shouldRemind, reminderText } = require('../core/grep-sweep-reminder');

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (event.tool_name === 'Bash' && isSearchSweepCommand(event.tool_input && event.tool_input.command)) {
    const stateDir = resolveStateDirFromTranscript(event.transcript_path || '');
    const count = incrementCount(stateDir, event.session_id);
    if (shouldRemind(count)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: reminderText(count),
        },
      }));
    }
  }
} catch {
  // This reminder is advisory and must never block the tool call.
}
process.exit(0);
