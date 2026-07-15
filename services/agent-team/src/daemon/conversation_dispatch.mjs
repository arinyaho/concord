import { isAuthorizedThread } from "./thread_gate.mjs";
import { selectRound } from "./select_round.mjs";
import { advanceTurn } from "./conversation.mjs";

// The conversation routing core (bot-skip lives in the bin, ahead of this). Returns true iff it
// handled the message. Authorized conversation-channel message -> create thread, AWAIT-seed the
// store, run the first turn. Authorized tracked-thread message -> run a follow-up turn. Turns for
// the SAME thread are serialized by a per-thread promise-chain lock so two rapid messages in one
// thread cannot race the shared `state` object; different threads proceed concurrently.
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

export function makeConversationHandler({ cfg, roster, store, deps }) {
  const { createThread, post, runRole, persist } = deps;
  const maxRoundLen = cfg.maxRoundLen ?? roster.length;
  const locks = new Map(); // threadId -> tail promise (serialize same-thread turns)

  function withThreadLock(threadId, fn) {
    const prev = locks.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {}); // keep the chain alive past a failed turn
    locks.set(threadId, tail);
    // Evict once this thread's chain settles, but only if no newer turn has
    // chained onto it in the meantime (i.e. we are still the current tail).
    tail.then(() => {
      if (locks.get(threadId) === tail) locks.delete(threadId);
    });
    return next;
  }

  async function run(threadId, userText, state) {
    await withThreadLock(threadId, () => advanceTurn({
      threadId, userText, roster, maxRoundLen, state,
      select: selectRound, runRole, post,
      persist: (tid, s) => persist(tid, s),
    }));
  }

  return async function handle(msg) {
    const authed = nonEmpty(msg.author?.id) && msg.guildId === cfg.guildId
      && Array.isArray(cfg.userIds) && cfg.userIds.includes(msg.author.id);

    // (a) conversation channel -> new conversation
    if (authed && cfg.conversationChannelIds.includes(msg.channelId)) {
      const thread = await createThread(msg);
      const state = { roleSessions: {} };
      await persist(thread.id, state);          // AWAIT-seed before any follow-up can be processed
      store.set(thread.id, state);
      await run(thread.id, msg.content ?? "", state);
      return true;
    }
    // (b) tracked thread -> follow-up
    const parentId = msg.channel?.parentId;
    if (isAuthorizedThread({ authorId: msg.author?.id, channelId: msg.channelId, guildId: msg.guildId, parentId }, cfg, store)) {
      const state = store.get(msg.channelId);
      await run(msg.channelId, msg.content ?? "", state);
      return true;
    }
    return false;
  };
}
