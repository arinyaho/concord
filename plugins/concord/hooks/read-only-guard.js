#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { dataDir } = require('../skills/explain-pr/scripts/data-dir');
const { readMode, readAllowedTools, allToolNames, decideClaude } = require('../core/read-only');

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const dir = dataDir(process.env, 'claude');
  const preparedDir = typeof event.session_id === 'string' ? readMode(dir, event.session_id) : null;
  if (preparedDir) {
    const decision = decideClaude(event, { preparedDir, allowedTools: allToolNames(readAllowedTools(dir)) });
    if (!decision.allow) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      }));
    }
  }
} catch {
  // A session outside the mode must never be broken by this hook.
}
process.exit(0);
