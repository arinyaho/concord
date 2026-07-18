import test from "node:test";
import assert from "node:assert/strict";
import { makeOutcomeRouter } from "../../src/daemon/outcome_router.mjs";

test("job with onDone -> onDone called, replyForOutcome NOT called", async () => {
  const outcome = { kind: "done", code: 0, tail: "" };
  const onDoneCalls = [];
  let replyForOutcomeCalled = false;
  const job = { jobId: "conv1", onDone: (o) => { onDoneCalls.push(o); } };
  const onOutcome = makeOutcomeRouter({
    replyForOutcome: () => { replyForOutcomeCalled = true; },
    onError: () => {},
  });
  onOutcome(job, outcome);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(onDoneCalls, [outcome]);
  assert.equal(replyForOutcomeCalled, false);
});

test("job with .msg and no onDone -> replyForOutcome called (job, outcome), capability path unbroken", async () => {
  const outcome = { kind: "failed", code: 1, tail: "boom" };
  const calls = [];
  const job = { jobId: "cap1", msg: {} };
  const onOutcome = makeOutcomeRouter({
    replyForOutcome: (j, o) => { calls.push([j, o]); },
    onError: () => {},
  });
  onOutcome(job, outcome);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], job);
  assert.equal(calls[0][1], outcome);
});

test("a rejecting onDone is .catch-guarded -> onError called, no unhandled rejection", async () => {
  const err = new Error("onDone blew up");
  const errors = [];
  const job = { jobId: "conv2", onDone: async () => { throw err; } };
  const onOutcome = makeOutcomeRouter({
    replyForOutcome: () => { throw new Error("should not be called"); },
    onError: (e) => { errors.push(e); },
  });
  onOutcome(job, { kind: "failed", code: 1, tail: "x" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, [err]);
});

test("terminal relay settles before routing the outcome", async () => {
  const terminal = deferred();
  const calls = [];
  const onOutcome = makeOutcomeRouter({
    replyForOutcome: () => calls.push("reply"),
    onError: () => {},
  });
  onOutcome({ jobId: "cap-terminal", msg: {} }, { kind: "done", code: 0, tail: "" }, terminal.promise);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  terminal.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ["reply"]);
});

test("a rejecting terminal relay is guarded and still routes the outcome", async () => {
  const err = new Error("terminal blew up");
  const errors = [];
  const calls = [];
  const onOutcome = makeOutcomeRouter({
    replyForOutcome: () => calls.push("reply"),
    onError: (e) => errors.push(e),
  });
  onOutcome({ jobId: "cap-terminal-error", msg: {} }, { kind: "failed", code: 1, tail: "x" }, Promise.reject(err));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, [err]);
  assert.deepEqual(calls, ["reply"]);
});

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
