import test from "node:test";
import assert from "node:assert/strict";
import { makeWebhookResolver } from "../../src/daemon/webhook_cache.mjs";

const MARKER = "agent-team";

// Build a fake world: one parent text channel (id "P") and a thread (id "T", parentId "P").
function world({ existing = [], createThrows = null, cap = false } = {}) {
  const created = [];
  let fetched = 0;
  const parent = {
    id: "P",
    async fetchWebhooks() {
      fetched++;
      return { find: (fn) => existing.find(fn) };
    },
    async createWebhook({ name }) {
      if (createThrows) throw createThrows;
      const wh = { name, owner: { id: "BOT" }, send: async () => {} };
      created.push(wh);
      return wh;
    },
  };
  const thread = { id: "T", parentId: "P", parent };
  const channels = { P: parent, T: thread };
  const fetchChannel = async (id) => channels[id];
  return { parent, thread, created, fetchChannel, get fetched() { return fetched; } };
}

test("creates a marker webhook when none exists, keyed by parent id", async () => {
  const w = world();
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  const wh = await resolve("T");
  assert.equal(wh.name, MARKER);
  assert.equal(w.created.length, 1);
});

test("reuses an existing marker webhook owned by us (no create)", async () => {
  const existing = [{ name: MARKER, owner: { id: "BOT" }, send: async () => {} }];
  const w = world({ existing });
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  const wh = await resolve("T");
  assert.equal(wh, existing[0]);
  assert.equal(w.created.length, 0);
});

test("ignores a same-named webhook owned by another user; creates ours", async () => {
  const existing = [{ name: MARKER, owner: { id: "SOMEONE" }, send: async () => {} }];
  const w = world({ existing });
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  const wh = await resolve("T");
  assert.equal(wh.owner.id, "BOT");
  assert.equal(w.created.length, 1);
});

test("getBotUserId is read at resolve time, not construction (BLOCKER-1 guard)", async () => {
  const existing = [{ name: MARKER, owner: { id: "BOT" }, send: async () => {} }];
  const w = world({ existing });
  let userId; // null at construction, populated before the first resolve
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => userId, markerName: MARKER });
  userId = "BOT"; // simulate client.user populating after ready
  const wh = await resolve("T");
  assert.equal(wh, existing[0]); // reuse-probe matched => id was read late
});

test("caches the second call (no second fetchWebhooks) on success", async () => {
  const w = world();
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  await resolve("T");
  await resolve("T");
  assert.equal(w.fetched, 1); // second resolve served from cache
});

test("permanent error (code 50013) caches the null sentinel and never retries", async () => {
  const err = Object.assign(new Error("Missing Permissions"), { code: 50013 });
  const w = world({ createThrows: err });
  // no existing webhook => it will try create => throw permanent
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  assert.equal(await resolve("T"), null);
  assert.equal(await resolve("T"), null);
  assert.equal(w.fetched, 1); // sticky: second resolve did NOT re-fetch
});

test("transient error does NOT cache; the next resolve re-probes and can succeed", async () => {
  let firstCall = true;
  const parent = {
    id: "P",
    async fetchWebhooks() {
      if (firstCall) { firstCall = false; throw Object.assign(new Error("503"), { code: 0 }); }
      return { find: () => undefined };
    },
    async createWebhook({ name }) { return { name, owner: { id: "BOT" }, send: async () => {} }; },
  };
  const thread = { id: "T", parentId: "P", parent };
  const fetchChannel = async (id) => ({ P: parent, T: thread }[id]);
  const resolve = makeWebhookResolver({ fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  assert.equal(await resolve("T"), null); // transient failure => inline this post
  const wh = await resolve("T"); // re-probe
  assert.equal(wh.name, MARKER); // succeeded on retry
});

test("coalesces two concurrent first calls into a single createWebhook", async () => {
  const w = world();
  const resolve = makeWebhookResolver({ fetchChannel: w.fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  const [a, b] = await Promise.all([resolve("T"), resolve("T")]);
  assert.equal(a, b);
  assert.equal(w.created.length, 1); // exactly one webhook despite the race
});

test("resolves the parent object via fetchChannel when thread.parent is uncached", async () => {
  const parent = {
    id: "P",
    async fetchWebhooks() { return { find: () => undefined }; },
    async createWebhook({ name }) { return { name, owner: { id: "BOT" }, send: async () => {} }; },
  };
  const thread = { id: "T", parentId: "P", parent: null }; // cache miss: .parent is null
  const fetchChannel = async (id) => ({ P: parent, T: thread }[id]);
  const resolve = makeWebhookResolver({ fetchChannel, getBotUserId: () => "BOT", markerName: MARKER });
  const wh = await resolve("T");
  assert.equal(wh.name, MARKER); // reached parent via fetchChannel("P"), not the ThreadChannel
});
