// Manual e2e (network, OAuth). Builds a throwaway git repo with a DoD, runs the CLI
// against a small task, asserts outcome "done" / review "converged".
// Run: cd services/agent-team && unset ANTHROPIC_API_KEY && node smoke/e2e-capability.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCoder } from "../src/coder.mjs";
import { runCapability } from "../src/capability.mjs";
import { runReviewUntilGreen } from "../src/review_runner.mjs";
import { makeRunCli } from "../src/adapters/review_cli.mjs";
import { makeSpawn } from "../src/adapters/spawn_subagent.mjs";
import { createWorktree } from "../src/adapters/worktree.mjs";

function git(cwd, ...a) { const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; }

const repo = mkdtempSync(join(tmpdir(), "e2e-repo-"));
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "e2e@example.com");
git(repo, "config", "user.name", "e2e");
writeFileSync(join(repo, "review.config.json"), JSON.stringify({ dod: ["node --test"] }));
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "e2e", type: "module" }));
spawnSync("mkdir", ["-p", join(repo, "test")]);
writeFileSync(join(repo, "test", "placeholder.test.js"), `import{test} from "node:test"; test("boot",()=>{});`);
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");

const stateDir = mkdtempSync(join(tmpdir(), "e2e-state-"));
const CLI_PATH = new URL("../../../plugins/concord/hooks/review-cli.js", import.meta.url).pathname;
const branch = "agent-team/e2e-run";
const { worktreePath } = createWorktree({ repoRoot: repo, base: "main", branch });
const coder = createCoder({ cwd: worktreePath, branch });
const runCli = makeRunCli({ repoRoot: worktreePath, stateDir, cliPath: CLI_PATH });
const spawn = makeSpawn({ repoRoot: worktreePath });
const reviewRunner = { runReview: (t) => runReviewUntilGreen({ target: t, runCli, spawn, maxRounds: 5 }) };

const res = await runCapability({
  task: "Add a pure function `add(a, b)` in add.js that returns a+b, with a node --test test for it.",
  coder, reviewRunner, base: "main",
});
const pass = res.outcome === "done" && res.review.outcome === "converged" && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify({ pass, outcome: res.outcome, review: res.review.outcome, rounds: res.review.rounds }, null, 2));

// Also exercise the ACTUAL shipped binary end-to-end (not just the in-process wiring
// above): real CLI_PATH resolution, worktree creation, JSONL logging, and the
// exit-code report -- that in-process wiring bypasses all of. Reuses the same
// throwaway repo (git worktree add supports multiple concurrent worktrees).
const BIN_PATH = new URL("../bin/agent-team-run.mjs", import.meta.url).pathname;
const binResult = spawnSync("node", [
  BIN_PATH,
  "Add a pure function `sub(a, b)` in sub.js that returns a-b, with a node --test test for it.",
  "--repo", repo,
  "--base", "main",
], { encoding: "utf8" });
let binJson;
try { binJson = JSON.parse(binResult.stdout); } catch { binJson = null; }
const binPass = binResult.status === 0 && binJson && binJson.outcome === "done";
console.log(JSON.stringify({ binPass, binExitCode: binResult.status, binOutcome: binJson && binJson.outcome }, null, 2));

const overallPass = pass && binPass;
process.exit(overallPass ? 0 : 1);
