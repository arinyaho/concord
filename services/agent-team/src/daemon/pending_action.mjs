import { saveThread } from "./session_store.mjs";

// Per-thread pending action proposal (last-wins), stored as a `pendingAction` field on the existing
// session-store thread state so it persists through the same atomic saveThread as roleSessions. It
// does its OWN synchronous persist -- it must NOT rely on advanceTurn's conditional (if sessionId)
// persist, or a proposal from a session-less turn would be memory-only and lost on restart.
function ensure(store, threadId) {
  let state = store.get(threadId);
  if (!state) { state = { roleSessions: {} }; store.set(threadId, state); }
  return state;
}

export function setPending(store, path, threadId, pending, deps = {}) {
  const state = ensure(store, threadId);
  state.pendingAction = pending;
  saveThread(store, path, threadId, state, deps);
}

export function getPending(store, threadId) {
  return store.get(threadId)?.pendingAction ?? null;
}

export function clearPending(store, path, threadId, deps = {}) {
  const state = store.get(threadId);
  if (!state || !("pendingAction" in state)) return;
  delete state.pendingAction;
  saveThread(store, path, threadId, state, deps);
}
