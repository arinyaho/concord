import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildLaunchArgv, branchFor, runLaunchJob } from "../../src/daemon/launch_job.mjs";
import { parseProgressLine } from "../../src/daemon/progress.mjs";

test("argv is an array with --job-id, no leading --, no --allow-uncontained", () => {
  const a = buildLaunchArgv({ launchBin: "/x/agent-team-launch.mjs", task: "fix x", repoPath: "/abs/chem", credsDir: "/creds", base: "dev", jobId: "ab12" });
  assert.deepEqual(a, ["/x/agent-team-launch.mjs", "fix x", "--repo", "/abs/chem", "--creds-dir", "/creds", "--base", "dev", "--job-id", "ab12"]);
  assert.ok(!a.includes("--allow-uncontained"));
  assert.notEqual(a[1], "--");
});
test("branchFor names the produced branch", () => {
  assert.equal(branchFor("ab12"), "agent-team/ab12");
});

test("parseProgressLine accepts only logger lines and maps progress events", () => {
  assert.equal(parseProgressLine('[2026-07-18T01:02:03.000Z] coder_start {"task":"fix x"}'), "coding");
  assert.equal(parseProgressLine('[2026-07-18T01:02:03.000Z] coder_commit {"branch":"agent-team/x"}'), "committing");
  for (const event of ["round_start", "review", "verify", "fix"]) {
    assert.equal(parseProgressLine(`[2026-07-18T01:02:03.000Z] ${event} {"round":1}`), "reviewing");
  }
  assert.equal(parseProgressLine("coder_start {}"), null);
  assert.equal(parseProgressLine("[timestamp] coder_start not-json"), null);
  assert.equal(parseProgressLine("[timestamp] unknown {}"), null);
});

function childWithStderr() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("runLaunchJob reports logger progress across stderr chunks", async () => {
  const child = childWithStderr();
  const progress = [];
  const result = runLaunchJob({ argv: [], env: {}, onProgress: (stage) => progress.push(stage) }, { spawn: () => child });

  child.stderr.emit("data", Buffer.from("[2026-07-18T01:02:03.000Z] coder_"));
  child.stderr.emit("data", Buffer.from("start {\"task\":\"fix x\"}\n[2026-07-18T01:02:04.000Z] review {}\n"));
  child.emit("close", 0);

  await result;
  assert.deepEqual(progress, ["coding", "reviewing"]);
});

test("runLaunchJob drops an overlong partial line until its newline", async () => {
  const child = childWithStderr();
  const progress = [];
  const result = runLaunchJob({ argv: [], env: {}, tailBytes: 10, onProgress: (stage) => progress.push(stage) }, { spawn: () => child });

  child.stderr.emit("data", Buffer.from("x".repeat(11)));
  child.stderr.emit("data", Buffer.from('[2026-07-18T01:02:03.000Z] coder_start {}\n[2026-07-18T01:02:04.000Z] coder_commit {}\n'));
  child.emit("close", 0);

  const { tail } = await result;
  assert.deepEqual(progress, ["committing"]);
  assert.equal(tail, "coder_commit {}\n".slice(-10));
});
