import test from "node:test";
import assert from "node:assert/strict";
import { parseControlVerb, formatStatus, handleControlVerb } from "../../src/daemon/control_verbs.mjs";

test("parseControlVerb: each verb + rejects non-verbs", () => {
  assert.deepEqual(parseControlVerb("/cancel a1"), { verb: "cancel", arg: "a1" });
  assert.deepEqual(parseControlVerb("/status"), { verb: "status", arg: undefined });
  assert.deepEqual(parseControlVerb("/clear"), { verb: "clear", arg: undefined });
  assert.deepEqual(parseControlVerb("/rename my new name"), { verb: "rename", arg: "my new name" });
  for (const s of ["/status now", "/clear x", "/cancel", "/rename", "/tokens", "run a1", "please /status", "hi"]) {
    assert.equal(parseControlVerb(s), null, s);
  }
});

test("formatStatus: bounded, truncates task, tolerates undefined threadId, empty case", () => {
  const s = formatStatus({
    pendings: [{ threadId: "t1", id: "p1", alias: "concord", task: "x".repeat(500) }],
    jobs: { running: [{ jobId: "j1", alias: "concord", task: "y".repeat(500), threadId: undefined }], queued: [] },
  });
  assert.ok(s.length <= 2000);
  assert.match(s, /p1/); assert.match(s, /j1/);
  assert.doesNotMatch(s, /x{500}/); // truncated
  const empty = formatStatus({ pendings: [], jobs: { running: [], queued: [] } });
  assert.match(empty, /nothing pending|no jobs/i);
});

function deps(over = {}) {
  const posts = [], setNames = [], sends = [];
  return {
    d: {
      threadId: "t1",
      channel: { setName: async (n) => setNames.push(n), send: async (o) => sends.push(o) },
      cfg: { sessionStorePath: "/s" },
      queue: { cancel: () => ({ found: true }), list: () => ({ running: [], queued: [] }) },
      postSystem: async (tid, text) => posts.push([tid, text]),
      getPending: () => ({ id: "p1", alias: "concord", repoPath: "/r", task: "fix" }),
      clearPending: () => {},
      listPendings: () => [],
      ...over,
    }, posts, setNames, sends,
  };
}

test("cancel: found -> ack; not found -> no such job (mention-disabled channel.send, not postSystem)", async () => {
  const a = deps(); await handleControlVerb({ verb: "cancel", arg: "a1" }, a.d);
  assert.match(a.sends.at(-1).content, /cancelled a1/);
  assert.deepEqual(a.sends.at(-1).allowedMentions, { parse: [] });
  assert.equal(a.posts.length, 0); // ack must NOT route through postSystem
  const b = deps({ queue: { cancel: () => ({ found: false }), list: () => ({}) } });
  await handleControlVerb({ verb: "cancel", arg: "zzz" }, b.d);
  assert.match(b.sends.at(-1).content, /no such job zzz/);
  assert.deepEqual(b.sends.at(-1).allowedMentions, { parse: [] });
  assert.equal(b.posts.length, 0);
});

test("cancel: user-supplied @everyone is echoed but mention-disabled (no live ping)", async () => {
  const c = deps({ queue: { cancel: () => ({ found: false }), list: () => ({}) } });
  await handleControlVerb({ verb: "cancel", arg: "@everyone" }, c.d);
  assert.equal(c.sends.at(-1).content, "no such job @everyone");
  assert.deepEqual(c.sends.at(-1).allowedMentions, { parse: [] }); // ping neutralized
  assert.equal(c.posts.length, 0);
});

test("clear: pending -> cleared; none -> nothing pending", async () => {
  const a = deps(); await handleControlVerb({ verb: "clear", arg: undefined }, a.d);
  assert.match(a.posts.at(-1)[1], /cleared/i);
  const b = deps({ getPending: () => null }); await handleControlVerb({ verb: "clear", arg: undefined }, b.d);
  assert.match(b.posts.at(-1)[1], /nothing pending/i);
});

test("rename: success -> setName + ack; failure -> rename failed", async () => {
  const a = deps(); await handleControlVerb({ verb: "rename", arg: "newname" }, a.d);
  assert.deepEqual(a.setNames, ["newname"]);
  assert.match(a.posts.at(-1)[1], /renamed/i);
  const b = deps({ channel: { setName: async () => { throw new Error("perm"); } } });
  await handleControlVerb({ verb: "rename", arg: "x" }, b.d);
  assert.match(b.posts.at(-1)[1], /rename failed/i);
});

test("status: posts via channel.send with mentions disabled, not postSystem", async () => {
  const sends = [];
  const a = deps({
    channel: { send: async (o) => sends.push(o) },
    listPendings: () => [{ threadId: "t1", id: "p1", alias: "concord", task: "fix" }],
    queue: { list: () => ({ running: [{ jobId: "j1", alias: "concord", task: "run", threadId: "t1" }], queued: [] }) },
  });
  await handleControlVerb({ verb: "status", arg: undefined }, a.d);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].allowedMentions, { parse: [] }); // mass-mention defense
  assert.match(sends[0].content, /p1/);
  assert.match(sends[0].content, /j1/);
  assert.equal(a.posts.length, 0); // must NOT route status output through postSystem
});
