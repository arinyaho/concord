import test from "node:test";
import assert from "node:assert/strict";
import { makeConversationHandler } from "../../src/daemon/conversation_dispatch.mjs";

const roster = [{ name: "spec", systemPrompt: "s" }];
const cfg = { guildId: "g", userIds: ["u"], conversationChannelIds: ["c1"], maxRoundLen: 10, sessionStorePath: "/x" };
function ctx() {
  const posts = [], created = [], store = new Map();
  const deps = {
    createThread: async (msg) => { created.push(msg.id); return { id: `thr_${msg.id}` }; },
    post: (tid, role, text) => posts.push([tid, role, text]),
    runRole: async (role) => ({ text: `${role.name} hi`, sessionId: "s1", skip: false, reset: false }),
    persist: (tid, state) => store.set(tid, JSON.parse(JSON.stringify(state))),
  };
  return { deps, posts, created, store };
}
const chanMsg = { id: "m1", author: { id: "u", bot: false }, channelId: "c1", guildId: "g" };

test("authorized conversation-channel message -> thread created + turn run; returns true", async () => {
  const { deps, posts, created } = ctx();
  const h = makeConversationHandler({ cfg, roster, store: new Map(), deps });
  const handled = await h(chanMsg);
  assert.equal(handled, true);
  assert.deepEqual(created, ["m1"]);
  assert.deepEqual(posts[0], ["thr_m1", "spec", "spec hi"]);
});
test("message in a non-conversation channel -> not handled (false), no thread", async () => {
  const { deps, created } = ctx();
  const h = makeConversationHandler({ cfg, roster, store: new Map(), deps });
  const handled = await h({ ...chanMsg, channelId: "other" });
  assert.equal(handled, false);
  assert.deepEqual(created, []);
});
test("unauthorized author in a conversation channel -> not handled, no thread", async () => {
  const { deps, created } = ctx();
  const h = makeConversationHandler({ cfg, roster, store: new Map(), deps });
  const handled = await h({ ...chanMsg, author: { id: "intruder", bot: false } });
  assert.equal(handled, false);
  assert.deepEqual(created, []);
});
test("authorized message in a tracked thread -> follow-up turn; returns true", async () => {
  const { deps, posts } = ctx();
  const store = new Map([["thr1", { roleSessions: { spec: "prev" } }]]);
  const h = makeConversationHandler({ cfg, roster, store, deps });
  const handled = await h({ id: "m2", author: { id: "u", bot: false }, channelId: "thr1", guildId: "g", channel: { parentId: "c1" } });
  assert.equal(handled, true);
  assert.deepEqual(posts[0], ["thr1", "spec", "spec hi"]);
});

// The per-thread promise-chain lock (withThreadLock) is the headline "turn semaphore" -- two rapid
// messages in the SAME thread must not interleave on the shared `state` object. These tests drive
// that invariant directly with manual promise gates (no timers/sleeps, no network).
test("same-thread turns serialize: second turn's runRole does not enter until the first fully exits", async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const deps = {
    createThread: async (msg) => ({ id: `thr_${msg.id}` }),
    post: () => {},
    runRole: async (role) => {
      calls += 1;
      const n = calls;
      order.push(`enter${n}`);
      if (n === 1) await gate; // first turn blocks here until we release it below
      order.push(`exit${n}`);
      return { text: `${role.name} ${n}`, sessionId: `s${n}`, skip: false, reset: false };
    },
    persist: () => {},
  };
  const store = new Map([["thr1", { roleSessions: {} }]]);
  const h = makeConversationHandler({ cfg, roster, store, deps });
  const threadMsg = (id) => ({ id, author: { id: "u", bot: false }, channelId: "thr1", guildId: "g", channel: { parentId: "c1" } });

  const p1 = h(threadMsg("m1"));
  const p2 = h(threadMsg("m2")); // fired without awaiting p1 -- must not race the first turn

  // Flush microtasks so the first turn reaches its (still-pending) gate; the lock must prevent the
  // second turn's runRole from being invoked at all until we release the gate below.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["enter1"]);

  releaseFirst();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["enter1", "exit1", "enter2", "exit2"]);
});

test("new conversation: thread is tracked (persist + store.set) before the first turn's runRole runs", async () => {
  const order = [];
  const store = new Map();
  const trackedSet = store.set.bind(store);
  store.set = (k, v) => { order.push("store.set"); return trackedSet(k, v); };
  const deps = {
    createThread: async (msg) => ({ id: `thr_${msg.id}` }),
    post: () => {},
    runRole: async () => { order.push("runRole"); return { text: "hi", sessionId: "s1", skip: false, reset: false }; },
    persist: () => { order.push("persist"); },
  };
  const h = makeConversationHandler({ cfg, roster, store, deps });
  const handled = await h(chanMsg);
  assert.equal(handled, true);
  // advanceTurn persists again after the turn (session id bookkeeping) -- only the seed-before-run
  // ordering matters here, so check the prefix rather than the full (longer) call log.
  assert.deepEqual(order.slice(0, 3), ["persist", "store.set", "runRole"]);
});
