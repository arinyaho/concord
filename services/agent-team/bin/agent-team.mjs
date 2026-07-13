#!/usr/bin/env node
import { join } from "node:path";
import { createRole } from "../src/role.mjs";
import { ROLES, reviewerSystemPrompt } from "../src/roster.mjs";
import { runJob } from "../src/coordinator.mjs";
import { createLogger } from "../src/log.mjs";
import { assertLaunchAllowed } from "../src/launch/interlock.mjs";

function parseArgs(argv) {
  const args = { diverge: false, maxRounds: 3, model: undefined, brief: "", allowUncontained: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--diverge") args.diverge = true;
    else if (a === "--max-rounds") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error("--max-rounds needs a positive integer");
        process.exit(2);
      }
      args.maxRounds = n;
    }
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--allow-uncontained") args.allowUncontained = true;
    else rest.push(a);
  }
  args.brief = rest.join(" ").trim();
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.brief) {
  console.error('Usage: node bin/agent-team.mjs [--diverge] [--max-rounds N] [--model NAME] [--allow-uncontained] "<brief>"');
  process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY) {
  console.error("WARNING: ANTHROPIC_API_KEY is set; this slice is meant to run on OAuth. Unset it.");
}

// Credential-isolation interlock (spec 2026-07-12): this bin runs roles on the host; refuse an
// un-contained, non-opted-in invocation before any side effect. Symmetric with agent-team-run.mjs.
try {
  assertLaunchAllowed({ env: process.env, allowUncontained: args.allowUncontained });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// Deterministic run-file name from argv + pid (no clock in the name; the logger
// still timestamps each line via its default clock).
const runPath = join(process.cwd(), "runs", `run-${process.pid}.jsonl`);
const logger = createLogger(runPath);

const spec = createRole({
  name: ROLES.spec.name,
  systemPrompt: ROLES.spec.systemPrompt,
  model: args.model ?? ROLES.spec.model,
});
const reviewer = createRole({
  name: ROLES.reviewer.name,
  systemPrompt: reviewerSystemPrompt(args.diverge),
  model: args.model ?? ROLES.reviewer.model,
});

logger.event("start", { diverge: args.diverge, maxRounds: args.maxRounds, model: args.model ?? "default" });
const res = await runJob({ brief: args.brief, spec, reviewer, maxRounds: args.maxRounds, logger });
res.apiKeyPresent = !!process.env.ANTHROPIC_API_KEY;
res.logPath = runPath;
console.log(JSON.stringify(res, null, 2));
process.exit(0);
