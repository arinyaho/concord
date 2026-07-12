#!/usr/bin/env node
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCoder } from "../src/coder.mjs";
import { runCapability } from "../src/capability.mjs";
import { runReviewUntilGreen } from "../src/review_runner.mjs";
import { makeRunCli } from "../src/adapters/review_cli.mjs";
import { makeSpawn } from "../src/adapters/spawn_subagent.mjs";
import { createWorktree } from "../src/adapters/worktree.mjs";
import { createLogger } from "../src/log.mjs";
import { assertLaunchAllowed } from "../src/launch/interlock.mjs";

function parseArgs(argv) {
  const a = { base: "main", maxRounds: 5, model: undefined, timeout: undefined, repo: undefined, allowUncontained: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--repo") a.repo = argv[++i];
    else if (t === "--base") a.base = argv[++i];
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--timeout") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) { console.error("--timeout needs a positive integer"); process.exit(2); }
      a.timeout = n;
    }
    else if (t === "--max-rounds") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) { console.error("--max-rounds needs a positive integer"); process.exit(2); }
      a.maxRounds = n;
    }
    else if (t === "--allow-uncontained") a.allowUncontained = true;
    else rest.push(t);
  }
  a.task = rest.join(" ").trim();
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.task || !args.repo) {
  console.error('Usage: agent-team-run "<task>" --repo <path> [--base main] [--max-rounds N] [--model NAME] [--timeout MS] [--allow-uncontained]');
  process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY) console.error("WARNING: ANTHROPIC_API_KEY is set; this is meant to run on OAuth. Unset it.");

// Credential-isolation interlock (spec 2026-07-12): refuse a remote-triggered, un-contained run
// before any side effect. Contained (inside agent-team-launch) or an explicit local opt-in only.
try {
  assertLaunchAllowed({ env: process.env, allowUncontained: args.allowUncontained });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// review-cli.js path in the concord monorepo (this package lives at services/agent-team/).
const CLI_PATH = new URL("../../../plugins/concord/hooks/review-cli.js", import.meta.url).pathname;
const stateDir = mkdtempSync(join(tmpdir(), "agent-team-state-"));
const runPath = join(process.cwd(), "runs", `run-${process.pid}.jsonl`);
const logger = createLogger(runPath);

const branch = `agent-team/run-${process.pid}`;
const { worktreePath } = createWorktree({ repoRoot: args.repo, base: args.base, branch });
const coder = createCoder({ cwd: worktreePath, branch, model: args.model, timeoutMs: args.timeout });
const runCli = makeRunCli({ repoRoot: worktreePath, stateDir, cliPath: CLI_PATH, timeoutMs: args.timeout });
const spawn = makeSpawn({ repoRoot: worktreePath, model: args.model, timeoutMs: args.timeout });
const reviewRunner = {
  runReview: (target) => runReviewUntilGreen({ target, runCli, spawn, maxRounds: args.maxRounds, logger }),
};

const res = await runCapability({ task: args.task, coder, reviewRunner, base: args.base, logger, allowUncontained: args.allowUncontained });
res.apiKeyPresent = !!process.env.ANTHROPIC_API_KEY;
res.logPath = runPath;
console.log(JSON.stringify(res, null, 2));
process.exit(res.outcome === "done" ? 0 : 1);
