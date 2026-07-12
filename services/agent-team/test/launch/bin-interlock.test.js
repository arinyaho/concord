import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
// Run a bin uncontained with NO opt-in: the interlock must refuse before any side effect.
function runBin(bin, args, env) {
  return spawnSync("node", [join(binDir, bin), ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_TEAM_CONTAINED: "", ...env },
  });
}

test("agent-team-run refuses uncontained with no opt-in (exit 2, message)", () => {
  const r = runBin("agent-team-run.mjs", ["some task", "--repo", "/nonexistent-xyz"], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uncontained/i);
});

test("agent-team (phase-2 coordinator bin) refuses uncontained with no opt-in (exit 2, message)", () => {
  const r = runBin("agent-team.mjs", ["some brief"], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uncontained/i);
});
