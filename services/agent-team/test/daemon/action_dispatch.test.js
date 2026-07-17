import test from "node:test";
import assert from "node:assert/strict";
import { makeDispatchAction } from "../../src/daemon/action_dispatch.mjs";

const pending = { id: "a1", alias: "concord", repoPath: "/r", task: "fix it" };

test("submits a job with jobId=id, onDone, and NO msg", () => {
  let submitted;
  const queue = { submit: (job) => { submitted = job; return true; } };
  const dispatch = makeDispatchAction({ queue });
  const res = dispatch({ pending, threadId: "t1", feedTurn: () => {} });
  assert.equal(res.accepted, true);
  assert.equal(submitted.jobId, "a1");
  assert.equal(submitted.task, "fix it");
  assert.equal(submitted.repoPath, "/r");
  assert.equal("msg" in submitted, false);
  assert.equal(typeof submitted.onDone, "function");
});
test("onDone feeds the formatted outcome to feedTurn for this thread", () => {
  let fed;
  const queue = { submit: (job) => { job.onDone({ kind: "done", code: 0, tail: "ok" }); return true; } };
  const dispatch = makeDispatchAction({ queue });
  dispatch({ pending, threadId: "t9", feedTurn: (tid, text) => { fed = [tid, text]; } });
  assert.equal(fed[0], "t9");
  assert.match(fed[1], /\[job result:.*branch=agent-team\/a1.*outcome=done/);
});
test("queue full -> accepted:false", () => {
  const dispatch = makeDispatchAction({ queue: { submit: () => false } });
  assert.equal(dispatch({ pending, threadId: "t1", feedTurn: () => {} }).accepted, false);
});
test("dispatched job carries threadId", () => {
  let submitted;
  const queue = { submit: (jobIt) => { submitted = jobIt; return true; } };
  const dispatch = makeDispatchAction({ queue });
  dispatch({ pending: { id: "a1", alias: "concord", repoPath: "/r", task: "fix it" }, threadId: "t9", feedTurn: () => {} });
  assert.equal(submitted.threadId, "t9");
});
