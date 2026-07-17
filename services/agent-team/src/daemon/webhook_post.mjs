// Role-post identity layer (B-3b). Posts a conversation role's prose through a per-channel Discord
// webhook (username = role, optional avatar), giving each role a distinct visual voice. Falls back
// to the injected inline poster (rawPost) whenever a webhook is unavailable or a post throws, so
// conversation never breaks. The reserved pseudo-role "system" (busy/tally/footer notices that ride
// the same post seam) is never webhook-voiced. Signature matches rawPost so it drops into the
// makeActionPost `post` slot.

export function makeWebhookPost({ resolveWebhook, roleAvatars, fallbackPost }) {
  const avatars = roleAvatars ?? {};
  return async function webhookPost(threadId, role, text) {
    if (role === "system") return fallbackPost(threadId, role, text);
    const content = String(text).slice(0, 2000);
    let wh;
    try {
      wh = await resolveWebhook(threadId);
    } catch (e) {
      console.error(`[agent-team] webhook resolve failed for ${threadId}:`, e);
      return fallbackPost(threadId, role, text);
    }
    if (!wh) return fallbackPost(threadId, role, text); // outside the send-try: a null-path fallback throw propagates once
    try {
      const payload = { threadId, username: role, content, allowedMentions: { parse: [] } };
      const avatar = avatars[role];
      if (typeof avatar === "string" && avatar) payload.avatarURL = avatar;
      await wh.send(payload);
    } catch (e) {
      console.error(`[agent-team] webhook send failed for ${role} in ${threadId}:`, e);
      await fallbackPost(threadId, role, text);
    }
  };
}
