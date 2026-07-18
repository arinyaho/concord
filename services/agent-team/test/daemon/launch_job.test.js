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
  assert.deepEqual(parseProgressLine('[2026-07-18T01:02:03.000Z] coder_start {"task":"fix x"}'), {
    type: "progress", phase: "coding", detail: { task: "fix x" },
  });
  assert.deepEqual(parseProgressLine('[2026-07-18T01:02:03.000Z] coder_commit {"branch":"agent-team/x"}'), {
    type: "progress", phase: "committing", detail: { branch: "agent-team/x" },
  });
  for (const event of ["round_start", "review", "verify", "fix"]) {
    assert.deepEqual(parseProgressLine(`[2026-07-18T01:02:03.000Z] ${event} {"round":1}`), {
      type: "progress", phase: "reviewing", detail: { round: 1 },
    });
  }
  assert.equal(parseProgressLine("coder_start {}"), null);
  assert.equal(parseProgressLine("[timestamp] coder_start not-json"), null);
  assert.equal(parseProgressLine("[timestamp] unknown {}"), null);
  for (const data of ["null", "[]", '"text"', "1", "false"]) {
    assert.equal(parseProgressLine(`[timestamp] coder_start ${data}`), null);
  }
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
  assert.deepEqual(progress, [
    { type: "progress", phase: "coding", detail: { task: "fix x" } },
    { type: "progress", phase: "reviewing", detail: {} },
  ]);
});

test("runLaunchJob drops an overlong partial line until its newline", async () => {
  const child = childWithStderr();
  const progress = [];
  const result = runLaunchJob({ argv: [], env: {}, tailBytes: 60, onProgress: (stage) => progress.push(stage) }, { spawn: () => child });

  child.stderr.emit("data", Buffer.from("x".repeat(61)));
  child.stderr.emit("data", Buffer.from('[2026-07-18T01:02:03.000Z] coder_start {}\n[2026-07-18T01:02:04.000Z] coder_commit {}\n'));
  child.emit("close", 0);

  const { tail } = await result;
  assert.deepEqual(progress, [{ type: "progress", phase: "committing", detail: {} }]);
  assert.equal(tail.length, 60);
});

test("runLaunchJob drops an overlong line when its newline arrives in the same chunk", async () => {
  const child = childWithStderr();
  const progress = [];
  const result = runLaunchJob({ argv: [], env: {}, tailBytes: 60, onProgress: (stage) => progress.push(stage) }, { spawn: () => child });

  child.stderr.emit("data", Buffer.from(`[timestamp] coder_start {"task":"${"x".repeat(61)}"}\n[timestamp] coder_commit {}\n`));
  child.emit("close", 0);

  await result;
  assert.deepEqual(progress, [{ type: "progress", phase: "committing", detail: {} }]);
});
