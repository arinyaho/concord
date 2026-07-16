'use strict';
const os = require('node:os');
const path = require('node:path');

// Mirror Claude Code's project-dir encoding: the config dir honors CLAUDE_CONFIG_DIR,
// and the slug replaces BOTH '/' and '.' with '-' (a `.claude` segment becomes
// `--claude`). Shared by any CLI that needs the same project-scoped state dir a
// cwd-driven hook would resolve to. Callers apply their own env-var override (e.g.
// CHARTER_STATE_DIR, REVIEW_STATE_DIR) on top of this -- this function has no
// override of its own.
function resolveStateDirFromCwd() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const slug = process.cwd().replace(/[/.]/g, '-');
  return path.join(configDir, 'projects', slug, 'state');
}

// The SessionStart/Stop hook payload carries the transcript path directly, so hooks
// derive the state dir as a sibling "state" directory rather than reconstructing it
// from cwd (a hook's cwd is not guaranteed to be the project root).
function resolveStateDirFromTranscript(transcriptPath) {
  return path.join(path.dirname(String(transcriptPath)), 'state');
}

module.exports = { resolveStateDirFromCwd, resolveStateDirFromTranscript };
