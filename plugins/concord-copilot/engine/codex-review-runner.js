'use strict';

// Codex has no in-session Task primitive. This runner is therefore the sole
// orchestration authority: every clean-context reviewer is a `codex exec`
// subprocess and every state transition remains owned by review-cli.
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { canonicalPath, runPath, openInitiativeRun, reserveLaunch, denialReason, recordDisposition, normalizeDisposition, consumeDispositionDelivery, terminalTarget, publicInitiativeSummary, finaliseInitiativeRun } = require('./initiative-review-run');
const { gitHeadSha, gitDirty, fileTarget } = require('./target');
const fs = require('node:fs');
const path = require('node:path');
const { safeIdForFilename } = require('./artifact-name');
const { writeFileAtomic } = require('./atomic-write');
const { targetSlug } = require('./review');
const { artifactDestinationFromPrompt } = require('./review-artifact');
const { isValidFindingId } = require('./gate-contract');
const { same } = require('./review-eval');
const { PANEL_LENSES } = require('./report');
const { BLOCKED_CLAUSE, reviewerPrompt } = require('./round-plan');
const { isWindows, crossPlatformOpts, crossPlatformArgs, crossPlatformCommand, needsDoubleEscape } = require('./spawn-cross-platform');

const CODEX_VERSION = 'codex-cli 0.154.0';
const CODEX_BIN_ENV = 'CONCORD_CODEX_BIN';
const MACOS_APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const CODEX_USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const CODEX_EVENT_TYPES = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
const CODEX_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'error', 'collaboration_tool_call', 'collab_agent_tool_call']);
const PROVIDERS = new Set(['claude', 'codex', 'copilot']);
const REVIEW_SUBPROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 5 * 1000;
let codexResolutionCache = null;

function resolveCodexExecutable(repoRoot, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || (isWindows ? 'win32' : process.platform);
  const override = String(env[CODEX_BIN_ENV] || '').trim();
  const candidates = override
    ? [{ command: override, source: CODEX_BIN_ENV }]
    : [{ command: 'codex', source: 'PATH' }, ...(platform === 'darwin' ? [{ command: MACOS_APP_CODEX, source: 'macOS ChatGPT app' }] : [])];
  const cacheKey = JSON.stringify([repoRoot, platform, env.PATH, override]);
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
      const value = { ...candidate, version: String(result.stdout || '').trim() };
      if (!options.probe) codexResolutionCache = { key: cacheKey, value };
      return value;
    }
    failures.push(`${candidate.command}: ${result?.error?.code || `exit ${result?.error?.status ?? result?.status ?? 'unknown'}`}`);
  }
  const error = new Error(`harness-failure: no usable Codex executable was found before review started. Checked: ${failures.join('; ')}. Set ${CODEX_BIN_ENV}=/absolute/path/to/codex to select one explicitly.`);
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

function jsonCli(cliPath, args, repoRoot) {
  const out = execFileSync('node', [cliPath, ...args], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repoRoot },
  });
  try { return JSON.parse(out); } catch (e) { throw new Error(`harness-failure: review-cli ${args[0]} returned non-JSON output`); }
}

function normalizeUsage(raw) {
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const providerUsage = Object.fromEntries(Object.entries(raw || {}).filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
  const exactKeys = raw && sameKeys(Object.keys(raw), CODEX_USAGE_FIELDS);
  const providerInputTokens = number(raw && raw.input_tokens);
  const cachedInputTokens = number(raw && raw.cached_input_tokens);
  const cacheWriteInputTokens = number(raw && raw.cache_write_input_tokens);
  const reasoningOutputTokens = number(raw && raw.reasoning_output_tokens);
  const providerOutputTokens = number(raw && raw.output_tokens);
  const outputTokens = providerOutputTokens === null || reasoningOutputTokens === null ? null : number(providerOutputTokens - reasoningOutputTokens);
  const totalTokens = providerInputTokens === null || providerOutputTokens === null ? null : providerInputTokens + providerOutputTokens;
  const usagePartial = !exactKeys
    || [providerInputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens, outputTokens].some((value) => value === null)
    || (providerInputTokens !== null && cachedInputTokens !== null && cacheWriteInputTokens !== null && cachedInputTokens + cacheWriteInputTokens > providerInputTokens)
    || totalTokens === 0;
  const inputTokens = usagePartial ? null : providerInputTokens - cachedInputTokens - cacheWriteInputTokens;
  const usage = {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
    outputTokens,
    totalTokens: usagePartial ? null : totalTokens,
  };
  return { usage, usagePartial, providerUsage };
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && [...actual].sort().every((key, index) => key === [...expected].sort()[index]);
}

function codexExec({ role, prompt, repoRoot, stateDir, requestedModel, reasoningEffort, serviceTier, timeoutMs, abortSignal, codexExecutable }) {
  return new Promise((resolve, reject) => {
    const resolvedCodex = codexExecutable || resolveCodexExecutable(repoRoot);
    const invocationId = crypto.randomUUID();
    const model = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel : null;
    const effort = typeof reasoningEffort === 'string' && reasoningEffort.trim() ? reasoningEffort : null;
    const tier = typeof serviceTier === 'string' && serviceTier.trim() ? serviceTier : null;
    const cliVersion = resolvedCodex.version;
    const startedAt = Date.now();
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
    const child = spawn(crossPlatformCommand(resolvedCodex.command, repoRoot), crossPlatformArgs([
      'exec', '--cd', repoRoot, '--sandbox', 'workspace-write', '--add-dir', stateDir,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--config', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ...(tier ? ['--config', `service_tier=${JSON.stringify(tier)}`] : []),
      '--skip-git-repo-check', '--json', ...(isWindows ? ['-'] : [prompt]),
    ], needsDoubleEscape(resolvedCodex.command, repoRoot)), crossPlatformOpts({ cwd: repoRoot, stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'ignore'], detached: !isWindows }));
    if (isWindows) {
      // If `codex` exits before consuming stdin (a rejected flag, a
      // startup auth failure, the wrong binary on PATH), writing the
      // prompt can raise EPIPE on this stream. Only the ChildProcess itself
      // has an 'error' listener (below); stdin has none, so Node would
      // otherwise treat this as an unhandled error and crash the whole
      // review process instead of returning failed telemetry through the
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
    let usage;
    let completionCount = 0;
    let streamPartial = cliVersion !== CODEX_VERSION;
    let collaborationEvidenceCount = 0;
    let errorEvidenceCount = 0;
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (!event || !CODEX_EVENT_TYPES.has(event.type)) streamPartial = true;
        if (/^item\./.test(event?.type || '') && (!event.item || !CODEX_ITEM_TYPES.has(event.item.type))) streamPartial = true;
        if (event.type === 'turn.completed') {
          completionCount++;
          usage = event.usage;
        }
        if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') {
          errorEvidenceCount++;
          streamPartial = true;
        }
        if (/collab|agent/i.test(String(event.item?.type || event.type)) && event.item?.type !== 'agent_message') {
          collaborationEvidenceCount++;
          streamPartial = true;
        }
      } catch (_) { streamPartial = true; }
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
      error.telemetry = {
        status: 'failed', role, engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', cliVersion,
        requestedModel: model, reasoningEffort: effort, serviceTier: tier, resolvedModel: 'unavailable', invocationId,
        elapsedMs: Date.now() - startedAt, usagePartial: true,
      };
      reject(error);
    });
    child.once('close', (status, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      consume(pending);
      const normalized = normalizeUsage(usage);
      resolve({
        status, role, engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', cliVersion,
        requestedModel: model, reasoningEffort: effort, serviceTier: tier, resolvedModel: 'unavailable', invocationId, elapsedMs: Date.now() - startedAt,
        ...normalized,
        signal: signal || null,
        timedOut,
        interrupted: abortSignal?.aborted ? String(abortSignal.reason || 'signal') : null,
        usagePartial: normalized.usagePartial || streamPartial || completionCount !== 1 || status !== 0 || !!signal,
        ...(cliVersion !== CODEX_VERSION ? { usageStatus: 'unsupported-cli-version' } : {}),
        evidence: { collaboration: collaborationEvidenceCount, errors: errorEvidenceCount },
      });
    });
  });
}

function providerExec(input) {
  const { provider, role, prompt, repoRoot, stateDir, timeoutMs, abortSignal } = input;
  if (!PROVIDERS.has(provider)) throw new Error(`harness-failure: unsupported provider "${provider}"`);
  if (provider === 'codex') return codexExec(input);

  const requestedModel = typeof input.requestedModel === 'string' && input.requestedModel.trim()
    ? input.requestedModel
    : null;
  const invocationId = crypto.randomUUID();
  const startedAt = Date.now();
  const executable = provider;
  // Same win32-only stdin rerouting as codexExec, for the same reason: a
  // multi-line prompt on cmd.exe's command line risks a line break being
  // read as a command boundary. `claude -p` with no trailing prompt
  // argument reads from stdin (documented). `copilot` without `-p`/
  // `--prompt` also reads piped stdin (documented), though its stdin path
  // is less exercised in the wild than `-p`'s (see the open
  // github/copilot-cli issue requesting a `--prompt-file` flag specifically
  // because piping is "awkward") -- unverified against a real `copilot`
  // binary, which this repo does not have; disclosed in the design note.
  const args = provider === 'claude'
    ? [
        '-p',
        ...(requestedModel ? ['--model', requestedModel] : []),
        '--output-format', 'json', '--no-session-persistence',
        '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
        '--add-dir', stateDir, ...(isWindows ? [] : [prompt]),
      ]
    : [
        ...(isWindows ? [] : ['-p', prompt]),
        ...(requestedModel ? ['--model', requestedModel] : []),
        '--silent', '--allow-all-tools', '--allow-all-paths', '--no-ask-user',
        '-C', repoRoot,
      ];
  const providerName = provider === 'claude' ? 'anthropic' : 'github';
  const providerSchema = provider === 'claude' ? 'claude-print-json-v1' : 'copilot-prompt-v1';

  const OUTPUT_LIMIT = 4000;
  const truncate = (text) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n...(truncated)` : text);

  return new Promise((resolve, reject) => {
    const child = spawn(crossPlatformCommand(executable, repoRoot), crossPlatformArgs(args, needsDoubleEscape(executable, repoRoot)), crossPlatformOpts({ cwd: repoRoot, stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: !isWindows }));
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      error.telemetry = {
        status: 'failed', role, engine: provider, provider: providerName, providerSchema,
        requestedModel, resolvedModel: 'unavailable', invocationId,
        elapsedMs: Date.now() - startedAt, usagePartial: true,
        stdout: truncate(stdout), stderr: truncate(stderr),
      };
      reject(error);
    });
    child.once('close', (status, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      resolve({
      status, role, engine: provider, provider: providerName, providerSchema,
      requestedModel, resolvedModel: 'unavailable', invocationId,
      elapsedMs: Date.now() - startedAt, usagePartial: true, signal: signal || null, timedOut,
      interrupted: abortSignal?.aborted ? String(abortSignal.reason || 'signal') : null,
      stdout: truncate(stdout), stderr: truncate(stderr),
      });
    });
  });
}

// A fresh git review needs an explicit merge-base side of the diff. Resolve
// the repository's advertised remote default without hard-coding `origin`;
// repositories with no remote HEAD must name a base rather than silently
// falling back to a working-tree diff against HEAD.
function resolveDefaultBase(repoRoot, exec = execFileSync) {
  let refs;
  try {
    refs = exec(crossPlatformCommand('git', repoRoot), crossPlatformArgs(['for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD'], needsDoubleEscape('git', repoRoot)), crossPlatformOpts({ cwd: repoRoot, encoding: 'utf8' }));
  } catch (error) {
    throw new Error('review-until-green: cannot determine a remote default base; pass an explicit base');
  }
  for (const ref of String(refs).split(/\r?\n/)) {
    const match = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
    if (match) return `${match[1]}/${match[2]}`;
  }
  throw new Error('review-until-green: cannot determine a remote default base; pass an explicit base');
}

function pendingContinuationPacket(run, target, revision, kind, includeConsumed = false, reason) {
  const entry = JSON.parse(fs.readFileSync(run.path, 'utf8')).dispositions.findLast((item) => item.target === target
    && same(item.revision, revision)
    && (!kind || item.kind === kind)
    && (!reason || item.reason === reason));
  return entry?.packet && (includeConsumed || entry.packet.delivery?.consumed === false) ? entry.packet : null;
}

function acknowledgeContinuationPacket(options, claim) {
  if (!options?.initiativeStateDir || !options?.initiativeRunKey || typeof claim !== 'string') return false;
  return consumeDispositionDelivery({ path: runPath(options.initiativeStateDir, options.initiativeRunKey) }, claim);
}

async function invoke(spawn, input) {
  const result = await spawn(input);
  if (result && (result.interrupted || result.timedOut || result.signal || result.status !== 0)) {
    const failure = result.interrupted
      ? { role: input.role, kind: 'interrupted', message: `${input.role} interrupted by parent ${result.interrupted}`, signal: result.interrupted }
      : result.timedOut
        ? { role: input.role, kind: 'timeout', message: `${input.role} subprocess timed out` }
        : result.signal
          ? { role: input.role, kind: 'signal', message: `${input.role} subprocess ended from ${result.signal}`, signal: result.signal }
          : { role: input.role, kind: 'subprocess-exit', message: `${input.role} subprocess exited ${result.status}`, exitCode: result.status };
    const error = new Error(`harness-failure: ${failure.message}`);
    error.reviewFailure = failure;
    throw error;
  }
}

async function runReviewUntilGreen(options) {
  const { ref, base, broad = false, noBroad = false, noDod = false, resume = false, repoRoot: configuredRepoRoot = process.cwd(), cliPath = path.join(__dirname, '..', 'bin', 'review-cli.js') } = options;
  const repoRoot = canonicalPath(configuredRepoRoot);
  const canonicalRepoRoot = repoRoot;
  const canonicalStateDir = options.initiativeStateDir && canonicalPath(options.initiativeStateDir);
  const keyedRun = options.initiativeRunKey || options.initiativeStateDir;
  if (keyedRun && (!options.initiativeRunKey || !options.initiativeStateDir)) throw new Error('review-until-green: --initiative-run-key and --initiative-state-dir must be used together');
  if (keyedRun) runPath(options.initiativeStateDir, options.initiativeRunKey);
  const stateRelativeToRepo = keyedRun && path.relative(canonicalRepoRoot, canonicalStateDir);
  if (keyedRun && !stateRelativeToRepo.startsWith('..') && !path.isAbsolute(stateRelativeToRepo)) {
    let worktree = false;
    try { worktree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: canonicalRepoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch {}
    if (worktree) try { execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path.relative(canonicalRepoRoot, runPath(canonicalStateDir, options.initiativeRunKey))], { cwd: canonicalRepoRoot }); } catch { throw new Error('review-until-green: an initiative state directory inside the repository must be ignored'); }
  }
  const initiativeRun = keyedRun ? openInitiativeRun({ stateDir: canonicalStateDir, key: options.initiativeRunKey, repository: canonicalRepoRoot, maxLaunches: options.initiativeMaxLaunches, maxRounds: options.initiativeMaxRounds, allowTerminal: !!options.initiativeFinalise }) : null;
  if (options.initiativeFinalise) {
    if (!initiativeRun) throw new Error('review-until-green: --initiative-finalise requires an initiative run');
    if (!finaliseInitiativeRun(initiativeRun)) throw new Error('review-until-green: initiative run finalisation was contended');
    return { decision: { finalised: true }, initiative: publicInitiativeSummary(initiativeRun) };
  }
  if (!ref) throw new Error('review-until-green: missing target ref');
  // Never resolve a base for resume: round-start restores ledger.target.base.
  // File targets do not have a git base at all.
  const baseResolver = options.resolveDefaultBase || (options.runCli ? null : resolveDefaultBase);
  let initialBase = resume ? undefined : base;
  const runCli = options.runCli || ((args) => jsonCli(cliPath, args, repoRoot));
  let reviewer = options.reviewer || 'codex';
  let fixer = options.fixer || 'codex';
  let reviewerModel = options.reviewerModel;
  let fixerModel = options.fixerModel;
  let initiativeRevision = { ref };
  const rawSpawn = options.spawn || ((input) => providerExec(input));
  const abortController = options.handleSignals ? new AbortController() : null;
  const signalHandlers = abortController ? Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => abortController.abort(signal)])) : {};
  let checks = [];
  for (const [signal, handler] of Object.entries(signalHandlers)) process.once(signal, handler);
  try {
  // Resolve base before computing identity below -- an identity that factors
  // base into its hash must see the real default, not undefined, or its
  // head_sha can disagree with what round-start computes once the real base
  // is known. A resolution failure is deferred (not thrown yet) so identity
  // still gets computed and recorded on the error disposition below, exactly
  // as it did before this ordering existed.
  let baseResolutionError = null;
  if (!resume && initialBase === undefined && !ref.startsWith('file:') && baseResolver) {
    try { initialBase = baseResolver(repoRoot); } catch (error) { baseResolutionError = error; }
  }
  if (initialBase) initiativeRevision = { ...initiativeRevision, base: initialBase };
  if (initiativeRun && fs.existsSync(repoRoot)) {
    try {
      const head_sha = options.targetIdentity ? options.targetIdentity(ref, initialBase, canonicalRepoRoot) : ref.startsWith('file:')
        ? fileTarget({ files: [ref.slice('file:'.length)] }, canonicalRepoRoot).identity : gitHeadSha(canonicalRepoRoot);
      initiativeRevision = { ...initiativeRevision, head_sha };
    } catch (_) { /* round-start remains the authority when identity cannot be acquired */ }
  }
  if (baseResolutionError) throw baseResolutionError;
  // A replay against an already-terminal target (including the dirty-worktree
  // guard below) is not a review failure and must not be recorded as one by
  // the catch below -- it is tagged so the catch rethrows it unrecorded.
  const validated = initiativeRun && terminalTarget(initiativeRun, ref, (terminalRevision) => {
    const identityBase = resume ? terminalRevision.base : initialBase;
    const head_sha = options.targetIdentity ? options.targetIdentity(ref, identityBase, canonicalRepoRoot) : ref.startsWith('file:')
      ? fileTarget({ files: [ref.slice('file:'.length)] }, canonicalRepoRoot).identity
      : (() => {
        if (gitDirty(canonicalRepoRoot)) {
          const dirtyError = new Error('round-start: working tree is dirty; commit or stash before review-until-green');
          dirtyError.notAReviewFailure = true;
          throw dirtyError;
        }
        return gitHeadSha(canonicalRepoRoot);
      })();
    return { ref, ...(identityBase ? { base: identityBase } : {}), head_sha };
  }, ['terminal', 'escape']);
  if (validated) {
    // includeConsumed: a replay against a target whose packet a prior
    // invocation already delivered must still return it -- otherwise this
    // preflight silently produces no continuationPacket, and the launcher's
    // empty-output fallback is suppressed for a terminal decision, leaving
    // the caller with nothing to read at all.
    const packet = pendingContinuationPacket(initiativeRun, ref, validated.revision, validated.kind, true);
    return { decision: validated.kind === 'escape' ? 'escape' : 'terminal', initiative: publicInitiativeSummary(initiativeRun), ...(packet ? { continuationPacket: packet } : {}) };
  }
  for (const provider of [reviewer, fixer]) {
    if (!PROVIDERS.has(provider)) throw new Error(`review-until-green: unsupported provider "${provider}"`);
  }
  const telemetry = {
    total: { calls: 0, partialCalls: 0, inputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    byRole: {},
    invocations: [],
  };
  let currentRound = null;
  let telemetryPath = null;
  let telemetryLoaded = false;
  const persistTelemetry = () => {
    if (!telemetryPath) return;
    writeFileAtomic(telemetryPath, `${JSON.stringify(telemetry)}\n`);
  };
  const record = (input, result) => {
    const usage = result && result.usage || {};
    const partial = !result || result.usagePartial !== false;
    const values = {
      inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
      cacheWriteInputTokens: Number.isFinite(usage.cacheWriteInputTokens) ? usage.cacheWriteInputTokens : null,
      cachedInputTokens: Number.isFinite(usage.cachedInputTokens) ? usage.cachedInputTokens : null,
      reasoningOutputTokens: Number.isFinite(usage.reasoningOutputTokens) ? usage.reasoningOutputTokens : null,
      outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
      totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
      elapsedMs: Number.isFinite(result && result.elapsedMs) ? result.elapsedMs : null,
    };
    const role = input.role;
    const aggregate = telemetry.byRole[role] || (telemetry.byRole[role] = {
      calls: 0, partialCalls: 0, inputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0,
    });
    for (const target of [aggregate, telemetry.total]) {
      target.calls++;
      if (partial) target.partialCalls++;
      if (result?.usageStatus === 'unsupported-cli-version') {
        target.unsupportedCliVersionCalls = (target.unsupportedCliVersionCalls || 0) + 1;
        target.unsupportedCliVersions = Array.from(new Set([...(target.unsupportedCliVersions || []), result.cliVersion].filter(Boolean))).sort();
      }
      for (const key of Object.keys(values)) if (values[key] !== null) target[key] += values[key];
    }
    telemetry.invocations.push({
      ...(input.telemetrySlot || {}),
      role, round: currentRound, model: input.requestedModel || result?.requestedModel || null, resolvedModel: result?.resolvedModel || null,
      reasoningEffort: input.reasoningEffort || result?.reasoningEffort || null, serviceTier: input.serviceTier || result?.serviceTier || null,
      status: result && (Number.isInteger(result.status) || result.status === 'failed') ? result.status : null,
      usagePartial: partial, ...values,
      ...(result?.usageStatus ? { usageStatus: result.usageStatus } : {}),
      ...(result && result.invocationId ? { engine: result.engine, provider: result.provider, providerSchema: result.providerSchema, invocationId: result.invocationId } : {}),
      ...(result?.cliVersion ? { cliVersion: result.cliVersion } : {}),
      ...(result?.evidence ? { evidence: result.evidence } : {}),
      ...(result && result.providerUsage && Object.keys(result.providerUsage).length ? { providerUsage: result.providerUsage } : {}),
    });
    persistTelemetry();
  };
  const spawn = async (input) => {
    const provider = input.provider;
    const providerName = provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'openai' : 'github';
    const providerSchema = provider === 'claude' ? 'claude-print-json-v1' : provider === 'codex' ? 'codex-exec-json-v1' : 'copilot-prompt-v1';
    const identity = {
      engine: provider, provider: providerName, providerSchema, invocationId: crypto.randomUUID(),
    };
    try {
      const result = await rawSpawn(input);
      record(input, { ...identity, ...result });
      return result;
    } catch (error) {
      record(input, { ...identity, status: 'failed', usagePartial: true, ...(error?.telemetry || {}) });
      throw error;
    }
  };
  const withTelemetry = (result) => {
    const output = { ...result, telemetry: result?.telemetry || telemetry };
    const genuinelyTerminal = result?.decision === 'terminal' || result?.decision?.converged === true || result?.decision?.parked === true || result?.decision?.abandoned === true;
    const terminal = genuinelyTerminal || result?.decision === 'escape' || result?.decision?.intentReview || result?.decision?.gatePending;
    // A genuinely terminal result always clears the local cache -- no more
    // accumulation is expected. Without an initiative run, a re-runnable
    // decision (escape/gate-pending/intent-review) has nowhere else its
    // telemetry is captured, so the cache must survive for the next
    // invocation to keep accumulating into it. WITH an initiative run,
    // that telemetry is captured durably in the disposition recorded below
    // instead, so the local cache becomes redundant and must be cleared --
    // otherwise a retry reloads it and appends the same invocations into
    // ledger.telemetry a second time.
    if ((genuinelyTerminal || (initiativeRun && terminal)) && telemetryPath) {
      try { fs.unlinkSync(telemetryPath); } catch {}
    }
    if (initiativeRun && terminal) {
      const reconciliation = result?.reconciliation;
      // Derive escaped from the SAME normalization recordDisposition uses
      // below to decide the stored kind -- checking only the literal string
      // 'escape' misses gatePending/intentReview, which normalizeDisposition
      // also classifies as 'escape': the packet's trigger/nextAction would
      // then say 'terminal'/'replay' for an entry actually stored as
      // 'escape', and the post-record lookup (kind 'terminal') would find
      // nothing and throw a spurious contention error.
      const escaped = normalizeDisposition(result).kind === 'escape';
      const recorded = recordDisposition(initiativeRun, {
        target: ref,
        revision: initiativeRevision,
        result,
        packet: {
          trigger: escaped ? 'escape' : 'terminal',
          exit: { code: Number.isInteger(result?.exitCode) ? result.exitCode : 0, signal: result?.signal || null },
          dod: { status: (result?.checks || checks)[0]?.status || 'not-run' },
          telemetry: { complete: output.telemetry?.total?.partialCalls === 0 },
          nextAction: escaped ? 'resume' : 'replay',
          handoff: result?.handoff || result?.message || null,
        },
        finding: reconciliation?.finding || null,
        stage: reconciliation?.stage || null,
        avoidedLaunches: reconciliation?.avoidedLaunches || 0,
        findings: reconciliation?.findings || {},
        checks: result?.checks || checks,
        telemetry: (output.telemetry?.invocations || []).map(({ role, round, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens }) => ({ role, stage: 'review', revision: initiativeRevision, round, elapsedMs, inputTokens, cacheWriteInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens, totalTokens })),
      });
      // includeConsumed only for 'terminal': its dedup matches regardless of
      // consumption, so a consumed match here is a legitimate concurrent
      // success. 'escape' dedup only matches an UNCONSUMED entry, so a
      // consumed match here would be a stale, unrelated escape at this
      // revision -- including it would mask the real failure (e.g. the
      // ledger was finalised concurrently) behind a wrong, already-settled
      // packet instead of throwing.
      const packet = pendingContinuationPacket(initiativeRun, ref, initiativeRevision, escaped ? 'escape' : 'terminal', !escaped);
      if (!packet) throw new Error(recorded ? 'review-until-green: initiative delivery claim was contended' : 'review-until-green: initiative target terminal recording was contended');
      output.continuationPacket = packet;
    }
    return output;
  };
  const cli = (args) => runCli(args);
  const throwIfAborted = async (persist = false) => {
    if (!abortController || !abortController.signal.aborted) return;
    const signal = String(abortController.signal.reason || 'signal');
    const failure = { role: 'runner', kind: 'interrupted', message: `review runner interrupted by ${signal}`, signal };
    if (persist) try { await cli(['round-failure', ref, JSON.stringify(failure)]); } catch (_) {}
    const error = new Error(`harness-failure: ${failure.message}`);
    error.reviewFailure = failure;
    throw error;
  };
  const runPanel = async (context, launch) => {
    const lenses = PANEL_LENSES;
    for (;;) {
      const panel = await cli(['gate-panel-round-start', ref]);
      const lensResults = await Promise.allSettled(lenses.map(async (lens) => {
        const artifact = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-${lens}.json`);
        try {
          await launch({ role: `gate-panel-${lens}`, repoRoot, stateDir: context.stateDir,
            prompt: `Review ${path.join(context.stateDir, `round-${context.round}-diff.txt`)} and the repository through the ${lens} lens. You MAY Read/Grep the repository and MUST read ${path.join(context.stateDir, `intent-${context.slug}.md`)} if it exists to assess the design and acceptance criteria. Previously rejected IDs: ${JSON.stringify(panel.rejectedIds || [])} -- do not re-raise one unless you found something the earlier round did not. Every candidate faces three adversarial verifiers that default to REFUTED when uncertain and decide by majority, so a gap you cannot anchor in evidence will not survive: substantiate what you raise rather than raising more. Write ONLY {"status":"ok","findings":[]} to ${artifact}; every ID must use gate:${lens}:<slug>.${BLOCKED_CLAUSE}` });
        } catch (error) {
          if (error.reviewFailure && ['interrupted', 'timeout', 'signal'].includes(error.reviewFailure.kind)) throw error;
        }
      }));
      const lensFailure = lensResults.find((result) => result.status === 'rejected');
      if (lensFailure) throw lensFailure.reason;
      const candidates = [];
      for (const lens of lenses) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-${lens}.json`), 'utf8'));
          for (const finding of raw.findings || []) {
            // Candidate IDs are interpolated into verdict artifact names below.
            // Panel output is advisory and lenient, so an invalid candidate is
            // discarded as malformed lens output rather than becoming a path.
            if (finding && typeof finding.id === 'string' && finding.id.startsWith('gate:') && isValidFindingId(finding.id)) candidates.push(finding);
          }
        } catch (_) { /* panel lenses are intentionally lenient */ }
      }
      const rejected = [];
      for (const finding of candidates) {
        let survives = 0;
        const voteResults = await Promise.allSettled([0, 1, 2].map(async (vote) => {
          const verdict = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-vote-${safeIdForFilename(finding.id)}-${vote}.json`);
          await launch({ role: 'gate-panel-verify', repoRoot, stateDir: context.stateDir,
            prompt: `Try to refute gate finding ${JSON.stringify(finding)}. Default to refuted if uncertain. Write ONLY {"status":"ok","survives":false} to ${verdict}.${BLOCKED_CLAUSE}` });
          let raw;
          // Missing/unparseable verdict stays lenient (counts as refuted), but a
          // voter that DECLARED `blocked` never performed the refutation it was
          // assigned -- tallying that as a refutation is the false clean the
          // field exists to prevent, so it fails the round like every other
          // panel read path (review-cli.js requireNotBlocked).
          try { raw = JSON.parse(fs.readFileSync(verdict, 'utf8')); } catch (_) { return false; }
          const blocked = raw ? raw.blocked : undefined;
          if (blocked !== undefined && !(Array.isArray(blocked) && !blocked.length)) {
            const detail = Array.isArray(blocked) ? blocked.map((b) => String(b)).join('; ') : String(blocked);
            throw new Error(`harness-failure: gate-panel vote ${vote} on ${finding.id} could not run: ${detail} -- it was blocked from the method it was assigned, so this round has no usable verdict. Fix the reviewer's environment (sandbox, permissions, missing tool) and re-run; do not accept the artifact.`);
          }
          return raw ? raw.survives === true : false;
        }));
        const voteFailure = voteResults.find((result) => result.status === 'rejected');
        if (voteFailure) throw voteFailure.reason;
        const votes = voteResults.map((result) => result.value);
        survives = votes.filter(Boolean).length;
        if (survives < 2) rejected.push(finding.id);
      }
      fs.writeFileSync(path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-verify.json`), JSON.stringify({ status: 'ok', rejected }) + '\n');
      const recorded = await cli(['gate-panel-round-record', ref]);
      if (recorded.status === 'done') return;
    }
  };

  for (;;) {
    await throwIfAborted();
    const startArgs = ['round-start', ref];
    if (initialBase) startArgs.push(initialBase);
    if (broad) startArgs.push('--broad');
    if (noBroad) startArgs.push('--no-broad'); // broad review is on by default; this is the opt-out
    if (noDod) startArgs.push('--no-dod');
    // On resume, an unpassed reviewer/fixer must NOT be resent as the 'codex'
    // default -- round-start rejects a request that conflicts with the
    // ledger's persisted routing. Omit it and let round-start fall back to
    // ledger.reviewRouting, which it already supports.
    if (!resume || options.reviewer) startArgs.push('--reviewer', reviewer);
    if (!resume || options.fixer) startArgs.push('--fixer', fixer);
    if (options.reviewerModel) startArgs.push('--reviewer-model', options.reviewerModel);
    if (options.fixerModel) startArgs.push('--fixer-model', options.fixerModel);
    const started = await cli(startArgs);
    if (!initialBase && started.base) initialBase = started.base;
    if (initiativeRevision.head_sha && started.head && initiativeRevision.head_sha !== started.head) throw new Error('review-until-green: initiative target revision changed before round-start');
    initiativeRevision = { ref: started.ref || ref, ...(started.base || initialBase ? { base: started.base || initialBase } : {}), ...(started.head || initiativeRevision.head_sha ? { head_sha: started.head || initiativeRevision.head_sha } : {}) };
    await throwIfAborted(started.decision === 'work');
    if (started.reviewRouting) {
      reviewer = started.reviewRouting.reviewer || reviewer;
      fixer = started.reviewRouting.fixer || fixer;
      reviewerModel = started.reviewRouting.reviewerModel || reviewerModel;
      fixerModel = started.reviewRouting.fixerModel || fixerModel;
    }
    if (!telemetryPath) telemetryPath = path.join(started.stateDir, `telemetry-${targetSlug(ref)}.json`);
    if (!telemetryLoaded) {
      if (fs.existsSync(telemetryPath)) {
        try {
          Object.assign(telemetry, JSON.parse(fs.readFileSync(telemetryPath, 'utf8')));
          for (const aggregate of [telemetry.total, ...Object.values(telemetry.byRole || {})]) if (!Number.isFinite(aggregate.cacheWriteInputTokens)) aggregate.cacheWriteInputTokens = 0;
        } catch {
          telemetry.total.malformedCalls = 1;
          telemetry.invocations.push({
            engine: 'codex', provider: 'openai', role: 'unknown', round: null, invocationId: null,
            status: 'malformed', usagePartial: true, artifactPath: telemetryPath, elapsedMs: null,
            inputTokens: null, cacheWriteInputTokens: null, cachedInputTokens: null,
            reasoningOutputTokens: null, outputTokens: null, totalTokens: null,
          });
        }
      }
    }
    telemetryLoaded = true;
    if (started.decision !== 'work') return withTelemetry(started);
    currentRound = started.round;
    const revision = initiativeRevision;
    checks = [{ name: 'definition-of-done', status: started.dodDeferred ? 'deferred' : (started.dodPassed ? 'passed' : 'failed') }];
    const context = { stateDir: started.stateDir, round: started.round, targetType: started.targetType, dodPassed: started.dodPassed, dodDeferred: started.dodDeferred, priorIntentIds: started.priorIntentIds, slug: targetSlug(ref) };
    let slotAllocation = Promise.resolve();
    const launch = async (input) => {
      const reservation = { role: input.role, target: ref, revision, attemptId: started.attemptId || `${revision.ref}\u0000${revision.head_sha || revision.base || 'unknown'}`, round: currentRound };
      if (initiativeRun && !reserveLaunch(initiativeRun, reservation)) {
        const reason = denialReason(initiativeRun, reservation);
        const denied = new Error(`review-until-green: initiative launch ${reason || 'reservation contended'} before ${input.role}`);
        // A run out of budget or parked for reconciliation is a blocked outcome, not a review failure.
        if (reason === 'budget-exhausted' || reason === 'reconciliation-required') denied.initiativeBlocked = reason;
        throw denied;
      }
      const artifactPath = artifactDestinationFromPrompt(input.prompt, input.stateDir);
      const isFix = input.role === 'fix';
      const provider = isFix ? fixer : reviewer;
      const requestedModel = isFix ? fixerModel : reviewerModel;
      let telemetrySlot = null;
      if (artifactPath && provider === 'codex') {
        const allocation = slotAllocation.then(() => cli(['telemetry-slot', ref, artifactPath, '--engine', 'codex']));
        slotAllocation = allocation.catch(() => {});
        telemetrySlot = await allocation;
      }
      return invoke(spawn, {
        ...input,
        provider,
        ...(requestedModel ? { requestedModel } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        ...(options.subprocessTimeoutMs ? { timeoutMs: options.subprocessTimeoutMs } : {}),
        ...(abortController ? { abortSignal: abortController.signal } : {}),
        ...(telemetrySlot ? { telemetrySlot } : {}),
      });
    };

    const runArtifactReviewer = async (role) => {
      if ((started.completedArtifacts || []).includes(role)) return;
      let retryPrompt = (started.retryArtifacts && started.retryArtifacts[role]) || (started.retryArtifact && started.retryArtifact.role === role ? started.retryArtifact.prompt : undefined);
      try {
        for (let attempt = retryPrompt ? 1 : 0; attempt < 2; attempt++) {
          await launch({ role, prompt: reviewerPrompt(role, { ...context, retryPrompt }), repoRoot, stateDir: context.stateDir });
          const normalized = await cli(['artifact-normalize', ref, role]);
          if (normalized.status === 'ok') return;
          if (normalized.status !== 'retry' || attempt === 1) throw new Error(`harness-failure: ${role} artifact retry exhausted`);
          retryPrompt = normalized.prompt;
        }
      } catch (error) {
        const failure = error.reviewFailure || { role, kind: /artifact|missing gate artifact/.test(String(error.message)) ? 'artifact-write-failure' : 'harness-error', message: String(error.message).replace(/^harness-failure:\s*/, '') };
        try { await cli(['round-failure', ref, JSON.stringify(failure)]); } catch (_) {}
        throw error;
      }
    };

    const reviewers = [
      (async () => {
        await runArtifactReviewer('correctness');
        await runArtifactReviewer('verify');
      })(),
    ];
    if (started.intentApplied) reviewers.push(runArtifactReviewer('intent'));
    if (started.gateApplied) reviewers.push((async () => {
      await runArtifactReviewer('gate');
      await runArtifactReviewer('gate-verify');
    })());
    const reviewerResults = await Promise.allSettled(reviewers);
    const reviewerFailure = reviewerResults.find((result) => result.status === 'rejected');
    if (reviewerFailure) throw reviewerFailure.reason;

    const planned = await cli(['plan-fixes', ref]);
    await throwIfAborted(true);
    for (const finding of planned.fixes || []) {
      try {
        await launch({ role: 'fix', prompt: reviewerPrompt('fix', { ...context, finding, plannedFindingIds: (planned.fixes || []).map((f) => f.id) }), repoRoot, stateDir: context.stateDir });
        if (started.targetType !== 'file') {
          const committed = await cli(['commit-fix', ref, finding.id]);
          if (committed?.committed && committed.sha) initiativeRevision = { ...initiativeRevision, head_sha: committed.sha };
        } else {
          const head_sha = options.targetIdentity ? options.targetIdentity(ref, initialBase, canonicalRepoRoot) : fileTarget({ files: [ref.slice('file:'.length)] }, canonicalRepoRoot).identity;
          initiativeRevision = { ...initiativeRevision, head_sha };
        }
      } catch (error) {
        const failure = error.reviewFailure || { role: 'fix', kind: /artifact|missing gate artifact/.test(String(error.message)) ? 'artifact-write-failure' : 'harness-error', message: String(error.message).replace(/^harness-failure:\s*/, '') };
        try { await cli(['round-failure', ref, JSON.stringify(failure)]); } catch (_) {}
        throw error;
      }
    }
    let recorded = await cli(['record', ref]);
    if (recorded.decision && recorded.decision.panelPending) {
      await runPanel(context, launch);
      await throwIfAborted(true);
      recorded = await cli(['record', ref]);
    }
    await throwIfAborted(true);
    if (recorded.decision && recorded.decision.continue) continue;
    return withTelemetry(recorded);
  }
  } catch (error) {
    if (error.notAReviewFailure) throw error;
    if (error.initiativeBlocked) return { decision: error.initiativeBlocked === 'budget-exhausted' ? 'blocked' : error.initiativeBlocked, reason: error.initiativeBlocked, initiative: publicInitiativeSummary(initiativeRun) };
    const failure = error.reviewFailure || {};
    // recordDisposition dedups an 'error' by its reason (a hash of the
    // message), not just target+revision+kind -- so the fallback lookups
    // below must filter by that same reason, or a different, more recent
    // error at this revision could be returned in place of this one's own
    // (distinct) failure.
    const errorReason = normalizeDisposition(error).reason;
    // A failure here (the ledger lock was busy with no retry, or the run
    // was finalised concurrently) must not replace the real review failure
    // this catch is handling -- rethrow the ORIGINAL error, with the
    // recording failure only noted on its message, so the caller still
    // sees what actually went wrong instead of a generic "contended".
    if (initiativeRun && initiativeRevision.head_sha && !recordDisposition(initiativeRun, { target: ref, revision: initiativeRevision, result: error, packet: { trigger: 'error', exit: { code: Number.isInteger(failure.exitCode) ? failure.exitCode : null, signal: failure.signal || null }, dod: { status: checks[0]?.status || 'not-run' }, telemetry: { complete: false }, nextAction: 'resume', error: { message: error.message } }, checks })) {
      if (!pendingContinuationPacket(initiativeRun, ref, initiativeRevision, 'error', true, errorReason)) {
        error.message = `${error.message} (review-until-green: initiative error disposition recording was also contended)`;
        throw error;
      }
    }
    if (initiativeRun && initiativeRevision.head_sha) {
      const packet = pendingContinuationPacket(initiativeRun, ref, initiativeRevision, 'error', true, errorReason);
      if (!packet) {
        error.message = `${error.message} (review-until-green: initiative error delivery claim was also contended)`;
        throw error;
      }
      error.continuationPacket = packet;
    }
    throw error;
  } finally {
    for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
  }
}

module.exports = { runReviewUntilGreen, acknowledgeContinuationPacket, reviewerPrompt, codexExec, providerExec, jsonCli, resolveCodexExecutable, resolveDefaultBase };
