import test from "node:test";
import assert from "node:assert/strict";
import { loadStore, saveThread } from "../../src/daemon/session_store.mjs";

test("loadStore: missing/unparseable -> empty map, no throw", () => {
  const miss = loadStore("/x", { readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
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
test("loadStore: non-ENOENT read error -> empty map, logged", () => {
  const calls = [];
  const orig = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const err = new Error("permission denied");
    err.code = "EACCES";
    const m = loadStore("/x", { readFileSync: () => { throw err; } });
    assert.equal(m.size, 0);
    assert.equal(calls.length, 1);
  } finally {
    console.error = orig;
  }
});
test("loadStore: ENOENT read error -> empty map, not logged", () => {
  const calls = [];
  const orig = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const err = new Error("no such file or directory");
    err.code = "ENOENT";
    const m = loadStore("/x", { readFileSync: () => { throw err; } });
    assert.equal(m.size, 0);
    assert.equal(calls.length, 0);
  } finally {
    console.error = orig;
  }
});
test("loadStore: drops an entry whose roleSessions is an array", () => {
  const json = JSON.stringify({ t1: { roleSessions: ["spec", "s1"] } });
  const m = loadStore("/x", { readFileSync: () => json });
  assert.equal(m.has("t1"), false);
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
