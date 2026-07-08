#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveStateDirFromCwd } = require('./lib/statedir');
const engine = require('./lib/engine');
const dodExec = require('./lib/dod-exec');

// Thin entry: wires the real LLM/git/process implementations behind
// lib/engine.js's injected-dependency boundary and runs the loop for one
// target. All the actual orchestration logic (and its tests) live in
// lib/engine.js with fakes -- this file has none of its own logic to test in
// isolation, only wiring.

const CLAUDE_CALL_TIMEOUT_MS = 90 * 1000; // matches the spike's 90s alarm cap

function resolveStateDir() {
  if (process.env.REVIEW_STATE_DIR) return process.env.REVIEW_STATE_DIR;
  return resolveStateDirFromCwd();
}

function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
}

// The default `runGate`: a headless `claude -p --safe-mode --model sonnet`
// call per design §4. `--safe-mode` strips ambient session plugins/hooks that
// would otherwise fire unprompted and pollute output/cost; `--` precedes the
// prompt so `--add-dir` cannot swallow it; stdin is explicitly closed (no
// `--bare` -- it demands an API key and refuses OAuth/keychain auth, per the
// spike). The prompt is passed as a single argv element via execFileSync
// (no shell involved) -- never interpolated into a shell command string.
function claudeCall(repoRoot, prompt, opts = {}) {
  const args = ['-p', '--safe-mode', '--model', 'sonnet', '--output-format', 'json'];
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.addDir) args.push('--add-dir', opts.addDir);
  args.push('--', prompt);

  let raw;
  try {
    // cwd pinned to repoRoot regardless of where this process itself was
    // invoked from, so claude's Read/Edit tools resolve relative paths
    // (finding.file) against the target repo, not this script's own cwd.
    raw = sh('claude', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: CLAUDE_CALL_TIMEOUT_MS });
  } catch (e) {
    throw new Error(`claude -p invocation failed: ${e && e.message ? e.message : e}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`claude -p returned non-JSON output: ${e.message}`);
  }
  if (parsed.is_error) {
    throw new Error(`claude -p reported an error: ${parsed.result || parsed.subtype || 'unknown'}`);
  }
  return { text: parsed.result || '', costUsd: Number(parsed.total_cost_usd) || 0 };
}

function makeGitOps(repoRoot, target) {
  return {
    diff() {
      const args = target.base ? ['diff', `${target.base}...HEAD`] : ['diff', 'HEAD'];
      return sh('git', args, { cwd: repoRoot });
    },
    commitFix(findingId, summary) {
      sh('git', ['add', '-A'], { cwd: repoRoot });
      const message = `fix(review-until-green): ${findingId}\n\n${summary}`;
      sh('git', ['commit', '-m', message], { cwd: repoRoot });
      return sh('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
    },
    isReachable(sha) {
      try {
        sh('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: repoRoot });
        return true;
      } catch (e) {
        return false;
      }
    },
  };
}

function makeSpanStillPresent(repoRoot) {
  return (file, span) => {
    if (!span) return true;
    try {
      const content = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      return content.includes(span);
    } catch (e) {
      return false;
    }
  };
}

// Terminal handoff (design §8): rounds, killed/fixed/parked counts, a per-fix
// rationale digest, and the needs-decision packets -- the "one consolidated
// handoff" that replaces the manual review<->fix relay.
function renderHandoff(result) {
  const { ledger, cost, aborted } = result;
  const lines = [];
  lines.push(`review-until-green: target ${ledger.target && ledger.target.ref} -- status: ${ledger.status}`);
  lines.push(
    `rounds: ${ledger.round}/${ledger.budget.max_rounds} (spent ${ledger.budget.spent})  cost: $${cost.totalUsd.toFixed(4)} across ${cost.calls} call(s)`
  );
  if (aborted) lines.push(`ABORTED (${aborted.kind}): ${aborted.message}`);

  const fixed = (ledger.findings || []).filter((f) => f.status === 'fixed');
  const killedCount = (ledger.seen || []).filter((s) => s.status === 'killed').length;
  const parked = (ledger.findings || []).filter((f) => f.status === 'parked');
  lines.push(`findings: ${fixed.length} fixed, ${killedCount} killed (false-positive), ${parked.length} parked`);

  if (fixed.length) {
    lines.push('', 'Fix digest:');
    for (const f of fixed) lines.push(`  - [${f.id}] ${f.summary} -> commit ${f.fix_commit}`);
  }
  if (parked.length) {
    lines.push('', 'Needs-decision packets:');
    for (const f of parked) {
      const reason = f.park_reason || {};
      lines.push(`  - [${f.id}] ${f.file}: ${f.summary}`);
      lines.push(`    kind: ${reason.kind || 'unknown'} -- ${reason.text || '(no reason recorded)'}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const [ref, base] = process.argv.slice(2);
  if (!ref) throw new Error('review-engine: missing required <ref> argument');

  const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();
  const headSha = sh('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
  const target = { kind: 'local', ref, base: base || 'main', head_sha: headSha };

  const dodConfig = dodExec.loadDodConfig(repoRoot);
  const deps = {
    repoRoot,
    stateDir: resolveStateDir(),
    runGate: (prompt, opts) => claudeCall(repoRoot, prompt, opts),
    runDodExec: () => dodExec.runDodExec({ cwd: repoRoot, commands: dodConfig.dod, execFn: dodExec.defaultExecFn }),
    gitOps: makeGitOps(repoRoot, target),
    spanStillPresent: makeSpanStillPresent(repoRoot),
  };

  const result = await engine.runLoop(deps, target);
  process.stdout.write(renderHandoff(result) + '\n');
  process.exit(result.ledger.status === 'clean' ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`review-engine: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
