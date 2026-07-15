import assert from "node:assert/strict";
import { makeConversationHandler } from "../src/daemon/conversation_dispatch.mjs";
import { CONVERSATION_ROSTER } from "../src/daemon/conversation_roster.mjs";

const cfg = { guildId: "g", userIds: ["u"], conversationChannelIds: ["c1"], maxRoundLen: 10, sessionStorePath: "/x" };
const posts = [], store = new Map();
const h = makeConversationHandler({
  cfg, roster: CONVERSATION_ROSTER, store,
  deps: {
    createThread: async (m) => ({ id: `thr_${m.id}` }),
    post: (tid, role, text) => posts.push([tid, role, text]),
    runRole: async (role) => ({ text: `${role.name}: hi`, sessionId: "s", skip: role.name === "reviewer", reset: false }),
    persist: (tid, s) => store.set(tid, s),
  },
});
const handled = await h({ id: "m1", author: { id: "u", bot: false }, channelId: "c1", guildId: "g", content: "design it" });
assert.equal(handled, true);
assert.ok(posts.some(([, role]) => role === "spec"), "spec posted");
assert.ok(!posts.some(([, role]) => role === "reviewer"), "reviewer skipped -> not posted");
console.log("CONV CONTRACT OK");
