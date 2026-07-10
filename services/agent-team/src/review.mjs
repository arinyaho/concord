// Parse a reviewer reply into a structured verdict. Fails closed: any input we
// cannot read as a JSON object with an `approved` field is treated as NOT
// approved, so an unreadable review can never end the loop as a success.
export function parseReview(text) {
  const s = String(text ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) {
    return { approved: false, findings: ["unparseable reviewer output"] };
  }
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    return {
      approved: o.approved === true,
      findings: Array.isArray(o.findings) ? o.findings : [],
    };
  } catch {
    return { approved: false, findings: ["invalid JSON from reviewer"] };
  }
}
