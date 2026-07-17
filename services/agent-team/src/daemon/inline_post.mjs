// Inline Discord posters (the non-webhook voice). Extracted from the bin so the mention hardening
// (allowedMentions:{parse:[]}) and the 2000-char clamp are unit-testable no-network -- the channel
// fetch is injected. rawPost = the `**role:** text` inline label (also the webhook fallback);
// postSystem = the daemon's own bot-voice for system/control notices. Both post model-derived text
// (role prose; the proposal confirm's r.task tail), so both keep mentions inert (contract 4).
export function makeInlinePosters({ fetchChannel }) {
  const rawPost = async (threadId, role, text) => {
    const ch = await fetchChannel(threadId);
    await ch.send({ content: `**${role}:** ${text}`.slice(0, 2000), allowedMentions: { parse: [] } });
  };
  const postSystem = async (threadId, text) => {
    const ch = await fetchChannel(threadId);
    await ch.send({ content: String(text).slice(0, 2000), allowedMentions: { parse: [] } });
  };
  return { rawPost, postSystem };
}
