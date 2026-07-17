import test from "node:test";
import assert from "node:assert/strict";
import { setPending, getPending, clearPending } from "../../src/daemon/pending_action.mjs";
import { loadStore } from "../../src/daemon/session_store.mjs";

function fakeDeps(calls) {
  return { writeFileSync: (p, d) => calls.push(["write", p, JSON.parse(d)]), renameSync: (a, b) => calls.push(["rename", a, b]) };
}
const P = { id: "a1", alias: "concord", repoPath: "/r", task: "fix it" };

test("setPending stores the field and persists via its own saveThread", () => {
  const store = new Map([["t1", { roleSessions: { spec: "s" } }]]);
  const calls = [];
  setPending(store, "/dir/store.json", "t1", P, fakeDeps(calls));
  assert.deepEqual(store.get("t1").pendingAction, P);
  assert.deepEqual(store.get("t1").roleSessions, { spec: "s" }); // roleSessions preserved
  assert.equal(calls[0][0], "write"); // persisted, not memory-only
  assert.deepEqual(calls.at(-1), ["rename", "/dir/store.json.tmp", "/dir/store.json"]);
});
test("setPending on a thread with no prior state creates it", () => {
  const store = new Map();
  setPending(store, "/s.json", "tX", P, fakeDeps([]));
  assert.deepEqual(store.get("tX"), { roleSessions: {}, pendingAction: P });
});
test("last-wins overwrite", () => {
  const store = new Map();
  setPending(store, "/s.json", "t1", P, fakeDeps([]));
  const P2 = { ...P, id: "b2", task: "other" };
  setPending(store, "/s.json", "t1", P2, fakeDeps([]));
  assert.deepEqual(getPending(store, "t1"), P2);
});
test("getPending reads, clearPending removes + persists", () => {
  const store = new Map([["t1", { roleSessions: {}, pendingAction: P }]]);
  assert.deepEqual(getPending(store, "t1"), P);
  const calls = [];
  clearPending(store, "/s.json", "t1", fakeDeps(calls));
  assert.equal(getPending(store, "t1"), null);
  assert.equal(calls[0][0], "write");
});
test("getPending on missing thread/field -> null", () => {
  assert.equal(getPending(new Map(), "none"), null);
  assert.equal(getPending(new Map([["t", { roleSessions: {} }]]), "t"), null);
});

test("pendingAction survives a real save->load round-trip through session_store (not just a write call)", () => {
  const store = new Map([["t1", { roleSessions: { spec: "s" } }]]);
  let written = null;
  const saveDeps = {
    writeFileSync: (p, d) => { written = d; }, // capture the exact JSON saveThread wrote, no fs
    renameSync: () => {},
  };
  setPending(store, "/dir/store.json", "t1", P, saveDeps);
  assert.ok(written, "saveThread wrote something to round-trip");

  // Reload from that exact captured JSON via an injected readFileSync -- proves the field survives
  // the serialize -> parse cycle, not merely that a write happened.
  const loadDeps = { readFileSync: () => written };
  const reloaded = loadStore("/dir/store.json", loadDeps);
  assert.deepEqual(getPending(reloaded, "t1"), P);
});
