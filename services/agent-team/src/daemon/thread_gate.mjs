// Fail-closed thread authorization. A follow-up turn is authorized only in a thread the daemon
// created (tracked in the store) whose LIVE parent is still a conversation channel (so removing a
// channel from the allowlist immediately de-authorizes its threads), by the allowlisted author in
// the pinned guild. Nullish on any field -> false.
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

export function isAuthorizedThread({ authorId, channelId, guildId, parentId }, cfg, store) {
  if (![authorId, channelId, guildId, parentId].every(nonEmpty)) return false;
  if (guildId !== cfg?.guildId) return false;
  if (!Array.isArray(cfg?.userIds) || !cfg.userIds.includes(authorId)) return false;
  if (!store.has(channelId)) return false;
  return Array.isArray(cfg?.conversationChannelIds) && cfg.conversationChannelIds.includes(parentId);
}
