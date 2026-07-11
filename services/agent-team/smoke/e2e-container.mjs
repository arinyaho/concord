// MANUAL / NETWORK. Drives the REAL launcher end-to-end: seeds a throwaway target repo with a
// failing node-only DoD, runs agent-team-launch, asserts the coder+review converge (outcome done)
// and the produced branch re-exports into the target. NOT under test/.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const credsDir = process.argv[process.argv.indexOf("--creds-dir") + 1];
if (!credsDir) { console.error("need --creds-dir"); process.exit(2); }
const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

// $HOME-rooted so colima mounts it.
const target = join(mkdtempSync(join(homedir(), ".agent-team", "e2e-")), "repo");
git(["init", "-q", "-b", "main", target]);
git(["-C", target, "config", "user.email", "s@x"]); git(["-C", target, "config", "user.name", "s"]);
writeFileSync(join(target, "review.config.json"), JSON.stringify({ dod: ["node --test add.test.mjs"] }));
writeFileSync(join(target, "add.test.mjs"),
  'import test from "node:test"; import assert from "node:assert"; import { add } from "./add.mjs"; test("add", () => assert.strictEqual(add(2,3),5));\n');
git(["-C", target, "add", "-A"]); git(["-C", target, "commit", "-qm", "seed failing DoD"]);

const bin = new URL("../bin/agent-team-launch.mjs", import.meta.url).pathname;
const r = spawnSync("node", [bin,
  "create add.mjs exporting a function add(a,b) that returns a+b",
  "--repo", target, "--creds-dir", credsDir, "--base", "main"],
  { encoding: "utf8", stdio: "pipe" });
console.log(r.stdout); console.error(r.stderr);
const converged = /"outcome": "done"/.test(r.stdout) || r.status === 0;
const branched = git(["-C", target, "branch", "--list", "agent-team/*"]).stdout.trim() !== "";
if (!converged || !branched) { console.error("E2E SMOKE FAILED"); process.exit(1); }
console.log("E2E SMOKE PASSED");
