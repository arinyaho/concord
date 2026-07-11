import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanClone, reExport } from "../../src/launch/repo.mjs";

const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

function seedRepo() {
  const dir = join(mkdtempSync(join(tmpdir(), "at-src-")), "repo");
  git(["init", "-q", "-b", "main", dir]);
  git(["-C", dir, "config", "user.email", "s@x"]); git(["-C", dir, "config", "user.name", "s"]);
  git(["-C", dir, "config", "credential.helper", "store"]); // must be stripped from the clone
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(["-C", dir, "add", "-A"]); git(["-C", dir, "commit", "-qm", "seed"]);
  return dir;
}

test("cleanClone produces a self-contained repo with no origin, no hooks, no credential.helper", () => {
  const src = seedRepo();
  const workDir = join(mkdtempSync(join(tmpdir(), "at-wt-")), "work");
  cleanClone({ srcRepo: src, workDir, base: "main", runGit: git });
  assert.ok(existsSync(join(workDir, ".git")));
  assert.equal(git(["-C", workDir, "remote"]).stdout.trim(), "");
  assert.equal(readdirSync(join(workDir, ".git", "hooks")).length, 0);
  const cfg = readFileSync(join(workDir, ".git", "config"), "utf8");
  assert.ok(!/credential/.test(cfg));
  assert.equal(git(["-C", workDir, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "main");
});

test("reExport lands a branch made in the clone back into the source repo", () => {
  const src = seedRepo();
  const workDir = join(mkdtempSync(join(tmpdir(), "at-wt-")), "work");
  cleanClone({ srcRepo: src, workDir, base: "main", runGit: git });
  git(["-C", workDir, "switch", "-qc", "feat/x"]);
  writeFileSync(join(workDir, "f.txt"), "hi\n");
  git(["-C", workDir, "add", "-A"]); git(["-C", workDir, "commit", "-qm", "add f"]);
  reExport({ srcRepo: src, workDir, branch: "feat/x", runGit: git });
  assert.equal(git(["-C", src, "rev-parse", "feat/x"]).status, 0);
  assert.match(git(["-C", src, "show", "feat/x:f.txt"]).stdout, /hi/);
});

test("reExport with a wildcard refspec lands the launcher-minted branch back into the source repo", () => {
  const src = seedRepo();
  const workDir = join(mkdtempSync(join(tmpdir(), "at-wt-")), "work");
  cleanClone({ srcRepo: src, workDir, base: "main", runGit: git });
  git(["-C", workDir, "switch", "-qc", "agent-team/run-7"]);
  writeFileSync(join(workDir, "g.txt"), "hi7\n");
  git(["-C", workDir, "add", "-A"]); git(["-C", workDir, "commit", "-qm", "add g"]);
  reExport({ srcRepo: src, workDir, branch: "refs/heads/agent-team/*", runGit: git });
  assert.equal(git(["-C", src, "rev-parse", "agent-team/run-7"]).status, 0);
  assert.match(git(["-C", src, "show", "agent-team/run-7:g.txt"]).stdout, /hi7/);
});
