import test from "node:test";
import assert from "node:assert/strict";
import { createQueue, computeOutcome } from "../../src/daemon/queue.mjs";

const tick = () => new Promise((r) => setImmediate(r));

test("runs up to cap concurrently, drains the rest", async () => {
  let active = 0, maxActive = 0;
  const release = [];
  const runJob = () => new Promise((res) => { active++; maxActive = Math.max(maxActive, active); release.push(() => { active--; res({ code: 0, tail: "" }); }); });
  const q = createQueue({ cap: 2, queueMax: 10, jobTimeoutMs: 100000, runJob, dockerKill() {}, onOutcome() {} });
  for (let i = 0; i < 4; i++) q.submit({ jobId: `j${i}` });
  await tick();
  assert.equal(maxActive, 2);
  while (release.length) { release.shift()(); await tick(); }
  assert.equal(maxActive, 2);
});
test("submit returns false when the FIFO is full", () => {
  const q = createQueue({ cap: 1, queueMax: 1, jobTimeoutMs: 100000, runJob: () => new Promise(() => {}), dockerKill() {}, onOutcome() {} });
  assert.equal(q.submit({ jobId: "a" }), true); // running
  assert.equal(q.submit({ jobId: "b" }), true); // queued (depth 1)
  assert.equal(q.submit({ jobId: "c" }), false); // full
});
test("timeout kills the container and reports timeout", async () => {
  const killed = [];
  const q = createQueue({ cap: 1, queueMax: 5, jobTimeoutMs: 5, runJob: () => new Promise(() => {}), dockerKill: (id) => killed.push(id), onOutcome: (job, o) => { job._o = o; } });
  const job = { jobId: "slow" };
  q.submit(job);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(killed, ["slow"]);
  assert.equal(job._o.kind, "timeout");
});
test("timeout kills the child process tree (killTree) in addition to dockerKill", async () => {
  const killed = []; const dockerKilled = [];
  const q = createQueue({
    cap: 1, queueMax: 5, jobTimeoutMs: 5,
    runJob: () => new Promise(() => {}),
    dockerKill: (id) => dockerKilled.push(id),
    killTree: (child) => killed.push(child),
    onOutcome() {},
  });
  const job = { jobId: "wedged", child: { pid: 4242 } };
  q.submit(job);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(killed, [{ pid: 4242 }]);
  assert.deepEqual(dockerKilled, ["wedged"]);
});
test("late natural resolution after timeout does not double-fire onOutcome", async () => {
  let calls = 0; let lastKind = null;
  const q = createQueue({
    cap: 1, queueMax: 5, jobTimeoutMs: 5,
    runJob: () => new Promise((res) => setTimeout(() => res({ code: 0, tail: "" }), 40)),
    dockerKill() {}, onOutcome: (job, o) => { calls++; lastKind = o.kind; },
  });
  q.submit({ jobId: "late" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1);
  assert.equal(lastKind, "timeout");
});
test("runJob rejection -> failed outcome once", async () => {
  let calls = 0; let lastKind = null;
  const q = createQueue({
    cap: 1, queueMax: 5, jobTimeoutMs: 100000,
    runJob: () => Promise.reject(new Error("boom")),
    dockerKill() {}, onOutcome: (job, o) => { calls++; lastKind = o.kind; },
  });
  q.submit({ jobId: "rej" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(lastKind, "failed");
});

// --- cancel + list (B-3a Task 1) ---

// A controllable runJob: returns a promise we resolve by hand, and records job.child via onChild-like.
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

function makeQueue(over = {}) {
  const outcomes = [], killed = [], dockerKilled = [];
  const runs = new Map(); // jobId -> deferred
  const q = createQueue({
    cap: 1, queueMax: 10, jobTimeoutMs: 1_000_000,
    runJob: (job) => { job.child = { pid: 4242 }; const d = deferred(); runs.set(job.jobId, d); return d.promise; },
    dockerKill: (id) => dockerKilled.push(id),
    killTree: (child) => killed.push(child?.pid),
    onOutcome: (job, outcome) => outcomes.push({ jobId: job.jobId, kind: outcome.kind }),
    ...over,
  });
  return { q, outcomes, killed, dockerKilled, runs };
}
const job = (jobId, extra = {}) => ({ jobId, alias: "concord", task: "fix it", threadId: "t1", ...extra });

test("cancel a RUNNING job -> killTree + dockerKill, cancelled outcome, running cleared, found:true", async () => {
  const { q, outcomes, killed, dockerKilled } = makeQueue();
  q.submit(job("a1"));
  await Promise.resolve(); // let pump start the job
  assert.deepEqual(q.list().running.map((r) => r.jobId), ["a1"]);
  const r = q.cancel("a1");
  assert.deepEqual(r, { found: true });
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(dockerKilled, ["a1"]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(outcomes, [{ jobId: "a1", kind: "cancelled" }]);
  assert.deepEqual(q.list().running, []);
  assert.deepEqual(q.cancel("a1"), { found: false }); // idempotent after settle
});

test("cancel a QUEUED job -> spliced, cancelled outcome, never ran, found:true", async () => {
  const { q, outcomes, dockerKilled, runs } = makeQueue();
  q.submit(job("a1")); // runs (cap 1)
  await Promise.resolve();
  q.submit(job("a2")); // queued
  assert.deepEqual(q.list().queued.map((x) => x.jobId), ["a2"]);
  const r = q.cancel("a2");
  assert.deepEqual(r, { found: true });
  assert.deepEqual(dockerKilled, []); // a queued job is never dockerKilled
  assert.equal(runs.has("a2"), false); // never ran
  assert.ok(outcomes.some((o) => o.jobId === "a2" && o.kind === "cancelled"));
  assert.deepEqual(q.list().queued, []);
});

test("cancel unknown id -> found:false, no dockerKill", () => {
  const { q, dockerKilled } = makeQueue();
  assert.deepEqual(q.cancel("nope"), { found: false });
  assert.deepEqual(dockerKilled, []);
});

test("list summaries carry jobId/alias/task/threadId (threadId may be undefined)", async () => {
  const { q } = makeQueue();
  q.submit(job("a1"));
  q.submit({ jobId: "cap1", alias: "concord", task: "capability", msg: {} }); // capability job, no threadId
  await Promise.resolve();
  const running = q.list().running.find((x) => x.jobId === "a1");
  assert.deepEqual(running, { jobId: "a1", alias: "concord", task: "fix it", threadId: "t1" });
  const queued = q.list().queued.find((x) => x.jobId === "cap1");
  assert.equal(queued.threadId, undefined);
});

test("natural completion then cancel -> onOutcome fires once, cancel found:false", async () => {
  const { q, outcomes, runs } = makeQueue();
  q.submit(job("a1"));
  await Promise.resolve();
  runs.get("a1").resolve({ code: 0, tail: "ok" }); // natural completion
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(outcomes, [{ jobId: "a1", kind: "done" }]);
  assert.deepEqual(q.cancel("a1"), { found: false });
  assert.equal(outcomes.length, 1); // no second outcome
});

// --- lifecycle relay hooks (B-3c Task 3) ---

test("onStart sees a FIFO job only after it is running", async () => {
  const events = [];
  let q;
  const run = deferred();
  q = createQueue({
    cap: 1, queueMax: 1, jobTimeoutMs: 1_000_000,
    runJob: () => { events.push("run"); return run.promise; },
    dockerKill() {}, onOutcome() {},
  });
  const first = job("first", {
    onStart() { events.push(`start:${q.list().running.map((j) => j.jobId).join(",")}`); },
  });

  q.submit(first);
  await Promise.resolve();
  assert.deepEqual(events, ["start:first", "run"]);
  run.resolve({ code: 0, tail: "" });
});

test("an onStart synchronous cancel resolves the running job", async () => {
  const outcomes = [];
  let runJobCalls = 0;
  let q;
  q = createQueue({
    cap: 1, queueMax: 1, jobTimeoutMs: 1_000_000,
    runJob: () => { runJobCalls++; return new Promise(() => {}); },
    dockerKill() {},
    onOutcome: (j, outcome) => outcomes.push({ jobId: j.jobId, kind: outcome.kind }),
  });
  q.submit(job("sync-cancel", {
    onStart() { assert.deepEqual(q.cancel("sync-cancel"), { found: true }); },
  }));

  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(runJobCalls, 0);
  assert.deepEqual(outcomes, [{ jobId: "sync-cancel", kind: "cancelled" }]);
  assert.deepEqual(q.list().running, []);
});

test("an immediate completion emits terminal after a deferred onStart settles", async () => {
  const start = deferred();
  const events = [];
  const q = createQueue({
    cap: 1, queueMax: 1, jobTimeoutMs: 1_000_000,
    runJob: () => Promise.resolve({ code: 0, tail: "" }),
    dockerKill() {},
    onOutcome: () => events.push("outcome"),
  });
  q.submit(job("deferred-start", {
    onStart() { events.push("start"); return start.promise; },
    onTerminal() { events.push("terminal"); },
  }));

  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ["start"]);
  assert.deepEqual(q.list().running, []);
  start.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ["start", "terminal", "outcome"]);
});

test("cancelling a queued job skips its lifecycle relay hooks", async () => {
  const firstRun = deferred();
  const terminalCalls = [];
  const q = createQueue({
    cap: 1, queueMax: 2, jobTimeoutMs: 1_000_000,
    runJob: (j) => j.jobId === "first" ? firstRun.promise : Promise.resolve({ code: 0, tail: "" }),
    dockerKill() {}, onOutcome() {},
  });
  q.submit(job("first"));
  q.submit(job("queued", {
    onStart() { terminalCalls.push("start"); },
    onTerminal() { terminalCalls.push("terminal"); },
  }));

  assert.deepEqual(q.cancel("queued"), { found: true });
  await Promise.resolve();
  assert.deepEqual(terminalCalls, []);
  firstRun.resolve({ code: 0, tail: "" });
});

test("a pending onTerminal promise does not hold the queue slot", async () => {
  const firstRun = deferred();
  const terminal = deferred();
  const started = [];
  const lifecycle = [];
  const received = [];
  const q = createQueue({
    cap: 1, queueMax: 2, jobTimeoutMs: 1_000_000,
    runJob: (j) => j.jobId === "first" ? firstRun.promise : Promise.resolve({ code: 0, tail: "" }),
    dockerKill() {},
    onOutcome: (j, o, terminalPromise) => {
      if (j.jobId === "first") lifecycle.push("outcome");
      received.push({ jobId: j.jobId, terminalPromise });
    },
  });
  q.submit(job("first", { onTerminal() { lifecycle.push("terminal"); return terminal.promise; } }));
  q.submit(job("second", { onStart() { started.push("second"); } }));

  firstRun.resolve({ code: 0, tail: "" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lifecycle, ["terminal", "outcome"]);
  assert.deepEqual(started, ["second"]);
  const firstReceived = received.find((entry) => entry.jobId === "first");
  assert.equal(typeof firstReceived?.terminalPromise?.then, "function");
  terminal.resolve();
});

// --- computeOutcome precedence (pure) ---

test("computeOutcome: cancelled beats timedOut (precedence pin)", () => {
  // Both flags true: cancel must win. Reordering the fn to check timedOut first fails here.
  assert.deepEqual(
    computeOutcome({ cancelled: true, timedOut: true, res: { code: 124, tail: "timed out" } }),
    { kind: "cancelled", code: 130, tail: "cancelled" },
  );
});

test("computeOutcome: cancelled without timeout", () => {
  assert.deepEqual(
    computeOutcome({ cancelled: true, timedOut: false, res: { code: 0, tail: "" } }),
    { kind: "cancelled", code: 130, tail: "cancelled" },
  );
});

test("computeOutcome: timeout when not cancelled", () => {
  assert.deepEqual(
    computeOutcome({ cancelled: false, timedOut: true, res: { code: 124, tail: "x" } }),
    { kind: "timeout", code: 124, tail: "x" },
  );
});

test("computeOutcome: done on zero exit", () => {
  assert.deepEqual(
    computeOutcome({ cancelled: false, timedOut: false, res: { code: 0, tail: "ok" } }),
    { kind: "done", code: 0, tail: "ok" },
  );
});

test("computeOutcome: failed on non-zero exit", () => {
  assert.deepEqual(
    computeOutcome({ cancelled: false, timedOut: false, res: { code: 1, tail: "boom" } }),
    { kind: "failed", code: 1, tail: "boom" },
  );
});
