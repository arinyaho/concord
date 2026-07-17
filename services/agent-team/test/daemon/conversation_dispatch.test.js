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

// The per-thread promise-chain lock (withThreadLock) enforces same-thread serialization -- two
// rapid messages in the SAME thread must not interleave on the shared `state` object. This is
// distinct from the cross-thread turn-concurrency semaphore (tested further below), which bounds
// how many turns across DIFFERENT threads run at once. This test drives the per-thread invariant
// directly with a manual promise gate (no timers/sleeps, no network).
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

// The cross-thread turn-concurrency semaphore is a SEPARATE mechanism from withThreadLock above:
// it bounds how many turns run their host query concurrently across ALL threads on one handler
// (withThreadLock only ever serializes turns within a single thread; distinct threads are not
// bounded by it at all). These tests drive that bound directly with a manual promise gate shared
// across every runRole call (no timers/sleeps, no network) and rely on repeated `Promise.resolve()`
// flushes to let every already-queued microtask (thread lock hand-off, semaphore acquire, turn
// dispatch) settle before asserting -- deterministic since no real I/O or timer is involved.
async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test("cross-thread cap: at most MAX_CONCURRENT_TURNS runRole calls are in-flight across distinct threads", async () => {
  const order = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const deps = {
    createThread: async (msg) => ({ id: `thr_${msg.id}` }),
    post: () => {},
    runRole: async (role) => {
      order.push(`enter:${role.name}`);
      await gate; // every call blocks on the SAME gate until we release it below
      order.push(`exit:${role.name}`);
      return { text: `${role.name} hi`, sessionId: "s1", skip: false, reset: false };
    },
    persist: () => {},
  };
  const CAP = 4; // must match MAX_CONCURRENT_TURNS in src/daemon/conversation_dispatch.mjs
  const N = CAP + 1; // one more distinct thread than the cap allows to run concurrently
  const store = new Map();
  for (let i = 1; i <= N; i += 1) store.set(`thr${i}`, { roleSessions: {} });
  const h = makeConversationHandler({ cfg, roster, store, deps });
  const threadMsg = (i) => ({ id: `m${i}`, author: { id: "u", bot: false }, channelId: `thr${i}`, guildId: "g", channel: { parentId: "c1" } });

  const pending = [];
  for (let i = 1; i <= N; i += 1) pending.push(h(threadMsg(i)));

  await flushMicrotasks();
  const enteredBeforeRelease = order.filter((e) => e.startsWith("enter:")).length;
  assert.equal(enteredBeforeRelease, CAP); // exactly the cap is in-flight; the extra thread is still queued

  releaseGate();
  await Promise.all(pending);
  const enteredAfterRelease = order.filter((e) => e.startsWith("enter:")).length;
  assert.equal(enteredAfterRelease, N); // once a slot frees, the queued thread's turn runs too
});

test("/tokens in an authorized tracked thread posts the tally and runs NO role", async () => {
  const posts = [];
  let roleRan = false;
  const cfg = { guildId: "g", userIds: ["u"], conversationChannelIds: ["conv"] };
  const store = new Map([["thr", { roleSessions: {}, tokens: { perRole: { spec: { freshInput: 100, turns: 1 } }, totals: { freshInput: 100 }, turnCount: 1 } }]]);
  const handle = makeConversationHandler({ cfg, roster: [{ name: "spec" }], store, deps: {
    createThread: async () => ({ id: "x" }),
    post: async (_tid, role, text) => { posts.push({ role, text }); },
    runRole: async () => { roleRan = true; return { text: "", sessionId: "s", skip: false, reset: false, usage: {} }; },
    persist: async () => {},
  }});
  // a tracked-thread message whose content is exactly "/tokens" (parentId in conversationChannelIds)
  const handled = await handle({ author: { id: "u" }, guildId: "g", channelId: "thr", content: "/tokens", channel: { parentId: "conv" } });
  assert.equal(handled, true);
  assert.equal(roleRan, false);                          // NO role invoked
  const reply = posts.find((p) => /tokens \(this conversation/.test(p.text));
  assert.ok(reply, "a tally is posted");
  assert.doesNotMatch(reply.text, /session|resume/);     // numbers-only
});

test("a message merely CONTAINING /tokens as free text is NOT the verb (runs the turn)", async () => {
  let roleRan = false;
  const cfg = { guildId: "g", userIds: ["u"], conversationChannelIds: ["conv"] };
  const store = new Map([["thr", { roleSessions: {}, tokens: undefined }]]);
  const handle = makeConversationHandler({ cfg, roster: [{ name: "spec" }], store, deps: {
    createThread: async () => ({ id: "x" }),
    post: async () => {},
    runRole: async () => { roleRan = true; return { text: "hi", sessionId: "s", skip: false, reset: false, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }; },
    persist: async () => {},
  }});
  await handle({ author: { id: "u" }, guildId: "g", channelId: "thr", content: "please run /tokens later", channel: { parentId: "conv" } });
  assert.equal(roleRan, true); // not an exact match -> a normal turn
});

test("depth bound: a turn beyond MAX_CONCURRENT_TURNS + MAX_QUEUED_TURNS is dropped with a busy note instead of running", async () => {
  const posts = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const runRoleCalls = [];
  const deps = {
    createThread: async (msg) => ({ id: `thr_${msg.id}` }),
    post: (tid, role, text) => posts.push([tid, role, text]),
    runRole: async (role) => {
      runRoleCalls.push(role.name);
      await gate;
      return { text: `${role.name} hi`, sessionId: "s1", skip: false, reset: false };
    },
    persist: () => {},
  };
  const CAP = 4; // MAX_CONCURRENT_TURNS
  const QUEUE = 4; // MAX_QUEUED_TURNS
  const N = CAP + QUEUE; // exactly fills active slots + the wait queue
  const store = new Map();
  for (let i = 1; i <= N + 1; i += 1) store.set(`thr${i}`, { roleSessions: {} });
  const h = makeConversationHandler({ cfg, roster, store, deps });
  const threadMsg = (i) => ({ id: `m${i}`, author: { id: "u", bot: false }, channelId: `thr${i}`, guildId: "g", channel: { parentId: "c1" } });

  const pending = [];
  for (let i = 1; i <= N; i += 1) pending.push(h(threadMsg(i)));
  await flushMicrotasks();
  assert.equal(runRoleCalls.length, CAP); // 4 active; 4 more queued behind the semaphore, none run yet

  // One more distinct thread arrives while the queue is already at MAX_QUEUED_TURNS -- it must be
  // dropped with an in-thread busy note, without ever invoking runRole.
  const overflowHandled = await h(threadMsg(N + 1));
  assert.equal(overflowHandled, true);
  assert.equal(runRoleCalls.length, CAP); // unchanged -- the overflow turn never ran
  assert.deepEqual(posts.at(-1), [`thr${N + 1}`, "system", "(busy -- try again shortly)"]);

  releaseGate();
  await Promise.all(pending);
});
