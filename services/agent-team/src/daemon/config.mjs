import { isAbsolute } from "node:path";

// PURE: validate a parsed-JSON config object and apply defaults. Fails fast + loud so a
// misconfig never surfaces as a confusing per-job failure. credsDir existence/sole-entry is
// checked here only structurally; the launcher's assertCredsDir enforces the .credentials.json
// sole-entry contract at run time.
export function loadConfig(raw) {
  const c = raw ?? {};
  const req = (v, name) => { if (typeof v !== "string" || v.length === 0) throw new Error(`config.${name} must be a non-empty string`); };
  req(c.guildId, "guildId");
  req(c.channelId, "channelId");
  req(c.credsDir, "credsDir");
  req(c.botTokenEnv, "botTokenEnv");
  if (!isAbsolute(c.credsDir)) throw new Error("config.credsDir must be an absolute path");
  if (!Array.isArray(c.userIds) || c.userIds.length === 0 || !c.userIds.every((s) => typeof s === "string" && s))
    throw new Error("config.userIds must be a non-empty array of strings");
  if (!c.repos || typeof c.repos !== "object" || Object.keys(c.repos).length === 0)
    throw new Error("config.repos must be a non-empty { alias: absolutePath } map");
  for (const [alias, p] of Object.entries(c.repos)) {
    if (typeof p !== "string" || !isAbsolute(p)) throw new Error(`config.repos.${alias} must be an absolute path`);
  }
  if (typeof c.jobTimeoutMs !== "number" || c.jobTimeoutMs <= 0) throw new Error("config.jobTimeoutMs must be a positive number");
  req(c.diagnoseModel, "diagnoseModel");
  const cap = c.cap ?? 10;
  const queueMax = c.queueMax ?? 50;
  const credsRefreshMs = c.credsRefreshMs ?? 1800000;
  if (typeof cap !== "number" || cap < 1) throw new Error("config.cap must be a number >= 1");
  if (typeof queueMax !== "number" || queueMax < 1) throw new Error("config.queueMax must be a number >= 1");
  if (typeof credsRefreshMs !== "number" || credsRefreshMs <= 0) throw new Error("config.credsRefreshMs must be a positive number");
  return {
    repos: c.repos,
    credsDir: c.credsDir,
    guildId: c.guildId,
    channelId: c.channelId,
    userIds: c.userIds,
    cap,
    queueMax,
    jobTimeoutMs: c.jobTimeoutMs,
    credsRefreshMs,
    diagnoseModel: c.diagnoseModel,
    base: c.base ?? "main",
    botTokenEnv: c.botTokenEnv,
  };
}
