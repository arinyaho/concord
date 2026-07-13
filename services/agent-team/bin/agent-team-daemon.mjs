#!/usr/bin/env node
import { readFileSync, copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/daemon/config.mjs";
import { makeHandler } from "../src/daemon/handler.mjs";
import { createQueue } from "../src/daemon/queue.mjs";
import { buildLaunchArgv, runLaunchJob } from "../src/daemon/launch_job.mjs";
import { diagnose } from "../src/daemon/diagnose.mjs";
import { replyForOutcome } from "../src/daemon/outcome.mjs";
import { startCredsRefresh } from "../src/daemon/creds_refresh.mjs";

async function main() {
  const cfgPath = process.env.AGENT_TEAM_CONFIG;
  if (!cfgPath) { console.error("AGENT_TEAM_CONFIG (absolute path to config JSON) is required"); process.exit(2); }
  const cfg = loadConfig(JSON.parse(readFileSync(cfgPath, "utf8")));

  // Env posture: assert not-contained, mark REMOTE, extract + delete the token so it does not
  // inherit into spawned host children (agent-team-launch / docker).
  if (process.env.AGENT_TEAM_CONTAINED !== undefined) { console.error("refuse: AGENT_TEAM_CONTAINED must not be set in the daemon env"); process.exit(2); }
  process.env.AGENT_TEAM_REMOTE = "1";
  const token = process.env[cfg.botTokenEnv];
  if (!token) { console.error(`bot token env ${cfg.botTokenEnv} is empty`); process.exit(2); }
  delete process.env[cfg.botTokenEnv];
  // Child env for launches: inherit ours (REMOTE=1, token already deleted), WITHOUT the token.
  const childEnv = { ...process.env };

  const here = dirname(fileURLToPath(import.meta.url));
  const launchBin = join(here, "agent-team-launch.mjs");

  startCredsRefresh({ srcFile: join(homedir(), ".claude", ".credentials.json"), destDir: cfg.credsDir, intervalMs: cfg.credsRefreshMs }, { copyFile: copyFileSync, rename: renameSync });

  const runJob = (job) => {
    const argv = buildLaunchArgv({ launchBin, task: job.task, repoPath: job.repoPath, credsDir: cfg.credsDir, base: cfg.base, jobId: job.jobId });
    return runLaunchJob({ argv, env: childEnv }, { spawn: nodeSpawn });
  };
  const dockerKill = (jobId) => { try { spawnSync("docker", ["kill", `agent-team-${jobId}`]); } catch {} };
  const boundDiagnose = (tail, model) => diagnose(tail, { query, model });

  const queue = createQueue({
    cap: cfg.cap, queueMax: cfg.queueMax, jobTimeoutMs: cfg.jobTimeoutMs, runJob, dockerKill,
    onOutcome: (job, outcome) => { replyForOutcome(job, outcome, { reply: (m, t) => m.reply(t), diagnose: boundDiagnose, model: cfg.diagnoseModel }).catch((e) => console.error(`reply failed: ${e.message}`)); },
  });

  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const handle = makeHandler({ cfg, deps: { queue, mintId: () => randomUUID().slice(0, 8), reply: (msg, text) => msg.reply(text) } });
  client.on("messageCreate", (msg) => handle(msg).catch((e) => console.error(`handle failed: ${e.message}`)));
  client.once("ready", () => console.error(`agent-team daemon ready as ${client.user?.tag}`));
  await client.login(token);
}

main().catch((e) => { console.error(`daemon fatal: ${e.message}`); process.exit(1); });
