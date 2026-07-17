// Pure token accounting. No I/O, no query, no tool. Reads the SDK's four usage fields
// directly (input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens);
// resumed context is cache-read (NOT input_tokens) so it is cache_read + cache_creation, never
// a subtraction. TOTAL over missing usage: never throws, flags usagePartial.
const W_CREATE = 1.25; // approximate single-TTL cache-creation multiplier (see spec: signal, not billable truth)
const CATS = ["freshInput", "resumedContext", "cacheCreation", "cacheRead", "output", "costWeightedInput"];
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function recordTurn({ role, usage }) {
  const u = usage && typeof usage === "object" ? usage : {};
  const freshInput = n(u.input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheCreation = n(u.cache_creation_input_tokens);
  const output = n(u.output_tokens);
  const resumedContext = cacheRead + cacheCreation;
  const costWeightedInput = freshInput * 1 + cacheCreation * W_CREATE + cacheRead * 0.1;
  // partial if usage absent, or any of the four expected fields is not a finite number
  const usagePartial = !usage || ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    .some((k) => typeof u[k] !== "number" || !Number.isFinite(u[k]));
  return { role, freshInput, resumedContext, cacheCreation, cacheRead, output, costWeightedInput, usagePartial };
}

function emptyTotals() { return Object.fromEntries(CATS.map((c) => [c, 0])); }

export function foldTurn(agg, rec) {
  const a = agg && typeof agg === "object"
    ? agg
    : { perRole: {}, totals: emptyTotals(), turnCount: 0, partialTurns: 0 };
  const pr = a.perRole[rec.role] ?? (a.perRole[rec.role] = { ...emptyTotals(), turns: 0 });
  for (const c of CATS) { pr[c] += rec[c]; a.totals[c] += rec[c]; }
  pr.turns += 1;
  a.turnCount += 1;
  if (rec.usagePartial) a.partialTurns += 1;
  return a;
}

export function summarize(agg) {
  const a = agg && typeof agg === "object" ? agg : { perRole: {}, totals: emptyTotals(), turnCount: 0, partialTurns: 0 };
  return { perRole: a.perRole, perCategory: { ...a.totals }, totals: a.totals, turnCount: a.turnCount, partialTurns: a.partialTurns };
}

const k = (x) => (x >= 1000 ? `${Math.round(x / 100) / 10}k` : `${x}`);

export function formatSummaryLine(s) {
  const t = s.totals;
  return `tokens: fresh ${k(t.freshInput)} - cached ${k(t.resumedContext)} - created ${k(t.cacheCreation)} - out ${k(t.output)} - ~${k(Math.round(t.costWeightedInput))} input-equiv(approx) (${s.turnCount} turns)`;
}

export function formatTally(s) {
  const lines = [`tokens (this conversation, ${s.turnCount} turns${s.partialTurns ? `, ${s.partialTurns} partial` : ""}):`];
  for (const [role, pr] of Object.entries(s.perRole)) {
    lines.push(`  ${role}: fresh ${k(pr.freshInput)} - cached ${k(pr.resumedContext)} - created ${k(pr.cacheCreation)} - out ${k(pr.output)} - ~${k(Math.round(pr.costWeightedInput))} eq~approx (${pr.turns})`);
  }
  const t = s.totals;
  lines.push(`  TOTAL: fresh ${k(t.freshInput)} - cached ${k(t.resumedContext)} - created ${k(t.cacheCreation)} - out ${k(t.output)} - ~${k(Math.round(t.costWeightedInput))} eq~approx`);
  return lines.join("\n");
}
