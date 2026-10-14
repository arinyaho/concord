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

// #339: the verify prompt reads the correctness artifact a subagent wrote.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSpawn } from "../src/adapters/spawn_subagent.mjs";

async function verifyPrompt(setup) {
  const stateDir = mkdtempSync(join(tmpdir(), "spawn-verify-"));
  try {
    setup(join(stateDir, "round-1-correctness.json"));
    let prompt;
    await makeSpawn({ repoRoot: "/repo", query: async function* (q) { prompt = q.prompt; } })("verify", { stateDir, round: 1 });
    return prompt;
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}

test("verify prompt treats a missing or malformed correctness artifact as an empty examined list", async () => {
  const missing = await verifyPrompt(() => {});
  const malformed = await verifyPrompt((file) => writeFileSync(file, "{nope"));
  const listed = await verifyPrompt((file) => writeFileSync(file, JSON.stringify({ examined: ["a.txt", 3] })));
  assert.match(listed, /a\.txt/);
  assert.doesNotMatch(missing, /a\.txt/);
  assert.doesNotMatch(malformed, /a\.txt/);
});

test("verify prompt ends the round with a harness failure on an oversized correctness artifact", async () => {
  await assert.rejects(verifyPrompt((file) => { writeFileSync(file, ""); truncateSync(file, 20 * 1024 * 1024 + 1); }), /harness-failure/);
});

test("verify prompt refuses a FIFO correctness artifact without blocking", { skip: process.platform === "win32" }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), "spawn-verify-"));
  try {
    assert.equal(spawnSync("mkfifo", [join(stateDir, "round-1-correctness.json")]).status, 0);
    const script = `import { makeSpawn } from ${JSON.stringify(new URL("../src/adapters/spawn_subagent.mjs", import.meta.url).href)};
      makeSpawn({ repoRoot: "/repo", query: async function* () {} })("verify", { stateDir: process.argv[1], round: 1 })
        .then(() => process.exit(2), (e) => process.exit(/harness-failure/.test(e.message) ? 0 : 3));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, stateDir], { timeout: 8000 });
    assert.equal(child.error, undefined, `blocked: ${child.error}`);
    assert.equal(child.status, 0);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
