// PURE fail-closed guard for the pipeline's credential-bearing work. "Contained" is the
// launcher-set env sentinel (buildDockerArgs emits AGENT_TEAM_CONTAINED=1); the opt-in is a
// per-invocation param ONLY (never an env var -- an ambient AGENT_TEAM_ALLOW_UNCONTAINED would
// inherit into a daemon and fail the gate open invisibly). Throws when neither holds.
export function assertLaunchAllowed({ env = process.env, allowUncontained = false } = {}) {
  const contained = env.AGENT_TEAM_CONTAINED === "1";
  // A REMOTE trigger (the daemon sets AGENT_TEAM_REMOTE=1) must NEVER reach a bare host run,
  // even with an opt-in flag: the opt-in exists for trusted LOCAL runs, not remote ones.
  if (env.AGENT_TEAM_REMOTE === "1" && !contained) {
    throw new Error(
      "agent-team: refused -- a REMOTE trigger (AGENT_TEAM_REMOTE=1) must run containerized. " +
      "Route it through bin/agent-team-launch.mjs; the local --allow-uncontained opt-in does not apply to remote triggers."
    );
  }
  if (contained || allowUncontained) return;
  throw new Error(
    "agent-team: refused to run uncontained. This entry runs the pipeline with the author's " +
    "ambient host credentials and must not be triggered outside the container. Run it via " +
    "bin/agent-team-launch.mjs (containerized), or pass --allow-uncontained (CLI) / " +
    "{ allowUncontained: true } (in-process) for a trusted local run."
  );
}
