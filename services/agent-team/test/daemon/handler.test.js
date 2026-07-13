import test from "node:test";
import assert from "node:assert/strict";
import { makeHandler } from "../../src/daemon/handler.mjs";

const cfg = { guildId: "g", channelId: "c", userIds: ["u"], repos: { chem: "/abs/chem" }, credsDir: "/creds", base: "dev" };
function ctx(overrides = {}) {
  const submitted = [], replies = [];
  const deps = {
    queue: { submit: (job) => { submitted.push(job); return overrides.full ? false : true; } },
    mintId: () => "ab12",
    reply: (msg, text) => replies.push(text),
  };
  return { deps, submitted, replies };
}
const authoredMsg = (content) => ({ author: { id: "u", bot: false }, channelId: "c", guildId: "g", content });

test("authorized message -> submit once + ack", async () => {
  const { deps, submitted, replies } = ctx();
  await makeHandler({ cfg, deps })(authoredMsg("chem: fix x"));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].jobId, "ab12");
  assert.match(replies[0], /queued #ab12/);
});
test("unauthorized -> no submit, no reply", async () => {
  const { deps, submitted, replies } = ctx();
  await makeHandler({ cfg, deps })({ ...authoredMsg("chem: x"), author: { id: "intruder", bot: false } });
  assert.equal(submitted.length, 0);
  assert.equal(replies.length, 0);
});
test("bad alias -> reply error, no submit", async () => {
  const { deps, submitted, replies } = ctx();
  await makeHandler({ cfg, deps })(authoredMsg("nope: x"));
  assert.equal(submitted.length, 0);
  assert.match(replies[0], /unknown alias/);
});
test("bot author -> ignored", async () => {
  const { deps, submitted } = ctx();
  await makeHandler({ cfg, deps })({ ...authoredMsg("chem: x"), author: { id: "u", bot: true } });
  assert.equal(submitted.length, 0);
});
test("queue full -> queue-full reply", async () => {
  const { deps, replies } = ctx({ full: true });
  await makeHandler({ cfg, deps })(authoredMsg("chem: x"));
  assert.match(replies[0], /queue full/);
});
