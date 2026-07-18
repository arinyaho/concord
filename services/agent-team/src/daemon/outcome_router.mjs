// Route a completed job's outcome. A conversation job carries an `onDone` closure (and no `.msg`)
// -> its outcome feeds back into the conversation. A capability job carries `.msg` (and no onDone)
// -> its outcome goes to the capability reply path. onOutcome is called fire-and-forget by the
// queue, so any rejection is caught here (an unhandled rejection would crash the daemon).
export function makeOutcomeRouter({ replyForOutcome, onError }) {
  const reportError = (e) => { try { (onError ?? (() => {}))(e); } catch {} };
  return function onOutcome(job, outcome, terminalPromise) {
    Promise.resolve(terminalPromise)
      .catch((e) => { reportError(e); })
      .then(() => job.onDone ? job.onDone(outcome) : replyForOutcome(job, outcome))
      .catch(reportError);
  };
}
