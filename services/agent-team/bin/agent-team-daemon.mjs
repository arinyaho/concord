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
import { makeOutcomeRouter } from "../src/daemon/outcome_router.mjs";
import { startCredsRefresh } from "../src/daemon/creds_refresh.mjs";
import { loadStore, saveThread } from "../src/daemon/session_store.mjs";
import { runRole } from "../src/daemon/roles.mjs";
import { makeConversationHandler } from "../src/daemon/conversation_dispatch.mjs";
import { getPending, clearPending } from "../src/daemon/pending_action.mjs";
import { makeDispatchAction } from "../src/daemon/action_dispatch.mjs";
import { makeActionPost } from "../src/daemon/action_post.mjs";
import { buildConversationRoster } from "../src/daemon/conversation_roster.mjs";
import { makeWebhookResolver } from "../src/daemon/webhook_cache.mjs";
import { makeWebhookPost } from "../src/daemon/webhook_post.mjs";

// Wraps the tool-less role adapter with a per-call AbortController + wall-clock timeout, so a
// hung role turn is CANCELLED (query() honors abort per the Task 1 spike) rather than abandoned.
// advanceTurn's injected runRole is called with a 5th arg (undefined, its own placeholder) that
// this wrapper's 4-arg signature simply does not accept -- advanceTurn is unmodified. Reuses
// cfg.jobTimeoutMs (the existing capability-job wall clock) rather than adding a new config field.
function makeConvRunRole({ query, timeoutMs }) {
  return async function convRunRole(role, userText, priorOutputs, resumeId) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      return await runRole(role, userText, priorOutputs, resumeId, abortController, { query });
    } finally {
      clearTimeout(timer);
    }
  };
}

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
    return runLaunchJob({ argv, env: childEnv, onChild: (c) => { job.child = c; } }, { spawn: nodeSpawn });
  };
  const dockerKill = (jobId) => { try { spawnSync("docker", ["kill", `agent-team-${jobId}`]); } catch {} };
  const boundDiagnose = (tail, model) => diagnose(tail, { query, model });

  const queue = createQueue({
    cap: cfg.cap, queueMax: cfg.queueMax, jobTimeoutMs: cfg.jobTimeoutMs, runJob, dockerKill,
    onOutcome: makeOutcomeRouter({
      replyForOutcome: (job, outcome) => replyForOutcome(job, outcome, { reply: (m, t) => m.reply(t), diagnose: boundDiagnose, model: cfg.diagnoseModel }),
      onError: (e) => console.error(`outcome handling failed: ${e.message}`),
    }),
  });

  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const handle = makeHandler({ cfg, deps: { queue, mintId: () => randomUUID().slice(0, 8), reply: (msg, text) => msg.reply(text) } });

  // B-1 conversation path: disjoint channels from the capability path (config-enforced), so a
  // message routes to exactly one. Tried FIRST; falls through to the capability handler if it
  // declines (non-conversation channel/thread, or an unauthorized author).
  const convStore = loadStore(cfg.sessionStorePath);
  const mintId = () => randomUUID().slice(0, 8);
  const rawPost = async (threadId, role, text) => {
    const ch = await client.channels.fetch(threadId);
    await ch.send({ content: `**${role}:** ${text}`.slice(0, 2000), allowedMentions: { parse: [] } });
  };
  const postSystem = async (threadId, text) => {
    const ch = await client.channels.fetch(threadId);
    await ch.send({ content: String(text).slice(0, 2000), allowedMentions: { parse: [] } });
  };
  const resolveWebhook = makeWebhookResolver({
    fetchChannel: (id) => client.channels.fetch(id),
    getBotUserId: () => client.user?.id, // getter: client.user is null until ready
    markerName: "agent-team",
  });
  const webhookPost = makeWebhookPost({ resolveWebhook, roleAvatars: cfg.roleAvatars, fallbackPost: rawPost });
  const dispatchAction = makeDispatchAction({ queue });
  const wrappedPost = makeActionPost({ post: webhookPost, cfg, store: convStore, storePath: cfg.sessionStorePath, mintId, postSystem });

  const conv = makeConversationHandler({
    cfg, roster: buildConversationRoster(Object.keys(cfg.repos)), store: convStore,
    deps: {
      createThread: (msg) => msg.startThread({ name: (msg.content || "conversation").slice(0, 80) }),
      post: wrappedPost,
      runRole: makeConvRunRole({ query, timeoutMs: cfg.jobTimeoutMs }),
      persist: (threadId, state) => saveThread(convStore, cfg.sessionStorePath, threadId, state),
      postSystem, getPending, clearPending, dispatchAction, queue,
    },
  });
  const convHandle = conv.handle;
  // feedTurn is conv.feedTurn -- already wired into dispatchAction via the handler's confirm routing.

  client.on("messageCreate", async (msg) => {
    if (msg.author?.bot) return;
    try {
      if (await convHandle(msg)) return;
    } catch (e) { console.error(`conversation: ${e.message}`); return; }
    await handle(msg).catch((e) => console.error(`handle failed: ${e.message}`));
  });
  client.once("ready", () => console.error(`agent-team daemon ready as ${client.user?.tag}`));
  await client.login(token);
}

main().catch((e) => { console.error(`daemon fatal: ${e.message}`); process.exit(1); });
