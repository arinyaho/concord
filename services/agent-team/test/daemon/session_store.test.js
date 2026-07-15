import test from "node:test";
import assert from "node:assert/strict";
import { loadStore, saveThread } from "../../src/daemon/session_store.mjs";

test("loadStore: missing/unparseable -> empty map, no throw", () => {
  const miss = loadStore("/x", { readFileSync: () => { throw new Error("ENOENT"); } });
  assert.equal(miss.size, 0);
  const bad = loadStore("/x", { readFileSync: () => "not json" });
  assert.equal(bad.size, 0);
});
test("loadStore: drops a malformed entry, keeps valid ones", () => {
  const json = JSON.stringify({ t1: { roleSessions: { spec: "s1" } }, t2: { bogus: 1 } });
  const m = loadStore("/x", { readFileSync: () => json });
  assert.deepEqual(m.get("t1"), { roleSessions: { spec: "s1" } });
  assert.equal(m.has("t2"), false);
});
test("saveThread: mutates map + atomic temp-then-rename with mode 0600", () => {
  const calls = [];
  const m = new Map();
  saveThread(m, "/dir/store.json", "t9", { roleSessions: { spec: "s9" } }, {
    writeFileSync: (p, data, opts) => calls.push(["write", p, JSON.parse(data), opts]),
    renameSync: (a, b) => calls.push(["rename", a, b]),
  });
  assert.deepEqual(m.get("t9"), { roleSessions: { spec: "s9" } });
  assert.equal(calls[0][0], "write");
  assert.equal(calls[0][1], "/dir/store.json.tmp");
  assert.deepEqual(calls[0][2], { t9: { roleSessions: { spec: "s9" } } });
  assert.deepEqual(calls[0][3], { mode: 0o600 });
  assert.deepEqual(calls[1], ["rename", "/dir/store.json.tmp", "/dir/store.json"]);
});
