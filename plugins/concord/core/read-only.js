'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Codex's PreToolUse names every shell call, unified exec included, `Bash`.
const SHELL_TOOLS = new Set(['Bash']);

function DENY_REASON(dir) {
  return `explain-pr read-only mode: only reading ${dir} and the tools in allowed-tools.json are allowed. /clear or a new session ends the mode.`;
}

function modeFile(dir, sessionId) {
  const id = sessionId;
  if (typeof id !== 'string' || !id || id !== path.basename(id) || id === '.' || id === '..') return null;
  return path.join(dir, 'modes', id);
}

// The fields each mode kind names, every one an absolute path:
// - read: explain-pr's reading session, confined to reading one prepared directory;
// - agent: a confined agent that reads one round directory and writes one output file, after the canary;
// - worktree: a writable headless session that reads and edits a worktree and a session directory, after the canary.
// A confined kind's hook denies every call until it has denied and logged a Read of the canary path, then logs each
// decision to its log file.
const KINDS = {
  read: ['dir'],
  agent: ['dir', 'output', 'canary', 'log'],
  worktree: ['worktree', 'session', 'canary', 'log'],
};

function validMode(mode) {
  const fields = mode && typeof mode === 'object' && !Array.isArray(mode) && Object.hasOwn(KINDS, mode.kind) ? KINDS[mode.kind] : null;
  return Boolean(fields) && fields.every((f) => typeof mode[f] === 'string' && path.isAbsolute(mode[f]));
}

// A session's mode: null exactly when the session has no mode file. A mode file that exists but cannot be read or
// parsed throws, so the caller denies.
function readMode(dir, sessionId) {
  const file = modeFile(dir, sessionId);
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const mode = JSON.parse(text);
  if (!validMode(mode)) throw new Error('invalid mode file');
  return mode;
}

function writeMode(dir, sessionId, mode) {
  const file = modeFile(dir, sessionId);
  if (!file) throw new Error(`invalid session id: ${sessionId}`);
  if (!validMode(mode)) throw new Error('invalid mode');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(mode)}\n`);
}

function removeMode(dir, sessionId) {
  const file = modeFile(dir, sessionId);
  if (file) fs.rmSync(file, { force: true });
}

// Only MCP tools (mcp__<server>__<tool>) can be listed: a hand-edited file naming any other tool lists nothing.
function readAllowedTools(dir) {
  try {
    const trackers = JSON.parse(fs.readFileSync(path.join(dir, 'allowed-tools.json'), 'utf8')).trackers;
    if (!trackers || typeof trackers !== 'object' || Array.isArray(trackers)) return {};
    const out = {};
    for (const [name, list] of Object.entries(trackers)) {
      if (Array.isArray(list)) out[name] = list.filter((t) => typeof t === 'string' && t.startsWith('mcp__'));
    }
    return out;
  } catch {
    return {};
  }
}

function allToolNames(list) {
  return Object.values(list).flat();
}

// Real path of an absolute path p; for a path that does not exist yet, the real path of its
// longest existing ancestor plus the remaining segments. Callers reject ".." segments first,
// so path.resolve cannot fold one away.
function resolveReal(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
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

function hasDotDot(p) {
  return p.split(/[\\/]/).includes('..');
}

// A path-like input: a string, absolute, with no ".." segment, inside realDir after resolving links.
function pathInside(p, realDir) {
  return typeof p === 'string' && !hasDotDot(p) && within(p, realDir);
}

const GLOB_META = /[*?[\]!+@]/;

// A segment that could name "..". A literal segment (no glob metacharacter) only if it is "..".
// A wildcard segment that starts with "." or "[" is denied, whatever a matcher makes of a class
// or an escape there ([.], [!a], [[:punct:]], \.). A wildcard segment that starts with "*" or "?"
// is allowed: glob matchers do not let "*" or "?" match a leading dot by default.
function mayBeDotDot(seg) {
  return GLOB_META.test(seg) ? /^[.[]/.test(seg) : seg === '..';
}

// A glob pattern is allowed when it is relative, has no backslash, no segment that could name
// "..", no brace or group alternatives and no "~" (each can hide an outside location), and its
// literal leading segments, resolved under base, stay inside realDir (a symlink there may leave it).
function patternInside(pattern, base, realDir) {
  if (typeof pattern !== 'string' || path.isAbsolute(pattern) || pattern.includes('\\')) return false;
  if (pattern.split('/').some(mayBeDotDot)) return false;
  if (/[{}()]/.test(pattern) || pattern.startsWith('~')) return false;
  const literal = [];
  for (const seg of pattern.split('/')) {
    if (GLOB_META.test(seg)) break;
    literal.push(seg);
  }
  return within(path.join(base, ...literal), realDir);
}

// Read, Glob or Grep with every path-like input inside realDir.
function readsInside(name, input, realDir) {
  if (name === 'Read') return pathInside(input.file_path, realDir);
  if (name === 'Glob') return pathInside(input.path, realDir) && patternInside(input.pattern, input.path, realDir);
  if (name === 'Grep') return pathInside(input.path, realDir) && (input.glob === undefined || patternInside(input.glob, input.path, realDir));
  return false;
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// explain-pr's reading session. Every call is checked, a subagent's included. ToolSearch only returns tool
// definitions; it is how a deferred tool on the list becomes callable. An allowed call gets no explicit decision.
function decideRead(event, preparedDir, allowedTools) {
  const realDir = realOrNull(preparedDir);
  const name = event.tool_name;
  const ok = realDir !== null && (['Read', 'Glob', 'Grep'].includes(name)
    ? readsInside(name, event.tool_input || {}, realDir)
    : name === 'ToolSearch' || allowedTools.includes(name));
  return ok ? { allow: true } : { allow: false, reason: DENY_REASON(preparedDir) };
}

function canaryLogged(log) {
  let text;
  try {
    text = fs.readFileSync(log, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  return text.split('\n').some((line) => {
    try {
      return JSON.parse(line).canary === true;
    } catch {
      return false;
    }
  });
}

function confinedAllows(mode, name, input) {
  if (mode.kind === 'agent') {
    const realDir = realOrNull(mode.dir);
    if (realDir === null) return false;
    if (name === 'Write') {
      const p = input.file_path;
      return typeof p === 'string' && !hasDotDot(p) && resolveReal(p) !== null && resolveReal(p) === resolveReal(mode.output);
    }
    return readsInside(name, input, realDir);
  }
  const dirs = [mode.worktree, mode.session].map(realOrNull).filter((d) => d !== null);
  if (dirs.length !== 2) return false;
  if (name === 'Edit' || name === 'Write') return dirs.some((d) => pathInside(input.file_path, d));
  return dirs.some((d) => readsInside(name, input, d));
}

// A confined agent or a writable headless session. Until the log holds a denied Read of the canary path, every call
// is denied; that first denial is how the launching script knows the hook ran. Each decision is logged (tool name and
// decision only), and a call that cannot be logged is denied by the caller.
function decideConfined(event, mode) {
  const name = String(event.tool_name);
  const input = event.tool_input || {};
  const started = canaryLogged(mode.log);
  const canary = !started && name === 'Read' && input.file_path === mode.canary;
  const allow = started && confinedAllows(mode, name, input);
  fs.appendFileSync(mode.log, `${JSON.stringify({ tool: name, decision: allow ? 'allow' : 'deny', ...(canary ? { canary: true } : {}) })}\n`);
  if (allow) return { allow: true };
  return { allow: false, reason: started ? CONFINED_REASON(mode.kind) : `Concord confined mode: read ${mode.canary} first; it is denied.` };
}

function CONFINED_REASON(kind) {
  return kind === 'agent'
    ? 'Concord confined agent: only reading the round directory and writing the one output file are allowed.'
    : 'Concord headless session: only reading and editing files in the worktree and the session directory are allowed.';
}

function decideClaude(event, mode, allowedTools = []) {
  return mode.kind === 'read' ? decideRead(event, mode.dir, allowedTools) : decideConfined(event, mode);
}

// The marker a launcher puts in a confined agent's round directory under prs/.
const AGENT_MARKER = '.concord-confined-agent';

// The paths an apply_patch input names, resolved against cwd; null when one has a ".." segment or none is named.
function patchPaths(patch, cwd) {
  if (typeof patch !== 'string') return null;
  const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1].trim());
  if (!paths.length || paths.some(hasDotDot)) return null;
  return paths.map((p) => path.resolve(cwd, p));
}

function decideCodex(event, { prsRoot, allowedTools, sessionRoot }) {
  if (typeof event.cwd !== 'string') return { allow: true };
  const name = String(event.tool_name);
  const realSessions = sessionRoot ? realOrNull(sessionRoot) : null;
  if (realSessions !== null && within(event.cwd, realSessions)) {
    // A pr-to-merge headless session: the permissions profile is the boundary; patches stay in its two directories.
    const id = path.relative(realSessions, resolveReal(event.cwd)).split(path.sep)[0];
    const dirs = id ? ['worktree', 'session'].map((d) => realOrNull(path.join(realSessions, id, d))) : [];
    const deny = { allow: false, reason: CONFINED_REASON('worktree') };
    if (name.startsWith('mcp__')) return deny;
    if (name !== 'apply_patch') return { allow: true };
    const paths = patchPaths((event.tool_input || {}).command, resolveReal(event.cwd));
    const inside = paths !== null && dirs.length === 2 && dirs.every((d) => d !== null)
      && paths.every((p) => dirs.some((d) => within(p, d)));
    return inside ? { allow: true } : deny;
  }
  const realRoot = realOrNull(prsRoot);
  if (realRoot === null) return { allow: true }; // nothing has been prepared, so no session reads here
  if (!within(event.cwd, realRoot)) return { allow: true };
  const round = path.relative(realRoot, resolveReal(event.cwd)).split(path.sep)[0];
  const agent = Boolean(round) && fs.existsSync(path.join(realRoot, round, AGENT_MARKER));
  if (SHELL_TOOLS.has(name) || (!agent && allowedTools.includes(name))) return { allow: true };
  return { allow: false, reason: agent ? CONFINED_REASON('agent') : DENY_REASON(prsRoot) };
}

module.exports = {
  readMode, writeMode, removeMode, readAllowedTools, allToolNames,
  decideClaude, decideCodex, DENY_REASON, CONFINED_REASON, AGENT_MARKER,
};
