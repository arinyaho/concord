import test from "node:test";
import assert from "node:assert/strict";
import { selectRound } from "../../src/daemon/select_round.mjs";

const roster = [{ name: "spec" }, { name: "reviewer" }];
test("returns all roster role names in config order", () => {
  assert.deepEqual(selectRound("anything", roster, 10), ["spec", "reviewer"]);
});
test("caps at maxRoundLen", () => {
  assert.deepEqual(selectRound("x", roster, 1), ["spec"]);
});
