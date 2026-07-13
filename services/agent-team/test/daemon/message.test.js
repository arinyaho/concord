import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../../src/daemon/message.mjs";

const cfg = { repos: { chem: "/abs/chem", concord: "/abs/concord" } };

test("known alias -> resolved path + task", () => {
  assert.deepEqual(parseCommand("chem: fix the null check", cfg), { alias: "chem", repoPath: "/abs/chem", task: "fix the null check" });
});
test("unknown/absent alias -> error, no repo fallback", () => {
  assert.ok(parseCommand("nope: do it", cfg).error);
  assert.ok(parseCommand("no colon here", cfg).error);
});
test("a path-like token in the task is NOT treated as a path", () => {
  const r = parseCommand("chem: update --repo handling", cfg);
  assert.equal(r.repoPath, "/abs/chem");
  assert.equal(r.task, "update --repo handling");
});
test("a leading-dash task is rejected", () => {
  assert.ok(parseCommand("chem: --repo", cfg).error);
});
