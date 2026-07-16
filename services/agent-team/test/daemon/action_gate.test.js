import test from "node:test";
import assert from "node:assert/strict";
import { resolveProposal } from "../../src/daemon/action_gate.mjs";

const cfg = { repos: { concord: "/Users/x/concord", other: "/Users/x/other" } };

test("resolves a known alias to its whitelisted path", () => {
  assert.deepEqual(resolveProposal({ alias: "concord", task: "fix it" }, cfg),
    { ok: true, alias: "concord", repoPath: "/Users/x/concord", task: "fix it" });
});
test("fail-closed on unknown/absent alias", () => {
  assert.equal(resolveProposal({ alias: "nope", task: "x" }, cfg).ok, false);
  assert.match(resolveProposal({ alias: "nope", task: "x" }, cfg).reason, /alias/i);
  assert.equal(resolveProposal({ alias: "", task: "x" }, cfg).ok, false);
});
test("rejects empty and leading-dash task", () => {
  assert.equal(resolveProposal({ alias: "concord", task: "  " }, cfg).ok, false);
  assert.equal(resolveProposal({ alias: "concord", task: "-rf" }, cfg).ok, false);
  assert.match(resolveProposal({ alias: "concord", task: "-rf" }, cfg).reason, /task/i);
});
test("path is never taken from the proposal", () => {
  const r = resolveProposal({ alias: "concord", task: "x", repoPath: "/evil" }, cfg);
  assert.equal(r.repoPath, "/Users/x/concord");
});
