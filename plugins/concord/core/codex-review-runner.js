'use strict';

// Codex has no in-session Task primitive. This runner is therefore the sole
// orchestration authority: every clean-context reviewer is a `codex exec`
// subprocess and every state transition remains owned by review-cli.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { targetSlug } = require('./review');

function jsonCli(cliPath, args, repoRoot) {
  const out = execFileSync('node', [cliPath, ...args], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repoRoot },
  });
  try { return JSON.parse(out); } catch (e) { throw new Error(`harness-failure: review-cli ${args[0]} returned non-JSON output`); }
}

function codexExec({ role, prompt, repoRoot, stateDir }) {
  const result = spawnSync('codex', [
    'exec', '--cd', repoRoot, '--sandbox', 'workspace-write', '--add-dir', stateDir,
    '--skip-git-repo-check', prompt,
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`harness-failure: ${role} subprocess exited ${result.status}`);
  return result;
}

function reviewerPrompt(role, { stateDir, round, targetType, dodPassed, finding, retryPrompt, slug }) {
  const artifact = path.join(stateDir, role === 'fix' ? `round-${round}-fix-${finding.id}.json` : `round-${round}-${role}.json`);
  const retry = retryPrompt ? `\n\n${retryPrompt}` : '';
  if (role === 'correctness') {
    const doc = targetType === 'file';
    return `${doc ? 'Review the document' : 'Review the diff and surrounding code'} at ${path.join(stateDir, `round-${round}-diff.txt`)}. ${doc ? 'Find contradictions, unsupported claims, placeholders, over-claims, and omitted limitations. IDs must start docreview:.' : `Find correctness bugs, reuse/efficiency problems, and verifier-gaming. DoD already ${dodPassed ? 'passed; do not rerun tests' : 'failed; do not root-cause it'}. IDs must start correctness:.`} Write ONLY JSON to ${artifact}: {"status":"ok","examined":[],"findings":[]}.${retry}`;
  }
  if (role === 'verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-correctness.json`)} against ${path.join(stateDir, `round-${round}-diff.txt`)}. Write ONLY {"status":"ok","rejected":[]} to ${artifact}.${retry}`;
  if (role === 'intent') return `You are a design-conformance detector. Compare ${path.join(stateDir, `round-${round}-diff.txt`)} with ${path.join(stateDir, `intent-${slug}.md`)}. Raise a finding ONLY for an active contradiction of an explicit stated requirement on an exact changed line. Each finding MUST have an intent: ID, file, span containing that exact changed line, the verbatim requirement text, and summary. Never report omissions, unchanged lines, design taste, or non-normative text. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate') return `Review ${path.join(stateDir, `round-${round}-diff.txt`)} for defects a diff-local reviewer cannot catch. You MAY Read/Grep the repository and MUST read ${path.join(stateDir, `intent-${slug}.md`)} if it exists. Report only gate: findings in classes cross-context, silent-gap, ac-coverage, or design-conformance. Each finding needs file, span/evidence anchor, requirement text when available, and summary. Write ONLY {"status":"ok","findings":[]} to ${artifact}.${retry}`;
  if (role === 'gate-verify') return `Re-review candidates in ${path.join(stateDir, `round-${round}-gate.json`)} against the diff and repository. Reject false positives and design-taste objections; keep actionable gaps. You MAY add genuinely new gate: findings using the same file, span/evidence, requirement, and summary shape. Write ONLY {"status":"ok","rejected":[],"findings":[]} to ${artifact}.${retry}`;
  if (role === 'fix') return `Apply the minimal correct fix for ${finding.id} at ${finding.file}, ${finding.span}: ${finding.summary}. Edit only necessary files. Then write ONLY to ${artifact}: either {"status":"ok","edited":false} if no change was warranted, or {"status":"ok","edited":true,"files":["<every edited path>"]}. The files array MUST truthfully list EVERY file edited, including required companion files.${retry}`;
  throw new Error(`harness-failure: unknown reviewer role ${role}`);
}

async function invoke(spawn, input) {
  const result = await spawn(input);
  if (result && result.status != null && result.status !== 0) throw new Error(`harness-failure: ${input.role} subprocess exited ${result.status}`);
}

async function runReviewUntilGreen(options) {
  const { ref, base, broad = false, repoRoot = process.cwd(), cliPath = path.join(__dirname, '..', 'bin', 'review-cli.js') } = options;
  if (!ref) throw new Error('review-until-green: missing target ref');
  const runCli = options.runCli || ((args) => jsonCli(cliPath, args, repoRoot));
  const spawn = options.spawn || ((input) => codexExec(input));
  const cli = (args) => runCli(args);

  const runPanel = async (context) => {
    const lenses = ['ac-coverage', 'design-conformance', 'cross-context', 'silent-gap', 'threat-model'];
    for (;;) {
      const panel = await cli(['gate-panel-round-start', ref]);
      await Promise.all(lenses.map(async (lens) => {
        const artifact = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-${lens}.json`);
        await invoke(spawn, { role: `gate-panel-${lens}`, repoRoot, stateDir: context.stateDir,
          prompt: `Review ${path.join(context.stateDir, `round-${context.round}-diff.txt`)} and the repository through the ${lens} lens. You MAY Read/Grep the repository and MUST read ${path.join(context.stateDir, `intent-${context.slug}.md`)} if it exists to assess the design and acceptance criteria. Previously rejected IDs: ${JSON.stringify(panel.rejectedIds || [])}. Write ONLY {"status":"ok","findings":[]} to ${artifact}; every ID must use gate:${lens}:<slug>.` });
      }));
      const candidates = [];
      for (const lens of lenses) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-${lens}.json`), 'utf8'));
          for (const finding of raw.findings || []) if (finding && typeof finding.id === 'string') candidates.push(finding);
        } catch (_) { /* panel lenses are intentionally lenient */ }
      }
      const rejected = [];
      for (const finding of candidates) {
        let survives = 0;
        const votes = await Promise.all([0, 1, 2].map(async (vote) => {
          const verdict = path.join(context.stateDir, `round-${context.round}-gate-panel-${panel.round}-vote-${finding.id}-${vote}.json`);
          await invoke(spawn, { role: 'gate-panel-verify', repoRoot, stateDir: context.stateDir,
            prompt: `Try to refute gate finding ${JSON.stringify(finding)}. Default to refuted if uncertain. Write ONLY {"status":"ok","survives":false} to ${verdict}.` });
          try { return JSON.parse(fs.readFileSync(verdict, 'utf8')).survives === true; } catch (_) { return false; }
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
    if (base) startArgs.push(base);
    if (broad) startArgs.push('--broad');
    const started = await cli(startArgs);
    if (started.decision !== 'work') return started;
    const context = { stateDir: started.stateDir, round: started.round, targetType: started.targetType, dodPassed: started.dodPassed, slug: targetSlug(ref) };

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

    await runArtifactReviewer('correctness');
    await runArtifactReviewer('verify');
    if (started.intentApplied) await runArtifactReviewer('intent');
    if (started.gateApplied) {
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
    }

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
    return recorded;
  }
}

module.exports = { runReviewUntilGreen, reviewerPrompt, codexExec, jsonCli };
