// Manual end-to-end check (NOT a node --test file; lives outside test/).
// Reproduces the spike's pass/fail against the structured code AND checks that
// resume-based continuity actually advances the loop past round 1.
import { createRole } from "../src/role.mjs";
import { ROLES, reviewerSystemPrompt } from "../src/roster.mjs";
import { runJob } from "../src/coordinator.mjs";

const BRIEF = "Design a rate limiter for a public JSON API. One paragraph. Cover algorithm choice and where state lives.";

async function divergentRun() {
  const spec = createRole({ name: "spec", systemPrompt: ROLES.spec.systemPrompt });
  const reviewer = createRole({ name: "reviewer", systemPrompt: reviewerSystemPrompt(true) });
  const res = await runJob({ brief: BRIEF, spec, reviewer, maxRounds: 3 });
  return { outcome: res.outcome, rounds: res.rounds };
}

// Continuity: a reviewer that rejects round 1, approves round 2 -> forces the
// loop to advance, so the round-2 spec must build on its round-1 thread.
async function continuityRun() {
  const spec = createRole({
    name: "spec",
    systemPrompt: ROLES.spec.systemPrompt + " Always restate, verbatim, the algorithm name you chose in your first draft.",
  });
  let round = 0;
  const reviewer = {
    async send() {
      round += 1;
      return round === 1
        ? '{"approved": false, "findings": ["name where state lives explicitly"]}'
        : '{"approved": true, "findings": []}';
    },
  };
  const res = await runJob({ brief: BRIEF, spec, reviewer, maxRounds: 3 });
  return { outcome: res.outcome, rounds: res.rounds, finalDraft: res.finalDraft };
}

const divergent = await divergentRun();
console.error("divergent:", JSON.stringify(divergent));
const continuity = await continuityRun();
console.error("continuity:", JSON.stringify({ outcome: continuity.outcome, rounds: continuity.rounds }));

const pass =
  !process.env.ANTHROPIC_API_KEY &&
  divergent.outcome === "STOPPED_AT_CAP" &&
  continuity.outcome === "APPROVED" &&
  continuity.rounds === 2;

console.log(JSON.stringify({ pass, divergent, continuity: { outcome: continuity.outcome, rounds: continuity.rounds } }, null, 2));
process.exit(pass ? 0 : 1);
