'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SHELL_TOOLS = new Set(['shell', 'exec_command', 'local_shell']);

function DENY_REASON(dir) {
  return `explain-pr read-only mode: only reading ${dir} and the tools in allowed-tools.json are allowed. /clear or a new session ends the mode.`;
}

function modeFile(dir, sessionId) {
  const id = String(sessionId);
  if (!id || id !== path.basename(id) || id === '.' || id === '..') return null;
  return path.join(dir, 'modes', id);
}

function readMode(dir, sessionId) {
  const file = modeFile(dir, sessionId);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeMode(dir, sessionId, preparedDir) {
  const file = modeFile(dir, sessionId);
  if (!file) throw new Error(`invalid session id: ${sessionId}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${fs.realpathSync(preparedDir)}\n`);
}

function pruneModes(dir, nowMs, maxAgeDays = 30) {
  const modes = path.join(dir, 'modes');
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(modes);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(modes, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > maxAgeDays * 864e5) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // vanished between readdir and stat
    }
  }
  return removed;
}

function readAllowedTools(dir) {
  try {
    const trackers = JSON.parse(fs.readFileSync(path.join(dir, 'allowed-tools.json'), 'utf8')).trackers;
    if (!trackers || typeof trackers !== 'object' || Array.isArray(trackers)) return {};
    const out = {};
    for (const [name, list] of Object.entries(trackers)) {
      if (Array.isArray(list)) out[name] = list.filter((t) => typeof t === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function allToolNames(list) {
  return Object.values(list).flat();
}

// Real path of p; for a path that does not exist yet, the real path of its longest
// existing ancestor plus the remaining segments. null when a remaining segment is "..".
function resolveReal(p) {
  if (typeof p !== 'string' || !p) return null;
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.some((s) => s === '..') ? null : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function within(p, realDir) {
  const real = resolveReal(p);
  return real !== null && (real === realDir || real.startsWith(realDir + path.sep));
}

// path.resolve would fold ".." away, so check the raw segments first.
function hasDotDot(p) {
  return p.split(/[\\/]/).includes('..');
}

function badPattern(p) {
  return typeof p !== 'string' || path.isAbsolute(p) || hasDotDot(p);
}

function rawDotDot(p) {
  return typeof p !== 'string' || hasDotDot(p);
}

function decideClaude(event, { preparedDir, allowedTools }) {
  if (event.agent_id) return { allow: true };
  const deny = { allow: false, reason: DENY_REASON(preparedDir) };
  let realDir;
  try {
    realDir = fs.realpathSync(preparedDir);
  } catch {
    return deny;
  }
  const input = event.tool_input || {};
  const name = event.tool_name;
  let ok = false;
  if (name === 'Read') {
    ok = !rawDotDot(input.file_path) && within(input.file_path, realDir);
  } else if (name === 'Glob') {
    ok = !rawDotDot(input.path) && within(input.path, realDir) && !badPattern(input.pattern);
  } else if (name === 'Grep') {
    ok = !rawDotDot(input.path) && within(input.path, realDir) && (input.glob === undefined || !badPattern(input.glob));
  } else {
    ok = allowedTools.includes(name);
  }
  return ok ? { allow: true } : deny;
}

function decideCodex(event, { prsRoot, allowedTools }) {
  if (typeof event.cwd !== 'string') return { allow: true };
  let realRoot;
  try {
    realRoot = fs.realpathSync(prsRoot);
  } catch {
    return { allow: true }; // nothing has been prepared, so no session reads here
  }
  if (!within(event.cwd, realRoot)) return { allow: true };
  const name = String(event.tool_name);
  if (SHELL_TOOLS.has(name) || allowedTools.includes(name)) return { allow: true };
  return { allow: false, reason: DENY_REASON(prsRoot) };
}

module.exports = {
  readMode, writeMode, pruneModes, readAllowedTools, allToolNames,
  decideClaude, decideCodex, DENY_REASON,
};
