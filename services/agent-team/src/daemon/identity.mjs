// PURE fail-closed authorization. True only when the author is allowlisted AND the message is
// in the pinned guild+channel. Rejects when EITHER side is nullish/empty so an absent config pin
// can never satisfy an absent message field via undefined === undefined.
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

export function isAuthorized({ authorId, channelId, guildId }, cfg) {
  if (!nonEmpty(authorId) || !nonEmpty(channelId) || !nonEmpty(guildId)) return false;
  if (!nonEmpty(cfg?.guildId) || !nonEmpty(cfg?.channelId) || !Array.isArray(cfg?.userIds)) return false;
  return guildId === cfg.guildId && channelId === cfg.channelId && cfg.userIds.includes(authorId);
}
