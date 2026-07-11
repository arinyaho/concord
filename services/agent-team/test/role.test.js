import test from "node:test";
import assert from "node:assert/strict";
import { buildQueryOptions } from "../src/role.mjs";

test("no settingSources by default (env unset)", () => {
  const o = buildQueryOptions({ systemPrompt: "s", extra: {}, sessionId: null, env: {} });
  assert.equal("settingSources" in o, false);
});
test("settingSources from AGENT_TEAM_SETTING_SOURCES", () => {
  const o = buildQueryOptions({ systemPrompt: "s", extra: {}, sessionId: null, env: { AGENT_TEAM_SETTING_SOURCES: '["user"]' } });
  assert.deepEqual(o.settingSources, ["user"]);
});
test("malformed AGENT_TEAM_SETTING_SOURCES throws", () => {
  assert.throws(() => buildQueryOptions({ systemPrompt: "s", extra: {}, sessionId: null, env: { AGENT_TEAM_SETTING_SOURCES: "notjson" } }), /AGENT_TEAM_SETTING_SOURCES/);
});
