import test from "node:test";
import assert from "node:assert/strict";
import { CONVERSATION_ROSTER } from "../../src/daemon/conversation_roster.mjs";

test("ordered spec then reviewer, each with a non-empty system prompt mentioning SKIP", () => {
  assert.deepEqual(CONVERSATION_ROSTER.map((r) => r.name), ["spec", "reviewer"]);
  for (const r of CONVERSATION_ROSTER) {
    assert.ok(r.systemPrompt.length > 0);
    assert.match(r.systemPrompt, /SKIP/);
  }
});
