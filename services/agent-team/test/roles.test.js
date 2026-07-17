import { test } from "node:test";
import assert from "node:assert/strict";
import { runRole } from "../src/daemon/roles.mjs";

const role = { name: "spec", systemPrompt: "You are spec." };

// A fake query() that yields an init message then a result message carrying usage.
function fakeQuery({ sessionId = "s1", text = "hello", usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) {
  return async function* () {
    yield { type: "system", subtype: "init", session_id: sessionId };
    yield { type: "result", result: text, usage };
  };
}
// query() shape used by runRole is query({prompt, options}) -> async iterable
const mkQuery = (spec) => ({ prompt, options }) => fakeQuery(spec)();

test("runRole returns the result message usage (was dropped before)", async () => {
  const q = mkQuery({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } });
  const r = await runRole(role, "hi", [], null, undefined, { query: q });
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
  assert.equal(r.text, "hello");
});

test("runRole on a bad resume that throws returns the RETRY's usage only (no phantom sum)", async () => {
  let calls = 0;
  const q = ({ prompt, options }) => {
    calls += 1;
    if (options.resume) { // first call: bad resume -> throw like the SDK does
      return (async function* () { throw new Error("--resume requires a valid session Id"); })();
    }
    return fakeQuery({ sessionId: "fresh", text: "retry", usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })();
  };
  const r = await runRole(role, "hi", [], "stale-id", undefined, { query: q });
  assert.equal(calls, 2);          // resume attempt threw, then a fresh retry
  assert.equal(r.reset, true);
  assert.equal(r.usage.input_tokens, 7); // ONLY the retry's usage; nothing summed from the throw
});
