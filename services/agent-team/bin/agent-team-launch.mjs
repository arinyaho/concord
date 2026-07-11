#!/usr/bin/env node
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDockerArgs } from "../src/launch/run_spec.mjs";
import { assertNoApiKey, assertCredsDir, resolveRuntime } from "../src/launch/guards.mjs";
import { cleanClone, reExport } from "../src/launch/repo.mjs";

const BOT = { name: "agent-team-bot", email: "bot@agent-team.local" };

function parseArgs(argv) {
  const a = { base: "main", image: "agent-team:3a", repo: undefined, credsDir: undefined, skillsDir: undefined, concord: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--repo") a.repo = argv[++i];
    else if (t === "--creds-dir") a.credsDir = argv[++i];
    else if (t === "--skills-dir") a.skillsDir = argv[++i];
    else if (t === "--concord") a.concord = argv[++i];
    else if (t === "--image") a.image = argv[++i];
    else if (t === "--base") a.base = argv[++i];
    else rest.push(t);
  }
  a.task = rest.join(" ").trim();
  return a;
}

// $HOME-rooted worktree parent so colima mounts it (a /var/folders tmpdir would bind empty).
function defaultMkWorkDir(env) {
  const base = join(env.HOME || homedir(), ".agent-team", "work");
  return join(mkdtempSync(join(base + "-")), "work");
}

export async function runLaunch({ argv, env, deps }) {
  const {
    spawn, readdir, existsBin, runGit, mkWorkDir, rmWorkDir,
  } = deps;
  const a = parseArgs(argv);
  const home = env.HOME || homedir();
  const skillsDir = a.skillsDir || join(home, ".claude", "skills");
  const concordDir = a.concord || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  try {
    if (!a.task || !a.repo || !a.credsDir) {
      console.error('Usage: agent-team-launch "<task>" --repo <path> --creds-dir <path> [--skills-dir P] [--concord P] [--image T] [--base main]');
      return 2;
    }
    assertNoApiKey(env);
    const runtime = resolveRuntime(env, existsBin);
    assertCredsDir(a.credsDir, readdir);

    const workDir = mkWorkDir(env);
    cleanClone({ srcRepo: a.repo, workDir, base: a.base, runGit });

    const pipelineArgs = [a.task, "--repo", "/work", "--base", a.base];
    const args = buildDockerArgs({
      image: a.image, concordDir, workDir, credsDir: a.credsDir, skillsDir,
      gitName: BOT.name, gitEmail: BOT.email, settingSources: ["user"], pipelineArgs,
    });
    const code = await spawn(runtime, args);

    // The pipeline mints its own branch name (agent-team/run-<container-pid>); re-export by
    // scanning the produced branches. Simplest robust approach: fetch all agent-team/* refs.
    reExport({ srcRepo: a.repo, workDir, branch: "refs/heads/agent-team/*", runGit });
    rmWorkDir(workDir);
    return code;
  } catch (e) {
    console.error(`agent-team-launch: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const realDeps = {
    spawn: (bin, args) => new Promise((res) => {
      const c = nodeSpawn(bin, args, { stdio: "inherit" });
      c.on("close", (code) => res(code ?? 1));
      c.on("error", () => res(1));
    }),
    readdir: (d) => readdirSync(d),
    existsBin: (bin) => spawnSync("which", [bin]).status === 0,
    runGit: (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts }),
    mkWorkDir: defaultMkWorkDir,
    rmWorkDir: (d) => rmSync(d, { recursive: true, force: true }),
  };
  runLaunch({ argv: process.argv.slice(2), env: process.env, deps: realDeps }).then((c) => process.exit(c));
}
