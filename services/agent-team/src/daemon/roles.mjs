// Tool-less role adapter. Builds query() options DIRECTLY (NOT via createRole/buildQueryOptions,
// which env-gate settingSources and would load ~/.claude hooks on the host = RCE -- see
// diagnose.mjs). allowedTools:[] + settingSources:[] = no tool use and no hook/skill loading.
const SKIP_RE = /^SKIP(\W|$)/;

function buildPrompt(role, userText, priorOutputs) {
  const prior = priorOutputs.map((o) => `${o.role}: ${o.text}`).join("\n");
  return `${role.systemPrompt}\n\n` +
    (prior ? `So far this turn:\n${prior}\n\n` : "") +
    `The author said:\n${userText}`;
}

async function once(query, prompt, options) {
  let sessionId = null, result = null;
  for await (const m of query({ prompt, options })) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
    if ("result" in m) result = m.result;
  }
  return { sessionId, text: (result ?? "").trim() };
}

export async function runRole(role, userText, priorOutputs, resumeId, abortController, deps = {}) {
  const { query } = deps;
  const prompt = buildPrompt(role, userText, priorOutputs);
  const base = { allowedTools: [], settingSources: [], maxTurns: 1 };
  if (role.model) base.model = role.model;
  if (abortController) base.abortController = abortController;

  let reset = false, out;
  try {
    out = await once(query, prompt, resumeId ? { ...base, resume: resumeId } : base);
  } catch (e) {
    if (abortController?.signal?.aborted) throw e; // timeout/cancel, not a bad resume -- do not retry
    if (resumeId) { reset = true; out = await once(query, prompt, base); } // bad-resume THROWS -> retry fresh
    else throw e;
  }
  // bad-resume SILENT-FRESH branch (per Task 1 spike): if the SDK started a fresh session instead
  // of throwing, the returned id differs from what we asked to resume -> also flag reset.
  if (resumeId && out.sessionId && out.sessionId !== resumeId) reset = true;
  const skip = SKIP_RE.test(out.text);
  const text = skip ? out.text.replace(SKIP_RE, "").trim() : out.text;
  return { text, sessionId: out.sessionId, skip, reset };
}
