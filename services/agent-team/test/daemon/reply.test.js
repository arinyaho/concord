import test from "node:test";
import assert from "node:assert/strict";
import { formatAck, formatSuccess, formatFailure } from "../../src/daemon/reply.mjs";

test("ack names the job", () => {
  assert.match(formatAck({ jobId: "ab12", alias: "chem", task: "fix x" }), /ab12.*chem/s);
});
test("success names the branch", () => {
  assert.match(formatSuccess({ jobId: "ab12", branch: "agent-team/ab12" }), /agent-team\/ab12/);
});
test("failure clamps to 2000 chars even with a huge tail", () => {
  const out = formatFailure({ analysis: "boom", tail: "x".repeat(5000) });
  assert.ok(out.length <= 2000);
  assert.ok(out.includes("boom"));
});
test("failure with null analysis falls back to tail-only, still clamped", () => {
  const out = formatFailure({ analysis: null, tail: "y".repeat(5000) });
  assert.ok(out.length <= 2000);
});
