import test from "node:test";
import assert from "node:assert/strict";
import { makeInlinePosters } from "../../src/daemon/inline_post.mjs";

function ctx() {
  const sent = [];
  const fetchChannel = async (id) => ({ id, send: async (payload) => sent.push([id, payload]) });
  const { rawPost, postSystem } = makeInlinePosters({ fetchChannel });
  return { rawPost, postSystem, sent };
}

test("rawPost sends a **role:** label with mentions inert", async () => {
  const { rawPost, sent } = ctx();
  await rawPost("T", "spec", "hello");
  assert.equal(sent[0][0], "T");
  assert.equal(sent[0][1].content, "**spec:** hello");
  assert.deepEqual(sent[0][1].allowedMentions, { parse: [] });
});

test("postSystem sends plain text with mentions inert", async () => {
  const { postSystem, sent } = ctx();
  await postSystem("T", "job started (abc)");
  assert.equal(sent[0][0], "T");
  assert.equal(sent[0][1].content, "job started (abc)");
  assert.deepEqual(sent[0][1].allowedMentions, { parse: [] });
});

test("both clamp content to 2000 chars", async () => {
  const { rawPost, postSystem, sent } = ctx();
  await rawPost("T", "spec", "x".repeat(5000));
  await postSystem("T", "y".repeat(5000));
  assert.equal(sent[0][1].content.length, 2000);
  assert.equal(sent[1][1].content.length, 2000);
});
