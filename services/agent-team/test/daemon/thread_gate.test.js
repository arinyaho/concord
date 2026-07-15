import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedThread } from "../../src/daemon/thread_gate.mjs";

const cfg = { guildId: "g", userIds: ["u"], conversationChannelIds: ["c1"] };
const store = new Map([["thr1", { roleSessions: {} }]]);
const ok = { authorId: "u", channelId: "thr1", guildId: "g", parentId: "c1" };

test("tracked thread with allowlisted parent + author + guild -> true", () => {
  assert.equal(isAuthorizedThread(ok, cfg, store), true);
});
test("untracked thread -> false", () => {
  assert.equal(isAuthorizedThread({ ...ok, channelId: "thrX" }, cfg, store), false);
});
test("parent no longer in allowlist -> false (live re-check)", () => {
  assert.equal(isAuthorizedThread({ ...ok, parentId: "cGONE" }, cfg, store), false);
});
test("wrong author / guild / nullish -> false", () => {
  assert.equal(isAuthorizedThread({ ...ok, authorId: "x" }, cfg, store), false);
  assert.equal(isAuthorizedThread({ ...ok, guildId: "x" }, cfg, store), false);
  assert.equal(isAuthorizedThread({ ...ok, parentId: undefined }, cfg, store), false);
});
