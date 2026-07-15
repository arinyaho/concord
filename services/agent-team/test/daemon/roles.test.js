import test from "node:test";
import assert from "node:assert/strict";
import { runRole } from "../../src/daemon/roles.mjs";

function fakeQuery(text, id = "sess_new") {
  return async function* ({ options }) {
    fakeQuery.lastOptions = options;
    yield { type: "system", subtype: "init", session_id: id };
    yield { type: "result", result: text };
  };
}

test("pins allowedTools:[] + settingSources:[]; resume/model only when provided", async () => {
  const role = { name: "spec", model: "claude-sonnet-5", systemPrompt: "SP" };
  const r = await runRole(role, "hi", [], "sess_prev", undefined, { query: fakeQuery("hello") });
  const o = fakeQuery.lastOptions;
  assert.deepEqual(o.allowedTools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.model, "claude-sonnet-5");
  assert.equal(o.resume, "sess_prev");
  assert.equal(r.text, "hello");
  assert.equal(r.sessionId, "sess_new");
  assert.equal(r.skip, false);
});
test("first turn: no resume, no model when role omits it", async () => {
  const r = await runRole({ name: "reviewer", systemPrompt: "SP" }, "hi", [], undefined, undefined, { query: fakeQuery("ok") });
  assert.equal("resume" in fakeQuery.lastOptions, false);
  assert.equal("model" in fakeQuery.lastOptions, false);
  assert.equal(r.text, "ok");
});
test("skip predicate: leading SKIP token only", async () => {
  const s = await runRole({ name: "spec", systemPrompt: "SP" }, "x", [], undefined, undefined, { query: fakeQuery("SKIP") });
  assert.equal(s.skip, true);
  const s2 = await runRole({ name: "spec", systemPrompt: "SP" }, "x", [], undefined, undefined, { query: fakeQuery("SKIP -- not my area") });
  assert.equal(s2.skip, true);
  assert.equal(s2.text, "-- not my area"); // token stripped, remainder trimmed
  const ns = await runRole({ name: "spec", systemPrompt: "SP" }, "x", [], undefined, undefined, { query: fakeQuery("we should skip the cache") });
  assert.equal(ns.skip, false);
});
test("bad resume THROWS -> retry without resume, reset:true, security wall holds on retry", async () => {
  const seen = [];
  async function* retryingQuery({ options }) {
    seen.push(options);
    if (options.resume) throw new Error("--resume requires a valid session Id");
    yield { type: "system", subtype: "init", session_id: "sess_fresh" };
    yield { type: "result", result: "recovered" };
  }
  const r = await runRole({ name: "spec", systemPrompt: "SP" }, "hi", [], "sess_bad", undefined, { query: retryingQuery });
  assert.equal(r.reset, true);
  assert.equal(r.text, "recovered");
  assert.equal(r.sessionId, "sess_fresh");
  // First call carried resume; retry call dropped it.
  assert.equal(seen[0].resume, "sess_bad");
  assert.equal("resume" in seen[1], false);
  // Load-bearing: the retry-without-resume branch STILL pins the security wall.
  assert.deepEqual(seen[1].allowedTools, []);
  assert.deepEqual(seen[1].settingSources, []);
});
test("silent-fresh guard: resume succeeds but session id differs -> reset:true", async () => {
  const r = await runRole({ name: "spec", systemPrompt: "SP" }, "hi", [], "sess_asked", undefined, { query: fakeQuery("ok", "sess_other") });
  assert.equal(r.reset, true);
  assert.equal(r.sessionId, "sess_other");
});
test("abort during a resume turn is NOT a bad resume -> rethrows without retry (no session reset)", async () => {
  let calls = 0;
  const abortController = new AbortController();
  abortController.abort(); // simulate the per-turn timeout having already fired
  async function* abortingQuery() {
    calls += 1;
    throw new Error("aborted"); // what the SDK throws when the signal fires mid-query
    // eslint-disable-next-line no-unreachable
    yield {};
  }
  await assert.rejects(
    runRole({ name: "spec", systemPrompt: "SP" }, "hi", [], "sess_prev", abortController, { query: abortingQuery }),
    /aborted/,
  );
  assert.equal(calls, 1); // no retry -- bad-resume recovery must not swallow a real timeout/cancel
});
test("bad-resume retry still fires when the signal is NOT aborted (diverges from the abort case above)", async () => {
  let calls = 0;
  const abortController = new AbortController(); // never aborted
  async function* retryingQuery({ options }) {
    calls += 1;
    if (options.resume) throw new Error("--resume requires a valid session Id");
    yield { type: "system", subtype: "init", session_id: "sess_fresh" };
    yield { type: "result", result: "recovered" };
  }
  const r = await runRole({ name: "spec", systemPrompt: "SP" }, "hi", [], "sess_bad", abortController, { query: retryingQuery });
  assert.equal(r.reset, true);
  assert.equal(r.text, "recovered");
  assert.equal(calls, 2); // first call (resume) throws, retry (no resume) succeeds
});
