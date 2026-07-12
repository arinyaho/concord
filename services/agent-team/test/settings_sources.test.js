import test from "node:test";
import assert from "node:assert/strict";
import { settingSourcesFromEnv } from "../src/settings_sources.mjs";

test("unset env -> undefined", () => {
  assert.equal(settingSourcesFromEnv({}), undefined);
});
test("['user'] JSON -> ['user']", () => {
  assert.deepEqual(settingSourcesFromEnv({ AGENT_TEAM_SETTING_SOURCES: '["user"]' }), ["user"]);
});
test("malformed JSON throws", () => {
  assert.throws(() => settingSourcesFromEnv({ AGENT_TEAM_SETTING_SOURCES: "notjson" }), /AGENT_TEAM_SETTING_SOURCES/);
});
test("non-array JSON throws", () => {
  assert.throws(() => settingSourcesFromEnv({ AGENT_TEAM_SETTING_SOURCES: '"user"' }), /AGENT_TEAM_SETTING_SOURCES/);
});
test("array with non-string element throws", () => {
  assert.throws(() => settingSourcesFromEnv({ AGENT_TEAM_SETTING_SOURCES: "[1]" }), /AGENT_TEAM_SETTING_SOURCES/);
});
