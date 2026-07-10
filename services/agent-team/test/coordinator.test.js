import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../src/coordinator.mjs";

// Fake role: scripted replies, and it records every prompt it received.
function fakeRole(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async send(prompt) {
      calls.push(prompt);
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return typeof r === "function" ? r(prompt) : r;
    },
  };
}

test("stops early (APPROVED) when the reviewer approves", async () => {
  const spec = fakeRole(["draft v1"]);
  const reviewer = fakeRole(['{"approved": true, "findings": []}']);
  const res = await runJob({ brief: "B", spec, reviewer, maxRounds: 3 });
  assert.equal(res.outcome, "APPROVED");
  assert.equal(res.rounds, 1);
  assert.equal(res.finalDraft, "draft v1");
});

test("stops at the cap (STOPPED_AT_CAP) when the reviewer never approves", async () => {
  const spec = fakeRole(["d1", "d2", "d3", "d4"]);
  const reviewer = fakeRole(['{"approved": false, "findings": ["x"]}']); // always
  const res = await runJob({ brief: "B", spec, reviewer, maxRounds: 3 });
  assert.equal(res.outcome, "STOPPED_AT_CAP");
  assert.equal(res.rounds, 3);
  assert.equal(spec.calls.length, 3);
  assert.equal(reviewer.calls.length, 3);
});

test("routes the brief on round 1 and findings on later rounds (handback via coordinator)", async () => {
  const spec = fakeRole(["d1", "d2"]);
  const reviewer = fakeRole([
    '{"approved": false, "findings": ["add TTL", "name the store"]}',
    '{"approved": true, "findings": []}',
  ]);
  await runJob({ brief: "BRIEF-TEXT", spec, reviewer, maxRounds: 3 });
  // round 1 spec prompt carries the brief
  assert.match(spec.calls[0], /BRIEF-TEXT/);
  // round 2 spec prompt carries the reviewer's findings, not a direct reviewer->spec call
  assert.match(spec.calls[1], /add TTL/);
  assert.match(spec.calls[1], /name the store/);
  // reviewer always received the latest draft, never the brief directly
  assert.equal(reviewer.calls[0], "d1");
  assert.equal(reviewer.calls[1], "d2");
});

test("a rejection with no specific findings still carries forward as a revise prompt, not a re-sent brief", async () => {
  const spec = fakeRole(["d1", "d2", "d3"]);
  const reviewer = fakeRole([
    '{"approved": false, "findings": []}',
    '{"approved": false, "findings": []}',
  ]);
  await runJob({ brief: "BRIEF-TEXT", spec, reviewer, maxRounds: 3 });
  // round 1 spec prompt carries the brief, as always
  assert.match(spec.calls[0], /BRIEF-TEXT/);
  // round 2 must be a revise prompt: the brief must NOT be re-sent even though
  // findings was empty (the reviewer rejected without listing findings).
  assert.doesNotMatch(spec.calls[1], /^Brief:/);
  assert.doesNotMatch(spec.calls[1], /BRIEF-TEXT/);
});

test("an unparseable review never ends as APPROVED (fails closed to the cap)", async () => {
  const spec = fakeRole(["d1", "d2", "d3"]);
  const reviewer = fakeRole(["looks fine to me"]); // not JSON
  const res = await runJob({ brief: "B", spec, reviewer, maxRounds: 3 });
  assert.equal(res.outcome, "STOPPED_AT_CAP");
});

test("throws on a non-integer maxRounds instead of looping forever", async () => {
  const spec = fakeRole(["d"]);
  const reviewer = fakeRole(['{"approved": false, "findings": ["x"]}']);
  await assert.rejects(
    () => runJob({ brief: "B", spec, reviewer, maxRounds: Number("oops") }),
    /positive integer/
  );
});

test("a role that throws yields a terminal STOPPED_ERROR (no hang)", async () => {
  const spec = { calls: [], async send() { throw new Error("boom"); } };
  const reviewer = fakeRole(['{"approved": false, "findings": ["x"]}']);
  const res = await runJob({ brief: "B", spec, reviewer, maxRounds: 3 });
  assert.equal(res.outcome, "STOPPED_ERROR");
});
