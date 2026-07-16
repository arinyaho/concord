// Resolve + validate an action proposal against the capability alias whitelist. The repo path comes
// ONLY from cfg.repos[alias] (never from the proposal). The task guard mirrors message.mjs: a task
// becomes argv[0] to the launcher, so an empty or leading-dash task is rejected (a leading dash
// would mis-slot the launcher's trusted flags).
export function resolveProposal(proposal, cfg) {
  const alias = proposal?.alias;
  const task = typeof proposal?.task === "string" ? proposal.task.trim() : "";
  const repos = cfg?.repos ?? {};
  if (!alias || !Object.prototype.hasOwnProperty.call(repos, alias)) {
    return { ok: false, reason: `unknown repo alias '${alias ?? ""}'` };
  }
  if (!task) return { ok: false, reason: "invalid task (empty)" };
  if (task.startsWith("-")) return { ok: false, reason: "invalid task (may not begin with '-')" };
  return { ok: true, alias, repoPath: repos[alias], task };
}
