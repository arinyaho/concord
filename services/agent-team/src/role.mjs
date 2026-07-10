import { query } from "@anthropic-ai/claude-agent-sdk";

// A persistent role thread. First send() starts a session; later sends resume it
// so the role retains prior turns (options.resume, spike-confirmed). Each send()
// is bounded in wall-clock time: on timeout it rejects so the coordinator can
// convert a hung call into a terminal outcome rather than blocking forever.
// (Coarse guard: the underlying SDK stream is abandoned, not cancelled via
// AbortController -- clean cancellation is a follow-up.)
export function createRole({ name, systemPrompt, model, timeoutMs = 120000 }) {
  let sessionId = null;
  async function consume(userPrompt) {
    const options = { maxTurns: 1, allowedTools: [] };
    if (systemPrompt) options.systemPrompt = systemPrompt;
    if (model) options.model = model;
    if (sessionId) options.resume = sessionId;

    let result = null;
    for await (const m of query({ prompt: userPrompt, options })) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      if ("result" in m) result = m.result;
    }
    return (result ?? "").trim();
  }
  return {
    name,
    async send(userPrompt) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`role ${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([consume(userPrompt), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
