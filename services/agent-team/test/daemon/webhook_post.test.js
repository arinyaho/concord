import test from "node:test";
import assert from "node:assert/strict";
import { makeWebhookPost } from "../../src/daemon/webhook_post.mjs";

function ctx({ resolveWebhook, roleAvatars = {} } = {}) {
  const sent = [];   // webhook payloads
  const fell = [];   // fallback calls [threadId, role, text]
  const wh = { send: async (p) => sent.push(p) };
  const post = makeWebhookPost({
    resolveWebhook: resolveWebhook ?? (async () => wh),
    roleAvatars,
    fallbackPost: async (t, r, x) => fell.push([t, r, x]),
  });
  return { post, sent, fell, wh };
}

test("role prose posts through the webhook: username=role, mentions inert", async () => {
  const { post, sent, fell } = ctx();
  await post("T", "spec", "hello");
  assert.equal(fell.length, 0);
  assert.equal(sent[0].threadId, "T");
  assert.equal(sent[0].username, "spec");
  assert.equal(sent[0].content, "hello");
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal("avatarURL" in sent[0], false); // none configured
});

test("uses the configured avatar when present", async () => {
  const { post, sent } = ctx({ roleAvatars: { reviewer: "https://x/r.png" } });
  await post("T", "reviewer", "hi");
  assert.equal(sent[0].avatarURL, "https://x/r.png");
});

test("the reserved 'system' pseudo-role is never webhook-voiced (contract 2b)", async () => {
  let resolved = false;
  const { post, sent, fell } = ctx({ resolveWebhook: async () => { resolved = true; return { send: async () => {} }; } });
  await post("T", "system", "(busy)");
  assert.equal(resolved, false);        // resolveWebhook not even called
  assert.equal(sent.length, 0);
  assert.deepEqual(fell[0], ["T", "system", "(busy)"]);
});

test("null resolve => inline fallback, webhook not sent", async () => {
  const { post, sent, fell } = ctx({ resolveWebhook: async () => null });
  await post("T", "spec", "hey");
  assert.equal(sent.length, 0);
  assert.deepEqual(fell[0], ["T", "spec", "hey"]);
});

test("send throw => inline fallback for that post", async () => {
  const wh = { send: async () => { throw new Error("boom"); } };
  const { post, fell } = ctx({ resolveWebhook: async () => wh });
  await post("T", "spec", "hey");
  assert.deepEqual(fell[0], ["T", "spec", "hey"]);
});

test("resolve throw => inline fallback (whole-body catch)", async () => {
  const { post, fell } = ctx({ resolveWebhook: async () => { throw new Error("fetch failed"); } });
  await post("T", "reviewer", "hey");
  assert.deepEqual(fell[0], ["T", "reviewer", "hey"]);
});

test("content is clamped to 2000 chars", async () => {
  const { post, sent } = ctx();
  await post("T", "spec", "x".repeat(5000));
  assert.equal(sent[0].content.length, 2000);
});
