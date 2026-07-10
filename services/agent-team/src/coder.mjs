import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRole } from "./role.mjs";
import { ROLES } from "./roster.mjs";

// Read the Definition-of-Done command the review loop will grade against, so the
// coder runs the SAME command locally (not an agentic guess at "the tests").
// Fail closed: a missing/malformed config is an error, not a silent skip.
export function readDodCommand(repoRoot) {
  let raw;
  try {
    raw = readFileSync(join(repoRoot, "review.config.json"), "utf8");
  } catch {
    throw new Error(`review.config.json not found in ${repoRoot} (needed for the DoD command)`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`review.config.json is malformed: ${e.message}`);
  }
  const dod = Array.isArray(parsed.dod) ? parsed.dod.filter((c) => typeof c === "string" && c.trim()) : [];
  if (!dod.length) throw new Error(`review.config.json has no non-empty "dod" command`);
  return dod[0];
}

export function buildCoderPrompt(task, dodCommand, branch) {
  return (
    `Task: ${task}\n\n` +
    `Create and switch to branch \`${branch}\` (e.g. \`git switch -c ${branch}\`) if you are not ` +
    `already on it, in this worktree (your current directory).\n` +
    `The Definition-of-Done command is: \`${dodCommand}\`\n\n` +
    `Steps: (1) make the change; (2) run \`${dodCommand}\` and make it pass; ` +
    `(3) commit on \`${branch}\` (do not push). Reply with one line summarizing the change.`
  );
}

// A coder role bound to a worktree, on a caller-provided branch. The caller (bin or the
// e2e) mints ONE branch name shared by the worktree and the review target, so the ref
// review-until-green reviews is always the exact branch the coder committed on.
export function createCoder({ cwd, branch, model, timeoutMs = 300000 }) {
  const role = createRole({
    name: ROLES.coder.name,
    systemPrompt: ROLES.coder.systemPrompt,
    model,
    timeoutMs,
  });
  return {
    async run(task) {
      try {
        const dodCommand = readDodCommand(cwd);
        // The real role must run with allowedTools + cwd; createRole is extended in Task 5's
        // adapter wiring to accept these. maxTurns:30 is required because a multi-turn
        // edit -> test -> commit sequence cannot fit in the role's default maxTurns:1.
        const summary = await role.send(buildCoderPrompt(task, dodCommand, branch), {
          allowedTools: ["Read", "Write", "Edit", "Bash"],
          cwd,
          maxTurns: 30,
        });
        return { branch, summary: summary.trim(), worktreePath: cwd };
      } catch (error) {
        return { branch: null, summary: null, worktreePath: cwd, error: String(error && error.message || error) };
      }
    },
  };
}
