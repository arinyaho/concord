'use strict';
// Task 6: End-to-end -- diffless converge in a non-git directory.
//
// Drives the real CLI (round-start / plan-fixes / record) programmatically
// against a `file:<path>` target in a temp directory with NO git init,
// simulating the reviewer/fixer artifact writes the driver would make.
// Asserts convergence in 3 rounds with ZERO git usage.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const review = require('../../core/review');

const CLI = path.join(__dirname, '..', 'review-cli.js');

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
}

// ---------------------------------------------------------------------------
// Helper: write a round artifact into the state dir.
// ---------------------------------------------------------------------------
function writeArtifact(stateDir, n, name, obj) {
  fs.writeFileSync(path.join(stateDir, `round-${n}-${name}.json`), JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// E2E test: diffless file-target converges in 3 rounds with ZERO git ops.
// ---------------------------------------------------------------------------

test('e2e: file target converges in 3 rounds with zero git operations in the file directory', () => {
  // --- Setup: a temp dir with NO git init ---
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-e2e-file-'));
  const stateDir = tmpDir();
  const ref = 'file:note.md';
  const slug = review.targetSlug(ref);
  const env = { ...process.env, REVIEW_STATE_DIR: stateDir, REVIEW_REPO_ROOT: fileDir };

  // Confirm no .git at the start.
  assert.ok(!fs.existsSync(path.join(fileDir, '.git')), 'precondition: no .git in fileDir before any run');

  // =========================================================================
  // Round 1: one planted finding (an unsupported claim) -> fixed
  // =========================================================================

  // Step 1: write note.md with a planted issue.
  const notePath = path.join(fileDir, 'note.md');
  fs.writeFileSync(notePath, '# Design Note\nThis approach is proven to be optimal without any evidence.\n');

  // Step 2: round-start file:note.md
  const rs1 = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs1.decision, 'work', 'round 1 round-start must yield decision=work');
  assert.strictEqual(rs1.targetType, 'file', 'round 1 round-start must report targetType=file');
  const n1 = rs1.round;

  // Verify diff text equals the file content (no git diff header).
  const diffText1 = fs.readFileSync(path.join(stateDir, `round-${n1}-diff.txt`), 'utf8');
  assert.ok(diffText1.includes('proven to be optimal without any evidence'), 'round-1-diff.txt must contain the file content');
  assert.ok(diffText1.includes('===== note.md ====='), 'round-1-diff.txt must use the section-header format');
  assert.ok(!diffText1.includes('diff --git'), 'round-1-diff.txt must NOT be a git diff');

  // Verify ledger state.
  const ledger1 = review.readLedger(stateDir, slug);
  assert.strictEqual(ledger1.target.type, 'file');
  assert.strictEqual(ledger1.target.hasDoD, false);
  assert.strictEqual(ledger1.phase, 'gates');

  // Step 3: simulate the reviewer -- one docreview finding.
  const findingId = 'docreview:unsupported-claim';
  writeArtifact(stateDir, n1, 'correctness', {
    status: 'ok',
    examined: ['note.md'],
    findings: [
      {
        id: findingId,
        gate: 'correctness',
        file: 'note.md',
        span: 'proven to be optimal without any evidence',
        summary: 'Claim lacks any supporting evidence or citation.',
      },
    ],
  });
  // Empty verify (no rejections).
  writeArtifact(stateDir, n1, 'verify', { status: 'ok', rejected: [] });

  // Step 4: plan-fixes -- the finding should be routed to fixes.
  const pf1 = JSON.parse(run(['plan-fixes', ref], { env }));
  assert.strictEqual(pf1.fixes.length, 1, 'plan-fixes must route the finding to fixes');
  assert.strictEqual(pf1.fixes[0].id, findingId);

  // Simulate the fixer: edit note.md to resolve the issue (remove the unsupported claim).
  fs.writeFileSync(notePath, '# Design Note\nThis approach has been validated by benchmarks in [1].\n');
  // Write the fix artifact.
  writeArtifact(stateDir, n1, `fix-${findingId}`, { status: 'ok', edited: true, files: ['note.md'] });

  // Step 5: record -- finding must be marked fixed with sentinel, continue=true.
  const rec1 = JSON.parse(run(['record', ref], { env }));
  assert.strictEqual(rec1.decision.continue, true, 'round 1 record must continue (fix round never converges)');
  assert.strictEqual(rec1.decision.converged, false, 'round 1 must not converge');

  const ledgerAfterRec1 = review.readLedger(stateDir, slug);
  const fixedFinding = ledgerAfterRec1.findings.find((f) => f.id === findingId);
  assert.ok(fixedFinding, 'finding must be present in ledger after record');
  assert.strictEqual(fixedFinding.status, 'fixed', 'finding must be marked fixed');
  assert.strictEqual(fixedFinding.fix_commit, 'file-edit', 'fix_commit must be the file-edit sentinel');

  // Assert no .git created after round 1.
  assert.ok(!fs.existsSync(path.join(fileDir, '.git')), 'no .git must exist in fileDir after round 1');

  // =========================================================================
  // Round 2: identity changed (file was edited), reviewer finds nothing -> dryStreak 1, continue.
  // =========================================================================

  // Step 6a: round-start file:note.md (content changed since round 1 -> new identity).
  const rs2 = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs2.decision, 'work', 'round 2 round-start must yield decision=work');
  assert.strictEqual(rs2.targetType, 'file', 'round 2 round-start must report targetType=file');
  const n2 = rs2.round;
  assert.ok(n2 > n1, 'round number must advance');

  // Verify the diff reflects the updated file content.
  const diffText2 = fs.readFileSync(path.join(stateDir, `round-${n2}-diff.txt`), 'utf8');
  assert.ok(diffText2.includes('validated by benchmarks'), 'round-2-diff.txt must reflect the edited file');

  // Step 6b: reviewer writes empty findings.
  writeArtifact(stateDir, n2, 'correctness', { status: 'ok', examined: [], findings: [] });
  writeArtifact(stateDir, n2, 'verify', { status: 'ok', rejected: [] });

  // plan-fixes (no findings to plan).
  const pf2 = JSON.parse(run(['plan-fixes', ref], { env }));
  assert.deepStrictEqual(pf2.fixes, [], 'plan-fixes round 2 must have no fixes');

  // record -> dryStreak 1, continue=true (N=2 needed to converge).
  const rec2 = JSON.parse(run(['record', ref], { env }));
  assert.strictEqual(rec2.decision.continue, true, 'round 2 record must continue (dryStreak=1 < 2)');
  assert.strictEqual(rec2.decision.converged, false, 'round 2 must not converge yet');

  const ledgerAfterRec2 = review.readLedger(stateDir, slug);
  assert.strictEqual(ledgerAfterRec2.dryStreak, 1, 'dryStreak must be 1 after round 2');

  // Assert no .git created after round 2.
  assert.ok(!fs.existsSync(path.join(fileDir, '.git')), 'no .git must exist in fileDir after round 2');

  // =========================================================================
  // Round 3: reviewer again finds nothing -> dryStreak 2 -> converged=true.
  // =========================================================================

  // Step 7a: round-start file:note.md.
  // The file content is UNCHANGED from round 2 -- same bytes, same hash.
  // With reReviewOnStableContent:true, beginRound must still advance a real round
  // (not no-op), so dryStreak can reach 2 and the run converges. This is the
  // proof that the Task 7 fix works: round 3 runs on genuinely identical content.
  const rs3 = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs3.decision, 'work', 'round 3 round-start must yield decision=work (reReviewOnStableContent bypasses no-op)');
  const n3 = rs3.round;
  assert.ok(n3 > n2, 'round number must advance for round 3');

  // Verify the diff text for round 3 is IDENTICAL to round 2 -- same bytes,
  // same hash -- confirming the no-op guard was correctly bypassed.
  const diffText3 = fs.readFileSync(path.join(stateDir, `round-${n3}-diff.txt`), 'utf8');
  assert.strictEqual(diffText3, diffText2, 'round-3-diff.txt must be byte-identical to round-2-diff.txt (unchanged content, not a hash-forcing edit)');

  // Step 7b: reviewer writes empty findings again.
  writeArtifact(stateDir, n3, 'correctness', { status: 'ok', examined: [], findings: [] });
  writeArtifact(stateDir, n3, 'verify', { status: 'ok', rejected: [] });

  const pf3 = JSON.parse(run(['plan-fixes', ref], { env }));
  assert.deepStrictEqual(pf3.fixes, [], 'plan-fixes round 3 must have no fixes');

  // record -> dryStreak 2 -> converged=true.
  const rec3 = JSON.parse(run(['record', ref], { env }));
  assert.strictEqual(rec3.decision.continue, false, 'round 3 record must not continue (converged)');
  assert.strictEqual(rec3.decision.converged, true, 'round 3 must converge (dryStreak >= 2)');

  const ledgerAfterRec3 = review.readLedger(stateDir, slug);
  assert.strictEqual(ledgerAfterRec3.dryStreak, 2, 'dryStreak must be 2 after round 3');

  // =========================================================================
  // Step 8: Assert NO .git was created in the file directory at any point.
  // =========================================================================
  assert.ok(!fs.existsSync(path.join(fileDir, '.git')), 'ZERO git: .git must never be created in the file directory');
});

// finding #4: strengthen the no-git proof from a `.git`-absence check to a real
// git-exec spy. The CLI is spawned as a subprocess, so the spy crosses the
// process boundary via a PATH shim: a temp bin dir holds an executable `git`
// script that appends its argv to a marker file whenever invoked, prepended to
// PATH for the file-target run. A `.git`-absence check misses a read-only git
// touch (git --version, a `git status` resolving to a PARENT repo, any git call
// that errors before writing state); the marker asserts ZERO git PROCESSES were
// spawned -- exactly the class of touch that would violate the Obsidian/non-git
// contract (S2/S6). Run inside a real git repo (an ancestor .git present) so a
// stray `git status` WOULD resolve to it -- proving the file target does not
// even look.
test('e2e: a file-target run spawns ZERO git processes (PATH-shim git-exec spy)', () => {
  // A parent git repo so any stray git call would find an ancestor .git.
  const parentRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-e2e-gitspy-'));
  execFileSync('git', ['init', '-q'], { cwd: parentRepo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: parentRepo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: parentRepo });
  // The file target lives in a SUBDIR of that repo -- so `git status` here would
  // resolve to the parent .git if the file path ever touched git.
  const fileDir = path.join(parentRepo, 'docs');
  fs.mkdirSync(fileDir);
  const stateDir = tmpDir();

  // PATH shim: a bin dir whose `git` records every invocation to a marker file,
  // then exits 0 (so even if something tried git, it would not crash the run --
  // we detect the attempt via the marker, not via a failure).
  const shimBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-gitshim-'));
  const marker = path.join(shimBin, 'git-invocations.log');
  const gitShim = path.join(shimBin, 'git');
  fs.writeFileSync(gitShim, `#!/bin/sh\nprintf '%s\\n' "git $*" >> ${JSON.stringify(marker)}\nexit 0\n`);
  fs.chmodSync(gitShim, 0o755);
  const env = {
    ...process.env,
    REVIEW_STATE_DIR: stateDir,
    REVIEW_REPO_ROOT: fileDir,
    PATH: `${shimBin}${path.delimiter}${process.env.PATH}`,
  };

  const ref = 'file:note.md';
  const slug = review.targetSlug(ref);
  const notePath = path.join(fileDir, 'note.md');
  fs.writeFileSync(notePath, '# Doc\nan unsupported claim\n');

  // Drive a full round: round-start -> plan-fixes -> record.
  const rs = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs.targetType, 'file', 'must be a file target');
  const n = rs.round;
  writeArtifact(stateDir, n, 'correctness', {
    status: 'ok', examined: ['note.md'],
    findings: [{ id: 'docreview:claim', gate: 'correctness', file: 'note.md', span: 'an unsupported claim', summary: 'no citation' }],
  });
  writeArtifact(stateDir, n, 'verify', { status: 'ok', rejected: [] });
  const pf = JSON.parse(run(['plan-fixes', ref], { env }));
  assert.strictEqual(pf.fixes.length, 1);
  fs.writeFileSync(notePath, '# Doc\na claim backed by [1]\n');
  writeArtifact(stateDir, n, `fix-${pf.fixes[0].id}`, { status: 'ok', edited: true, files: ['note.md'] });
  run(['record', ref], { env });

  // The core assertion: the git shim was NEVER invoked -> the marker is absent
  // (or empty). If any git process had been spawned, the marker would list it.
  const invoked = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  assert.strictEqual(invoked, '', `file-target run must spawn ZERO git processes, but the shim recorded:\n${invoked}`);

  void slug;
});
