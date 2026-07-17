import assert from "node:assert/strict";
import { parseControlVerb, handleControlVerb } from "../src/daemon/control_verbs.mjs";

const posts = [], sent = [], setNames = [], cancelled = [];
const store = new Map([["t1", { roleSessions: {}, pendingAction: { id: "p1", alias: "concord", repoPath: "/r", task: "fix" } }]]);
const deps = {
  threadId: "t1",
  channel: { setName: async (n) => setNames.push(n), send: async (o) => sent.push(o) },
  cfg: { sessionStorePath: "/s" },
  queue: { cancel: (id) => { cancelled.push(id); return { found: id === "a1" }; }, list: () => ({ running: [{ jobId: "a1", alias: "concord", task: "fix", threadId: "t1" }], queued: [] }) },
  postSystem: async (tid, text) => posts.push([tid, text]),
  getPending: (tid) => store.get(tid)?.pendingAction ?? null,
  clearPending: (_p, tid) => { const s = store.get(tid); if (s) delete s.pendingAction; },
  listPendings: () => [...store.entries()].filter(([, s]) => s.pendingAction).map(([tid, s]) => ({ threadId: tid, ...s.pendingAction })),
};

await handleControlVerb(parseControlVerb("/cancel a1"), deps);
// cancel acks go through mention-disabled channel.send (echo user input safely), not postSystem.
assert.ok(sent.some((o) => o.allowedMentions && /cancelled a1/.test(o.content)), "cancel ack via mention-safe send");
await handleControlVerb(parseControlVerb("/status"), deps);
assert.ok(sent.some((o) => o.allowedMentions && /a1/.test(o.content)));
await handleControlVerb(parseControlVerb("/clear"), deps);
assert.match(posts.at(-1)[1], /cleared/i);
assert.equal(store.get("t1").pendingAction, undefined);
await handleControlVerb(parseControlVerb("/rename newname"), deps);
assert.deepEqual(setNames, ["newname"]);
console.log("CONTROL VERBS CONTRACT OK");
