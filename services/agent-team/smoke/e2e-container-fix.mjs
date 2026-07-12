// MANUAL / NETWORK, CONTAINER LEG for the FIX path. Drives the REAL launcher
// (bin/agent-team-launch.mjs) end-to-end -- same shape as e2e-container.mjs -- but against
// a task worded to invite a reviewable finding (divide(a,b) with b === 0 handling left
// unspecified), so the in-container review loop MAY raise a finding and exercise the real
// review -> fix -> commit-fix -> re-review cycle. e2e-container.mjs never runs this path: its
// trivial add(a,b) task converges round 1 with zero findings, so the fix/re-review machinery
// never fires. Real-LLM behavior cannot guarantee a defect is produced, so -- exactly like the
// local (non-container) e2e-capability-fix.mjs -- the assertion here is deliberately tolerant:
// "done" and "parked" are both valid loop terminations, and a park is itself the point (it
// proves review ran and, if it found something, that the fix path engaged). The
// fix -> commit-fix path itself is covered deterministically by the unit tests and the
// contract test, not by this leg; this leg only proves the machinery runs end-to-end inside
// the real container.
// Run: node smoke/e2e-container-fix.mjs --creds-dir <dir-containing-only-.credentials.json>
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const credsDir = process.argv[process.argv.indexOf("--creds-dir") + 1];
if (!credsDir) { console.error("need --creds-dir"); process.exit(2); }
const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

// $HOME-rooted (not tmpdir) so colima's file-sharing mounts it into the VM.
const agentTeamDir = join(homedir(), ".agent-team");
mkdirSync(agentTeamDir, { recursive: true });
// Snapshot so we can sweep away any leftover workdirs this run creates -- the launcher's own
// mkWorkDir/rmWorkDir pair removes the inner "work" dir but leaves the mkdtemp-created parent
// (e.g. ~/.agent-team/work-XXXXXX/) behind on disk.
const before = new Set(readdirSync(agentTeamDir));

const target = join(mkdtempSync(join(agentTeamDir, "e2e-cfix-")), "repo");
git(["init", "-q", "-b", "main", target]);
git(["-C", target, "config", "user.email", "s@x"]); git(["-C", target, "config", "user.name", "s"]);
writeFileSync(join(target, "review.config.json"), JSON.stringify({ dod: ["node --test"] }));
writeFileSync(join(target, "package.json"), JSON.stringify({ name: "e2e-cfix", type: "module" }));
mkdirSync(join(target, "test"), { recursive: true });
writeFileSync(join(target, "test", "placeholder.test.js"),
  'import { test } from "node:test"; test("boot", () => {});\n');
git(["-C", target, "add", "-A"]); git(["-C", target, "commit", "-qm", "seed passing DoD"]);

const bin = new URL("../bin/agent-team-launch.mjs", import.meta.url).pathname;
const task = "Add a pure function divide(a, b) in divide.mjs that returns a divided by b, with a " +
  "node --test test for it. Do not add any special-casing for b === 0.";
const r = spawnSync("node", [bin, task, "--repo", target, "--creds-dir", credsDir, "--base", "main"],
  { encoding: "utf8", stdio: "pipe" });
console.log(r.stdout); console.error(r.stderr);

// The container's own console.log(JSON.stringify(res, null, 2)) (bin/agent-team-run.mjs)
// is inherited straight through to our stdout; pull the trailing JSON object out of it.
let parsed = null;
const jsonStart = r.stdout.indexOf("{");
if (jsonStart >= 0) {
  try { parsed = JSON.parse(r.stdout.slice(jsonStart)); } catch { parsed = null; }
}

const outcome = parsed ? parsed.outcome : null;
const reviewOutcome = parsed && parsed.review ? parsed.review.outcome : null;
const rounds = parsed && parsed.review ? parsed.review.rounds : null;
const fixed = parsed && parsed.review ? parsed.review.fixed : null;
const oauthOnly = parsed ? parsed.apiKeyPresent === false : false;

// Tolerant: "done" and "parked" both pass -- neither is a harness failure. Only an explicit
// "error" outcome, an unparseable/missing result (container or launcher crash), or a leaked
// API key fail this leg.
const outcomeOk = outcome === "done" || outcome === "parked";
const failed = !outcomeOk || !oauthOnly;

console.log(JSON.stringify({ outcome, reviewOutcome, rounds, fixed, oauthOnly }));
console.log(failed ? "E2E-CONTAINER-FIX FAILED" : "E2E-CONTAINER-FIX PASSED");

// Always clean up: the throwaway target repo, and any workdir directories that appeared
// under ~/.agent-team/ during this run (never touch pre-existing entries -- other runs may
// be using the directory concurrently). Never echo creds file contents.
rmSync(dirname(target), { recursive: true, force: true });
for (const entry of readdirSync(agentTeamDir)) {
  if (!before.has(entry)) rmSync(join(agentTeamDir, entry), { recursive: true, force: true });
}

if (failed) process.exit(1);
