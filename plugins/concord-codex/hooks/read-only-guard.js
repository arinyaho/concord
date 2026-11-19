#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dataDir, sessionRoot } = require('../runtime/data-dir');
const { readAllowedTools, allToolNames, decideCodex } = require('../engine/read-only');

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const dir = dataDir('explain-pr', 'codex');
  const decision = decideCodex(event, {
    prsRoot: path.join(dir, 'prs'), allowedTools: allToolNames(readAllowedTools(dir)), sessionRoot: sessionRoot('codex'),
  });
  if (!decision.allow) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    }));
  }
} catch {
  // A session outside the mode must never be broken by this hook.
}
process.exit(0);
