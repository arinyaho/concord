import test from "node:test";
import assert from "node:assert/strict";
import { formatOutcomePrompt } from "../../src/daemon/action_feedback.mjs";

test("done outcome -> branch + done + one-line summary", () => {
  const s = formatOutcomePrompt({ kind: "done", code: 0, tail: "converged\nall green" }, { alias: "concord", jobId: "a1" });
  assert.match(s, /^\[job result:/);
  assert.match(s, /alias=concord/);
  assert.match(s, /branch=agent-team\/a1/);
  assert.match(s, /outcome=done/);
  assert.doesNotMatch(s, /\n.*\n/); // at most one newline's worth -- not the full multi-line log
});
test("failed/timeout map to a non-done outcome and stay one line", () => {
  assert.match(formatOutcomePrompt({ kind: "failed", code: 1, tail: "boom" }, { alias: "r", jobId: "b2" }), /outcome=failed/);
  assert.match(formatOutcomePrompt({ kind: "timeout", code: 124, tail: "x" }, { alias: "r", jobId: "b2" }), /outcome=timeout/);
});
