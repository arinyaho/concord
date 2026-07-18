import assert from "node:assert/strict";
import test from "node:test";
import { makeProgressRelay } from "../../src/daemon/progress_relay.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeSender() {
  const sends = [];
  const edits = [];
  const sent = deferred();
  const message = {
    edit: async (payload) => { edits.push(payload); },
  };
  return {
    sends,
    edits,
    message,
    send: async (payload) => {
      sends.push(payload);
      return sent.promise;
    },
    resolveSend: () => sent.resolve(message),
  };
}

const phases = (items) => items.join("\n");
const safe = { allowedMentions: { parse: [] } };

test("start sends cloning, then new known phases extend one timeline after the send", async () => {
  const fake = fakeSender();
  const relay = makeProgressRelay({ send: fake.send });

  relay.start();
  relay.progress({ type: "progress", phase: "coding" });
  await Promise.resolve();
  assert.deepEqual(fake.sends, [{ content: phases(["cloning"]), ...safe }]);
  assert.deepEqual(fake.edits, []);

  fake.resolveSend();
  await relay.progress({ type: "progress", phase: "reviewing" });

  assert.deepEqual(fake.edits, [
    { content: phases(["cloning", "coding"]), ...safe },
    { content: phases(["cloning", "coding", "reviewing"]), ...safe },
  ]);
});

test("deduplicates phases and ignores unknown progress", async () => {
  const fake = fakeSender();
  const relay = makeProgressRelay({ send: fake.send });

  relay.start();
  fake.resolveSend();
  await relay.progress({ type: "progress", phase: "coding" });
  await relay.progress({ type: "progress", phase: "coding" });
  await relay.progress({ type: "progress", phase: "waiting" });

  assert.deepEqual(fake.edits, [{ content: phases(["cloning", "coding"]), ...safe }]);
});

test("terminal appends its exact known outcome once and ignores late progress and terminal calls", async () => {
  const fake = fakeSender();
  const relay = makeProgressRelay({ send: fake.send });

  relay.start();
  fake.resolveSend();
  await relay.terminal({ kind: "failed" });
  await relay.progress({ type: "progress", phase: "coding" });
  await relay.terminal({ kind: "done" });

  assert.deepEqual(fake.edits, [{ content: phases(["cloning", "failed"]), ...safe }]);
});

test("contains send and edit failures", async () => {
  const sendFailure = makeProgressRelay({ send: async () => { throw new Error("send failed"); } });
  await assert.doesNotReject(sendFailure.start());
  await assert.doesNotReject(sendFailure.progress({ type: "progress", phase: "coding" }));
  await assert.doesNotReject(sendFailure.terminal({ kind: "failed" }));

  const edits = [];
  const relay = makeProgressRelay({
    send: async () => ({ edit: async (payload) => { edits.push(payload); throw new Error("edit failed"); } }),
  });

  await relay.start();
  await assert.doesNotReject(relay.progress({ type: "progress", phase: "coding" }));
  await assert.doesNotReject(relay.terminal({ kind: "done" }));
  assert.equal(edits.length, 2);
});

test("terminal deadline abandons queued writes without making concurrent edits", async () => {
  const firstEdit = deferred();
  const sends = [];
  const edits = [];
  let active = 0;
  let peak = 0;
  const relay = makeProgressRelay({
    deadlineMs: 5,
    send: async (payload) => {
      sends.push(payload);
      return {
        edit: async (edit) => {
          edits.push(edit);
          active += 1;
          peak = Math.max(peak, active);
          if (edits.length === 1) await firstEdit.promise;
          active -= 1;
        },
      };
    },
  });

  await relay.start();
  relay.progress({ type: "progress", phase: "coding" });
  await relay.terminal({ kind: "timeout" });
  assert.equal(edits.length, 1);

  firstEdit.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 1);
  assert.deepEqual(edits, [{ content: phases(["cloning", "coding"]), ...safe }]);
  await relay.progress({ type: "progress", phase: "reviewing" });
  assert.equal(edits.length, 1);
});
