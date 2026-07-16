// No-network contract smoke for delegated actions (B-2). Wires the real makeConversationHandler +
// makeActionPost against a mocked discord/queue boundary and drives the two required assertions:
// (1) a proposing role output, sent through the wrapped post, records a pending proposal and posts
// a confirm prompt naming the minted id; (2) a `run <id>` message, routed through conv.handle,
// dispatches the action with that same minted id. All deps are injected (no fs, no discord.js, no
// network); run with `node smoke/action-contract.mjs`.
import assert from "node:assert/strict";
import { makeConversationHandler } from "../src/daemon/conversation_dispatch.mjs";
import { makeActionPost } from "../src/daemon/action_post.mjs";
import { setPending, getPending, clearPending } from "../src/daemon/pending_action.mjs";
import { buildConversationRoster } from "../src/daemon/conversation_roster.mjs";

const cfg = { guildId: "g", userIds: ["u"], conversationChannelIds: ["c1"], maxRoundLen: 10, sessionStorePath: "/tmp/x.json", repos: { concord: "/r" } };
const store = new Map();
const systems = [];
const submitted = [];
const noFs = { writeFileSync: () => {}, renameSync: () => {} };
const postSystem = async (tid, text) => systems.push([tid, text]);
const rawPost = async () => {};
const wrappedPost = makeActionPost({ post: rawPost, cfg, store, storePath: cfg.sessionStorePath, mintId: () => "id1", postSystem, deps: noFs });

// Mock dispatchAction stands in for makeDispatchAction({ queue }): it records what it was called
// with (so we can assert the minted id reached it) and drives the job-outcome re-entry through the
// handler's own feedTurn, exactly like the real makeDispatchAction's onDone closure would.
const dispatchAction = ({ pending, threadId, feedTurn }) => {
  submitted.push([threadId, pending]);
  feedTurn(threadId, "[job result: alias=concord, branch=agent-team/id1, outcome=done, summary=ok]");
  return { accepted: true };
};

function saveThreadShim(tid, s) {
  store.set(tid, s);
}

const conv = makeConversationHandler({
  cfg, roster: buildConversationRoster(["concord"]), store,
  deps: {
    createThread: async (m) => ({ id: "thr1" }),
    post: wrappedPost,
    runRole: async (role) => ({ text: role.name === "spec" ? "let's do it\nDISPATCH concord :: fix the bug" : "SKIP", sessionId: "s", skip: role.name !== "spec", reset: false }),
    persist: (tid, s) => setPending && saveThreadShim(tid, s),
    postSystem, getPending, clearPending: (s, p, tid) => clearPending(s, p, tid, noFs), dispatchAction,
  },
});

// Seed a tracked thread (as createThread + the AWAIT-seed persist would), then drive a proposing
// turn straight through the wrapped post -- this is what advanceTurn calls per-role.
store.set("thr1", { roleSessions: {} });
await wrappedPost("thr1", "spec", "let's do it\nDISPATCH concord :: fix the bug");
assert.ok(getPending(store, "thr1"), "pending recorded");
assert.match(systems.find(([, t]) => /run id1/.test(t))[1], /run id1/);

// A `run <id>` message in the tracked thread must route through conv.handle's confirm branch and
// call dispatchAction with the SAME minted id -- not re-mint, not silently no-op.
const handled = await conv.handle({ id: "m2", author: { id: "u", bot: false }, channelId: "thr1", guildId: "g", channel: { parentId: "c1" }, content: "run id1" });
assert.equal(handled, true);
assert.equal(submitted.length, 1, "dispatchAction called exactly once");
assert.equal(submitted[0][0], "thr1", "dispatched for the confirming thread");
assert.equal(submitted[0][1].id, "id1", "dispatched with the minted id");

console.log("ACTION CONTRACT OK");
