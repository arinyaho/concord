import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTurn, foldTurn, summarize, formatSummaryLine, formatTally } from "../src/daemon/meter.mjs";

const W = 1.25;

test("recordTurn maps the four usage fields directly (no subtraction)", () => {
  const r = recordTurn({ role: "spec", usage: {
    input_tokens: 8000, output_tokens: 3000,
    cache_read_input_tokens: 60000, cache_creation_input_tokens: 4000,
  }});
  assert.equal(r.role, "spec");
  assert.equal(r.freshInput, 8000);
  assert.equal(r.cacheRead, 60000);
  assert.equal(r.cacheCreation, 4000);
  assert.equal(r.resumedContext, 64000);          // cache_read + cache_creation
  assert.equal(r.output, 3000);
  assert.equal(r.costWeightedInput, 8000 * 1 + 4000 * W + 60000 * 0.1); // = 8000+5000+6000 = 19000
  assert.equal(r.usagePartial, false);
});

test("recordTurn is TOTAL over undefined usage -- never throws, flags partial", () => {
  const r = recordTurn({ role: "coder", usage: undefined });
  assert.equal(r.usagePartial, true);
  assert.equal(r.freshInput, 0);
  assert.equal(r.resumedContext, 0);
  assert.equal(r.output, 0);
  assert.equal(r.costWeightedInput, 0);
});

test("recordTurn is TOTAL over missing individual fields", () => {
  const r = recordTurn({ role: "coder", usage: { input_tokens: 500 } }); // others absent
  assert.equal(r.freshInput, 500);
  assert.equal(r.cacheRead, 0);
  assert.equal(r.cacheCreation, 0);
  assert.equal(r.resumedContext, 0);
  assert.equal(r.output, 0);
  assert.equal(r.usagePartial, true); // any absent field marks partial
});

test("foldTurn accumulates a rolling aggregate keyed by role, no array kept", () => {
  let agg;
  agg = foldTurn(agg, recordTurn({ role: "spec", usage: { input_tokens: 100, output_tokens: 10 } }));
  agg = foldTurn(agg, recordTurn({ role: "spec", usage: { input_tokens: 200, output_tokens: 20 } }));
  agg = foldTurn(agg, recordTurn({ role: "coder", usage: { input_tokens: 50, output_tokens: 5 } }));
  assert.equal(agg.turnCount, 3);
  assert.equal(agg.perRole.spec.freshInput, 300);
  assert.equal(agg.perRole.spec.output, 30);
  assert.equal(agg.perRole.spec.turns, 2);
  assert.equal(agg.perRole.coder.freshInput, 50);
  assert.equal(agg.totals.freshInput, 350);
  assert.equal(agg.totals.output, 35);
  assert.ok(!("turns" in agg) || Array.isArray(agg.turns) === false); // NO unbounded array
});

test("summarize derives perCategory + totals; formatters are numbers-only strings", () => {
  let agg;
  agg = foldTurn(agg, recordTurn({ role: "spec", usage: {
    input_tokens: 8000, output_tokens: 3000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 4000 } }));
  const s = summarize(agg);
  assert.equal(s.totals.freshInput, 8000);
  assert.equal(s.perCategory.resumedContext, 64000);
  const line = formatSummaryLine(s);
  assert.equal(typeof line, "string");
  assert.match(line, /fresh/);
  assert.doesNotMatch(line, /session|prompt|\//); // numbers-only: no session id / prompt / path
  const tally = formatTally(s);
  assert.match(tally, /spec/); // per-role role NAMES are fine (not secrets); still no session/prompt/path
  assert.doesNotMatch(tally, /session_id|resume/);
});
