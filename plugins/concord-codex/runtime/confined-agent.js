'use strict';
// Starts one confined agent process (`claude -p` or `codex exec`) and returns only its output file. Two kinds:
// - agent: reads one round directory and writes one output file in a fresh owner-only output directory;
// - worktree: a writable headless session that reads and edits a worktree and a session directory, and writes its
//   result file in the session directory.
// The result is { status } with status 'ok' (and output), 'cannot start', 'hook did not run', 'preflight failed'
// (and reason), or 'malformed output' (and reason). Nothing the agent prints is read.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { dataDir, sessionRoot } = require('./data-dir');
const { configuredServers, BARE } = require('./codex-servers');
const { isWindows, crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');

// The core module sits in core/ in the Claude plugin and in engine/ in the Codex package.
const readOnly = require(['core', 'engine'].map((d) => path.join(__dirname, '..', d, 'read-only.js')).find((p) => fs.existsSync(p)));

const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const GRACE_MS = 5000;
const PREFLIGHT_MS = 60 * 1000;

// The variables a child keeps; every other one, the GitHub token included, is dropped.
const ENV_COMMON = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
const ENV_HARNESS = {
  claude: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  codex: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
};

function childEnv(harness, env, extra = {}) {
  const out = {};
  for (const k of [...ENV_COMMON, ...ENV_HARNESS[harness]]) if (env[k] !== undefined) out[k] = env[k];
  return { ...out, ...extra };
}

const real = (p) => fs.realpathSync(p);
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);

// Claude Code: the read-only hook is the only setting; whatever it does not allow is refused, never prompted.
function claudeArgs({ kind, sessionId, model, effort, prompt }) {
  const guard = path.join(__dirname, '..', 'hooks', 'read-only-guard.js');
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(guard)}` }] }] } };
  return ['-p', '--session-id', sessionId, '--setting-sources', '', '--settings', JSON.stringify(settings),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--tools', kind === 'agent' ? 'Read,Grep,Glob,Write' : 'Read,Grep,Glob,Edit,Write',
    '--strict-mcp-config', '--no-session-persistence',
    ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    // --tools takes several values, so a prompt on argv follows `--`; on win32 it goes on stdin.
    ...(isWindows ? [] : ['--', prompt])];
}

// Codex: explain-pr's reading-session switches adapted for exec, as a permissions profile on the command line.
function codexProfile({ reads, writes }) {
  const entries = [['":minimal"', 'read'], ...reads.map((d) => [JSON.stringify(d), 'read']), ...writes.map((d) => [JSON.stringify(d), 'write']),
    ['"/tmp"', 'none'], ['"/var/tmp"', 'none']];
  return ['-c', 'default_permissions="concord"', '-c', `permissions.concord.filesystem={${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`];
}

// Every MCP server of the user's config.toml is switched off; null when one cannot be (an unparsed form, an id that is
// not a bare key), so the agent does not start.
function codexServersOff(env) {
  const servers = configuredServers(env);
  if (servers.some((id) => !BARE.test(id))) return null;
  return servers.flatMap((id) => ['-c', `mcp_servers.${id}.enabled=false`]);
}

function codexArgs({ cwd, profile, serversOff, model, effort, prompt }) {
  return ['exec', '--ephemeral', '--skip-git-repo-check', '-C', cwd, ...profile,
    '-c', 'web_search="disabled"', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'multi_agent', '--disable', 'image_generation', '-c', 'shell_environment_policy.inherit="core"',
    ...serversOff,
    ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    isWindows ? '-' : prompt];
}

function sandboxRun(bin, profile, cwd, command, env) {
  try {
    const r = spawnSync(crossPlatformCommand(bin, cwd), crossPlatformArgs(['sandbox', ...profile, '--', ...command], needsDoubleEscape(bin, cwd)),
      crossPlatformOpts({ cwd, env, stdio: 'ignore', timeout: PREFLIGHT_MS, windowsHide: true }));
    return r.error ? null : r.status;
  } catch {
    return null;
  }
}

// Run under the profile without a model, in the agent's working directory (`codex sandbox` takes `-C` only with a
// named profile): a listing of the readable directory must succeed (the sandbox runs), the
// listing of the user's home must be refused, and for a writable session the network must be refused.
function codexPreflight({ bin, profile, cwd, env, network }) {
  const list = (dir) => (isWindows ? ['cmd.exe', '/d', '/c', 'dir', dir] : ['/bin/ls', dir]);
  if (sandboxRun(bin, profile, cwd, list(cwd), env) !== 0) return 'sandbox did not run';
  if (sandboxRun(bin, profile, cwd, list(os.homedir()), env) === 0) return 'home readable';
  // curl exits 6 when the host cannot be resolved and 7 when the connection is refused.
  if (network && ![6, 7].includes(sandboxRun(bin, profile, cwd, ['curl', '-sS', '-m', '10', '-o', isWindows ? 'NUL' : '/dev/null', 'https://api.github.com'], env))) return 'network reachable';
  return null;
}

function killTree(child, signal) {
  if (!child.pid) return;
  if (isWindows) {
    spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

// Runs the child to its end. Past the time limit, or once the output file grows past the size limit, the process
// group is stopped and the reason returned.
function runChild({ bin, args, cwd, env, prompt, output, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(crossPlatformCommand(bin, cwd), crossPlatformArgs(args, needsDoubleEscape(bin, cwd)),
        crossPlatformOpts({ cwd, env, stdio: [isWindows ? 'pipe' : 'ignore', 'ignore', 'ignore'], detached: !isWindows, windowsHide: true }));
    } catch {
      resolve({ started: false });
      return;
    }
    let limit = null;
    const stop = (reason) => {
      if (limit) return;
      limit = reason;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop('late'), timeoutMs);
    const poll = setInterval(() => {
      try { if (fs.statSync(output).size > maxBytes) stop('too large'); } catch { /* not written yet */ }
    }, 1000);
    const done = (started) => {
      clearTimeout(timer);
      clearInterval(poll);
      killTree(child, 'SIGKILL');
      resolve({ started, limit });
    };
    child.once('error', () => done(false));
    child.once('close', () => done(true));
    if (isWindows) {
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    }
  });
}

function readOutput(output, maxBytes) {
  let st;
  try { st = fs.lstatSync(output); } catch { return { status: 'malformed output', reason: 'missing' }; }
  if (!st.isFile()) return { status: 'malformed output', reason: 'missing' };
  if (st.size > maxBytes) return { status: 'malformed output', reason: 'too large' };
  return { status: 'ok', output: fs.readFileSync(output, 'utf8') };
}

function canaryLogged(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).canary === true; } catch { return false; } });
  } catch {
    return false;
  }
}

// opts: harness ('claude' | 'codex'); kind ('agent' | 'worktree'); prompt; model; effort; env (default process.env);
// bin (default the harness name); timeoutMs; maxBytes.
// agent: dir (the round directory), outputDir (created here; must not exist), outputName.
// worktree: worktree, session (both existing), outputName (the result file in the session directory; must not exist).
async function runConfined(opts) {
  const { harness, kind, model, effort } = opts;
  const env = opts.env || process.env;
  const bin = opts.bin || harness;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const cleanup = [];
  try {
    let reads; let writes; let cwd; let output;
    try {
      if (!['claude', 'codex'].includes(harness) || !['agent', 'worktree'].includes(kind) || !/^[\w.-]+$/.test(opts.outputName || '')) throw new Error('bad options');
      if (kind === 'agent') {
        const dir = real(opts.dir);
        // Fresh and owner-only: nothing but this agent can have put a file there.
        fs.mkdirSync(opts.outputDir, { mode: 0o700 });
        const outDir = real(opts.outputDir);
        reads = [dir];
        writes = [outDir];
        output = path.join(outDir, opts.outputName);
        cwd = dir;
      } else {
        const worktree = real(opts.worktree);
        const session = real(opts.session);
        output = path.join(session, opts.outputName);
        if (fs.existsSync(output)) throw new Error('result file exists');
        reads = [worktree, session];
        writes = [worktree, session];
        cwd = worktree;
      }
    } catch {
      return { status: 'cannot start' };
    }

    let args;
    let childCwd = cwd;
    let extraEnv = {};
    let log = null;
    let prompt = opts.prompt;
    if (harness === 'claude') {
      const modes = dataDir('explain-pr', 'claude', env);
      const sessionId = crypto.randomUUID();
      log = path.join(modes, 'modes', `${sessionId}.log`);
      const canary = path.join(reads[0], `.canary-${sessionId}`);
      const mode = kind === 'agent'
        ? { kind, dir: reads[0], output, canary, log }
        : { kind, worktree: reads[0], session: reads[1], canary, log };
      cleanup.push(() => readOnly.removeMode(modes, sessionId), () => fs.rmSync(log, { force: true }));
      try {
        readOnly.writeMode(modes, sessionId, mode);
      } catch {
        return { status: 'cannot start' };
      }
      // A review agent starts in an empty directory outside the round directory, so nothing there loads as settings.
      if (kind === 'agent') {
        childCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-agent-'));
        cleanup.push(() => fs.rmSync(childCwd, { recursive: true, force: true }));
      }
      extraEnv = { EXPLAIN_PR_DIR: modes };
      prompt = `Your first tool call must be a Read of ${canary}; it is denied, and that denial turns on your tools.\n\n${prompt}`;
      args = claudeArgs({ kind, sessionId, model, effort, prompt });
    } else {
      const serversOff = codexServersOff(env);
      let root = null;
      try { root = real(kind === 'agent' ? path.join(dataDir('explain-pr', 'codex', env), 'prs') : sessionRoot('codex', env)); } catch { /* none */ }
      // The Codex hook recognizes the session by its working directory under this root.
      if (!serversOff || !root || cwd === root || !within(cwd, root)) return { status: 'cannot start' };
      const profile = codexProfile({ reads, writes });
      const sandboxEnv = childEnv('codex', env);
      const failed = codexPreflight({ bin, profile, cwd, env: sandboxEnv, network: kind === 'worktree' });
      if (failed) return { status: 'preflight failed', reason: failed };
      if (kind === 'agent') {
        // The Codex hook knows a confined agent by this marker in its round directory under prs/.
        const marker = path.join(root, path.relative(root, cwd).split(path.sep)[0], readOnly.AGENT_MARKER);
        fs.writeFileSync(marker, '');
        cleanup.push(() => fs.rmSync(marker, { force: true }));
      }
      args = codexArgs({ cwd, profile, serversOff, model, effort, prompt });
    }

    const run = await runChild({ bin, args, cwd: childCwd, env: childEnv(harness, env, extraEnv), prompt, output, timeoutMs, maxBytes });
    if (!run.started) return { status: 'cannot start' };
    // A stopped agent may not have reached its first call; either way its output is not read.
    if (run.limit) return { status: 'malformed output', reason: run.limit };
    if (log && !canaryLogged(log)) return { status: 'hook did not run' };
    return readOutput(output, maxBytes);
  } finally {
    for (const f of cleanup.reverse()) {
      try { f(); } catch { /* best effort */ }
    }
  }
}

module.exports = { runConfined, claudeArgs, codexArgs, codexProfile, childEnv, TIMEOUT_MS, MAX_BYTES };
