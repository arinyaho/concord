import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanClone, reExport } from "../../src/launch/repo.mjs";

const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

function seedRepo(runGit = git) {
  const dir = join(mkdtempSync(join(tmpdir(), "at-src-")), "repo");
  runGit(["init", "-q", "-b", "main", dir]);
  runGit(["-C", dir, "config", "user.email", "s@x"]); runGit(["-C", dir, "config", "user.name", "s"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  runGit(["-C", dir, "add", "-A"]); runGit(["-C", dir, "commit", "-qm", "seed"]);
  return dir;
}

// Second branch `dev` with its own commit, HEAD left on `main` -- lets us exercise the
// `base` != HEAD materialization path in cleanClone.
function seedRepoWithDevBranch(runGit = git) {
  const dir = seedRepo(runGit);
  runGit(["-C", dir, "switch", "-qc", "dev"]);
  writeFileSync(join(dir, "dev.txt"), "dev\n");
  runGit(["-C", dir, "add", "-A"]); runGit(["-C", dir, "commit", "-qm", "dev commit"]);
  runGit(["-C", dir, "switch", "-q", "main"]);
  return dir;
}

test("cleanClone produces a self-contained repo with no origin, no hooks, no credential.helper", () => {
  const src = seedRepo();
  const workDir = join(mkdtempSync(join(tmpdir(), "at-wt-")), "work");
  cleanClone({ srcRepo: src, workDir, base: "main", runGit: git });
  assert.ok(existsSync(join(workDir, ".git")));
  assert.equal(git(["-C", workDir, "remote"]).stdout.trim(), "");
  assert.equal(readdirSync(join(workDir, ".git", "hooks")).length, 0);
  // Effective (resolved) credential.helper must be empty, not just "absent from the raw
  // local config text" -- the fix intentionally writes an empty LOCAL override, which DOES
  // appear in the raw config text, so we assert on the resolved value instead.
  assert.equal(git(["-C", workDir, "config", "credential.helper"]).stdout.trim(), "");
  assert.equal(git(["-C", workDir, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "main");
});

test("cleanClone shadows an inherited GLOBAL credential.helper with an empty LOCAL override", () => {
  // Fake an inherited GLOBAL helper via GIT_CONFIG_GLOBAL, pointed at a throwaway file --
  // never touch the real ~/.gitconfig. A clone never inherits the SOURCE repo's local
  // config, so the only realistic way credential.helper leaks into workDir is via
  // global/system scope, which this reproduces.
  const cfgDir = mkdtempSync(join(tmpdir(), "at-gitconfig-"));
  const tmpGlobal = join(cfgDir, "gitconfig-global");
  writeFileSync(tmpGlobal, "[credential]\n\thelper = store\n");
  const gitG = (args, opts = {}) => spawnSync("git", args, {
    encoding: "utf8",
    ...opts,
    env: { ...process.env, GIT_CONFIG_GLOBAL: tmpGlobal, GIT_CONFIG_SYSTEM: "/dev/null" },
  });

  const src = seedRepo(gitG);
  const workDir = join(mkdtempSync(join(tmpdir(), "at-wt-")), "work");
  cleanClone({ srcRepo: src, workDir, base: "main", runGit: gitG });

  assert.equal(gitG(["-C", workDir, "config", "credential.helper"]).stdout.trim(), "");
});

test("cleanClone materializes a non-HEAD base as a local branch before removing origin", () => {
  const src = seedRepoWithDevBranch();
  const workDir = join(mkdtempSync(join(tmpdir(), "at-wt-")), "work");
  cleanClone({ srcRepo: src, workDir, base: "dev", runGit: git });
  // `dev` must exist locally in workDir (materialized from origin/dev before origin was
  // removed -- if origin had been removed first, `git branch dev origin/dev` would have
  // nothing to branch from and cleanClone would throw instead of reaching here).
  assert.equal(git(["-C", workDir, "rev-parse", "--verify", "dev"]).status, 0);
  assert.equal(git(["-C", workDir, "remote"]).stdout.trim(), "");
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
