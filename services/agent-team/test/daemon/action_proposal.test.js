import test from "node:test";
import assert from "node:assert/strict";
import { parseProposal } from "../../src/daemon/action_proposal.mjs";

test("parses a trailing DISPATCH line and strips it from prose", () => {
  const t = "We should fix the retry bug.\nDISPATCH concord :: fix the retry off-by-one in foo.js";
  const r = parseProposal(t);
  assert.deepEqual(r.proposal, { alias: "concord", task: "fix the retry off-by-one in foo.js" });
  assert.equal(r.prose, "We should fix the retry bug.");
});
test("task prose may contain braces and quotes (not JSON)", () => {
  const r = parseProposal('DISPATCH repo-1 :: rename `f()` to g and update {a,b}');
  assert.deepEqual(r.proposal, { alias: "repo-1", task: "rename `f()` to g and update {a,b}" });
  assert.equal(r.prose, "");
});
test("no directive -> null proposal, prose unchanged", () => {
  const r = parseProposal("just discussing, no action");
  assert.equal(r.proposal, null);
  assert.equal(r.prose, "just discussing, no action");
});
test("no-ops on system notices and malformed directives", () => {
  for (const s of ["(session reset)", "(reviewer error: boom)", "(busy -- try again shortly)", "DISPATCH concord fix it", "DISPATCH :: no alias"]) {
    assert.equal(parseProposal(s).proposal, null, s);
    assert.equal(parseProposal(s).prose, s, s);
  }
});
