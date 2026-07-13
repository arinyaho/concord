import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../../src/daemon/diagnose.mjs";

test("pins allowedTools:[] and settingSources:[] on the query options", async () => {
  let seen = null;
  async function* fakeQuery({ options }) { seen = options; yield { type: "result", result: "DNS failure -- check the host" }; }
  const out = await diagnose("getaddrinfo ENOTFOUND", { query: fakeQuery, model: "claude-sonnet-5" });
  assert.deepEqual(seen.allowedTools, []);
  assert.deepEqual(seen.settingSources, []);
  assert.equal(seen.model, "claude-sonnet-5");
  assert.match(out, /DNS/);
});
test("fail-open: returns null when query throws", async () => {
  async function* boom() { throw new Error("network"); }
  assert.equal(await diagnose("x", { query: boom, model: "m" }), null);
});
