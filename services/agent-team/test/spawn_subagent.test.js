import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnOptions } from "../src/adapters/spawn_subagent.mjs";

test("no settingSources by default (env unset)", () => {
  const o = buildSpawnOptions({ repoRoot: "/repo", model: undefined, env: {} });
  assert.equal("settingSources" in o, false);
  assert.equal(o.maxTurns, 12);
  assert.deepEqual(o.allowedTools, ["Read", "Write", "Edit", "Bash"]);
  assert.equal(o.cwd, "/repo");
});
test("settingSources from AGENT_TEAM_SETTING_SOURCES gates review-loop subagent cwd into untrusted repoRoot", () => {
  const o = buildSpawnOptions({ repoRoot: "/repo", model: undefined, env: { AGENT_TEAM_SETTING_SOURCES: '["user"]' } });
  assert.deepEqual(o.settingSources, ["user"]);
});
