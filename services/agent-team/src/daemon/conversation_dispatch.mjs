import { isAuthorizedThread } from "./thread_gate.mjs";
import { selectRound } from "./select_round.mjs";
import { advanceTurn } from "./conversation.mjs";

// The conversation routing core (bot-skip lives in the bin, ahead of this). Returns true iff it
// handled the message. Authorized conversation-channel message -> create thread, AWAIT-seed the
// store, run the first turn. Authorized tracked-thread message -> run a follow-up turn. Turns for
// the SAME thread are serialized by a per-thread promise-chain lock (withThreadLock) so two rapid
// messages in one thread cannot race the shared `state` object -- that lock is per-thread only and
// does not bound how many DIFFERENT threads run turns at once. Cross-thread concurrency is bounded
// separately by a shared in-process counting semaphore (makeSemaphore): at most MAX_CONCURRENT_TURNS
// turns run their host query at a time across ALL threads, with a bounded wait queue so a burst of
// distinct threads degrades to an in-thread "busy" note instead of unbounded concurrent host queries.
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

// Max turns (across all threads) allowed to run their host query concurrently.
const MAX_CONCURRENT_TURNS = 4;
// Max turns allowed to wait for a free slot before a new turn is dropped with a busy note instead
// of queueing indefinitely (bounds memory/backlog under a burst of distinct threads).
const MAX_QUEUED_TURNS = 4;

// A minimal counting semaphore: `cap` concurrent slots plus a FIFO wait queue of resolvers.
// acquire() resolves immediately if a slot is free, otherwise queues until release() frees one.
function makeSemaphore(cap) {
  let active = 0;
  const q = [];
  return {
    acquire: () => new Promise((res) => {
      if (active < cap) { active++; res(); } else q.push(res);
    }),
    release: () => {
      active--;
      if (q.length) { active++; q.shift()(); }
    },
    waiting: () => q.length,
  };
}

export function makeConversationHandler({ cfg, roster, store, deps }) {
  const { createThread, post, runRole, persist, postSystem, getPending, clearPending, dispatchAction } = deps;
  const maxRoundLen = cfg.maxRoundLen ?? roster.length;
  const locks = new Map(); // threadId -> tail promise (serialize same-thread turns)
  const sem = makeSemaphore(MAX_CONCURRENT_TURNS); // shared across all threads on this handler

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

  async function run(threadId, userText, state, opts = {}) {
    await withThreadLock(threadId, async () => {
      // Depth bound: too many turns already waiting on a free cross-thread slot -> drop this one
      // with an in-thread notice rather than growing the queue without limit. This check and the
      // eventual acquire() both run inside the per-thread lock, so it cannot race itself for the
      // same thread; it can still race turns from other threads for queue slots, which is fine --
      // the bound is advisory backpressure, not an exact count. A job-outcome re-entry (feedTurn)
      // bypasses this drop: a computed outcome is bounded by the capability queue's own cap, not a
      // floodable author burst, so it must never be silently shed.
      if (!opts.bypassBusyDrop && sem.waiting() >= MAX_QUEUED_TURNS) {
        // Best-effort notice: a post failure here (e.g. Discord unreachable) must not turn a
        // dropped-for-capacity turn into an unhandled rejection.
        try {
          await post(threadId, "system", "(busy -- try again shortly)");
        } catch (e) {
          console.error(`[agent-team] busy notice post failed for thread ${threadId}:`, e);
        }
        return;
      }
      await sem.acquire();
      try {
        await advanceTurn({
          threadId, userText, roster, maxRoundLen, state,
          select: selectRound, runRole, post,
          persist: (tid, s) => persist(tid, s),
        });
      } finally {
        sem.release();
      }
    });
  }

  // Locked re-entry for a job outcome. Re-fetches state (guard a closed/evicted thread) and runs a
  // synthesized turn through the SAME lock + semaphore as a user turn, but BYPASSING the busy-drop --
  // a computed job outcome (bounded by the capability queue's own cap, not a floodable author burst)
  // must never be silently shed.
  //
  // advanceTurn only posts non-skip ROLE outputs -- it never posts userText itself. The conversation
  // roles can legitimately SKIP the result turn (their SKIP_RULE invites "outside your area -> SKIP"),
  // and if EVERY role skips, nothing would be posted or logged: the author, who confirmed `run <id>`
  // and saw "job started", would never learn the job finished or failed. So the outcome is posted
  // unconditionally here, BEFORE the turn runs, guaranteeing the author always sees it regardless of
  // whether any role reacts. This mirrors the capability path (replyForOutcome posts unconditionally).
  // Best-effort + its own try/catch: a post failure here must not crash the fire-and-forget onDone
  // caller, nor block the turn that follows.
  async function feedTurn(threadId, userText) {
    const state = store.get(threadId);
    if (!state) {
      try {
        await postSystem(threadId, "(job result for a closed conversation -- ignored)");
      } catch (e) {
        console.error(`[agent-team] feedTurn guard notice post failed for thread ${threadId}:`, e);
      }
      return;
    }
    try {
      await postSystem(threadId, userText);
    } catch (e) {
      console.error(`[agent-team] job-result notice post failed for thread ${threadId}:`, e);
    }
    await run(threadId, userText, state, { bypassBusyDrop: true });
  }

  const handle = async function handle(msg) {
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
    // (b) tracked thread -> confirm a pending action, else a follow-up turn
    const parentId = msg.channel?.parentId;
    if (isAuthorizedThread({ authorId: msg.author?.id, channelId: msg.channelId, guildId: msg.guildId, parentId }, cfg, store)) {
      const threadId = msg.channelId;
      const confirm = (msg.content ?? "").trim().match(/^run\s+(\S+)$/i);
      if (confirm) {
        const pending = getPending(store, threadId);
        if (pending) {
          if (pending.id === confirm[1]) {
            const { accepted } = dispatchAction({ pending, threadId, feedTurn });
            if (accepted) {
              clearPending(store, cfg.sessionStorePath, threadId);
              await postSystem(threadId, `job started (${pending.id})`);
            } else {
              // Do NOT clear the pending proposal here -- leave it in place so the user can retry
              // `run <id>` once a capability slot frees up.
              await postSystem(threadId, "busy -- try again shortly");
            }
          } else {
            // A pending proposal exists but this id does not match it -- likely a fat-fingered id.
            await postSystem(threadId, `no pending proposal ${confirm[1]}`);
          }
          return true;
        }
        // No pending proposal at all: a `run <id>` message is ordinary conversation (spec 120), not
        // a confirmation. Fall through to the normal-turn path below so the team discusses it rather
        // than the daemon rejecting it.
      }
      const state = store.get(threadId);
      await run(threadId, msg.content ?? "", state);
      return true;
    }
    return false;
  };

  return { handle, feedTurn };
}
