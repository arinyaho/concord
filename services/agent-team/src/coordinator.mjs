import { parseReview } from "./review.mjs";

const NOOP_LOGGER = { event() {} };

// Deterministic coordinator. Owns the loop and the stop condition in code.
// spec/reviewer are role objects with async send(prompt) -> string.
export async function runJob({ brief, spec, reviewer, maxRounds = 3, logger = NOOP_LOGGER }) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError(`maxRounds must be a positive integer, got ${maxRounds}`);
  }

  let findings = [];
  let round = 0;
  let finalDraft = "";
  let outcome;
  const log = [];

  while (true) {
    if (round >= maxRounds) { outcome = "STOPPED_AT_CAP"; break; } // code owns termination
    round += 1;
    logger.event("round_start", { round, maxRounds });

    try {
      // delegation 1: coordinator -> spec. Brief on round 1; only findings after,
      // because the spec thread persists and remembers its prior draft.
      const specPrompt =
        findings.length === 0
          ? `Brief: ${brief}`
          : `Revise your prior draft to address every one of these reviewer findings:\n- ${findings.join("\n- ")}`;
      finalDraft = await spec.send(specPrompt);

      // delegation 2: coordinator -> reviewer (always sees the latest draft only).
      const review = parseReview(await reviewer.send(finalDraft));
      logger.event("review", { round, approved: review.approved, findingCount: review.findings.length });
      log.push({ round, approved: review.approved, findingCount: review.findings.length });

      if (review.approved) { outcome = "APPROVED"; break; } // convergent early stop
      findings = review.findings; // HANDBACK routed through coordinator into next round
    } catch (err) {
      // A hung or failing role call (e.g. role.mjs's timeout) must not block
      // termination forever — convert it into a terminal outcome.
      logger.event("error", { round, message: String((err && err.message) || err) });
      outcome = "STOPPED_ERROR";
      break;
    }
  }

  logger.event("done", { outcome, rounds: round });
  return { outcome, rounds: round, finalDraft, log };
}
