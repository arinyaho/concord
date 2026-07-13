// PURE reply formatters. Every outgoing message is clamped to Discord's 2000-char cap so an
// oversized tail never makes send() 400 and lose the result. diagnose output is UNTRUSTED text
// (LLM over an attacker-influenceable tail): plain text only, no synthesized clickable actions.
const CAP = 2000;
const clamp = (s) => (s.length <= CAP ? s : s.slice(0, CAP - 3) + "...");

export function formatAck({ jobId, alias, task }) {
  return clamp(`queued #${jobId}: ${alias} -- ${task}`);
}
export function formatSuccess({ jobId, branch }) {
  return clamp(`done #${jobId} -- branch ${branch}`);
}
export function formatFailure({ analysis, tail }) {
  const head = analysis ? `failed -- ${analysis}\n\n` : "failed\n\n";
  const FENCE = 8; // "```\n" + "\n```"
  const room = Math.max(0, CAP - head.length - 3 - FENCE);
  const t = (tail ?? "").length > room ? "..." + (tail ?? "").slice(-room) : (tail ?? "");
  return clamp(head + "```\n" + t + "\n```");
}
export function formatQueueFull() { return "queue full -- try again shortly"; }
export function formatTimeout({ jobId }) { return clamp(`timed out #${jobId}`); }
export function formatCredsExpired() { return "credentials expired -- re-seed the daemon's creds dir"; }
