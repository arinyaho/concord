import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorized } from "../../src/daemon/identity.mjs";

const cfg = { guildId: "g", channelId: "c", userIds: ["u1", "u2"] };

test("all three match -> true", () => {
  assert.equal(isAuthorized({ authorId: "u2", channelId: "c", guildId: "g" }, cfg), true);
});
test("each single mismatch -> false", () => {
  assert.equal(isAuthorized({ authorId: "x", channelId: "c", guildId: "g" }, cfg), false);
  assert.equal(isAuthorized({ authorId: "u1", channelId: "x", guildId: "g" }, cfg), false);
  assert.equal(isAuthorized({ authorId: "u1", channelId: "c", guildId: "x" }, cfg), false);
});
test("nullish on either side -> false (no undefined===undefined pass)", () => {
  assert.equal(isAuthorized({ authorId: "u1", channelId: "c", guildId: undefined }, cfg), false);
  assert.equal(isAuthorized({ authorId: "u1", channelId: "c", guildId: "g" }, { ...cfg, guildId: undefined }), false);
});
