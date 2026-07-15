// PURE, pluggable round selector. B-1: run every roster role, in config order, capped at
// maxRoundLen. userText is ignored here (content-based routing is a future LLM selectRound that
// replaces this function; role self-skip handles relevance in B-1). Keeping the signature stable
// is what lets that swap happen without touching advanceTurn.
export function selectRound(userText, roster, maxRoundLen) {
  return roster.map((r) => r.name).slice(0, maxRoundLen);
}
