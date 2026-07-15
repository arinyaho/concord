import test from "node:test";
import assert from "node:assert/strict";
import { advanceTurn } from "../../src/daemon/conversation.mjs";

const roster = [{ name: "spec" }, { name: "reviewer" }];
function ctx(runRoleImpl) {
  const posts = [], persisted = [];
  const state = { roleSessions: {} };
  const deps = {
    threadId: "t1", userText: "design the API", roster, maxRoundLen: 10, state,
    select: (u, r, cap) => r.map((x) => x.name).slice(0, cap),
    runRole: runRoleImpl,
    post: (tid, role, text) => posts.push([role, text]),
    persist: (tid, s) => persisted.push(JSON.parse(JSON.stringify(s.roleSessions))),
  };
  return { deps, posts, persisted, state };
}

// NOTE: advanceTurn calls runRole with the role OBJECT (it reads role.systemPrompt/model), so the
// mocks take `role` and use role.name -- NOT a bare string.
test("runs round in order, threads priorOutputs, persists each id, posts labeled", async () => {
  const seen = [];
  const { deps, posts, persisted, state } = ctx(async (role, text, prior, resume) => {
    seen.push([role.name, prior.map((p) => p.role)]);
    return { text: `${role.name} says hi`, sessionId: `sess_${role.name}`, skip: false, reset: false };
  });
  await advanceTurn(deps);
  assert.deepEqual(seen, [["spec", []], ["reviewer", ["spec"]]]); // reviewer sees spec's output
  assert.deepEqual(posts, [["spec", "spec says hi"], ["reviewer", "reviewer says hi"]]);
  assert.deepEqual(state.roleSessions, { spec: "sess_spec", reviewer: "sess_reviewer" });
  assert.equal(persisted.length, 2); // incremental
});
test("skip -> not posted, not threaded; reset -> notice posted", async () => {
  const { deps, posts } = ctx(async (role) =>
    role.name === "spec"
      ? { text: "", sessionId: "s", skip: true, reset: true }
      : { text: "reviewer speaks", sessionId: "r", skip: false, reset: false });
  await advanceTurn(deps);
  assert.deepEqual(posts, [["spec", "(session reset)"], ["reviewer", "reviewer speaks"]]);
});
test("a role throwing posts an error notice and the turn continues", async () => {
  const { deps, posts } = ctx(async (role) => {
    if (role.name === "spec") throw new Error("boom");
    return { text: "reviewer ok", sessionId: "r", skip: false, reset: false };
  });
  await advanceTurn(deps);
  assert.match(posts[0][1], /error/i);
  assert.deepEqual(posts[1], ["reviewer", "reviewer ok"]);
});
