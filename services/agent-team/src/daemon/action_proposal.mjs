// Deterministic parser for a role's action proposal. The proposal is the LAST line of the role's
// output, of the exact form `DISPATCH <alias> :: <task>` -- NOT JSON (task prose contains braces,
// quotes, etc.). Anything else (ordinary prose, or B-1's `(session reset)` / `(<name> error: ...)`
// / `(busy ...)` notices) yields no proposal and the text is returned unchanged.
const DISPATCH_RE = /^DISPATCH\s+([A-Za-z0-9_-]+)\s+::\s+(.+)$/;

export function parseProposal(roleText) {
  const text = typeof roleText === "string" ? roleText : "";
  const nl = text.lastIndexOf("\n");
  const lastLine = text.slice(nl + 1);
  const m = lastLine.match(DISPATCH_RE);
  if (!m) return { proposal: null, prose: text };
  const prose = text.slice(0, nl < 0 ? 0 : nl).replace(/\s+$/, "");
  return { proposal: { alias: m[1], task: m[2].trim() }, prose };
}
