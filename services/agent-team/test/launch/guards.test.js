import test from "node:test";
import assert from "node:assert/strict";
import { assertNoApiKey, assertCredsDir, resolveRuntime } from "../../src/launch/guards.mjs";

test("assertNoApiKey throws when ANTHROPIC_API_KEY set", () => {
  assert.throws(() => assertNoApiKey({ ANTHROPIC_API_KEY: "sk-x" }), /ANTHROPIC_API_KEY/);
});
test("assertNoApiKey passes when absent or empty", () => {
  assert.doesNotThrow(() => assertNoApiKey({}));
  assert.doesNotThrow(() => assertNoApiKey({ ANTHROPIC_API_KEY: "" }));
});

test("assertCredsDir accepts only .credentials.json alone", () => {
  assert.doesNotThrow(() => assertCredsDir("/d", () => [".credentials.json"]));
});
test("assertCredsDir rejects a planted sibling (settings.json)", () => {
  assert.throws(() => assertCredsDir("/d", () => [".credentials.json", "settings.json"]), /only .credentials.json/);
});
test("assertCredsDir rejects an empty/missing creds dir", () => {
  assert.throws(() => assertCredsDir("/d", () => []), /only .credentials.json/);
});

test("resolveRuntime defaults to docker when present", () => {
  assert.equal(resolveRuntime({}, (b) => b === "docker"), "docker");
});
test("resolveRuntime honors AGENT_TEAM_RUNTIME", () => {
  assert.equal(resolveRuntime({ AGENT_TEAM_RUNTIME: "podman" }, () => true), "podman");
});
test("resolveRuntime throws when the binary is absent", () => {
  assert.throws(() => resolveRuntime({}, () => false), /not found/);
});
