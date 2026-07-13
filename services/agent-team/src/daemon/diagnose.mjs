// Host-side pure-text failure summarizer. It runs UNCONTAINED with an attacker-influenceable
// error tail in context, so it MUST build its own options directly -- NOT via the env-gated
// buildQueryOptions (on the host AGENT_TEAM_SETTING_SOURCES is unset, so that builder omits
// settingSources and the SDK default loads ~/.claude hooks/skills = an execution surface).
// allowedTools:[] blocks tool USE; settingSources:[] blocks hook/skill loading. Both, together,
// make it genuinely error-string-in / text-out. Fail-open: null -> caller falls back to tail.
const PROMPT = (tail) =>
  "A dev job failed. From this error output, in at most 3 short lines, say what failed and the " +
  "most likely fix or where to look. Do not speculate beyond the text.\n\n" + tail;

export async function diagnose(errTail, { query, model }) {
  try {
    const options = { allowedTools: [], settingSources: [], model, maxTurns: 1 };
    let result = null;
    for await (const m of query({ prompt: PROMPT(errTail), options })) {
      if ("result" in m) result = m.result;
    }
    const text = (result ?? "").trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}
