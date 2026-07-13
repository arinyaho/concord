import test from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../../src/daemon/queue.mjs";

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
