import { branchFor } from "./launch_job.mjs";
import { formatSuccess, formatFailure, formatTimeout, formatCredsExpired } from "./reply.mjs";

// Pattern-match the launcher's stderr tail for a systemic auth failure (the launcher exposes
// only exit codes, no distinct auth code, and adding one is out of 3b-2 scope). Conservative:
// only well-known OAuth-expiry phrasings, so a per-task error is not misread as expiry.
const AUTH_RE = /oauth token expired|credentials? (expired|invalid)|401 unauthorized|authentication_error/i;
export function isAuthExpiry(tail) { return AUTH_RE.test(tail ?? ""); }

export async function replyForOutcome(job, outcome, { reply, diagnose, model }) {
  if (outcome.kind === "done") { await reply(job.msg, formatSuccess({ jobId: job.jobId, branch: branchFor(job.jobId) })); return; }
  if (outcome.kind === "timeout") { await reply(job.msg, formatTimeout({ jobId: job.jobId })); return; }
  if (isAuthExpiry(outcome.tail)) { await reply(job.msg, formatCredsExpired()); return; }
  const analysis = await diagnose(outcome.tail, model);
  await reply(job.msg, formatFailure({ analysis, tail: outcome.tail }));
}
