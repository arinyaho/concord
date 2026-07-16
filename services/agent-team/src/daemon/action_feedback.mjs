// Build the synthesized "continue" prompt fed back into the conversation on job completion. Summary
// only (outcome kind + branch + a single line of the tail) -- NEVER the full diff/log (token-bound).
// The roles receive this through B-1's buildPrompt ("The author said:\n..."); the [job result: ...]
// self-label makes a role read it as a system event, not author speech.
export function formatOutcomePrompt(outcome, { alias, jobId }) {
  const kind = outcome?.kind ?? "unknown";
  const firstLine = String(outcome?.tail ?? "").split("\n").find((l) => l.trim()) ?? "";
  const summary = firstLine.slice(0, 200);
  return `[job result: alias=${alias}, branch=agent-team/${jobId}, outcome=${kind}, summary=${summary}]`;
}
