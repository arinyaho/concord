'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Concord's per-user state directory of a harness: <CLAUDE_CONFIG_DIR or ~/.claude>/concord under Claude Code, and
// <CODEX_HOME or ~/.codex>/concord under Codex. The harness is always passed: a hook's environment need not carry the
// session id, and a watcher and its check run outside any harness.
function baseDir(harness, env = process.env) {
  if (harness === 'claude') return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'concord');
  if (harness === 'codex') return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'concord');
  throw new Error(`unknown harness ${harness}`);
}

// A skill's per-user data directory, <base>/<skill>. EXPLAIN_PR_DIR overrides explain-pr's.
function dataDir(skill, harness, env = process.env) {
  if (skill === 'explain-pr' && env.EXPLAIN_PR_DIR) return env.EXPLAIN_PR_DIR;
  return path.join(baseDir(harness, env), skill);
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

module.exports = { baseDir, dataDir, ensureDataDir, sessionRoot };
