'use strict';

// Codex has no in-session Task primitive. This runner is therefore the sole
// orchestration authority: every clean-context reviewer is a `codex exec`
// subprocess and every state transition remains owned by review-cli.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { targetSlug } = require('./review');
const { isValidFindingId } = require('./gate-contract');
const { PANEL_LENSES } = require('./report');

function jsonCli(cliPath, args, repoRoot) {
  const out = execFileSync('node', [cliPath, ...args], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repoRoot },
  });
  try { return JSON.parse(out); } catch (e) { throw new Error(`harness-failure: review-cli ${args[0]} returned non-JSON output`); }
}

function normalizeUsage(raw) {
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const providerInputTokens = number(raw && raw.input_tokens);
  const cachedInputTokens = number(raw && raw.cached_input_tokens);
  const reasoningOutputTokens = number(raw && raw.reasoning_output_tokens);
  const outputTokens = number(raw && raw.output_tokens);
  const reportedTotal = number(raw && raw.total_tokens);
  const totalWasReported = !!raw && Object.prototype.hasOwnProperty.call(raw, 'total_tokens');
  const usagePartial = [providerInputTokens, cachedInputTokens, reasoningOutputTokens, outputTokens].some((value) => value === null)
    || (providerInputTokens !== null && cachedInputTokens !== null && cachedInputTokens > providerInputTokens)
    || (totalWasReported && reportedTotal === null);
  const inputTokens = usagePartial ? null : providerInputTokens - cachedInputTokens;
  const usage = {
    inputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    outputTokens,
    totalTokens: !totalWasReported && !usagePartial
      ? providerInputTokens + outputTokens
      : reportedTotal,
  };
  return { usage, usagePartial: usagePartial || usage.totalTokens === null };
}

function codexExec({ role, prompt, repoRoot, stateDir }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('codex', [
      'exec', '--cd', repoRoot, '--sandbox', 'workspace-write', '--add-dir', stateDir,
      '--skip-git-repo-check', '--json', prompt,
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    let pending = '';
    let usage;
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'turn.completed' && event.usage) usage = event.usage;
      } catch (_) { /* malformed telemetry is reported as partial, not as reviewer success */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) consume(line);
    });
    child.once('error', reject);
    child.once('close', (status) => {
      consume(pending);
      resolve({ status, role, elapsedMs: Date.now() - startedAt, ...normalizeUsage(usage) });
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

function reviewerPrompt(role, { stateDir, round, targetType, dodPassed, dodDeferred, finding, retryPrompt, slug, priorIntentIds }) {
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
  if (role === 'fix') return `Apply the minimal correct fix for ${finding.id} at ${finding.file}, ${finding.span}: ${finding.summary}. Edit only necessary files. Then write ONLY to ${artifact}: either {"status":"ok","edited":false} if no change was warranted, or {"status":"ok","edited":true,"files":["<every edited path>"]}. The files array MUST truthfully list EVERY file edited, including required companion files, as repository-relative paths. It MUST NOT include this state artifact, any stateDir artifact, or any path outside the repository.${retry}`;
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
  const rawSpawn = options.spawn || ((input) => codexExec(input));
  const telemetry = {
    total: { calls: 0, partialCalls: 0, inputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    byRole: {},
    invocations: [],
  };
  let currentRound = null;
  let telemetryPath = null;
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
      inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0,
      cachedInputTokens: Number.isFinite(usage.cachedInputTokens) ? usage.cachedInputTokens : 0,
      reasoningOutputTokens: Number.isFinite(usage.reasoningOutputTokens) ? usage.reasoningOutputTokens : 0,
      outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
      totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0,
      elapsedMs: Number.isFinite(result && result.elapsedMs) ? result.elapsedMs : 0,
    };
    const role = input.role;
    const aggregate = telemetry.byRole[role] || (telemetry.byRole[role] = {
      calls: 0, partialCalls: 0, inputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0,
    });
    for (const target of [aggregate, telemetry.total]) {
      target.calls++;
      if (partial) target.partialCalls++;
      for (const key of Object.keys(values)) target[key] += values[key];
    }
    telemetry.invocations.push({
      role, round: currentRound, model: null, reasoningEffort: null,
      status: result && Number.isInteger(result.status) ? result.status : null,
      usagePartial: partial, ...values,
    });
    persistTelemetry();
  };
  const spawn = async (input) => {
    try {
      const result = await rawSpawn(input);
      record(input, result);
      return result;
    } catch (error) {
      record(input, null);
      throw error;
    }
  };
  const withTelemetry = (result) => {
    const output = { ...result, telemetry };
    if (typeof output.handoff === 'string') {
      const total = telemetry.total;
      output.handoff += `\nusage: ${total.calls} calls, ${total.partialCalls} partial, ${total.totalTokens} tokens, ${total.elapsedMs}ms`;
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

  const runPanel = async (context) => {
    const lenses = PANEL_LENSES;
    for (;;) {
      const panel = await cli(['gate-panel-round-start', ref]);
      await Promise.all(lenses.map(async (lens) => {
        const artifact = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-${lens}.json`);
        try {
          await invoke(spawn, { role: `gate-panel-${lens}`, repoRoot, stateDir: context.stateDir,
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
          await invoke(spawn, { role: 'gate-panel-verify', repoRoot, stateDir: context.stateDir,
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
    const started = await cli(startArgs);
    if (!telemetryPath) telemetryPath = path.join(started.stateDir, `telemetry-${targetSlug(ref)}.json`);
    if (resume && fs.existsSync(telemetryPath)) Object.assign(telemetry, JSON.parse(fs.readFileSync(telemetryPath, 'utf8')));
    if (started.decision !== 'work') return withTelemetry(started);
    currentRound = started.round;
    const context = { stateDir: started.stateDir, round: started.round, targetType: started.targetType, dodPassed: started.dodPassed, dodDeferred: started.dodDeferred, priorIntentIds: started.priorIntentIds, slug: targetSlug(ref) };

    const runArtifactReviewer = async (role) => {
      let retryPrompt;
      for (let attempt = 0; attempt < 2; attempt++) {
        await invoke(spawn, { role, prompt: reviewerPrompt(role, { ...context, retryPrompt }), repoRoot, stateDir: context.stateDir });
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
        await invoke(spawn, { role: 'gate-verify', prompt: reviewerPrompt('gate-verify', context), repoRoot, stateDir: context.stateDir });
      } catch (_) {
        // Preserve review-cli's legacy gate-verify leniency: a failed advisory
        // verifier contributes no rejections/new findings, not a harness stop.
      }
    })());
    await Promise.all(reviewers);

    const planned = await cli(['plan-fixes', ref]);
    for (const finding of planned.fixes || []) {
      await invoke(spawn, { role: 'fix', prompt: reviewerPrompt('fix', { ...context, finding }), repoRoot, stateDir: context.stateDir });
      if (started.targetType !== 'file') await cli(['commit-fix', ref, finding.id]);
    }
    let recorded = await cli(['record', ref]);
    if (recorded.decision && recorded.decision.panelPending) {
      await runPanel(context);
      recorded = await cli(['record', ref]);
    }
    if (recorded.decision && recorded.decision.continue) continue;
    return withTelemetry(recorded);
  }
}

module.exports = { runReviewUntilGreen, reviewerPrompt, codexExec, jsonCli, resolveDefaultBase };
