// Manual e2e (network, OAuth), SECOND LEG: exercises the real fix -> commit-fix path.
// The task is worded to invite a reviewable edge case (division by zero is left
// unspecified), so the review loop is likely -- but not guaranteed -- to raise a
// finding and fix it. Real-LLM behavior cannot guarantee a defect is produced, so
// this leg's assertion is deliberately tolerant: "done" and "parked" are both valid
// loop terminations (a non-"done" outcome here is a signal to look at the run's
// artifacts, not a flake to retry-until-green). What this leg actually proves is that
// WHEN a finding occurs, the fix -> commit-fix path is exercised for real: fixed >= 1
// implies rounds >= 1.
// Run: cd services/agent-team && unset ANTHROPIC_API_KEY && node smoke/e2e-capability-fix.mjs
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

const repo = mkdtempSync(join(tmpdir(), "e2e-fix-repo-"));
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "e2e@example.com");
git(repo, "config", "user.name", "e2e");
writeFileSync(join(repo, "review.config.json"), JSON.stringify({ dod: ["node --test"] }));
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "e2e-fix", type: "module" }));
spawnSync("mkdir", ["-p", join(repo, "test")]);
writeFileSync(join(repo, "test", "placeholder.test.js"), `import{test} from "node:test"; test("boot",()=>{});`);
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");

const stateDir = mkdtempSync(join(tmpdir(), "e2e-fix-state-"));
const CLI_PATH = new URL("../../../plugins/concord/hooks/review-cli.js", import.meta.url).pathname;
const branch = "agent-team/e2e-fix-run";
const { worktreePath } = createWorktree({ repoRoot: repo, base: "main", branch });
const coder = createCoder({ cwd: worktreePath, branch });
const runCli = makeRunCli({ repoRoot: worktreePath, stateDir, cliPath: CLI_PATH });
const spawn = makeSpawn({ repoRoot: worktreePath });
const reviewRunner = { runReview: (t) => runReviewUntilGreen({ target: t, runCli, spawn, maxRounds: 5 }) };

const res = await runCapability({
  task: "Add a pure function `divide(a, b)` in divide.js that returns a divided by b, with a " +
    "node --test test for it. Do not add any special-casing for b === 0.",
  coder, reviewRunner, base: "main",
});

const outcomeOk = res.outcome === "done" || res.outcome === "parked";
const fixPathOk = !res.review || res.review.fixed < 1 || res.review.rounds >= 1;
const pass = outcomeOk && fixPathOk && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify({
  pass, outcome: res.outcome, review: res.review && res.review.outcome,
  rounds: res.review && res.review.rounds, fixed: res.review && res.review.fixed,
}, null, 2));
process.exit(pass ? 0 : 1);
