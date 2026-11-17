'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A skill's per-user data directory: <CLAUDE_CONFIG_DIR or ~/.claude>/concord/<skill> under Claude Code, and
// <CODEX_HOME or ~/.codex>/concord/<skill> under Codex. EXPLAIN_PR_DIR overrides explain-pr's. The caller names the
// harness, since a hook's environment need not carry the session id.
function dataDir(skill, harness, env = process.env) {
  if (skill === 'explain-pr' && env.EXPLAIN_PR_DIR) return env.EXPLAIN_PR_DIR;
  const base = harness === 'claude'
    ? env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    : env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'concord', skill);
}

// The same directory, created owner-only (0700 on POSIX; on Windows a mode does not restrict access).
function ensureDataDir(skill, harness, env = process.env) {
  const dir = dataDir(skill, harness, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

// pr-to-merge's session-worktree root: session <id> edits <root>/<id>/worktree and <root>/<id>/session.
function sessionRoot(harness, env = process.env) {
  return path.join(dataDir('pr-to-merge', harness, env), 'sessions');
}

module.exports = { dataDir, ensureDataDir, sessionRoot };
