import assert from "node:assert/strict";
import { makeHandler } from "../src/daemon/handler.mjs";
import { createQueue } from "../src/daemon/queue.mjs";
import { replyForOutcome } from "../src/daemon/outcome.mjs";

const cfg = { guildId: "g", channelId: "c", userIds: ["u"], repos: { chem: "/abs/chem" }, credsDir: "/creds", base: "dev" };
const replies = [];
const queue = createQueue({
  cap: 1, queueMax: 5, jobTimeoutMs: 1000,
  runJob: async () => ({ code: 0, tail: "" }),
  dockerKill() {},
  onOutcome: (job, o) => replyForOutcome(job, o, { reply: (m, t) => replies.push(t), diagnose: async () => "x", model: "m" }),
});
const handle = makeHandler({ cfg, deps: { queue, mintId: () => "ab12", reply: (m, t) => replies.push(t) } });
await handle({ author: { id: "u", bot: false }, channelId: "c", guildId: "g", content: "chem: fix x", reply: (t) => replies.push(t) });
await new Promise((r) => setTimeout(r, 20));
assert.ok(replies.some((r) => /queued #ab12/.test(r)), "ack missing");
assert.ok(replies.some((r) => /agent-team\/ab12/.test(r)), "success reply missing");
console.log("CONTRACT OK");
