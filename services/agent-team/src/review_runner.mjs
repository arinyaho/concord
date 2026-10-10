// Drives concord review-cli verb-by-verb, spawning the review/verify/fix subagents
// the CLI's contract expects. review-cli owns rounds/dedupe/termination via its
// `record` decision; this runner adds a belt-and-suspenders maxRounds cap and maps
// any CLI harness-failure to a terminal `error` (never a false converged/parked).
// All effects are injected so the orchestration is unit-tested without network.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reportedNoEdit } = require("../../../plugins/concord/core/round-plan.js");

function isHarnessFailure(v) {
  return v && typeof v === "object" && v.harnessFailure === true;
}

export async function runReviewUntilGreen({ target, runCli, spawn, maxRounds = 5, logger = { event() {} } }) {
  const { ref, base } = target;
  let rounds = 0;
  let fixed = 0;
  let killed = 0;
  let parkedFindings = [];

  try {
    while (true) {
      if (rounds >= maxRounds) {
        // Cap hit without the CLI declaring convergence: fail closed, do NOT report converged.
        logger.event("terminate", { reason: "max_rounds", rounds });
        return { outcome: "error", rounds, fixed, killed, parkedFindings };
      }

      const start = await runCli("round-start", [ref, base]);
      if (isHarnessFailure(start)) throw new Error(start.message || "harness-failure");
      // round-start decisions that end the loop before any work:
      if (start.decision === "no-op") { logger.event("terminate", { reason: "no-op" }); return { outcome: "converged", rounds, fixed, killed, parkedFindings }; }
      if (start.decision === "terminal") { logger.event("terminate", { reason: "terminal" }); return { outcome: "parked", rounds, fixed, killed, parkedFindings }; }

      rounds += 1;
      const { round, stateDir } = start;
      const diffPath = `${stateDir}/round-${round}-diff.txt`;
      logger.event("round_start", { round });

      await spawn("review", { stateDir, round, diffPath });
      logger.event("review", { round });
      if (start.intentApplied) await spawn("intent", { stateDir, round, diffPath });
      // The verifiers read the complete candidate sets, so both finders finish first.
      if (start.gateApplied) await spawn("gate", { stateDir, round, ref, gateMode: start.gateMode });
      await spawn("verify", { stateDir, round, diffPath, gateApplied: Boolean(start.gateApplied), gateMode: start.gateMode });
      logger.event("verify", { round });
      if (start.gateApplied) await spawn("gate-verify", { stateDir, round, ref, gateMode: start.gateMode });
      await spawn("plan", { stateDir, round, diffPath, ref, intentHash: start.intentHash || null });

      const plan = await runCli("plan-fixes", [ref]);
      if (isHarnessFailure(plan)) throw new Error(plan.message || "harness-failure");
      if (plan.protocolVersion !== 2) throw new Error("review protocol v2 required");
      const fixGroups = plan.fixGroups || [];
      // A no-edit fixer leaves nothing to certify or commit; record parks its findings.
      const commit = async (transaction) => {
        if (reportedNoEdit(stateDir, round, transaction.memberGroups || [transaction])) return;
        await spawn("certify", { stateDir, round, ref, fixGroup: transaction });
        const committed = await runCli("commit-fix", [ref, transaction.groupId]);
        if (isHarnessFailure(committed)) throw new Error(committed.message || "harness-failure");
        if (committed.committed) { fixed += transaction.findingIds.length; logger.event("fix", { id: transaction.groupId }); }
      };
      // A group transaction is complete (fix, certify, commit) before the next
      // group's fixer starts; a round transaction certifies and commits once.
      if (plan.transactionScope === "round" && fixGroups.length) {
        for (const group of fixGroups) await spawn("fix", { stateDir, round, ref, fixGroup: group });
        await commit({ groupId: plan.planId, findingIds: fixGroups.flatMap((group) => group.findingIds), invariants: [...new Set(fixGroups.flatMap((group) => group.invariants || []))], memberGroups: fixGroups });
      } else for (const group of fixGroups) {
        await spawn("fix", { stateDir, round, ref, fixGroup: group });
        await commit(group);
      }

      const rec = await runCli("record", [ref]);
      if (isHarnessFailure(rec)) throw new Error(rec.message || "harness-failure");
      const d = rec.decision || {};
      if (!d.continue) {
        if (d.converged) { logger.event("terminate", { reason: "converged", rounds }); return { outcome: "converged", rounds, fixed, killed, parkedFindings }; }
        // parked or abandoned: both are non-converged termini; collect parked findings from `show`.
        const shown = await runCli("show", [ref]);
        if (!isHarnessFailure(shown)) parkedFindings = (shown.findings || []).filter((f) => f.status === "parked");
        killed = countKilled(shown);
        const reason = d.abandoned ? "abandoned" : "parked";
        logger.event("terminate", { reason, rounds });
        return { outcome: "parked", rounds, fixed, killed, parkedFindings };
      }
      // continue -> next round
    }
  } catch (err) {
    logger.event("error", { message: String(err && err.message || err) });
    return { outcome: "error", rounds, fixed, killed, parkedFindings };
  }
}

function countKilled(shown) {
  // Killed findings live in the ledger's `seen` array, not `findings` (which holds
  // active/parked candidates).
  if (isHarnessFailure(shown) || !shown || !Array.isArray(shown.seen)) return 0;
  return shown.seen.filter((f) => f.status === "killed").length;
}
