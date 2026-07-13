import test from "node:test";
import assert from "node:assert/strict";
import { assertLaunchAllowed } from "../../src/launch/interlock.mjs";

test("allowed when contained (AGENT_TEAM_CONTAINED=1)", () => {
  assert.doesNotThrow(() => assertLaunchAllowed({ env: { AGENT_TEAM_CONTAINED: "1" }, allowUncontained: false }));
});
test("allowed when allowUncontained is true", () => {
  assert.doesNotThrow(() => assertLaunchAllowed({ env: {}, allowUncontained: true }));
});
test("refused when neither contained nor opted in", () => {
  assert.throws(() => assertLaunchAllowed({ env: {}, allowUncontained: false }), /uncontained/i);
});
test("AGENT_TEAM_CONTAINED must be exactly '1' (fail-closed on other values)", () => {
  assert.throws(() => assertLaunchAllowed({ env: { AGENT_TEAM_CONTAINED: "true" }, allowUncontained: false }), /uncontained/i);
  assert.throws(() => assertLaunchAllowed({ env: { AGENT_TEAM_CONTAINED: "0" }, allowUncontained: false }), /uncontained/i);
});
test("does NOT read the opt-in from the environment", () => {
  // An env var must never satisfy the opt-in -- only the explicit param does.
  assert.throws(() => assertLaunchAllowed({ env: { AGENT_TEAM_ALLOW_UNCONTAINED: "1" }, allowUncontained: false }), /uncontained/i);
});
test("defaults: no args -> reads process.env for contained, allowUncontained false", () => {
  const saved = process.env.AGENT_TEAM_CONTAINED;
  delete process.env.AGENT_TEAM_CONTAINED;
  try { assert.throws(() => assertLaunchAllowed(), /uncontained/i); }
  finally { if (saved !== undefined) process.env.AGENT_TEAM_CONTAINED = saved; }
});
test("REMOTE=1 and not contained -> throws even with allowUncontained true", () => {
  assert.throws(
    () => assertLaunchAllowed({ env: { AGENT_TEAM_REMOTE: "1" }, allowUncontained: true }),
    /remote/i
  );
});
test("REMOTE=1 but contained -> allowed (container path unaffected)", () => {
  assert.doesNotThrow(
    () => assertLaunchAllowed({ env: { AGENT_TEAM_REMOTE: "1", AGENT_TEAM_CONTAINED: "1" }, allowUncontained: false })
  );
});
test("REMOTE unset -> prior behavior preserved (opt-in still allowed)", () => {
  assert.doesNotThrow(() => assertLaunchAllowed({ env: {}, allowUncontained: true }));
});
