import assert from "node:assert/strict";
import { makeWebhookPost } from "../src/daemon/webhook_post.mjs";

// A fake webhook + resolver: no discord client, no network.
const sent = [];
const fell = [];
const wh = { send: async (p) => sent.push(p) };
const post = makeWebhookPost({
  resolveWebhook: async () => wh,
  roleAvatars: { spec: "https://x/s.png" },
  fallbackPost: async (t, r, x) => fell.push([t, r, x]),
});

// A real persona routes through the webhook with an inert-mention payload + configured avatar.
await post("T", "spec", "let's design it");
assert.equal(sent.length, 1, "spec post should hit the webhook");
assert.equal(sent[0].username, "spec");
assert.equal(sent[0].avatarURL, "https://x/s.png");
assert.deepEqual(sent[0].allowedMentions, { parse: [] });

// The reserved 'system' pseudo-role must NOT touch the webhook.
await post("T", "system", "(busy -- try again shortly)");
assert.equal(sent.length, 1, "system post must not hit the webhook");
assert.deepEqual(fell.at(-1), ["T", "system", "(busy -- try again shortly)"]);

console.log("WEBHOOK AVATARS CONTRACT OK");
