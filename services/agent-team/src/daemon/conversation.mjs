import { recordTurn, foldTurn, summarize, formatSummaryLine } from "./meter.mjs";

// The turn engine. Decoupled from the trigger (advanceTurn takes plain userText -- a user
// message today, an autonomous "continue" prompt later). Runs the selected round sequentially,
// threading each role's output to later roles, posting labeled non-skip outputs, persisting each
// session id incrementally (so a mid-turn crash never replays the whole turn). A role's
// generation failure (runRole throwing) is contained: an error notice is posted and the turn
// continues. The cosmetic "(session reset)" notice is posted best-effort (safePost) and cannot
// precede-and-drop the real reply; the real reply is posted in its own try/catch, and once
// delivered (posted / threaded into priorOutputs) that happens BEFORE the fallible disk persist
// runs, so a persist failure can never discard an already-generated reply -- it only degrades
// durability (logged; on restart that role resumes from its last successfully-persisted session
// id) and never aborts the round.
export async function advanceTurn({ threadId, userText, roster, maxRoundLen, state, select, runRole, post, persist }) {
  const round = select(userText, roster, maxRoundLen);
  const byName = Object.fromEntries(roster.map((r) => [r.name, r]));
  const priorOutputs = [];
  // Best-effort notice post: never throws, so a failure posting a notice (e.g. Discord
  // unreachable, a call-specific rate-limit) can never itself abort the round.
  const safePost = async (roleName, text) => {
    try {
      await post(threadId, roleName, text);
    } catch (e) {
      console.error(`[agent-team] notice post failed for role ${roleName}:`, e);
    }
  };
  for (const name of round) {
    const role = byName[name];
    let res;
    try {
      res = await runRole(role, userText, priorOutputs, state.roleSessions[name], undefined);
    } catch (e) {
      await safePost(name, `(${name} error: ${e.message})`);
      continue;
    }

    // Meter: record every successful turn (including skips -- a self-skip still ran a full
    // LLM turn = burn source #1). Pure + total-over-missing, so it cannot throw into the loop.
    state.tokens = foldTurn(state.tokens, recordTurn({ role: name, usage: res.usage }));

    // The reset notice is cosmetic and posted best-effort via safePost, so a failure posting it
    // can never precede-and-drop the real reply below. Deliver the already-generated reply in its
    // own try/catch: a failure here (e.g. Discord unreachable) is a separate best-effort concern
    // that must not skip the persist below or abort the round.
    if (res.reset) await safePost(name, "(session reset)");
    if (!res.skip) {
      try {
        await post(threadId, name, res.text);
        priorOutputs.push({ role: name, text: res.text });
      } catch (e) {
        await safePost(name, `(${name} error: ${e.message})`);
      }
    }

    // Persist durability last and in isolation: a disk failure here must never discard the reply
    // already delivered above, and must not abort the round -- only future incremental persists.
    if (res.sessionId) {
      state.roleSessions[name] = res.sessionId;
      try {
        await persist(threadId, state);
      } catch (e) {
        console.error(`[agent-team] persist failed for role ${name}:`, e);
      }
    }
  }
  // Per-conversation footer: best-effort, after all replies, numbers-only, synthetic "system"
  // role. safePost never throws, so a footer-post failure cannot abort the round.
  if (state.tokens && state.tokens.turnCount > 0) {
    await safePost("system", formatSummaryLine(summarize(state.tokens)));
  }
}
