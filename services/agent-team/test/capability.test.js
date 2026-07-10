import { test } from "node:test";
import assert from "node:assert/strict";
import { runCapability } from "../src/capability.mjs";

const okCoder = (over = {}) => ({ async run() { return { branch: "b", summary: "did", worktreePath: "/wt", ...over }; } });
const failCoder = () => ({ async run() { return { branch: null, summary: null, worktreePath: "/wt", error: "boom" }; } });
const reviewReturning = (review, capture) => ({ async runReview(target) { if (capture) capture.target = target; return review; } });

test("coder success + converged -> done", async () => {
  const cap = { };
  const res = await runCapability({
    task: "t", coder: okCoder(), base: "main",
    reviewRunner: reviewReturning({ outcome: "converged", rounds: 1, fixed: 0, killed: 0, parkedFindings: [] }, cap),
  });
  assert.equal(res.outcome, "done");
  assert.equal(res.branch, "b");
  // target assembled from coder result + base
  assert.deepEqual(cap.target, { repoRoot: "/wt", ref: "b", base: "main" });
});

test("review parked -> parked", async () => {
  const res = await runCapability({
    task: "t", coder: okCoder(), base: "main",
    reviewRunner: reviewReturning({ outcome: "parked", rounds: 2, fixed: 1, killed: 0, parkedFindings: [{ id: "x" }] }),
  });
  assert.equal(res.outcome, "parked");
  assert.deepEqual(res.review.parkedFindings, [{ id: "x" }]);
});

test("review error -> error", async () => {
  const res = await runCapability({
    task: "t", coder: okCoder(), base: "main",
    reviewRunner: reviewReturning({ outcome: "error", rounds: 0, fixed: 0, killed: 0, parkedFindings: [] }),
  });
  assert.equal(res.outcome, "error");
});

test("coder failure short-circuits to error without calling review", async () => {
  let called = false;
  const res = await runCapability({
    task: "t", coder: failCoder(), base: "main",
    reviewRunner: { async runReview() { called = true; return {}; } },
  });
  assert.equal(res.outcome, "error");
  assert.equal(called, false);
  assert.equal(res.branch, null);
});
