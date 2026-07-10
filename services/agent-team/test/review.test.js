import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/review.mjs";

test("parses a clean approved verdict", () => {
  const r = parseReview('{"approved": true, "findings": []}');
  assert.equal(r.approved, true);
  assert.deepEqual(r.findings, []);
});

test("parses findings with surrounding prose", () => {
  const r = parseReview('Here is my review:\n{"approved": false, "findings": ["no algorithm named", "no state location"]}\nThanks.');
  assert.equal(r.approved, false);
  assert.deepEqual(r.findings, ["no algorithm named", "no state location"]);
});

test("fails closed on non-JSON (never reports approved)", () => {
  const r = parseReview("looks good to me!");
  assert.equal(r.approved, false);
  assert.equal(r.findings.length, 1);
});

test("fails closed on malformed JSON", () => {
  const r = parseReview('{"approved": true, "findings": [oops}');
  assert.equal(r.approved, false);
  assert.equal(r.findings.length, 1);
});

test("coerces a non-array findings field to empty array", () => {
  const r = parseReview('{"approved": false, "findings": "nope"}');
  assert.equal(r.approved, false);
  assert.deepEqual(r.findings, []);
});
