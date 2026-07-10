import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDodCommand, buildCoderPrompt } from "../src/coder.mjs";
import { ROLES } from "../src/roster.mjs";

test("readDodCommand returns the first dod command from review.config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "coder-"));
  writeFileSync(join(dir, "review.config.json"), JSON.stringify({ dod: ["node --test", "echo x"] }));
  assert.equal(readDodCommand(dir), "node --test");
  rmSync(dir, { recursive: true, force: true });
});

test("readDodCommand throws (fail-closed) when config is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "coder-"));
  assert.throws(() => readDodCommand(dir), /review\.config\.json/);
  rmSync(dir, { recursive: true, force: true });
});

test("readDodCommand throws when dod is empty or malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "coder-"));
  writeFileSync(join(dir, "review.config.json"), JSON.stringify({ dod: [] }));
  assert.throws(() => readDodCommand(dir), /dod/);
  rmSync(dir, { recursive: true, force: true });
});

test("buildCoderPrompt carries the task, the exact DoD command, and the branch", () => {
  const p = buildCoderPrompt("add an add() function", "node --test", "agent-team/coder-1");
  assert.match(p, /add an add\(\) function/);
  assert.match(p, /node --test/);
  assert.match(p, /agent-team\/coder-1/);
});

test("roster exposes a coder entry", () => {
  assert.equal(ROLES.coder.name, "coder");
  assert.ok(ROLES.coder.systemPrompt.length > 0);
});
