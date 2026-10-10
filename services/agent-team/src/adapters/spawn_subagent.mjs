import { createRequire } from "node:module";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { settingSourcesFromEnv } from "../settings_sources.mjs";

// The gate, plan, fix and certify prompts are the packaged runner's own, so their
// artifact names and JSON shapes are the ones review-cli reads.
const require = createRequire(import.meta.url);
const { reviewerPrompt, fixDeclaration } = require("../../../../plugins/concord/core/round-plan.js");
const { targetSlug } = require("../../../../plugins/concord/core/review.js");

// Per-kind prompt for a review-cli subagent. Each tells the subagent the EXACT
// absolute artifact path to write, and the exact JSON schema review-cli reads.
function promptFor(kind, { stateDir, round, diffPath, ref, intentHash, fixGroup, gateMode }) {
  const art = (name) => `${stateDir}/round-${round}-${name}.json`;
  if (kind === "review") {
    return `Read the diff at ${diffPath}. Review it for correctness bugs, reuse/simplification, and ` +
      `verifier-gaming. Write ONLY this JSON to ${art("correctness")} and nothing else: ` +
      `{"status":"ok","examined":[<every changed file path>],"findings":[{"id":"correctness:<slug>",` +
      `"gate":"correctness","file":"<path>","span":"<offending text>","summary":"<one sentence>"}]}. ` +
      `Empty findings array if clean. Every changed file in the diff MUST appear in "examined".`;
  }
  if (kind === "verify") {
    return `Read the diff at ${diffPath} and the candidate findings at ${art("correctness")}. Reject false ` +
      `positives. Write ONLY this JSON to ${art("verify")}: {"status":"ok","rejected":["<id>",...]}.`;
  }
  if (kind === "intent") {
    return `Read the diff at ${diffPath} and the intent source for this review. Write ONLY this JSON to ` +
      `${art("intent")}: {"status":"ok","findings":[{"id":"intent:<slug>","file":"<path>","summary":"<one sentence>"}]}. ` +
      `Every finding id MUST be prefixed "intent:" -- review-cli rejects any other prefix for this artifact. ` +
      `Empty findings array if nothing to flag.`;
  }
  if (kind === "gate" || kind === "gate-verify") return reviewerPrompt(kind, { stateDir, round, slug: targetSlug(ref), gateMode, gateApplied: true });
  if (kind === "plan") return reviewerPrompt("plan", { stateDir, round, slug: targetSlug(ref), intentHash });
  if (kind === "fix") return reviewerPrompt(kind, { stateDir, round, finding: fixGroup.findings[0], fixGroup });
  if (kind === "certify") {
    const fixFiles = [...new Set((fixGroup.memberGroups || [fixGroup]).flatMap((group) => fixDeclaration(stateDir, round, group.groupId)?.files || []))];
    return reviewerPrompt(kind, { stateDir, round, finding: fixGroup.findings?.[0], fixGroup, fixFiles });
  }
  throw new Error(`unknown spawn kind: ${kind}`);
}

// Pure: assemble query() options for a review-loop subagent. settingSources is env-gated the
// same way as buildQueryOptions in ../role.mjs: the container launcher pins ['user'] so that
// repo-committed project/local settings in the untrusted target repo (cwd: repoRoot) do NOT
// auto-execute on the subagent's first tool call -- SM6.
export function buildSpawnOptions({ repoRoot, model, env = process.env }) {
  const options = { maxTurns: 12, allowedTools: ["Read", "Write", "Edit", "Bash"], cwd: repoRoot };
  if (model) options.model = model;
  const ss = settingSourcesFromEnv(env);
  if (ss) options.settingSources = ss;
  return options;
}

export function makeSpawn({ repoRoot, model, timeoutMs = 300000, query = sdkQuery }) {
  return async function spawn(kind, opts) {
    const prompt = promptFor(kind, opts);
    const options = buildSpawnOptions({ repoRoot, model });
    const run = (async () => { for await (const _ of query({ prompt, options })) { /* drain */ } })();
    let timer;
    const race = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`spawn ${kind} timed out`)), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([run, race]);
    } finally {
      clearTimeout(timer);
    }
  };
}
