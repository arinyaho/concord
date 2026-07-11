import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Clean-clone the target into a $HOME-rooted workDir, then strip anything host-executable:
// the origin remote (no push target), all git hooks, and any credential.helper. The result
// is a self-contained standalone repo (real .git dir), so an in-container `git worktree add`
// works and no host secret rides along in .git/config (spec decision 2 / SB1).
export function cleanClone({ srcRepo, workDir, base, runGit }) {
  const clone = runGit(["clone", "--quiet", srcRepo, workDir]);
  if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr || clone.stdout}`);
  // Ensure `base` exists as a LOCAL branch before removing origin (clone only makes HEAD local).
  if (runGit(["-C", workDir, "rev-parse", "--verify", "--quiet", base]).status !== 0) {
    const b = runGit(["-C", workDir, "branch", base, `origin/${base}`]);
    if (b.status !== 0) throw new Error(`base branch '${base}' not found in ${srcRepo}`);
  }
  runGit(["-C", workDir, "remote", "remove", "origin"]);
  rmSync(join(workDir, ".git", "hooks"), { recursive: true, force: true });
  mkdirSync(join(workDir, ".git", "hooks"), { recursive: true });
  runGit(["-C", workDir, "config", "--unset-all", "credential.helper"]); // no-op if absent
}

// Land ONLY the produced branch back into the real repo. `fetch` writes the ref + objects
// without a checkout and without running hooks -- the host never runs git INSIDE workDir.
export function reExport({ srcRepo, workDir, branch, runGit }) {
  const r = runGit(["-C", srcRepo, "fetch", workDir, `${branch}:${branch}`]);
  if (r.status !== 0) throw new Error(`re-export fetch failed: ${r.stderr || r.stdout}`);
}
