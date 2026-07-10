import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunCli } from "../src/adapters/review_cli.mjs";

test("parses JSON stdout on exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const stub = join(dir, "stub.js");
  writeFileSync(stub, `console.log(JSON.stringify({ ok: true, verb: process.argv[2] }));`);
  const runCli = makeRunCli({ repoRoot: dir, stateDir: dir, cliPath: stub });
  const r = await runCli("round-start", ["b", "main"]);
  assert.deepEqual(r, { ok: true, verb: "round-start" });
  rmSync(dir, { recursive: true, force: true });
});

test("non-zero exit maps to harnessFailure (never a parsed decision)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const stub = join(dir, "stub.js");
  writeFileSync(stub, `process.stderr.write("harness-failure: boom\\n"); process.exit(1);`);
  const runCli = makeRunCli({ repoRoot: dir, stateDir: dir, cliPath: stub });
  const r = await runCli("record", ["b"]);
  assert.equal(r.harnessFailure, true);
  rmSync(dir, { recursive: true, force: true });
});
