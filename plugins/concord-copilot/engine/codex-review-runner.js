'use strict';

// Codex has no in-session Task primitive. This runner is therefore the sole
// orchestration authority: every clean-context reviewer is a `codex exec`
// subprocess and every state transition remains owned by review-cli.
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { targetSlug } = require('./review');
const { artifactDestinationFromPrompt } = require('./review-artifact');
const { isValidFindingId } = require('./gate-contract');
const { PANEL_LENSES } = require('./report');

const CODEX_VERSION = 'codex-cli 0.154.0';
const CODEX_USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const CODEX_EVENT_TYPES = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
const CODEX_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'error', 'collaboration_tool_call', 'collab_agent_tool_call']);
const PROVIDERS = new Set(['claude', 'codex', 'copilot']);
let versionCache = null;

function codexCliVersion(repoRoot) {
  const searchPath = process.env.PATH || '';
  if (!versionCache || versionCache.searchPath !== searchPath) {
    let value = null;
    try { value = execFileSync('codex', ['--version'], { cwd: repoRoot, encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
    versionCache = { searchPath, value };
  }
  return versionCache.value;
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

function codexExec({ role, prompt, repoRoot, stateDir, requestedModel, reasoningEffort, serviceTier }) {
  return new Promise((resolve, reject) => {
    const invocationId = crypto.randomUUID();
    const model = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel : null;
    const effort = typeof reasoningEffort === 'string' && reasoningEffort.trim() ? reasoningEffort : null;
    const tier = typeof serviceTier === 'string' && serviceTier.trim() ? serviceTier : null;
    const cliVersion = codexCliVersion(repoRoot);
    const startedAt = Date.now();
    const child = spawn('codex', [
      'exec', '--cd', repoRoot, '--sandbox', 'workspace-write', '--add-dir', stateDir,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--config', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ...(tier ? ['--config', `service_tier=${JSON.stringify(tier)}`] : []),
      '--skip-git-repo-check', '--json', prompt,
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
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
      error.telemetry = {
        status: 'failed', role, engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', cliVersion,
        requestedModel: model, reasoningEffort: effort, serviceTier: tier, resolvedModel: 'unavailable', invocationId,
        elapsedMs: Date.now() - startedAt, usagePartial: true,
      };
      reject(error);
    });
    child.once('close', (status) => {
      consume(pending);
      const normalized = normalizeUsage(usage);
      resolve({
        status, role, engine: 'codex', provider: 'openai', providerSchema: 'codex-exec-json-v1', cliVersion,
        requestedModel: model, reasoningEffort: effort, serviceTier: tier, resolvedModel: 'unavailable', invocationId, elapsedMs: Date.now() - startedAt,
        ...normalized,
        usagePartial: normalized.usagePartial || streamPartial || completionCount !== 1 || status !== 0,
        ...(cliVersion !== CODEX_VERSION ? { usageStatus: 'unsupported-cli-version' } : {}),
        evidence: { collaboration: collaborationEvidenceCount, errors: errorEvidenceCount },
      });
    });
  });
}

function providerExec(input) {
  const { provider, role, prompt, repoRoot, stateDir } = input;
  if (!PROVIDERS.has(provider)) throw new Error(`harness-failure: unsupported provider "${provider}"`);
  if (provider === 'codex') return codexExec(input);

  const requestedModel = typeof input.requestedModel === 'string' && input.requestedModel.trim()
    ? input.requestedModel
    : null;
  const invocationId = crypto.randomUUID();
  const startedAt = Date.now();
  const executable = provider;
  const args = provider === 'claude'
    ? [
        '-p',
        ...(requestedModel ? ['--model', requestedModel] : []),
        '--output-format', 'json', '--no-session-persistence',
        '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
        '--add-dir', stateDir, prompt,
      ]
    : [
        '-p', prompt,
        ...(requestedModel ? ['--model', requestedModel] : []),
        '--silent', '--allow-all-tools', '--allow-all-paths', '--no-ask-user',
        '-C', repoRoot,
      ];
  const providerName = provider === 'claude' ? 'anthropic' : 'github';
  const providerSchema = provider === 'claude' ? 'claude-print-json-v1' : 'copilot-prompt-v1';

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', (error) => {
      error.telemetry = {
        status: 'failed', role, engine: provider, provider: providerName, providerSchema,
        requestedModel, resolvedModel: 'unavailable', invocationId,
        elapsedMs: Date.now() - startedAt, usagePartial: true,
      };
      reject(error);
    });
    child.once('close', (status) => resolve({
      status, role, engine: provider, provider: providerName, providerSchema,
      requestedModel, resolvedModel: 'unavailable', invocationId,
      elapsedMs: Date.now() - startedAt, usagePartial: true,
    }));
  });
}

// A fresh git review needs an explicit merge-base side of the diff. Resolve
// the repository's advertised remote default without hard-coding `origin`;
// repositories with no remote HEAD must name a base rather than silently
// falling back to a working-tree diff against HEAD.
function resolveDefaultBase(repoRoot, exec = execFileSync) {
  let refs;
  try {
    refs = exec('git', ['for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  } catch (error) {
    throw new Error('review-until-green: cannot determine a remote default base; pass an explicit base');
  }
  for (const ref of String(refs).split(/\r?\n/)) {
    const match = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
    if (match) return `${match[1]}/${match[2]}`;
  }
  throw new Error('review-until-green: cannot determine a remote default base; pass an explicit base');
}

// The loop makes reviewers hunt verifier-gaming in the diff; this is the same
// guard pointed at the reviewer's own evidence. A reviewer that loses a tool it
// was told to use (denied by the sandbox, missing, crashed) otherwise emits a
// confident schema-valid verdict produced by a check it never ran -- which
// artifact-normalize cannot distinguish from a real one. Declaring `blocked`
// makes the round fail loudly instead, which is the correct outcome.
const BLOCKED_CLAUSE = ' If you cannot run a tool this task requires (missing, denied by sandbox or permissions, crashed, timed out), do NOT substitute a weaker method and do NOT stay silent: write {"status":"ok","blocked":["<tool>: <what failed>"]} and stop.';

function reviewerPrompt(role, { stateDir, round, targetType, dodPassed, dodDeferred, finding, retryPrompt, slug, priorIntentIds, plannedFindingIds = [] }) {
  const artifact = path.join(stateDir, role === 'fix' ? `round-${round}-fix-${finding.id}.json` : `round-${round}-${role}.json`);
  const retry = `${role === 'fix' ? '' : BLOCKED_CLAUSE}${retryPrompt ? `\n\n${retryPrompt}` : ''}`;
  if (role === 'correctness') {
    const doc = targetType === 'file';
    // Under a deferral round-start still reports dodPassed:true, so this note
    // must key off dodDeferred: telling a reviewer "DoD already passed; do not
    // rerun tests" when no gate ran removes the only remaining check.
    const dodNote = dodDeferred
      ? "No executable DoD gate ran this run; a single run of the repo's own already-configured build/test command is acceptable if you genuinely need one."
      : `DoD already ${dodPassed ? 'passed; do not rerun tests' : 'failed; do not root-cause it'}.`;
    return `${doc ? 'Review the document' : 'Review the diff and surrounding code'} at ${path.join(stateDir, `round-${round}-diff.txt`)}. ${doc ? 'Find contradictions, unsupported claims, placeholders, over-claims, and omitted limitations. Every reviewed target MUST appear in "examined". Finding IDs MUST use docreview:<stable-slug>. Every finding MUST include "file", "span", and "summary"; use {"id":"docreview:<stable-slug>","gate":"correctness","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"}.' : `Find correctness bugs, reuse/efficiency problems, and verifier-gaming. ${dodNote} Every finding MUST include "file", "span", and "summary"; use {"id":"correctness:<stable-slug>","file":"<path>","span":"<exact offending text>","summary":"<one sentence>"} -- a finding with no "file" fails the round outright, it is not retried. Every changed file in the diff MUST appear in "examined". Uncertainty is not a reason to withhold a finding: a separate verify pass rejects false positives, so a finding you are unsure about costs nothing to raise. Triviality is different: a real but minor finding is not a false positive, so it routes to a fixer and an honest "no change warranted" parks the run for a human. Raise a minor one only if the fix is worth making; that judgement is yours, and it is the ONLY thing you may withhold on.`} Ignore any intent-*.md file in the state directory; it is not part of your input. Write ONLY JSON to ${artifact}: {"status":"ok","examined":[],"findings":[]}.${retry}`;
  }
  if (role === 'verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-correctness.json`)} against ${path.join(stateDir, `round-${round}-diff.txt`)}. Ignore any intent-*.md file in the state directory; it is not part of your input. Your different lens may also catch a bug the first pass missed -- add it to "findings" in the same shape the correctness pass uses (id, file, span, summary), and it routes to a fixer like any other. Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}; each rejection is {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"} -- a rejection with no stated basis is rejected by the artifact contract.${retry}`;
  if (role === 'intent') return `You are a design-conformance detector. Compare ${path.join(stateDir, `round-${round}-diff.txt`)} with ${path.join(stateDir, `intent-${slug}.md`)}. Raise a finding ONLY for an active contradiction of an explicit stated requirement on an exact changed line. Each finding MUST have an intent: ID, file, span containing that exact changed line, the verbatim requirement text, and summary. Never report omissions, unchanged lines, design taste, or non-normative text. Still-open intent IDs from the previous round: ${JSON.stringify(priorIntentIds || [])}. For the SAME objection against the SAME requirement, REUSE that id verbatim so a human recognises the objection they already saw; mint a new id ONLY for a genuinely new objection -- nothing dedupes intent findings, so a re-slugged repeat reads as a second problem. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate') return `Review ${path.join(stateDir, `round-${round}-diff.txt`)} for defects a diff-local reviewer cannot catch. You MAY Read/Grep the repository and MUST read ${path.join(stateDir, `intent-${slug}.md`)} if it exists. Report only gate: findings, and every ID MUST be gate:<class>:<slug> with <class> one of cross-context, silent-gap, ac-coverage, design-conformance -- a two-segment id silently defaults the class. Each finding needs file, span/evidence anchor, requirement text when available, and summary. Report every gap you find, including ones you are uncertain about: a separate gate-verify pass rejects false positives, so your job here is coverage, not filtering. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate-verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-gate.json`)} against the diff and repository. Reject false positives and design-taste objections; keep actionable gaps. You MAY add genuinely new gate: findings using the same file, span/evidence, requirement, and summary shape. Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}; each rejection is {"id":"<finding id>","reason":"<one line naming what you actually ran, measured, or read to reject it>"}.${retry}`;
  if (role === 'fix') {
    const mirrorClaim = targetType === 'file' ? '' : `,"resolvedFindingIds":["<distinct planned mirror finding id>"]`;
    const mirrorNote = targetType === 'file' ? '' : ` Omit resolvedFindingIds unless this commit also resolves that distinct planned finding: its exact span must be absent from a file in files. It may contain only IDs from this round's other planned fixes: ${JSON.stringify(plannedFindingIds.filter((id) => id !== finding.id))}`;
    return `Apply the minimal correct fix for ${finding.id} at ${finding.file}, ${finding.span}: ${finding.summary}. Edit only necessary files. Then write ONLY to ${artifact}: either {"status":"ok","edited":false} if no change was warranted, or {"status":"ok","edited":true,"files":["<every edited path>"]${mirrorClaim}}.${mirrorNote} The files array MUST truthfully list EVERY file edited, including required companion files, as repository-relative paths. It MUST NOT include this state artifact, any stateDir artifact, or any path outside the repository.${retry}`;
  }
  throw new Error(`harness-failure: unknown reviewer role ${role}`);
}

async function invoke(spawn, input) {
  const result = await spawn(input);
  if (result && result.status !== 0) throw new Error(`harness-failure: ${input.role} subprocess exited ${result.status}`);
}

async function runReviewUntilGreen(options) {
  const { ref, base, broad = false, noBroad = false, noDod = false, resume = false, repoRoot = process.cwd(), cliPath = path.join(__dirname, '..', 'bin', 'review-cli.js') } = options;
  if (!ref) throw new Error('review-until-green: missing target ref');
  const runCli = options.runCli || ((args) => jsonCli(cliPath, args, repoRoot));
  const reviewer = options.reviewer || 'codex';
  const fixer = options.fixer || 'codex';
  for (const provider of [reviewer, fixer]) {
    if (!PROVIDERS.has(provider)) throw new Error(`review-until-green: unsupported provider "${provider}"`);
  }
  const rawSpawn = options.spawn || ((input) => providerExec(input));
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
    const temporary = `${telemetryPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(telemetry)}\n`);
    fs.renameSync(temporary, telemetryPath);
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
    if ((result?.decision === 'terminal' || result?.decision?.converged === true || result?.decision?.parked === true || result?.decision?.abandoned === true) && telemetryPath) {
      try { fs.unlinkSync(telemetryPath); } catch {}
    }
    return output;
  };
  const cli = (args) => runCli(args);
  // Never resolve a base for resume: round-start restores ledger.target.base.
  // File targets do not have a git base at all.
  const baseResolver = options.resolveDefaultBase || (options.runCli ? null : resolveDefaultBase);
  const initialBase = resume
    ? undefined
    : (base === undefined && !ref.startsWith('file:') && baseResolver ? baseResolver(repoRoot) : base);

  const runPanel = async (context, launch) => {
    const lenses = PANEL_LENSES;
    for (;;) {
      const panel = await cli(['gate-panel-round-start', ref]);
      await Promise.all(lenses.map(async (lens) => {
        const artifact = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-${lens}.json`);
        try {
          await launch({ role: `gate-panel-${lens}`, repoRoot, stateDir: context.stateDir,
            prompt: `Review ${path.join(context.stateDir, `round-${context.round}-diff.txt`)} and the repository through the ${lens} lens. You MAY Read/Grep the repository and MUST read ${path.join(context.stateDir, `intent-${context.slug}.md`)} if it exists to assess the design and acceptance criteria. Previously rejected IDs: ${JSON.stringify(panel.rejectedIds || [])} -- do not re-raise one unless you found something the earlier round did not. Every candidate faces three adversarial verifiers that default to REFUTED when uncertain and decide by majority, so a gap you cannot anchor in evidence will not survive: substantiate what you raise rather than raising more. Write ONLY {"status":"ok","findings":[]} to ${artifact}; every ID must use gate:${lens}:<slug>.${BLOCKED_CLAUSE}` });
        } catch (_) { /* panel lenses are intentionally lenient */ }
      }));
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
        const votes = await Promise.all([0, 1, 2].map(async (vote) => {
          const verdict = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-vote-${finding.id}-${vote}.json`);
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
        survives = votes.filter(Boolean).length;
        if (survives < 2) rejected.push(finding.id);
      }
      fs.writeFileSync(path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-verify.json`), JSON.stringify({ status: 'ok', rejected }) + '\n');
      const recorded = await cli(['gate-panel-round-record', ref]);
      if (recorded.status === 'done') return;
    }
  };

  for (;;) {
    const startArgs = ['round-start', ref];
    if (initialBase) startArgs.push(initialBase);
    if (broad) startArgs.push('--broad');
    if (noBroad) startArgs.push('--no-broad'); // broad review is on by default; this is the opt-out
    if (noDod) startArgs.push('--no-dod');
    startArgs.push('--reviewer', reviewer, '--fixer', fixer);
    if (options.reviewerModel) startArgs.push('--reviewer-model', options.reviewerModel);
    if (options.fixerModel) startArgs.push('--fixer-model', options.fixerModel);
    const started = await cli(startArgs);
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
    const context = { stateDir: started.stateDir, round: started.round, targetType: started.targetType, dodPassed: started.dodPassed, dodDeferred: started.dodDeferred, priorIntentIds: started.priorIntentIds, slug: targetSlug(ref) };
    let slotAllocation = Promise.resolve();
    const launch = async (input) => {
      const artifactPath = artifactDestinationFromPrompt(input.prompt, input.stateDir);
      const isFix = input.role === 'fix';
      const provider = isFix ? fixer : reviewer;
      const requestedModel = isFix ? options.fixerModel : options.reviewerModel;
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
        ...(telemetrySlot ? { telemetrySlot } : {}),
      });
    };

    const runArtifactReviewer = async (role) => {
      let retryPrompt;
      for (let attempt = 0; attempt < 2; attempt++) {
        await launch({ role, prompt: reviewerPrompt(role, { ...context, retryPrompt }), repoRoot, stateDir: context.stateDir });
        const normalized = await cli(['artifact-normalize', ref, role]);
        if (normalized.status === 'ok') return;
        if (normalized.status !== 'retry' || attempt === 1) throw new Error(`harness-failure: ${role} artifact retry exhausted`);
        retryPrompt = normalized.prompt;
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
      // gate-verify is intentionally lenient in review-cli: a missing or
      // malformed advisory verify artifact means zero rejections/new findings,
      // not a harness failure. Do not route it through artifact-normalize.
      try {
        await launch({ role: 'gate-verify', prompt: reviewerPrompt('gate-verify', context), repoRoot, stateDir: context.stateDir });
      } catch (_) {
        // Preserve review-cli's legacy gate-verify leniency: a failed advisory
        // verifier contributes no rejections/new findings, not a harness stop.
      }
    })());
    await Promise.all(reviewers);

    const planned = await cli(['plan-fixes', ref]);
    for (const finding of planned.fixes || []) {
      await launch({ role: 'fix', prompt: reviewerPrompt('fix', { ...context, finding, plannedFindingIds: (planned.fixes || []).map((f) => f.id) }), repoRoot, stateDir: context.stateDir });
      if (started.targetType !== 'file') await cli(['commit-fix', ref, finding.id]);
    }
    let recorded = await cli(['record', ref]);
    if (recorded.decision && recorded.decision.panelPending) {
      await runPanel(context, launch);
      recorded = await cli(['record', ref]);
    }
    if (recorded.decision && recorded.decision.continue) continue;
    return withTelemetry(recorded);
  }
}

module.exports = { runReviewUntilGreen, reviewerPrompt, codexExec, providerExec, jsonCli, resolveDefaultBase };
