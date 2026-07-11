import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLaunch } from "../../bin/agent-team-launch.mjs";

// NOTE: cleanClone (Task 4, src/launch/repo.mjs) does real, non-injected fs.mkdirSync/rmSync
// on workDir/.git/hooks (only the `git` calls themselves go through the injected runGit). A
// literal "/home/u/work-1" is unwritable on macOS (/home is a special auto-mount that refuses
// mkdir outright), so mkWorkDir here returns a real tmpdir-rooted path -- same pattern already
// used by test/launch/repo.test.js -- instead of the brief's hardcoded literal.
function deps(overrides = {}) {
  const calls = { spawn: [], reExport: 0, clone: 0 };
  const workDir = join(mkdtempSync(join(tmpdir(), "at-launch-")), "work-1");
  return {
    calls,
    workDir,
    spawn: async (bin, args) => { calls.spawn.push({ bin, args }); return 0; },
    readdir: () => [".credentials.json"],
    existsBin: () => true,
    runGit: (args) => { if (args[0] === "clone") calls.clone++; if (args.includes("fetch")) calls.reExport++; return { status: 0, stdout: "", stderr: "" }; },
    mkWorkDir: () => workDir,
    rmWorkDir: () => {},
    ...overrides,
  };
}

const BASE = ["run the task", "--repo", "/home/u/realrepo", "--creds-dir", "/home/u/creds/.claude"];

test("refuses when ANTHROPIC_API_KEY is set", async () => {
  const d = deps();
  const code = await runLaunch({ argv: BASE, env: { ANTHROPIC_API_KEY: "sk", HOME: "/home/u" }, deps: d });
  assert.notEqual(code, 0);
  assert.equal(d.calls.spawn.length, 0);
});

test("happy path: clones, spawns runtime with the built args, re-exports, returns 0", async () => {
  const d = deps();
  const code = await runLaunch({ argv: BASE, env: { HOME: "/home/u" }, deps: d });
  assert.equal(code, 0);
  assert.equal(d.calls.clone, 1);
  assert.equal(d.calls.reExport, 1);
  assert.equal(d.calls.spawn.length, 1);
  const { bin, args } = d.calls.spawn[0];
  assert.equal(bin, "docker");
  assert.ok(args.includes("--rm"));
  assert.ok(args.join(" ").includes(`-v ${d.workDir}:/work`));
  assert.ok(args.join(" ").includes(`-e AGENT_TEAM_SETTING_SOURCES=["user"]`));
  // pipeline sees the CONTAINER repo path, not the host one
  assert.ok(args.join(" ").includes("--repo /work"));
});

test("refuses when creds dir has a planted sibling", async () => {
  const d = deps({ readdir: () => [".credentials.json", "settings.json"] });
  const code = await runLaunch({ argv: BASE, env: { HOME: "/home/u" }, deps: d });
  assert.notEqual(code, 0);
  assert.equal(d.calls.spawn.length, 0);
});
