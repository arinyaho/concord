'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveDataRoot(env = process.env) {
  return env.CONCORD_COPILOT_HOME ||
    env.PLUGIN_DATA ||
    env.COPILOT_PLUGIN_DATA ||
    env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.copilot', 'concord');
}

function canonicalProjectRoot(cwd) {
  if (!cwd) throw new Error('Copilot hook did not provide a working directory');
  const absolute = path.resolve(cwd);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    return absolute;
  }
}

function projectKey(cwd) {
  return crypto.createHash('sha256').update(canonicalProjectRoot(cwd)).digest('hex');
}

function resolveStateDir(cwd, env = process.env) {
  return path.join(resolveDataRoot(env), 'projects', projectKey(cwd), 'state');
}

function ensureStateDir(cwd, env = process.env) {
  const stateDir = resolveStateDir(cwd, env);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(stateDir, 0o700);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
  return stateDir;
}

module.exports = { resolveDataRoot, canonicalProjectRoot, projectKey, resolveStateDir, ensureStateDir };