import test from "node:test";
import assert from "node:assert/strict";
import { makeActionPost } from "../../src/daemon/action_post.mjs";
import { getPending } from "../../src/daemon/pending_action.mjs";

function ctx() {
  const posts = [], systems = [], pend = [];
  const deps = { writeFileSync: () => {}, renameSync: () => {} };
  const wp = makeActionPost({
    post: async (tid, role, text) => posts.push([tid, role, text]),
    cfg: { repos: { concord: "/r" } },
    store: new Map(), storePath: "/s.json",
    mintId: () => "id1",
    postSystem: async (tid, text) => systems.push([tid, text]),
    setPendingImpl: (s, p, tid, pending) => pend.push([tid, pending]),
    deps,
  });
  return { wp, posts, systems, pend };
}

test("valid proposal: strips prose, records pending, posts confirm", async () => {
  const { wp, posts, systems, pend } = ctx();
  await wp("t1", "spec", "let's fix it\nDISPATCH concord :: fix the bug");
  assert.deepEqual(posts[0], ["t1", "spec", "let's fix it"]); // stripped prose sent first
  assert.deepEqual(pend[0][1], { id: "id1", alias: "concord", repoPath: "/r", task: "fix the bug" });
  assert.match(systems[0][1], /run id1/); // confirm prompt names the id
});
test("no proposal: text passed through, no pending, no confirm", async () => {
  const { wp, posts, systems, pend } = ctx();
  await wp("t1", "reviewer", "just talking");
  assert.deepEqual(posts[0], ["t1", "reviewer", "just talking"]);
  assert.equal(pend.length, 0);
  assert.equal(systems.length, 0);
});
test("unknown alias: prose sent, reason posted, no pending", async () => {
  const { wp, posts, systems, pend } = ctx();
  await wp("t1", "spec", "do it\nDISPATCH nope :: x");
  assert.deepEqual(posts[0], ["t1", "spec", "do it"]);
  assert.equal(pend.length, 0);
  assert.match(systems[0][1], /alias/i);
});
test("dispatch-only output (empty prose): post not called, pending still recorded, confirm still posted", async () => {
  const { wp, posts, systems, pend } = ctx();
  await wp("t1", "spec", "DISPATCH concord :: fix it");
  assert.equal(posts.length, 0); // no blank "**role:** " message
  assert.deepEqual(pend[0][1], { id: "id1", alias: "concord", repoPath: "/r", task: "fix it" });
  assert.match(systems[0][1], /run id1/);
});
test("a detection failure never throws out of the wrap", async () => {
  const wp = makeActionPost({
    post: async () => {}, cfg: { repos: { concord: "/r" } }, store: new Map(), storePath: "/s",
    mintId: () => "id1", postSystem: async () => {},
    setPendingImpl: () => { throw new Error("disk full"); }, deps: {},
  });
  await assert.doesNotReject(() => wp("t1", "spec", "go\nDISPATCH concord :: x"));
});
test("confirm prompt post fails: pending is rolled back, not orphaned, and wrap does not throw", async () => {
  const pend = [], cleared = [];
  const wp = makeActionPost({
    post: async () => {},
    cfg: { repos: { concord: "/r" } },
    store: new Map(), storePath: "/s.json",
    mintId: () => "id1",
    postSystem: async () => { throw new Error("discord unreachable"); },
    setPendingImpl: (s, p, tid, pending) => pend.push([tid, pending]),
    clearPendingImpl: (s, p, tid) => cleared.push(tid),
    deps: {},
  });
  await assert.doesNotReject(() => wp("t1", "spec", "go\nDISPATCH concord :: fix it"));
  assert.deepEqual(pend[0][1], { id: "id1", alias: "concord", repoPath: "/r", task: "fix it" }); // was recorded
  assert.deepEqual(cleared, ["t1"]); // then rolled back since the author never got the id
});
test("real setPending: persist throws after in-memory mutation -> rolled back, not orphaned", async () => {
  // Uses the REAL setPending/clearPending (no *Impl injection) so the mutate-then-persist ordering is
  // exercised for real: setPending sets state.pendingAction on the store Map, THEN calls saveThread,
  // which here throws via a failing deps.writeFileSync (disk full / EACCES). Without the fix, the
  // in-memory pendingAction would be left set with no confirm ever posted -> orphaned, unrunnable.
  const store = new Map();
  const deps = {
    writeFileSync: () => { throw new Error("ENOSPC: no space left on device"); },
    renameSync: () => {},
  };
  const wp = makeActionPost({
    post: async () => {},
    cfg: { repos: { concord: "/r" } },
    store, storePath: "/s.json",
    mintId: () => "id1",
    postSystem: async () => {},
    deps,
  });
  await assert.doesNotReject(() => wp("t1", "spec", "go\nDISPATCH concord :: fix it"));
  assert.equal(getPending(store, "t1"), null); // rolled back, no orphan left in the in-memory store
});
