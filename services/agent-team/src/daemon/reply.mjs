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
  const OPEN = "```\n", CLOSE = "\n```";
  const FENCE = OPEN.length + CLOSE.length; // 8
  let head = analysis ? `failed -- ${analysis}\n\n` : "failed\n\n";
  const maxHead = CAP - FENCE;
  if (head.length > maxHead) head = head.slice(0, maxHead - 3) + "...";
  const room = CAP - head.length - FENCE - 3;
  const body = tail ?? "";
  const t = room <= 0 ? "" : (body.length > room ? "..." + body.slice(-room) : body);
  return clamp(head + OPEN + t + CLOSE);
}
export function formatQueueFull() { return "queue full -- try again shortly"; }
export function formatTimeout({ jobId }) { return clamp(`timed out #${jobId}`); }
export function formatCredsExpired() { return "credentials expired -- re-seed the daemon's creds dir"; }
