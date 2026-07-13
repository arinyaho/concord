import { spawn as nodeSpawn } from "node:child_process";

// Build the agent-team-launch argv ARRAY. task is ONE element (the launcher's parser treats only
// separate elements as flags, so an in-task "--repo" cannot split into a flag); no leading "--"
// (the launcher's parseArgs has no end-of-options handling and would swallow it into the task);
// no --allow-uncontained (a remote trigger must never opt out).
export function buildLaunchArgv({ launchBin, task, repoPath, credsDir, base, jobId }) {
  return [launchBin, task, "--repo", repoPath, "--creds-dir", credsDir, "--base", base, "--job-id", jobId];
}

export function branchFor(jobId) { return `agent-team/${jobId}`; }

// Spawn agent-team-launch (node) with shell:false. Captures a bounded stderr tail. Resolves
// { code, tail }. The daemon (queue) owns the wall-clock timeout + docker kill, not this.
export function runLaunchJob({ argv, env, tailBytes = 4000 }, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "inherit", "pipe"] });
    let tail = "";
    child.stderr.on("data", (d) => { tail = (tail + d.toString()).slice(-tailBytes); });
    child.on("close", (code) => resolve({ code: code ?? 1, tail, child }));
    child.on("error", (e) => resolve({ code: 1, tail: tail + `\n${e.message}`, child }));
  });
}
