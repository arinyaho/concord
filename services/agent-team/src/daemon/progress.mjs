const PROGRESS_BY_EVENT = new Map([
  ["coder_start", "coding"],
  ["coder_commit", "committing"],
  ["round_start", "reviewing"],
  ["review", "reviewing"],
  ["verify", "reviewing"],
  ["fix", "reviewing"],
]);

// Parses the stderr line format emitted by createLogger: `[timestamp] event {json}`.
// Unknown logger events are valid but do not represent a progress transition.
export function parseProgressLine(line) {
  const match = /^\[[^\]\r\n]+\] ([a-z_]+) (.+)$/.exec(line);
  if (!match) return null;
  let detail;
  try {
    detail = JSON.parse(match[2]);
  } catch {
    return null;
  }
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
  const phase = PROGRESS_BY_EVENT.get(match[1]);
  return phase ? { type: "progress", phase, detail } : null;
}
