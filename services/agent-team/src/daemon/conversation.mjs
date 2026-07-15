// The turn engine. Decoupled from the trigger (advanceTurn takes plain userText -- a user
// message today, an autonomous "continue" prompt later). Runs the selected round sequentially,
// threading each role's output to later roles, persisting each session id incrementally (so a
// mid-turn crash never replays the whole turn), posting labeled non-skip outputs. A single
// role's failure is contained: an error notice is posted and the turn continues.
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
    if (res.sessionId) { state.roleSessions[name] = res.sessionId; await persist(threadId, state); }
    if (res.reset) await post(threadId, name, "(session reset)");
    if (!res.skip) { await post(threadId, name, res.text); priorOutputs.push({ role: name, text: res.text }); }
  }
}
