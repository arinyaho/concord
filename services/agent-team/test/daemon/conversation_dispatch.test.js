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
  const { handle: h } = makeConversationHandler({ cfg, roster, store: new Map(), deps });
  const handled = await h(chanMsg);
  assert.equal(handled, true);
  assert.deepEqual(created, ["m1"]);
  assert.deepEqual(posts[0], ["thr_m1", "spec", "spec hi"]);
});
test("message in a non-conversation channel -> not handled (false), no thread", async () => {
  const { deps, created } = ctx();
  const { handle: h } = makeConversationHandler({ cfg, roster, store: new Map(), deps });
  const handled = await h({ ...chanMsg, channelId: "other" });
  assert.equal(handled, false);
  assert.deepEqual(created, []);
});
test("unauthorized author in a conversation channel -> not handled, no thread", async () => {
  const { deps, created } = ctx();
  const { handle: h } = makeConversationHandler({ cfg, roster, store: new Map(), deps });
  const handled = await h({ ...chanMsg, author: { id: "intruder", bot: false } });
  assert.equal(handled, false);
  assert.deepEqual(created, []);
});
test("authorized message in a tracked thread -> follow-up turn; returns true", async () => {
  const { deps, posts } = ctx();
  const store = new Map([["thr1", { roleSessions: { spec: "prev" } }]]);
  const { handle: h } = makeConversationHandler({ cfg, roster, store, deps });
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
  const { handle: h } = makeConversationHandler({ cfg, roster, store, deps });
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
  const { handle: h } = makeConversationHandler({ cfg, roster, store, deps });
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
  const { handle: h } = makeConversationHandler({ cfg, roster, store, deps });
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
  const { handle: h } = makeConversationHandler({ cfg, roster, store, deps });
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

// B-2: feedTurn (locked re-entry with busy-drop bypass) + confirm routing in the tracked-thread
// branch. makeConversationHandler now returns { handle, feedTurn } instead of a bare function.
const roster2 = [{ name: "spec", systemPrompt: "s" }];
const cfg2 = { guildId: "g", userIds: ["u"], conversationChannelIds: ["c1"], maxRoundLen: 10, sessionStorePath: "/x" };

function h2(over = {}) {
  const posts = [], systems = [], submitted = [];
  const store = new Map();
  const deps = {
    createThread: async (m) => ({ id: `thr_${m.id}` }),
    post: async (tid, role, text) => posts.push([tid, role, text]),
    runRole: async (role) => ({ text: `${role.name} hi`, sessionId: "s1", skip: false, reset: false }),
    persist: (tid, s) => store.set(tid, JSON.parse(JSON.stringify(s))),
    postSystem: async (tid, text) => systems.push([tid, text]),
    getPending: (s, tid) => s.get(tid)?.pendingAction ?? null,
    clearPending: (s, p, tid) => { const st = s.get(tid); if (st) delete st.pendingAction; },
    dispatchAction: ({ pending, threadId, feedTurn }) => { submitted.push([threadId, pending, feedTurn]); return { accepted: true }; },
    ...over,
  };
  const handler = makeConversationHandler({ cfg: cfg2, roster: roster2, store, deps });
  return { handler, posts, systems, submitted, store };
}
const thr = { id: "m2", author: { id: "u", bot: false }, channelId: "thr1", guildId: "g", channel: { parentId: "c1" }, content: "" };

test("returns { handle, feedTurn }", () => {
  const { handler } = h2();
  assert.equal(typeof handler.handle, "function");
  assert.equal(typeof handler.feedTurn, "function");
});
test("`run <id>` matching pending -> dispatchAction + clears pending, no normal turn", async () => {
  const { handler, submitted, store } = h2();
  store.set("thr1", { roleSessions: {}, pendingAction: { id: "a1", alias: "concord", repoPath: "/r", task: "fix" } });
  const handled = await handler.handle({ ...thr, content: "run a1" });
  assert.equal(handled, true);
  assert.equal(submitted[0][0], "thr1");
  assert.equal(submitted[0][1].id, "a1");
  assert.equal(store.get("thr1").pendingAction, undefined); // cleared on accept
});
test("`run <id>` with a pending of a DIFFERENT id -> 'no pending proposal', no dispatch", async () => {
  const { handler, systems, submitted, store } = h2();
  store.set("thr1", { roleSessions: {}, pendingAction: { id: "a1", alias: "concord", repoPath: "/r", task: "fix" } });
  const r = await handler.handle({ ...thr, content: "run zzz" });
  assert.equal(r, true);
  assert.equal(submitted.length, 0);
  assert.match(systems.at(-1)[1], /no pending proposal zzz/);
});
test("`run <id>` with NO pending -> ordinary conversation: a normal turn runs, no rejection note", async () => {
  const { handler, posts, systems, submitted, store } = h2();
  store.set("thr1", { roleSessions: {} }); // tracked thread, no pendingAction at all
  const r = await handler.handle({ ...thr, content: "run xyz" });
  assert.equal(r, true);
  assert.equal(submitted.length, 0); // never dispatched
  assert.deepEqual(posts.at(-1), ["thr1", "spec", "spec hi"]); // fell through to a normal turn
  assert.ok(!systems.some(([, text]) => /no pending proposal/.test(text))); // not rejected
});
test("queue full on confirm -> busy note, pending NOT cleared", async () => {
  const { handler, systems, store } = h2({ dispatchAction: () => ({ accepted: false }) });
  store.set("thr1", { roleSessions: {}, pendingAction: { id: "a1", alias: "concord", repoPath: "/r", task: "fix" } });
  await handler.handle({ ...thr, content: "run a1" });
  assert.match(systems.at(-1)[1], /busy/i);
  assert.equal(store.get("thr1").pendingAction.id, "a1"); // preserved for retry
});
test("feedTurn on a missing thread -> guarded note, no throw", async () => {
  const { handler, systems } = h2();
  await handler.feedTurn("ghost", "[job result: ...]");
  assert.match(systems.at(-1)[1], /closed|no longer|missing|unknown/i);
});

// advanceTurn only posts non-skip ROLE outputs -- it never posts userText itself. If every role
// legitimately SKIPs the job-result turn (their SKIP_RULE invites "outside your area -> SKIP"),
// nothing would be posted or logged and the author would never learn the job finished or failed.
// feedTurn must guarantee the outcome is always visible regardless of role reactions.
test("feedTurn posts the job outcome unconditionally, even when every role skips the result turn", async () => {
  const { handler, systems, store } = h2({
    runRole: async () => ({ text: "", sessionId: "s1", skip: true, reset: false }), // every role skips
  });
  store.set("thr1", { roleSessions: {} });
  await handler.feedTurn("thr1", "[job result: outcome=failed ...]");
  // The outcome was posted via postSystem -- the author sees it even though no role posted anything.
  assert.ok(systems.some(([tid, text]) => tid === "thr1" && text === "[job result: outcome=failed ...]"));
});

// Happy path: when a role DOES react, the author still gets both the unconditional system note
// (posted before the turn) and the role's reply (posted by advanceTurn during the turn).
test("feedTurn: when a role reacts, both the system outcome note and the role reply are posted", async () => {
  const { handler, posts, systems, store } = h2(); // default runRole: skip:false, posts "spec hi"
  store.set("thr1", { roleSessions: {} });
  await handler.feedTurn("thr1", "[job result: outcome=succeeded ...]");
  assert.ok(systems.some(([tid, text]) => tid === "thr1" && text === "[job result: outcome=succeeded ...]"));
  assert.deepEqual(posts.at(-1), ["thr1", "spec", "spec hi"]);
});

// The whole point of feedTurn is that a computed job outcome is NEVER silently shed the way an
// over-the-cap author burst is: it re-enters the SAME lock + semaphore but BYPASSES the busy-drop.
// This drives that invariant behaviorally under real saturation -- fill the cross-thread semaphore
// to the drop threshold (MAX_CONCURRENT_TURNS active + MAX_QUEUED_TURNS waiting), confirm a normal
// turn IS dropped there (proving the harness actually reached the threshold), then confirm a feedTurn
// re-entry under the SAME saturation is NOT dropped (no busy note, and its role eventually runs).
// Deterministic: one shared manual promise gate + microtask flushes, no timers/sleeps.
test("feedTurn bypasses the busy-drop: a job outcome runs under saturation where a normal turn is dropped", async () => {
  const posts = [];
  const entered = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const deps = {
    createThread: async (msg) => ({ id: `thr_${msg.id}` }),
    post: (tid, role, text) => posts.push([tid, role, text]),
    runRole: async (role) => {
      entered.push(role.name);
      await gate; // every in-flight turn parks here, holding its semaphore slot, until released below
      return { text: `${role.name} hi`, sessionId: "s1", skip: false, reset: false };
    },
    persist: () => {},
    postSystem: async (tid, text) => posts.push([tid, "system", text]),
    getPending: () => null,
    clearPending: () => {},
    dispatchAction: () => ({ accepted: true }),
  };
  const CAP = 4;   // MAX_CONCURRENT_TURNS
  const QUEUE = 4; // MAX_QUEUED_TURNS
  const SAT = CAP + QUEUE; // 8 in-flight turns -> sem.waiting() === MAX_QUEUED_TURNS (the drop threshold)
  const store = new Map();
  for (let i = 1; i <= SAT; i += 1) store.set(`thr${i}`, { roleSessions: {} });
  store.set("thr9", { roleSessions: {} });    // control: a normal turn that must be dropped
  store.set("thrFeed", { roleSessions: {} });  // feedTurn target that must NOT be dropped
  const { handle, feedTurn } = makeConversationHandler({ cfg: cfg2, roster: roster2, store, deps });
  const threadMsg = (id) => ({ id: `m_${id}`, author: { id: "u", bot: false }, channelId: id, guildId: "g", channel: { parentId: "c1" }, content: "hi" });

  // Saturate: 8 concurrent normal turns on distinct tracked threads -> CAP active in runRole, QUEUE queued.
  const pending = [];
  for (let i = 1; i <= SAT; i += 1) pending.push(handle(threadMsg(`thr${i}`)));
  await flushMicrotasks();
  assert.equal(entered.length, CAP); // exactly the cap is in runRole; sem.waiting() now === QUEUE (drop threshold)

  // Control: a 9th NORMAL turn under this saturation IS busy-dropped -- proves the threshold is truly reached.
  const dropped = await handle(threadMsg("thr9"));
  assert.equal(dropped, true);
  assert.equal(entered.length, CAP); // unchanged -- the dropped normal turn never entered runRole
  assert.deepEqual(posts.at(-1), ["thr9", "system", "(busy -- try again shortly)"]);

  // Bypass: feedTurn on a tracked thread under the SAME saturation must NOT be dropped. Fire without
  // awaiting -- it queues behind the semaphore (its await would not resolve until the gate releases).
  const fed = feedTurn("thrFeed", "[job result: done]");
  await flushMicrotasks();
  // The busy-drop branch was skipped for the job outcome: no "(busy ...)" note is posted for its thread.
  assert.ok(!posts.some(([tid, , text]) => tid === "thrFeed" && String(text).includes("busy")));
  assert.equal(entered.length, CAP); // no slot has freed yet, so its runRole has not entered -- it queued, not dropped

  // Release the gate: the active turns settle, the semaphore drains its wait queue, and the queued
  // feedTurn turn finally runs -- proving the job outcome was carried through, never shed.
  releaseGate();
  await Promise.all([...pending, fed]);
  assert.ok(entered.length > CAP); // more roles ran once slots freed, including the feedTurn turn
  assert.ok(posts.some(([tid, role]) => tid === "thrFeed" && role === "spec")); // its reply was posted -> it ran
});
