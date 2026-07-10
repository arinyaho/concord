import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log.mjs";

test("appends one JSON line per event with type and data", () => {
  const dir = mkdtempSync(join(tmpdir(), "at-log-"));
  const path = join(dir, "run.jsonl");
  const log = createLogger(path, () => "T0");
  log.event("round_start", { round: 1 });
  log.event("review", { approved: false, findingCount: 2 });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { t: "T0", type: "round_start", round: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { t: "T0", type: "review", approved: false, findingCount: 2 });
  rmSync(dir, { recursive: true, force: true });
});

test("creates missing parent directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "at-log-"));
  const path = join(dir, "nested", "deep", "run.jsonl");
  const log = createLogger(path, () => "T0");
  log.event("hello", {});
  assert.equal(readFileSync(path, "utf8").trim(), '{"t":"T0","type":"hello"}');
  rmSync(dir, { recursive: true, force: true });
});
