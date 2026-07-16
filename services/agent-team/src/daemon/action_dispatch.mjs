import { formatOutcomePrompt } from "./action_feedback.mjs";

// Submit a confirmed action as a capability job on the EXISTING queue. The job carries jobId (= the
// proposal id -- runJob/dockerKill/timeout/branch all key on it), an onDone closure (over threadId)
// that feeds the outcome back into the conversation, and NO `.msg` -- so the bin's global onOutcome
// discriminator routes it to onDone instead of the capability replyForOutcome. feedTurn is supplied
// by the handler at call time (it is the handler's own locked re-entry).
export function makeDispatchAction({ queue }) {
  return function dispatchAction({ pending, threadId, feedTurn }) {
    const { id, alias, repoPath, task } = pending;
    const job = {
      task, repoPath, alias, jobId: id,
      onDone: (outcome) => feedTurn(threadId, formatOutcomePrompt(outcome, { alias, jobId: id })),
    };
    return { accepted: queue.submit(job) };
  };
}
