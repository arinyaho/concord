// Manual (network, OAuth): run the REAL review/fix/verify subagent prompts against a
// FIXED tiny diff and assert every emitted artifact satisfies review-cli's readers.
// Run: cd services/agent-team && unset ANTHROPIC_API_KEY && node smoke/contract-artifacts.mjs
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSpawn } from "../src/adapters/spawn_subagent.mjs";

const stateDir = mkdtempSync(join(tmpdir(), "contract-"));
const round = 1;
const diffPath = join(stateDir, `round-${round}-diff.txt`);
const diffText =
  "diff --git a/add.js b/add.js\n+++ b/add.js\n@@\n+export function add(a,b){ return a - b } // bug: should be +\n";
writeFileSync(diffPath, diffText);
// The exact set of files review-cli's coverage rule expects covered in `examined`:
// every `+++ b/<path>` line in the diff.
const changedFiles = [...diffText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);

const spawn = makeSpawn({ repoRoot: stateDir });

// --- review kind: correctness artifact ---
await spawn("review", { stateDir, round, diffPath });
const reviewRaw = readFileSync(join(stateDir, `round-${round}-correctness.json`), "utf8");
let reviewArt;
try { reviewArt = JSON.parse(reviewRaw); } catch (e) { console.error("FAIL: non-JSON correctness artifact:", reviewRaw.slice(0, 200)); process.exit(1); }
const examinedOk = Array.isArray(reviewArt.examined) && changedFiles.every((f) => reviewArt.examined.includes(f));
const reviewOk =
  reviewArt.status === "ok" &&
  examinedOk &&
  reviewArt.examined.includes("add.js") &&
  Array.isArray(reviewArt.findings) &&
  reviewArt.findings.every((f) => typeof f.id === "string" && !f.id.startsWith("intent:"));

// --- fix kind: fix-<id> artifact (only exercised if review actually found something) ---
let fixOk = true;
let fixArt = null;
const findingId = reviewArt.findings && reviewArt.findings[0] && reviewArt.findings[0].id;
if (findingId) {
  await spawn("fix", { stateDir, round, findingId });
  const fixRaw = readFileSync(join(stateDir, `round-${round}-fix-${findingId}.json`), "utf8");
  try { fixArt = JSON.parse(fixRaw); } catch (e) { console.error("FAIL: non-JSON fix artifact:", fixRaw.slice(0, 200)); process.exit(1); }
  fixOk = fixArt.status === "ok" && typeof fixArt.edited === "boolean" && (!fixArt.edited || Array.isArray(fixArt.files));
}

// --- verify kind: verify artifact ---
await spawn("verify", { stateDir, round, diffPath });
const verifyRaw = readFileSync(join(stateDir, `round-${round}-verify.json`), "utf8");
let verifyArt;
try { verifyArt = JSON.parse(verifyRaw); } catch (e) { console.error("FAIL: non-JSON verify artifact:", verifyRaw.slice(0, 200)); process.exit(1); }
const verifyOk = verifyArt.status === "ok" && Array.isArray(verifyArt.rejected);

const ok = reviewOk && fixOk && verifyOk && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify({
  ok, examined: reviewArt.examined, findingCount: (reviewArt.findings || []).length,
  fixTried: !!findingId, fixStatus: fixArt && fixArt.status, verifyStatus: verifyArt.status,
  apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
}, null, 2));
process.exit(ok ? 0 : 1);
