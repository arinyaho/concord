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
import { makeDispatchAction } from "../src/daemon/action_dispatch.mjs";
import { makeOutcomeRouter } from "../src/daemon/outcome_router.mjs";

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

// --- Real dispatch + outcome-router composition ---------------------------------------------
// Everything above mocks dispatchAction directly, so the real makeDispatchAction + makeOutcomeRouter
// wiring (the bin's actual global onOutcome discriminator) is never exercised. Compose the REAL
// pieces against a mock queue + mock replyForOutcome and drive the discriminator both ways.
const submittedJobs = [];
const mockQueue = { submit: (job) => { submittedJobs.push(job); return true; } };
const realDispatchAction = makeDispatchAction({ queue: mockQueue });

const feedTurnCalls = [];
const fakeFeedTurn = (tid, text) => { feedTurnCalls.push([tid, text]); };

const pendingForReal = { id: "id2", alias: "concord", repoPath: "/r", task: "fix the bug" };
const { accepted: realAccepted } = realDispatchAction({ pending: pendingForReal, threadId: "thr2", feedTurn: fakeFeedTurn });
assert.equal(realAccepted, true, "real dispatchAction accepted the job onto the mock queue");
assert.equal(submittedJobs.length, 1, "exactly one job reached the mock queue");
const conversationJob = submittedJobs[0];
assert.equal(conversationJob.jobId, "id2", "job carries jobId = the minted proposal id");
assert.equal(typeof conversationJob.onDone, "function", "job carries an onDone closure");
assert.equal(conversationJob.msg, undefined, "a conversation job has NO .msg field");

const replyForOutcomeCalls = [];
const mockReplyForOutcome = (job, outcome) => { replyForOutcomeCalls.push([job, outcome]); };
const onErrorCalls = [];
const realOnOutcome = makeOutcomeRouter({ replyForOutcome: mockReplyForOutcome, onError: (e) => onErrorCalls.push(e) });

// (b) Feeding the submitted conversation job through the REAL router must route to its own onDone
// (-> feedTurn), never to the capability replyForOutcome.
realOnOutcome(conversationJob, { kind: "done", tail: "ok" });
assert.equal(feedTurnCalls.length, 1, "onDone (feedTurn) was invoked for the conversation job");
assert.equal(feedTurnCalls[0][0], "thr2", "feedTurn was called for the dispatching thread");
assert.equal(replyForOutcomeCalls.length, 0, "replyForOutcome was NOT called for a conversation job");
assert.equal(onErrorCalls.length, 0, "no error surfaced from the onDone path");

// (c) A capability job (.msg present, no onDone) through the SAME router must call replyForOutcome
// instead -- proving the discriminator branches correctly both ways, not just for the conversation case.
const capabilityJob = { msg: { channel: { id: "c1" } }, jobId: "cap1" };
realOnOutcome(capabilityJob, { kind: "done", tail: "ok" });
assert.equal(replyForOutcomeCalls.length, 1, "replyForOutcome WAS called for the capability job");
assert.equal(replyForOutcomeCalls[0][0], capabilityJob, "replyForOutcome received the capability job");
assert.equal(feedTurnCalls.length, 1, "the capability job did not also trigger feedTurn");

console.log("ACTION CONTRACT OK");
