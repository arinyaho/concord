import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/daemon/config.mjs";

const OK = {
  repos: { chem: "/Users/inkme/ccp/chemcopilot" },
  credsDir: "/Users/inkme/.agent-team/creds",
  guildId: "111", channelId: "222", userIds: ["333"],
  jobTimeoutMs: 1800000, diagnoseModel: "claude-sonnet-5", botTokenEnv: "DISCORD_BOT_TOKEN",
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
