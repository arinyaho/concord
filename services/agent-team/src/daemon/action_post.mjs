import { parseProposal } from "./action_proposal.mjs";
import { resolveProposal } from "./action_gate.mjs";
import { setPending as realSetPending } from "./pending_action.mjs";

// Wrap the injected role `post` so it detects an action proposal in a role's output. It sends the
// STRIPPED prose FIRST (so a detection problem can never delay or drop the role's words), then --
// best-effort inside its own try/catch, so it can NEVER throw out into advanceTurn's per-role catch
// (which would misattribute it as a role failure) -- resolves the proposal, records ONE pending
// proposal (last-wins) and posts a confirm prompt, or posts a fail-closed reason. `post` is called
// from inside advanceTurn, itself inside the per-thread lock, so pending writes are already serialized.
export function makeActionPost({ post, cfg, store, storePath, mintId, postSystem, setPendingImpl, deps = {} }) {
  const setPending = setPendingImpl ?? realSetPending;
  return async function wrappedPost(threadId, role, text) {
    const { proposal, prose } = parseProposal(text);
    await post(threadId, role, prose);
    if (!proposal) return;
    try {
      const r = resolveProposal(proposal, cfg);
      if (!r.ok) { await postSystem(threadId, `cannot dispatch: ${r.reason}`); return; }
      const id = mintId();
      setPending(store, storePath, threadId, { id, alias: r.alias, repoPath: r.repoPath, task: r.task }, deps);
      await postSystem(threadId, `Proposed job ${id} on ${r.alias} (${r.repoPath}): ${r.task}. Reply \`run ${id}\` to execute.`);
    } catch (e) {
      console.error(`[agent-team] action detection failed for thread ${threadId}:`, e);
    }
  };
}
