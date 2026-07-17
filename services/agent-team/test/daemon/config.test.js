import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/daemon/config.mjs";

const OK = {
  repos: { chem: "/Users/inkme/ccp/chemcopilot" },
  credsDir: "/Users/inkme/.agent-team/creds",
  guildId: "111", channelId: "222", userIds: ["333"],
  jobTimeoutMs: 1800000, diagnoseModel: "claude-sonnet-5", botTokenEnv: "DISCORD_BOT_TOKEN",
  conversationChannelIds: ["999"], sessionStorePath: "/Users/inkme/.agent-team/conversations.json",
};

test("accepts a well-formed config and applies defaults", () => {
  const c = loadConfig(OK);
  assert.equal(c.cap, 10);
  assert.equal(c.queueMax, 50);
  assert.equal(c.credsRefreshMs, 1800000);
  assert.equal(c.base, "main");
});
test("rejects empty/missing pins", () => {
  assert.throws(() => loadConfig({ ...OK, guildId: "" }), /guildId/i);
  assert.throws(() => loadConfig({ ...OK, channelId: undefined }), /channelId/i);
  assert.throws(() => loadConfig({ ...OK, userIds: [] }), /userIds/i);
});
test("rejects a non-absolute repos value", () => {
  assert.throws(() => loadConfig({ ...OK, repos: { x: "relative/path" } }), /absolute/i);
});
test("rejects a literal token in the config (only an env var NAME is allowed)", () => {
  assert.throws(() => loadConfig({ ...OK, botTokenEnv: undefined }), /botTokenEnv/i);
});
test("rejects non-positive / non-number cap, queueMax, credsRefreshMs", () => {
  assert.throws(() => loadConfig({ ...OK, cap: 0 }), /cap/i);
  assert.throws(() => loadConfig({ ...OK, queueMax: 0 }), /queueMax/i);
  assert.throws(() => loadConfig({ ...OK, credsRefreshMs: -1 }), /credsRefreshMs/i);
  assert.throws(() => loadConfig({ ...OK, cap: "ten" }), /cap/i);
});

const OKC = {
  ...OK,
  conversationChannelIds: ["444", "555"],
  sessionStorePath: "/Users/inkme/.agent-team/conversations.json",
};
test("accepts conversation fields + defaults maxRoundLen undefined", () => {
  const c = loadConfig(OKC);
  assert.deepEqual(c.conversationChannelIds, ["444", "555"]);
  assert.equal(c.sessionStorePath, "/Users/inkme/.agent-team/conversations.json");
  assert.equal(c.maxRoundLen, undefined);
});
test("rejects empty/malformed conversationChannelIds", () => {
  assert.throws(() => loadConfig({ ...OKC, conversationChannelIds: [] }), /conversationChannelIds/);
  assert.throws(() => loadConfig({ ...OKC, conversationChannelIds: [""] }), /conversationChannelIds/);
});
test("rejects a channel listed as BOTH capability and conversation", () => {
  assert.throws(() => loadConfig({ ...OKC, channelId: "444" }), /disjoint/i);
});
test("rejects a non-absolute sessionStorePath and non-positive maxRoundLen", () => {
  assert.throws(() => loadConfig({ ...OKC, sessionStorePath: "rel/path" }), /sessionStorePath/);
  assert.throws(() => loadConfig({ ...OKC, maxRoundLen: 0 }), /maxRoundLen/);
});

test("roleAvatars defaults to an empty object when absent", () => {
  const c = loadConfig(OK);
  assert.deepEqual(c.roleAvatars, {});
});
test("roleAvatars accepts a map of https URLs", () => {
  const c = loadConfig({ ...OK, roleAvatars: { spec: "https://x/a.png", reviewer: "https://x/b.png" } });
  assert.equal(c.roleAvatars.spec, "https://x/a.png");
});
test("roleAvatars rejects a non-https or non-string value", () => {
  assert.throws(() => loadConfig({ ...OK, roleAvatars: { spec: "http://x/a.png" } }), /https/i);
  assert.throws(() => loadConfig({ ...OK, roleAvatars: { spec: 123 } }), /https/i);
  assert.throws(() => loadConfig({ ...OK, roleAvatars: [] }), /roleAvatars/i);
});
