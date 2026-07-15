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
test("persist throwing after a role's runRole succeeds does not drop the reply: real text is posted, failure only logged, round continues", async () => {
  const { deps, posts, state } = ctx(async (role) => ({ text: `${role.name} ok`, sessionId: `s_${role.name}`, skip: false, reset: false }));
  let thrown = false;
  deps.persist = async (tid, s) => { if (!thrown) { thrown = true; throw new Error("disk full"); } };
  const origError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args);
  try {
    await advanceTurn(deps);
  } finally {
    console.error = origError;
  }
  // The generated reply is delivered even though the FIRST persist call (spec's) throws --
  // generation succeeded, so the real reply must reach Discord, not a generic error notice.
  assert.deepEqual(posts, [["spec", "spec ok"], ["reviewer", "reviewer ok"]]);
  assert.equal(errorLogs.length, 1); // persist failure is logged, not surfaced as a dropped reply
  // sessionId is still tracked in-memory for the round even though the disk write failed; only
  // durability degrades (resumed from the last successfully-persisted id on restart).
  assert.equal(state.roleSessions.spec, "s_spec");
  assert.equal(state.roleSessions.reviewer, "s_reviewer");
});
test("post throwing (e.g. Discord API failure) is contained: turn continues to the next role", async () => {
  const roleAttempts = [];
  const { deps, posts, state } = ctx(async (role) => {
    roleAttempts.push(role.name);
    return { text: `${role.name} ok`, sessionId: `s_${role.name}`, skip: false, reset: false };
  });
  deps.post = async (tid, role, text) => {
    if (role === "spec" && !text.includes("error")) throw new Error("discord unreachable");
    posts.push([role, text]);
  };
  await advanceTurn(deps);
  assert.deepEqual(roleAttempts, ["spec", "reviewer"]); // reviewer still ran
  assert.match(posts[0][1], /error/i);
  assert.deepEqual(posts[1], ["reviewer", "reviewer ok"]);
  assert.deepEqual(state.roleSessions, { spec: "s_spec", reviewer: "s_reviewer" }); // spec's session persisted despite post failure
});
