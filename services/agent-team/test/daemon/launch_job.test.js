import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchArgv, branchFor } from "../../src/daemon/launch_job.mjs";

test("argv is an array with --job-id, no leading --, no --allow-uncontained", () => {
  const a = buildLaunchArgv({ launchBin: "/x/agent-team-launch.mjs", task: "fix x", repoPath: "/abs/chem", credsDir: "/creds", base: "dev", jobId: "ab12" });
  assert.deepEqual(a, ["/x/agent-team-launch.mjs", "fix x", "--repo", "/abs/chem", "--creds-dir", "/creds", "--base", "dev", "--job-id", "ab12"]);
  assert.ok(!a.includes("--allow-uncontained"));
  assert.notEqual(a[1], "--");
});
test("branchFor names the produced branch", () => {
  assert.equal(branchFor("ab12"), "agent-team/ab12");
});
