import test from "node:test";
import assert from "node:assert/strict";
import { advanceTurn } from "../../src/daemon/conversation.mjs";

const roster = [{ name: "spec" }, { name: "reviewer" }];
function ctx(runRoleImpl) {
  const posts = [], persisted = [];
  const state = { roleSessions: {} };
  const deps = {
    threadId: "t1", userText: "design the API", roster, maxRoundLen: 10, state,
    select: (u, r, cap) => r.map((x) => x.name).slice(0, cap),
    runRole: runRoleImpl,
    // Exclude synthetic "system" footer posts so existing assertions remain stable.
    // The footer behavior is covered separately by the token meter tests below.
    post: (tid, role, text) => { if (role !== "system") posts.push([role, text]); },
    persist: (tid, s) => persisted.push(JSON.parse(JSON.stringify(s.roleSessions))),
  };
  return { deps, posts, persisted, state };
}

// NOTE: advanceTurn calls runRole with the role OBJECT (it reads role.systemPrompt/model), so the
// mocks take `role` and use role.name -- NOT a bare string.
test("runs round in order, threads priorOutputs, persists each id, posts labeled", async () => {
  const seen = [];
  const { deps, posts, persisted, state } = ctx(async (role, text, prior, resume) => {
    seen.push([role.name, prior.map((p) => p.role)]);
    return { text: `${role.name} says hi`, sessionId: `sess_${role.name}`, skip: false, reset: false };
  });
  await advanceTurn(deps);
  assert.deepEqual(seen, [["spec", []], ["reviewer", ["spec"]]]); // reviewer sees spec's output
  assert.deepEqual(posts, [["spec", "spec says hi"], ["reviewer", "reviewer says hi"]]);
  assert.deepEqual(state.roleSessions, { spec: "sess_spec", reviewer: "sess_reviewer" });
  assert.equal(persisted.length, 2); // incremental
});
test("skip -> not posted, not threaded; reset -> notice posted", async () => {
  const { deps, posts } = ctx(async (role) =>
    role.name === "spec"
      ? { text: "", sessionId: "s", skip: true, reset: true }
      : { text: "reviewer speaks", sessionId: "r", skip: false, reset: false });
  await advanceTurn(deps);
  assert.deepEqual(posts, [["spec", "(session reset)"], ["reviewer", "reviewer speaks"]]);
});
test("a role throwing posts an error notice and the turn continues", async () => {
  const { deps, posts } = ctx(async (role) => {
    if (role.name === "spec") throw new Error("boom");
    return { text: "reviewer ok", sessionId: "r", skip: false, reset: false };
  });
  await advanceTurn(deps);
  assert.match(posts[0][1], /error/i);
  assert.deepEqual(posts[1], ["reviewer", "reviewer ok"]);
});
test("persist throwing after a role's runRole succeeds does not drop the reply: real text is posted, failure only logged, round continues", async () => {
  const { deps, posts, state } = ctx(async (role) => ({ text: `${role.name} ok`, sessionId: `s_${role.name}`, skip: false, reset: false }));
  let thrown = false;
  deps.persist = async (tid, s) => { if (!thrown) { thrown = true; throw new Error("disk full"); } };
  const origError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args);
  try {
    await advanceTurn(deps);
  } finally {
    console.error = origError;
  }
  // The generated reply is delivered even though the FIRST persist call (spec's) throws --
  // generation succeeded, so the real reply must reach Discord, not a generic error notice.
  assert.deepEqual(posts, [["spec", "spec ok"], ["reviewer", "reviewer ok"]]);
  assert.equal(errorLogs.length, 1); // persist failure is logged, not surfaced as a dropped reply
  // sessionId is still tracked in-memory for the round even though the disk write failed; only
  // durability degrades (resumed from the last successfully-persisted id on restart).
  assert.equal(state.roleSessions.spec, "s_spec");
  assert.equal(state.roleSessions.reviewer, "s_reviewer");
});
test("runRole throwing AND the resulting error-notice post also throwing: turn still continues to the next role", async () => {
  const roleAttempts = [];
  const { deps, posts, state } = ctx(async (role) => {
    roleAttempts.push(role.name);
    if (role.name === "spec") throw new Error("boom");
    return { text: "reviewer ok", sessionId: "r", skip: false, reset: false };
  });
  deps.post = async (tid, role, text) => {
    if (/error/i.test(text)) throw new Error("discord unreachable");
    if (role !== "system") posts.push([role, text]); // exclude synthetic footer
  };
  await advanceTurn(deps);
  // Both roles were attempted: spec's runRole failure did not abort the round even though the
  // error-notice post ALSO threw.
  assert.deepEqual(roleAttempts, ["spec", "reviewer"]);
  // spec's error notice failed silently (no throw escapes advanceTurn); reviewer's real output
  // still made it through.
  assert.deepEqual(posts, [["reviewer", "reviewer ok"]]);
  assert.deepEqual(state.roleSessions, { reviewer: "r" });
});
test("reset-notice post throwing does not drop the real reply: reply is still posted and threaded", async () => {
  const seenPrior = [];
  const { deps, posts, state } = ctx(async (role, text, prior) => {
    if (role.name === "reviewer") seenPrior.push(prior.map((p) => p.role));
    return role.name === "spec"
      ? { text: "spec real reply", sessionId: "s", skip: false, reset: true }
      : { text: "reviewer ok", sessionId: "r", skip: false, reset: false };
  });
  deps.post = async (tid, role, text) => {
    if (role === "spec" && text === "(session reset)") throw new Error("rate limited");
    if (role !== "system") posts.push([role, text]); // exclude synthetic footer
  };
  const origError = console.error;
  console.error = () => {};
  try {
    await advanceTurn(deps);
  } finally {
    console.error = origError;
  }
  // The reset notice failed silently (best-effort via safePost); spec's real reply still made it
  // through and was threaded into priorOutputs (visible via reviewer seeing it, and via posts).
  assert.deepEqual(posts, [["spec", "spec real reply"], ["reviewer", "reviewer ok"]]);
  assert.deepEqual(seenPrior, [["spec"]]); // reviewer saw spec's reply threaded into priorOutputs
  assert.deepEqual(state.roleSessions, { spec: "s", reviewer: "r" }); // round continued normally
});
// --- Token meter tests ---

function meterHarness(runRoleImpl) {
  const posts = [];
  const state = { roleSessions: {} };
  const roster = [{ name: "spec" }, { name: "coder" }];
  return {
    posts, state,
    run: (userText) => advanceTurn({
      threadId: "t1", userText, roster, maxRoundLen: 2, state,
      select: () => ["spec", "coder"],
      runRole: runRoleImpl,
      post: async (_tid, role, text) => { posts.push({ role, text }); },
      persist: async () => {},
    }),
  };
}

test("advanceTurn folds usage into state.tokens for every turn INCLUDING skips", async () => {
  const h = meterHarness(async (role) => ({
    text: role.name === "coder" ? "" : "hi",
    sessionId: `s-${role.name}`,
    skip: role.name === "coder",     // coder skips -- but it still burned a turn
    reset: false,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
  await h.run("go");
  assert.equal(h.state.tokens.turnCount, 2);              // BOTH roles counted (skip too)
  assert.equal(h.state.tokens.perRole.coder.turns, 1);   // the skipping role's burn is recorded
  assert.equal(h.state.tokens.totals.freshInput, 200);
});

test("advanceTurn posts a numbers-only footer via post at round end", async () => {
  const h = meterHarness(async (role) => ({ text: "hi", sessionId: `s-${role.name}`, skip: false, reset: false,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
  await h.run("go");
  const footer = h.posts.find((p) => p.role === "system" && /tokens:/.test(p.text));
  assert.ok(footer, "a system-labeled token footer is posted");
  assert.doesNotMatch(footer.text, /s-spec|session/); // numbers-only, no session ids
});

test("advanceTurn: a throwing role records nothing (expected gap), round continues", async () => {
  let first = true;
  const h = meterHarness(async (role) => {
    if (first) { first = false; throw new Error("boom"); }         // spec throws
    return { text: "hi", sessionId: "s-coder", skip: false, reset: false,
      usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  });
  await h.run("go");
  assert.equal(h.state.tokens.turnCount, 1);   // only coder recorded; spec's throw = gap
  assert.equal(h.state.tokens.totals.freshInput, 50);
});

test("advanceTurn: a footer-post failure does not abort the round", async () => {
  const state = { roleSessions: {} };
  await assert.doesNotReject(advanceTurn({
    threadId: "t1", userText: "go", roster: [{ name: "spec" }], maxRoundLen: 1, state,
    select: () => ["spec"],
    runRole: async () => ({ text: "hi", sessionId: "s", skip: false, reset: false,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    post: async (_t, role) => { if (role === "system") throw new Error("discord down"); }, // footer post fails
    persist: async () => {},
  }));
  assert.equal(state.tokens.turnCount, 1); // fold still happened
});

// --- end token meter tests ---

test("post throwing (e.g. Discord API failure) is contained: turn continues to the next role", async () => {
  const roleAttempts = [];
  const { deps, posts, state } = ctx(async (role) => {
    roleAttempts.push(role.name);
    return { text: `${role.name} ok`, sessionId: `s_${role.name}`, skip: false, reset: false };
  });
  deps.post = async (tid, role, text) => {
    if (role === "spec" && !text.includes("error")) throw new Error("discord unreachable");
    posts.push([role, text]);
  };
  await advanceTurn(deps);
  assert.deepEqual(roleAttempts, ["spec", "reviewer"]); // reviewer still ran
  assert.match(posts[0][1], /error/i);
  assert.deepEqual(posts[1], ["reviewer", "reviewer ok"]);
  assert.deepEqual(state.roleSessions, { spec: "s_spec", reviewer: "s_reviewer" }); // spec's session persisted despite post failure
});
