import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewUntilGreen } from "../src/review_runner.mjs";
import { makeRunCli } from "../src/adapters/review_cli.mjs";
import { makeSpawn } from "../src/adapters/spawn_subagent.mjs";
import { createRequire } from "node:module";

const review = createRequire(import.meta.url)("../../../plugins/concord/core/review.js");

// Drives the production spawn adapter and the real review-cli. Only the SDK
// query is replaced: the fake agent writes the artifact each prompt names, so
// the prompts, artifact paths and CLI contract are the ones used at runtime.
const CLI_PATH = new URL("../../../plugins/concord/hooks/review-cli.js", import.meta.url).pathname;

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function initRepo(config = { dod: ["true"] }) {
  const repo = mkdtempSync(join(tmpdir(), "agent-team-int-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "review.config.json"), JSON.stringify(config));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git(repo, "commit", "-qam", "change");
  return repo;
}

// The artifact a prompt asks for is the last round artifact path it names.
function artifactOf(prompt) {
  const paths = prompt.match(/\/[^\s"',\]]*round-\d+-[^\s"',\]]+\.json/g) || [];
  const file = paths[paths.length - 1];
  const role = file.replace(/^.*round-\d+-/, "").replace(/\.json$/, "");
  return { file, round: Number(file.match(/round-(\d+)-/)[1]), role };
}

function fakeAgent({ repo, calls, findings, fixer, planGroups }) {
  // review-cli orders roles by artifact mtime; a real agent takes far longer than the clock's resolution.
  let clock = Date.now();
  return function query({ prompt }) {
    const { file, round, role } = artifactOf(prompt);
    const write = (value) => {
      writeFileSync(file, JSON.stringify(value));
      clock += 1000;
      utimesSync(file, new Date(clock), new Date(clock));
    };
    if (role === "correctness") {
      write({ status: "ok", examined: ["a.txt"], findings: round === 1 ? findings : [] });
      calls.push("review");
    } else if (role === "verify" || role === "gate-verify") {
      write({ status: "ok", rejected: [], findings: [] });
      calls.push(role);
    } else if (role === "gate" || role === "intent") {
      write({ status: "ok", findings: [] });
      calls.push(role);
    } else if (role === "plan" && planGroups && round === 1) {
      write({ status: "ok", protocolVersion: 2, groups: planGroups(file) });
      calls.push("plan");
    } else if (role === "plan") {
      write({ status: "ok", protocolVersion: 2, groups: round === 1 ? findings.map((finding) => ({
        groupId: finding.id.replace("correctness:", "g-"), findingIds: [finding.id], rootCause: finding.summary,
        invariants: ["the reported behavior is corrected"], changeClass: "local", structuralEffects: [], action: "fix",
      })) : [] });
      calls.push("plan");
    } else if (role.startsWith("fix-")) {
      const groupId = prompt.match(/"groupId":"([^"]+)"/)[1];
      write(fixer(groupId));
      calls.push(`fix(${groupId})`);
    } else if (role.startsWith("certify-")) {
      const groupId = prompt.match(/"groupId":"([^"]+)"/)[1];
      const resolvedFindingIds = JSON.parse(prompt.match(/"resolvedFindingIds":(\[[^\]]*\])/)[1]);
      const hash = createHash("sha256").update(readFileSync(join(repo, "a.txt"))).digest("hex");
      write({ status: "ok", groupId, resolvedFindingIds, files: ["a.txt"], fileHashes: { "a.txt": hash }, evidence: ["read a.txt"] });
      calls.push(`certify(${groupId})`);
    } else {
      throw new Error(`fake agent has no answer for ${role}`);
    }
    return (async function* () {})();
  };
}

function setup({ findings, fixer, planGroups, config }) {
  const repo = initRepo(config);
  const stateDir = mkdtempSync(join(tmpdir(), "agent-team-int-state-"));
  const calls = [];
  const cli = makeRunCli({ repoRoot: repo, stateDir, cliPath: CLI_PATH, timeoutMs: 60000 });
  const runCli = async (verb, args) => {
    const out = await cli(verb, args);
    if (verb === "commit-fix") calls.push(`commit(${args[1]})`);
    return out;
  };
  const spawn = makeSpawn({ repoRoot: repo, query: fakeAgent({ repo, calls, findings, planGroups, fixer: (groupId) => fixer(repo, groupId) }) });
  const events = [];
  const logger = { event: (name, data) => events.push({ name, ...data }) };
  return { repo, stateDir, calls, run: async () => ({ ...(await runReviewUntilGreen({ target: { ref: "feat", base: "main" }, runCli, spawn, maxRounds: 3, logger })), errors: events.filter((event) => event.name === "error") }) };
}

const TWO_FINDINGS = [
  { id: "correctness:a", gate: "correctness", file: "a.txt", span: "two", summary: "first defect" },
  { id: "correctness:b", gate: "correctness", file: "a.txt", span: "two", summary: "second defect" },
];

test("production spawn adapter: group transactions run fix, certify, commit in order and each commit holds only its own change", async () => {
  const env = setup({
    findings: TWO_FINDINGS,
    fixer: (repo, groupId) => {
      appendFileSync(join(repo, "a.txt"), `fixed by ${groupId}\n`);
      return { status: "ok", edited: true, groupId, files: ["a.txt"] };
    },
  });
  const result = await env.run();
  assert.equal(result.outcome, "converged", JSON.stringify(result));
  const round1 = env.calls.slice(env.calls.indexOf("plan") + 1, env.calls.lastIndexOf("commit(g-b)") + 1);
  assert.deepEqual(round1, ["fix(g-a)", "certify(g-a)", "commit(g-a)", "fix(g-b)", "certify(g-b)", "commit(g-b)"]);
  const first = git(env.repo, "show", "HEAD~1", "--format=", "--", "a.txt");
  assert.match(first, /\+fixed by g-a/);
  assert.doesNotMatch(first, /fixed by g-b/);
  assert.match(git(env.repo, "show", "HEAD", "--format=", "--", "a.txt"), /\+fixed by g-b/);
  const planPath = join(env.stateDir, "round-1-plan.json");
  assert.equal(JSON.parse(readFileSync(planPath, "utf8")).protocolVersion, 2);
  for (const groupId of ["g-a", "g-b"]) assert.equal(JSON.parse(readFileSync(join(env.stateDir, `round-1-certify-${groupId}.json`), "utf8")).groupId, groupId);
});

test("production spawn adapter: a fixer that reports no edit parks the finding without certification, commit or harness error", async () => {
  const env = setup({ findings: TWO_FINDINGS.slice(0, 1), fixer: () => ({ status: "ok", edited: false }) });
  const before = git(env.repo, "rev-parse", "HEAD");
  const result = await env.run();
  assert.equal(result.outcome, "parked", JSON.stringify(result));
  assert.deepEqual(result.parkedFindings.map((finding) => finding.id), ["correctness:a"]);
  assert.equal(result.parkedFindings[0].park_reason.kind, "needs-decision");
  assert.equal(git(env.repo, "rev-parse", "HEAD"), before);
  assert.equal(env.calls.some((call) => call.startsWith("certify") || call.startsWith("commit")), false);
});

const INTENT = "Exactly one owner decides the result.";

// Two structural groups bound to the intent round-start cached; sharing an invariant makes them one round transaction.
function sharedInvariantPlan(planFile) {
  const stateDir = planFile.replace(/\/round-\d+-plan\.json$/, "");
  const slug = review.targetSlug("feat");
  const designEvidence = { source: `intent-${slug}.md`, sourceHash: review.readLedger(stateDir, slug).intentHash, requirements: [INTENT], uniqueness: "one owner is required" };
  return TWO_FINDINGS.map((finding) => ({
    groupId: finding.id.replace("correctness:", "g-"), findingIds: [finding.id], rootCause: finding.summary,
    invariants: ["one owner decides the result"], changeClass: "structural", structuralEffects: ["ownership"], action: "fix", designEvidence,
  }));
}

test("production spawn adapter: a round transaction runs every fixer, then certifies and commits once", async () => {
  const env = setup({
    findings: TWO_FINDINGS,
    planGroups: sharedInvariantPlan,
    config: { dod: ["true"], intent: { command: `echo '${INTENT}'` } },
    fixer: (repo, groupId) => {
      appendFileSync(join(repo, "a.txt"), `fixed by ${groupId}\n`);
      return { status: "ok", edited: true, groupId, files: ["a.txt"] };
    },
  });
  const before = Number(git(env.repo, "rev-list", "--count", "HEAD"));
  const result = await env.run();
  assert.equal(result.outcome, "converged", JSON.stringify(result));
  const planId = review.readLedger(env.stateDir, review.targetSlug("feat")).review_history[0].planId;
  const round1 = env.calls.slice(env.calls.indexOf("plan") + 1, env.calls.findIndex((call) => call.startsWith("commit(")) + 1);
  assert.deepEqual(round1, ["fix(g-a)", "fix(g-b)", `certify(${planId})`, `commit(${planId})`]);
  assert.equal(Number(git(env.repo, "rev-list", "--count", "HEAD")), before + 1);
});

test("production spawn adapter: a round transaction with a no-edit member certifies and commits nothing and parks the run", async () => {
  const env = setup({
    findings: TWO_FINDINGS,
    planGroups: sharedInvariantPlan,
    config: { dod: ["true"], intent: { command: `echo '${INTENT}'` } },
    fixer: (repo, groupId) => {
      if (groupId === "g-b") return { status: "ok", edited: false };
      appendFileSync(join(repo, "a.txt"), `fixed by ${groupId}\n`);
      return { status: "ok", edited: true, groupId, files: ["a.txt"] };
    },
  });
  const before = git(env.repo, "rev-parse", "HEAD");
  const result = await env.run();
  assert.equal(result.outcome, "parked", JSON.stringify(result));
  assert.equal(env.calls.some((call) => call.startsWith("certify") || call.startsWith("commit")), false, JSON.stringify(env.calls));
  assert.equal(git(env.repo, "rev-parse", "HEAD"), before);
  assert.match(readFileSync(join(env.repo, "a.txt"), "utf8"), /fixed by g-a/);
  assert.deepEqual(result.parkedFindings.map((finding) => finding.id).sort(), ["correctness:a", "correctness:b"]);
  assert.equal(result.parkedFindings.find((finding) => finding.id === "correctness:b").park_reason.kind, "needs-decision");
});
