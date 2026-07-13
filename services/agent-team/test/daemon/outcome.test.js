import test from "node:test";
import assert from "node:assert/strict";
import { replyForOutcome, isAuthExpiry } from "../../src/daemon/outcome.mjs";

const job = { jobId: "ab12", msg: {} };
function deps(extra = {}) {
  const replies = [];
  return { replies, base: { reply: (m, t) => replies.push(t), diagnose: async () => "root cause X", model: "m", ...extra } };
}

test("done -> success reply with branch", async () => {
  const { replies, base } = deps();
  await replyForOutcome(job, { kind: "done", code: 0, tail: "" }, base);
  assert.match(replies[0], /agent-team\/ab12/);
});
test("timeout -> timeout reply", async () => {
  const { replies, base } = deps();
  await replyForOutcome(job, { kind: "timeout", code: 124, tail: "" }, base);
  assert.match(replies[0], /timed out #ab12/);
});
test("auth-expiry failure -> distinct creds-expired reply, no diagnose", async () => {
  let called = false;
  const { replies, base } = deps({ diagnose: async () => { called = true; return "x"; } });
  await replyForOutcome(job, { kind: "failed", code: 1, tail: "OAuth token expired" }, base);
  assert.match(replies[0], /credentials expired/);
  assert.equal(called, false);
});
test("generic failure -> analysis + tail", async () => {
  const { replies, base } = deps();
  await replyForOutcome(job, { kind: "failed", code: 1, tail: "boom" }, base);
  assert.match(replies[0], /root cause X/);
});
test("isAuthExpiry matches known token-expiry strings", () => {
  assert.equal(isAuthExpiry("... OAuth token expired ..."), true);
  assert.equal(isAuthExpiry("unrelated error"), false);
});
