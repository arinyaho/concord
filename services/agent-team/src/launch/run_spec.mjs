// PURE: assemble the `docker run` argv (after the `docker` binary) from a config object.
// Allowlist posture: exactly the four mounts + a fixed env set + the image + pass-through
// pipeline args. It NEVER emits a privilege/namespace/socket flag (spec decision 9 / SM3)
// -- the dangerous-flags-absent unit test guards future edits.
export function buildDockerArgs(cfg) {
  const {
    image, concordDir, workDir, credsDir, skillsDir,
    gitName, gitEmail, settingSources, pipelineArgs = [], jobId,
  } = cfg;
  const jobEnv = jobId ? ["-e", `AGENT_TEAM_JOB_ID=${jobId}`] : [];
  const jobName = jobId ? ["--name", `agent-team-${jobId}`] : [];
  return [
    "run", "--rm",
    ...jobName,
    "-v", `${concordDir}:/concord-ro:ro`,
    "-v", `${workDir}:/work`,
    "-v", `${credsDir}/.credentials.json:/root/.claude/.credentials.json:ro`,
    "-v", `${skillsDir}:/root/.claude/skills:ro`,
    "-e", "HOME=/root",
    "-e", "AGENT_TEAM_CONTAINED=1",
    "-e", `GIT_AUTHOR_NAME=${gitName}`,
    "-e", `GIT_AUTHOR_EMAIL=${gitEmail}`,
    "-e", `GIT_COMMITTER_NAME=${gitName}`,
    "-e", `GIT_COMMITTER_EMAIL=${gitEmail}`,
    "-e", `AGENT_TEAM_SETTING_SOURCES=${JSON.stringify(settingSources)}`,
    ...jobEnv,
    image,
    ...pipelineArgs,
  ];
}
