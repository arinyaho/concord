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
