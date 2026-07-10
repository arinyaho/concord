import { test } from "node:test";
import assert from "node:assert/strict";
import { runReviewUntilGreen } from "../src/review_runner.mjs";

const TARGET = { repoRoot: "/wt", ref: "b", base: "main" };

// Scriptable fake CLI: `script` maps verb -> array of responses (consumed in order).
function fakeCli(script) {
  const calls = [];
  const idx = {};
  return {
    calls,
    async runCli(verb, args) {
      calls.push([verb, ...args]);
      const seq = script[verb] || [];
      const i = idx[verb] || 0;
      idx[verb] = i + 1;
      const r = seq[Math.min(i, seq.length - 1)];
      if (r && r.__throw) throw new Error(r.__throw);
      return r;
    },
  };
}
function recordingSpawn() {
  const spawned = [];
  return { spawned, async spawn(kind, opts) { spawned.push([kind, opts]); } };
}

test("converges in one round (record continue:false, converged)", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: true }],
    "plan-fixes": [{ fixes: [] }],
    "record": [{ decision: { continue: false, converged: true, parked: false } }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "converged");
  assert.equal(res.rounds, 1);
  // review + verify spawned once each; no fixes
  assert.deepEqual(sp.spawned.map((s) => s[0]).sort(), ["review", "verify"]);
});

test("applies fixes: spawns fix per finding and commit-fixes each", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [{ id: "correctness:a" }, { id: "correctness:b" }] }],
    "commit-fix": [{ committed: true, sha: "x" }, { committed: true, sha: "y" }],
    "record": [{ decision: { continue: false, converged: true, parked: false } }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.fixed, 2);
  const fixSpawns = sp.spawned.filter((s) => s[0] === "fix");
  assert.equal(fixSpawns.length, 2);
  assert.equal(fixSpawns[0][1].findingId, "correctness:a");
  assert.deepEqual(cli.calls.filter((c) => c[0] === "commit-fix"), [
    ["commit-fix", "b", "correctness:a"],
    ["commit-fix", "b", "correctness:b"],
  ]);
});

test("multi-round then parked", async () => {
  const cli = fakeCli({
    "round-start": [
      { decision: "work", round: 1, stateDir: "/s", dodPassed: false },
      { decision: "work", round: 2, stateDir: "/s", dodPassed: false },
    ],
    "plan-fixes": [{ fixes: [{ id: "x" }] }, { fixes: [] }],
    "commit-fix": [{ committed: true }],
    "record": [
      { decision: { continue: true, converged: false, parked: false } },
      { decision: { continue: false, converged: false, parked: true } },
    ],
    "show": [{ findings: [{ id: "x", status: "parked" }], seen: [{ id: "y", status: "killed" }] }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "parked");
  assert.equal(res.rounds, 2);
  assert.equal(res.parkedFindings.length, 1);
  assert.equal(res.killed, 1);
});

test("round-start no-op terminates as converged without spawning", async () => {
  const cli = fakeCli({ "round-start": [{ decision: "no-op" }] });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "converged");
  assert.equal(sp.spawned.length, 0);
});

test("round-start terminal decision terminates as parked without spawning", async () => {
  const cli = fakeCli({ "round-start": [{ decision: "terminal" }] });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "parked");
  assert.equal(sp.spawned.length, 0);
});

test("harness-failure (thrown) at round-start maps to outcome error, never converged", async () => {
  const cli = fakeCli({ "round-start": [{ __throw: "harness-failure: coverage" }] });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure flagged result at round-start also maps to error", async () => {
  const cli = fakeCli({ "round-start": [{ harnessFailure: true, message: "bad" }] });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure (thrown) at plan-fixes maps to outcome error, never converged", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ __throw: "harness-failure: plan" }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure flagged result at plan-fixes maps to error", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ harnessFailure: true, message: "bad" }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure (thrown) at commit-fix maps to outcome error, never converged", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [{ id: "correctness:a" }] }],
    "commit-fix": [{ __throw: "harness-failure: commit" }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure flagged result at commit-fix maps to error", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [{ id: "correctness:a" }] }],
    "commit-fix": [{ harnessFailure: true, message: "bad" }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure (thrown) at record maps to outcome error, never converged", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [] }],
    "record": [{ __throw: "harness-failure: record" }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("harness-failure flagged result at record maps to error", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [] }],
    "record": [{ harnessFailure: true, message: "bad" }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "error");
});

test("commit-fix false (fixer made no edit) does not increment fixed and proceeds to record", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [{ id: "correctness:a" }] }],
    "commit-fix": [{ committed: false }],
    "record": [{ decision: { continue: false, converged: true, parked: false } }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.fixed, 0);
  assert.equal(res.outcome, "converged");
  assert.ok(cli.calls.some((c) => c[0] === "record"));
});

test("record decision abandoned:true is a non-converged terminus mapped to parked", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [] }],
    "record": [{ decision: { continue: false, converged: false, parked: false, abandoned: true } }],
    "show": [{ findings: [], seen: [] }],
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.equal(res.outcome, "parked");
});

test("belt-and-suspenders: never exceeds maxRounds even if record keeps continuing", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: false }],
    "plan-fixes": [{ fixes: [] }],
    "record": [{ decision: { continue: true, converged: false, parked: false } }], // always continue
  });
  const sp = recordingSpawn();
  const res = await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 3 });
  assert.equal(res.rounds, 3);
  assert.equal(res.outcome, "error"); // cap hit without convergence is an error, not a false converged
});

test("intent kind spawned only when round-start signals intentApplied", async () => {
  const cli = fakeCli({
    "round-start": [{ decision: "work", round: 1, stateDir: "/s", dodPassed: true, intentApplied: true }],
    "plan-fixes": [{ fixes: [] }],
    "record": [{ decision: { continue: false, converged: true, parked: false } }],
  });
  const sp = recordingSpawn();
  await runReviewUntilGreen({ target: TARGET, runCli: cli.runCli, spawn: sp.spawn, maxRounds: 5 });
  assert.ok(sp.spawned.some((s) => s[0] === "intent"));
});
