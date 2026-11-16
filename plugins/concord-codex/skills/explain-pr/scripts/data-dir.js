'use strict';
const os = require('node:os');
const path = require('node:path');

// The explain-pr data directory: EXPLAIN_PR_DIR; else under Claude Code (harness 'claude', or
// no harness and a session id set) <config dir or ~/.claude>/concord/explain-pr; else
// <CODEX_HOME or ~/.codex>/concord/explain-pr. Hooks pass their harness, since a hook's
// environment need not carry the session id.
function dataDir(env = process.env, harness) {
  if (env.EXPLAIN_PR_DIR) return env.EXPLAIN_PR_DIR;
  const claude = harness ? harness === 'claude' : Boolean(env.CLAUDE_CODE_SESSION_ID);
  const base = claude
    ? env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    : env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'concord', 'explain-pr');
}

module.exports = { dataDir };
