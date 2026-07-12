import { query } from "@anthropic-ai/claude-agent-sdk";
import { settingSourcesFromEnv } from "../settings_sources.mjs";

// Per-kind prompt for a review-cli subagent. Each tells the subagent the EXACT
// absolute artifact path to write, and the exact JSON schema review-cli reads.
function promptFor(kind, { stateDir, round, diffPath, findingId }) {
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
  if (kind === "fix") {
    return `Read the candidate findings at ${art("correctness")}. Apply the minimal correct fix for finding ` +
      `id "${findingId}" by editing the working tree, then write ONLY this JSON to ` +
      `${stateDir}/round-${round}-fix-${findingId}.json: {"status":"ok","edited":true,"files":["<path>",...]} ` +
      `(list every file you edited; "edited":false if no change was warranted). Do NOT commit.`;
  }
  if (kind === "intent") {
    return `Read the diff at ${diffPath} and the intent source for this review. Write ONLY this JSON to ` +
      `${art("intent")}: {"status":"ok","findings":[{"id":"intent:<slug>","file":"<path>","summary":"<one sentence>"}]}. ` +
      `Every finding id MUST be prefixed "intent:" -- review-cli rejects any other prefix for this artifact. ` +
      `Empty findings array if nothing to flag.`;
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

export function makeSpawn({ repoRoot, model, timeoutMs = 300000 }) {
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
