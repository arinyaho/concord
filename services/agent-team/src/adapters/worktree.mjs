import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Create a fresh worktree off `base` for the coder to edit in. Left on disk for
// inspection (caller cleans up), matching the phase-2 scratch convention.
export function createWorktree({ repoRoot, base, branch }) {
  const worktreePath = join(mkdtempSync(join(tmpdir(), "agent-team-wt-")), "wt");
  const r = spawnSync("git", ["-C", repoRoot, "worktree", "add", worktreePath, "-b", branch, base], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  return { worktreePath };
}
