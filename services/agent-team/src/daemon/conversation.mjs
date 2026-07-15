// The turn engine. Decoupled from the trigger (advanceTurn takes plain userText -- a user
// message today, an autonomous "continue" prompt later). Runs the selected round sequentially,
// threading each role's output to later roles, posting labeled non-skip outputs, persisting each
// session id incrementally (so a mid-turn crash never replays the whole turn). A role's
// generation failure (runRole throwing) is contained: an error notice is posted and the turn
// continues. Once a role has actually generated a reply, that reply is delivered (posted /
// threaded into priorOutputs) BEFORE the fallible disk persist runs, so a persist failure can
// never discard an already-generated reply -- it only degrades durability (logged; on restart
// that role resumes from its last successfully-persisted session id) and never aborts the round.
export async function advanceTurn({ threadId, userText, roster, maxRoundLen, state, select, runRole, post, persist }) {
  const round = select(userText, roster, maxRoundLen);
  const byName = Object.fromEntries(roster.map((r) => [r.name, r]));
  const priorOutputs = [];
  for (const name of round) {
    const role = byName[name];
    let res;
    try {
      res = await runRole(role, userText, priorOutputs, state.roleSessions[name], undefined);
    } catch (e) {
      await post(threadId, name, `(${name} error: ${e.message})`);
      continue;
    }

    // Deliver the already-generated reply first. A failure here (e.g. Discord unreachable) is a
    // separate best-effort concern: it must not skip the persist below or abort the round.
    try {
      if (res.reset) await post(threadId, name, "(session reset)");
      if (!res.skip) {
        await post(threadId, name, res.text);
        priorOutputs.push({ role: name, text: res.text });
      }
    } catch (e) {
      await post(threadId, name, `(${name} error: ${e.message})`).catch(() => {});
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
}
