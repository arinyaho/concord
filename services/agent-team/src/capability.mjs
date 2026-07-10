// Outer flow: run the coder once, assemble the review target, run review-until-green,
// and translate review_runner's vocabulary to the capability vocabulary. This is the
// SOLE place that maps { converged, parked, error } -> { done, parked, error }.

const REVIEW_TO_CAPABILITY = { converged: "done", parked: "parked", error: "error" };

export async function runCapability({ task, coder, reviewRunner, base, logger = { event() {} } }) {
  logger.event("coder_start", { task });
  const c = await coder.run(task);
  if (!c.branch) {
    logger.event("error", { where: "coder", message: c.error });
    return { outcome: "error", branch: null, review: null };
  }
  logger.event("coder_commit", { branch: c.branch, summary: c.summary });

  const target = { repoRoot: c.worktreePath, ref: c.branch, base };
  const review = await reviewRunner.runReview(target);
  const outcome = REVIEW_TO_CAPABILITY[review.outcome] || "error";
  logger.event("terminate", { outcome, rounds: review.rounds });
  return { outcome, branch: c.branch, review };
}
