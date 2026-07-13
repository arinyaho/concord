import test from "node:test";
import assert from "node:assert/strict";
import { refreshCredsOnce } from "../../src/daemon/creds_refresh.mjs";

test("copies ONLY .credentials.json, staging the temp OUTSIDE credsDir, then renames in", () => {
  const calls = [];
  const deps = {
    copyFile: (src, dst) => calls.push(["copy", src, dst]),
    rename: (src, dst) => calls.push(["rename", src, dst]),
  };
  refreshCredsOnce({ srcFile: "/home/.claude/.credentials.json", destDir: "/home/creds" }, deps);
  // Temp lives in the PARENT dir (same filesystem -> rename stays atomic) so credsDir never
  // holds a second entry that would trip the launcher's sole-entry assertCredsDir.
  assert.deepEqual(calls, [
    ["copy", "/home/.claude/.credentials.json", "/home/.credentials.json.tmp"],
    ["rename", "/home/.credentials.json.tmp", "/home/creds/.credentials.json"],
  ]);
});
