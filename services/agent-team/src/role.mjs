import { query } from "@anthropic-ai/claude-agent-sdk";
import { settingSourcesFromEnv } from "./settings_sources.mjs";

// Pure: assemble query() options. settingSources is env-gated so the container launcher can
// pin ['user'] (load author skills, exclude repo-committed project/local settings -- spec
// decision 10) while local author runs keep the SDK default (env unset).
export function buildQueryOptions({ systemPrompt, model, extra = {}, sessionId, env = process.env }) {
  const options = { maxTurns: extra.maxTurns ?? 1, allowedTools: extra.allowedTools ?? [] };
  if (systemPrompt) options.systemPrompt = systemPrompt;
  if (model) options.model = model;
  if (extra.cwd) options.cwd = extra.cwd;
  if (sessionId) options.resume = sessionId;
  const ss = settingSourcesFromEnv(env);
  if (ss) options.settingSources = ss;
  return options;
}

// A persistent role thread. First send() starts a session; later sends resume it
// so the role retains prior turns (options.resume, spike-confirmed). Each send()
// is bounded in wall-clock time: on timeout it rejects so the coordinator can
// convert a hung call into a terminal outcome rather than blocking forever.
// (Coarse guard: the underlying SDK stream is abandoned, not cancelled via
// AbortController -- clean cancellation is a follow-up.)
export function createRole({ name, systemPrompt, model, timeoutMs = 120000 }) {
  let sessionId = null;
  async function consume(userPrompt, extra = {}) {
    const options = buildQueryOptions({ systemPrompt, model, extra, sessionId });

    let result = null;
    for await (const m of query({ prompt: userPrompt, options })) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      if ("result" in m) result = m.result;
    }
    return (result ?? "").trim();
  }
  return {
    name,
    async send(userPrompt, extra = {}) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`role ${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([consume(userPrompt, extra), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
