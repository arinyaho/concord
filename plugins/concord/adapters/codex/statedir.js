'use strict';
const os = require('node:os');
const path = require('node:path');

// Codex StateDirPort. Rooted at Codex's config dir (CODEX_HOME, default ~/.codex),
// namespaced under `concord/` so Concord's per-project state never collides with
// Codex's own sessions/, plugins/, logs. Same cwd->slug encoding the Claude Code
// resolver uses. Like that resolver, this has NO env override of its own --
// REVIEW_STATE_DIR is applied one layer up by core/review-cli.js's resolveStateDir().
function resolveStateDirFromCwd() {
  const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const slug = process.cwd().replace(/[/.]/g, '-');
  return path.join(configDir, 'concord', 'projects', slug, 'state');
}

module.exports = { resolveStateDirFromCwd };
