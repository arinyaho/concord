'use strict';
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isWindows, crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');
const { providerFailure } = require('./provider-failure');

function canonicalPath(value) {
  const resolved = path.resolve(value);
  let ancestor = resolved;
  const tail = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...tail);
}

const CODEX_BIN_ENV = 'CONCORD_CODEX_BIN';
const CODEX_APP_ENV = 'CODEX_CLI_PATH';
const MACOS_APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const PROVIDERS = new Set(['claude', 'codex']);
const REVIEW_SUBPROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 5 * 1000;
let codexResolutionCache = null;

// CONCORD_CODEX_BIN is authoritative. Otherwise the first candidate whose --version exits 0 wins:
// the app that launched this session, then PATH, then the installed macOS app. Versions are not compared.
function codexCandidates(env, platform) {
  const override = String(env[CODEX_BIN_ENV] || '').trim();
  const appExported = String(env[CODEX_APP_ENV] || '').trim();
  return override
    ? [{ command: override, source: CODEX_BIN_ENV }]
    : [
      ...(appExported ? [{ command: appExported, source: CODEX_APP_ENV }] : []),
      { command: 'codex', source: 'PATH' },
      ...(platform === 'darwin' ? [{ command: MACOS_APP_CODEX, source: 'macOS ChatGPT app' }] : []),
    ];
}

function resolveCodexExecutable(repoRoot, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || (isWindows ? 'win32' : process.platform);
  const candidates = codexCandidates(env, platform);
  const cacheKey = JSON.stringify([repoRoot, platform, env.PATH, env[CODEX_BIN_ENV], env[CODEX_APP_ENV]]);
  if (!options.probe && codexResolutionCache?.key === cacheKey) {
    if (codexResolutionCache.error) throw codexResolutionCache.error;
    return codexResolutionCache.value;
  }
  const probe = options.probe || ((command) => {
    try {
      return { status: 0, stdout: execFileSync(
        crossPlatformCommand(command, repoRoot),
        crossPlatformArgs(['--version'], needsDoubleEscape(command, repoRoot)),
        crossPlatformOpts({ cwd: repoRoot, env, encoding: 'utf8', timeout: 5000, windowsHide: true }),
      ) };
    } catch (error) { return { error }; }
  });
  const failures = [];
  for (const candidate of candidates) {
    let result;
    try { result = probe(candidate.command, repoRoot, env); } catch (error) { result = { error }; }
    if (result?.status === 0) {
      const value = { ...candidate, version: String(result.stdout || '').trim(), skipped: failures.slice() };
      if (!options.probe) codexResolutionCache = { key: cacheKey, value };
      return value;
    }
    failures.push(`${candidate.source} ${candidate.command}: ${result?.error?.code || `exit ${result?.error?.status ?? result?.status ?? 'unknown'}`}`);
  }
  const error = new Error(`harness-failure: no usable Codex executable was found before review started. Checked: ${failures.join('; ')}. Set ${CODEX_BIN_ENV}=/absolute/path/to/codex to select one explicitly.`);
  error.code = 'CONCORD_CODEX_UNUSABLE';
  if (!options.probe) codexResolutionCache = { key: cacheKey, error };
  throw error;
}

function terminateProcessTree(child, signal) {
  if (isWindows && child.pid) {
    try {
      execFileSync(path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      return;
    } catch (_) {}
  }
  if (!isWindows && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch (_) {}
  }
  child.kill(signal);
}

// Every review reads an untrusted checkout: the reviewer gets no credential variables, a strict configuration
// that ignores the checkout's AGENTS.md and rules, and its process group ends with the top-level CLI.
function codexExec({ prompt, repoRoot, stateDir, requestedModel, reasoningEffort, timeoutMs, abortSignal, codexExecutable, env }) {
  return new Promise((resolve, reject) => {
    let resolvedCodex;
    try { resolvedCodex = codexExecutable || resolveCodexExecutable(repoRoot, { env }); } catch (error) {
      reject(error);
      return;
    }
    const model = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel : null;
    const effort = typeof reasoningEffort === 'string' && reasoningEffort.trim() ? reasoningEffort : null;
    const executable = { source: resolvedCodex.source, version: resolvedCodex.version };
    // On Windows, `shell: true` (crossPlatformOpts) routes this through
    // cmd.exe, whose command-line reader treats an embedded newline as a
    // command boundary before the argument ever reaches the quoting
    // crossPlatformArgs applies -- a real risk here, since `prompt` is a
    // multi-line reviewer prompt (a GitHub Codex review on this exact code,
    // PR #113, flagged it concretely). `codex exec -` reads the prompt from
    // stdin instead of argv, sidestepping the whole cmd.exe command-line
    // path for this value. Scoped to win32 only: the POSIX path (`prompt`
    // as the trailing positional arg) is unaffected by this class of bug
    // and stays exactly as tested.
    const childEnv = reviewerEnv(env);
    for (const key of Object.keys(childEnv)) {
      if (/KEY|SECRET|TOKEN/i.test(key)) delete childEnv[key];
    }
    const child = spawn(crossPlatformCommand(resolvedCodex.command, repoRoot), crossPlatformArgs([
      'exec', '--cd', repoRoot,
      '--strict-config', '--add-dir', stateDir,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--config', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      // An untrusted checkout's AGENTS.md and execpolicy rules must not steer the reviewer.
      '--config', 'project_doc_max_bytes=0', '--ignore-rules',
      '--skip-git-repo-check', '--json', ...(isWindows ? ['-'] : [prompt]),
    ], needsDoubleEscape(resolvedCodex.command, repoRoot)), crossPlatformOpts({ cwd: repoRoot, env: childEnv, stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: !isWindows }));
    // A top-level CLI can exit after spawning a same-group child. End the
    // review's process group before 'close' resolves the launch.
    child.once('exit', () => terminateProcessTree(child, 'SIGKILL'));
    if (isWindows) {
      // If `codex` exits before consuming stdin (a rejected flag, a
      // startup auth failure, the wrong binary on PATH), writing the
      // prompt can raise EPIPE on this stream. Only the ChildProcess itself
      // has an 'error' listener (below); stdin has none, so Node would
      // otherwise treat this as an unhandled error and crash the whole
      // review process instead of failing the launch through the
      // child's own 'error'/'close' handling (a GitHub Codex review on
      // this exact code, PR #113, caught it).
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    }
    let timedOut = false;
    let killTimer = null;
    const terminate = (signal) => {
      terminateProcessTree(child, signal);
      if (signal === 'SIGTERM') killTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), TERMINATION_GRACE_MS);
    };
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : REVIEW_SUBPROCESS_TIMEOUT_MS;
    const timeout = effectiveTimeoutMs > 0 ? setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, effectiveTimeoutMs) : null;
    const abort = () => terminate('SIGTERM');
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    let pending = '';
    let diagnosticText = '';
    let diagnosticStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { diagnosticStderr = (diagnosticStderr + chunk).slice(0, 8192); });
    // Only the error events are kept, as the diagnostic providerFailure classifies.
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') diagnosticText = (diagnosticText + line + '\n').slice(0, 8192);
      } catch (_) { /* a malformed line is no diagnostic */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) consume(line);
    });
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      error.executable = executable;
      reject(error);
    });
    child.once('close', (status, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      consume(pending);
      const interrupted = abortSignal?.aborted ? String(abortSignal.reason || 'signal') : null;
      resolve({ status, signal: signal || null, timedOut, interrupted, executable, diagnosticText, stderr: diagnosticStderr });
    });
  });
}

// A reviewer's own test run must not reach the driver's provider CLI through
// the driver's override; the reviewer's launch already resolved it.
function reviewerEnv(env) {
  const childEnv = { ...(env || process.env) };
  delete childEnv[CODEX_BIN_ENV];
  return childEnv;
}

function providerExec(input) {
  const { provider, prompt, repoRoot, stateDir, timeoutMs, abortSignal } = input;
  if (!PROVIDERS.has(provider)) throw new Error(`harness-failure: unsupported provider "${provider}"`);
  if (provider === 'codex') return codexExec(input);

  const requestedModel = typeof input.requestedModel === 'string' && input.requestedModel.trim()
    ? input.requestedModel
    : null;
  // Same win32-only stdin rerouting as codexExec, for the same reason: a
  // multi-line prompt on cmd.exe's command line risks a line break being
  // read as a command boundary. `claude -p` with no trailing prompt
  // argument reads from stdin (documented).
  const args = [
    '-p',
    ...(requestedModel ? ['--model', requestedModel] : []),
    ...(input.reasoningEffort ? ['--effort', input.reasoningEffort] : []),
    '--output-format', 'json', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    // An untrusted checkout's .claude/settings.json (hooks, permissions) must not run.
    '--setting-sources', 'user',
    `--add-dir=${stateDir}`, ...(isWindows ? [] : [prompt]),
  ];

  const OUTPUT_LIMIT = 4000;

  return new Promise((resolve, reject) => {
    const child = spawn(crossPlatformCommand('claude', repoRoot), crossPlatformArgs(args, needsDoubleEscape('claude', repoRoot)), crossPlatformOpts({ cwd: repoRoot, env: reviewerEnv(input.env), stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: !isWindows }));
    child.once('exit', () => terminateProcessTree(child, 'SIGKILL'));
    if (isWindows) {
      // See codexExec's identical stdin 'error' handling above -- the
      // same EPIPE risk (child exits before consuming the prompt) applies
      // here.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    }
    let timedOut = false;
    let killTimer = null;
    const terminate = (signal) => {
      terminateProcessTree(child, signal);
      if (signal === 'SIGTERM') killTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), TERMINATION_GRACE_MS);
    };
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : REVIEW_SUBPROCESS_TIMEOUT_MS;
    const timeout = effectiveTimeoutMs > 0 ? setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, effectiveTimeoutMs) : null;
    const abort = () => terminate('SIGTERM');
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(0, OUTPUT_LIMIT); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, OUTPUT_LIMIT); });
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (status, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      const interrupted = abortSignal?.aborted ? String(abortSignal.reason || 'signal') : null;
      resolve({ status, signal: signal || null, timedOut, interrupted, stdout, stderr });
    });
  });
}

async function invoke(spawn, input) {
  const result = await spawn(input);
  if (result && (result.interrupted || result.timedOut || result.signal || result.status !== 0)) {
    const failure = providerFailure(input, result);
    const error = new Error(`harness-failure: ${failure.message}`);
    error.reviewFailure = failure;
    throw error;
  }
}

// A Codex reviewer of an untrusted checkout runs from a CODEX_HOME of its own.
// Codex marks the directory it runs in as trusted and then loads that
// directory's .codex/config.toml, which can start MCP servers; an entry that
// marks the checkout untrusted before Codex starts keeps that configuration
// out. The account's own configuration stays out too; only its login is copied.
// The entries under `root` that a reviewer must not read, leaving every path in `keep` (and the
// directories on the way to it) reachable. A whole-root deny would also hide the checkout when it
// lies under the home, and Codex cannot mount a path below a denied parent.
function denyAround(root, keep) {
  const denied = [];
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      if (keep.some((k) => k === full)) continue;
      // A link is not mounted over (its target would be masked twice): the target is denied by its own entry, or here when it lies outside the root.
      let link = false;
      try { link = fs.lstatSync(full).isSymbolicLink(); } catch (_) { continue; } // gone since the listing
      if (link) {
        try {
          const target = fs.realpathSync(full);
          const reachable = keep.some((k) => k === target || k.startsWith(target + path.sep) || target.startsWith(k + path.sep));
          if (target !== root && !target.startsWith(root + path.sep) && !reachable && path.dirname(target) !== path.parse(target).root) denied.push(target);
        } catch (_) { /* a dangling link reads nothing */ }
        continue;
      }
      if (keep.some((k) => k.startsWith(full + path.sep))) walk(full); else denied.push(full);
    }
  };
  walk(root);
  return denied;
}

// Codex starts its own binary again inside the sandbox, so the directory it is installed in must stay readable.
function codexInstallDir(repoRoot) {
  const executablePath = (command, requireExecutable = false) => {
    const paths = /[\\/]/.test(command) ? [path.resolve(repoRoot, command)] : String(process.env.PATH || '').split(path.delimiter).map((dir) => requireExecutable ? path.resolve(repoRoot, dir || '.', command) : dir && path.join(dir, command));
    for (const candidate of paths.filter(Boolean)) {
      try {
        if (requireExecutable) {
          if (!fs.statSync(candidate).isFile()) continue;
          if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
        }
        const real = fs.realpathSync(candidate);
        return real.match(/^(.*[\\/]node_modules[\\/]@openai[\\/]codex)[\\/]/)?.[1] || real;
      } catch (_) { /* not installed here */ }
    }
    return null;
  };
  // Keep the installed directory readable for the same executable the runner will launch.
  try {
    const selected = resolveCodexExecutable(repoRoot);
    const installed = executablePath(selected.command, true);
    if (installed) return installed;
  } catch (_) { /* preserve config-only setups when no executable can be resolved */ }
  // The config is also generated before launches in config-only flows; retain the old best-effort path fallback there.
  for (const { command } of codexCandidates(process.env, isWindows ? 'win32' : process.platform)) {
    const installed = executablePath(command);
    if (installed) return installed;
  }
  return null;
}

// The CODEX_HOME configuration of a Codex reviewer. The reviewer reads an untrusted checkout,
// so it must not reach the account's credential files (gh, ssh, cloud, Claude, Codex) by absolute path,
// whatever HOME says: every entry of the real home is denied, except the way to the checkout and to the
// review's own directories. The CODEX_HOME itself is read-only, so a reviewer that could rewrite its
// config.toml cannot lift the restrictions for every later launch.
function reviewCodexConfig({ home, sourceAuth, checkout, stateDir, denyRead, realHome: accountHome = os.homedir() }) {
  const installed = codexInstallDir(checkout);
  const realHome = canonicalPath(accountHome);
  const keep = [checkout, canonicalPath(home), ...(stateDir ? [canonicalPath(stateDir)] : []), ...(installed ? [installed] : [])];
  // A path inside the home is already denied by its entry; a nested deny would stop Codex from mounting it.
  const named = denyRead.filter((p) => fs.existsSync(p) && !canonicalPath(p).startsWith(realHome + path.sep) && !keep.some((k) => k === p || k.startsWith(p + path.sep)));
  const around = [...denyAround(realHome, keep), ...named];
  const source = canonicalPath(sourceAuth);
  const covered = around.some((p) => source === p || source.startsWith(p + path.sep));
  // The home is read-only inside the sandbox, so a missing auth.json cannot appear there and needs no entry (a deny over a missing file cannot be mounted).
  const homeAuth = path.join(home, 'auth.json');
  const denied = [...(covered ? [] : [source]), ...(fs.existsSync(homeAuth) ? [homeAuth] : []), ...around];
  return `default_permissions = "concord-review"
approval_policy = "never"

[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false

[permissions.concord-review]
extends = ":workspace"

[permissions.concord-review.filesystem]
${[...new Set(denied)].map((p) => `${JSON.stringify(p)} = "deny"`).join('\n')}
${JSON.stringify(canonicalPath(home))} = "read"

[permissions.concord-review.network]
enabled = false

[projects.${JSON.stringify(checkout)}]
trust_level = "untrusted"
`;
}

module.exports = { canonicalPath, codexExec, providerExec, invoke, reviewCodexConfig, resolveCodexExecutable };
