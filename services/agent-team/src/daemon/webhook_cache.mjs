// Per-parent-channel Discord webhook resolver (B-3b). Gives each conversation role a distinct
// visual voice by posting through a webhook. Client-free + unit-testable: the discord client is
// injected as fetchChannel + getBotUserId. Webhooks belong to the PARENT text channel (a thread
// posts through the parent's webhook + thread_id), so the cache is keyed by parent channel id and
// one marker-named webhook is reused across all of a channel's threads (avoids the 15/channel cap).

const PERMANENT = new Set([50013, 30007]); // 50013 Missing Permissions, 30007 Maximum webhooks

export function makeWebhookResolver({ fetchChannel, getBotUserId, markerName }) {
  const cache = new Map(); // parentId -> Promise<webhook | null>

  async function getOrCreate(parent) {
    const hooks = await parent.fetchWebhooks();
    const me = getBotUserId(); // read LATE (BLOCKER-1): client.user is null at construction
    let wh = hooks.find((h) => me && h.owner?.id === me && h.name === markerName);
    if (!wh) wh = await parent.createWebhook({ name: markerName });
    return wh;
  }

  return async function resolveWebhook(threadId) {
    const thread = await fetchChannel(threadId);
    const parentId = thread.parentId ?? thread.id;
    let parent = thread.parent;
    if (!parent && thread.parentId) parent = await fetchChannel(thread.parentId);
    parent = parent ?? thread;
    if (cache.has(parentId)) return cache.get(parentId);
    // getOrCreate is async => a sync OR async throw both surface as a REJECTED Promise, so this
    // .catch runs as a microtask strictly AFTER the cache.set below. The transient cache.delete can
    // therefore never race ahead of the insert (which would wrongly latch a null sentinel on a
    // non-permanent failure). Permanent (50013/30007) -> keep the cached resolved-null (sticky);
    // transient/unknown -> delete so the next post re-probes.
    const p = getOrCreate(parent).catch((e) => {
      console.error(`[agent-team] webhook get-or-create failed for channel ${parentId}:`, e);
      if (!PERMANENT.has(e?.code)) cache.delete(parentId);
      return null;
    });
    cache.set(parentId, p);
    return p;
  };
}
