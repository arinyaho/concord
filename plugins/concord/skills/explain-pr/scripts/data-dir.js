'use strict';
const os = require('node:os');
const path = require('node:path');

// The explain-pr data directory: EXPLAIN_PR_DIR; else under Claude Code (session id set)
// <config dir or ~/.claude>/concord/explain-pr; else <CODEX_HOME or ~/.codex>/concord/explain-pr.
function dataDir(env = process.env) {
  if (env.EXPLAIN_PR_DIR) return env.EXPLAIN_PR_DIR;
  const base = env.CLAUDE_CODE_SESSION_ID
    ? env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    : env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'concord', 'explain-pr');
}

module.exports = { dataDir };
