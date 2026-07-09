'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const review = require('../lib/review');
const cli = require('../review-cli'); // must be requirable without running main()

const CLI = path.join(__dirname, '..', 'review-cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
}

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

test('review-cli is requirable as a module without executing main (guarded)', () => {
  assert.strictEqual(typeof cli.gitDiff, 'function');
  assert.strictEqual(typeof cli.gitIsReachable, 'function');
  assert.strictEqual(typeof cli.runDod, 'function');
});

test('git helpers operate on a real temp repo', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-git-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  assert.strictEqual(cli.gitIsDirty(repo), false);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  assert.strictEqual(cli.gitIsDirty(repo), true);
  const sha = cli.gitCommitFix(repo, 'correctness:x', 'fix it', ['a.txt']);
  assert.match(sha, /^[0-9a-f]{7,40}$/);
  assert.strictEqual(cli.gitIsReachable(repo, sha), true);
  cli.gitCheckoutTree(repo);
  assert.strictEqual(cli.gitIsDirty(repo), false);
});

test('review-cli show: prints an empty/fresh ledger summary for an unknown ref', () => {
  const dir = tmpDir();
  const out = run(['show', 'feat/x'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.status, 'converging');
  assert.strictEqual(parsed.round, 0);
});

test('round-start: fresh start runs DoD, writes diff file, sets phase gates, decision work', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  // commit a change so the tree is clean but a diff vs HEAD~1 exists
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.dodPassed, true);
  assert.strictEqual(out.stateDir, dir); // driver needs this to build <stateDir>/round-N-*.json paths
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.phase, 'gates');
  assert.ok(fs.existsSync(path.join(dir, `round-${ledger.round}-diff.txt`)));
});

test('round-start: refuses a dirty working tree on a fresh start', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n'); // uncommitted
  assert.throws(() => run(['round-start', 'feat/x'], { env }), /dirty/);
});

test('round-start: resume from phase fixes discards uncommitted edits and re-drives the same round at same budget', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  // seed a ledger mid-round: phase fixes, round 1, a stale artifact, budget spent 1
  let l = review.emptyLedger({ kind: 'local', ref: 'feat/x', head_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() });
  l = review.beginRound(l, 'h').ledger; // round 1
  l.phase = 'fixes';
  l.budget.spent = 1;
  l.planned = ['correctness:x'];
  review.writeLedger(dir, slug, l);
  fs.writeFileSync(path.join(dir, 'round-1-fix-correctness:x.json'), '{"status":"ok","edited":true}');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted fix\n'); // dirty from the crashed fix
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  JSON.parse(run(['round-start', 'feat/x'], { env }));
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.round, 1); // NOT advanced
  assert.strictEqual(after.budget.spent, 1); // NOT re-charged
  assert.strictEqual(after.phase, 'gates'); // re-driven
  assert.strictEqual(cli.gitIsDirty(repo), false); // uncommitted discarded
  assert.ok(!fs.existsSync(path.join(dir, 'round-1-fix-correctness:x.json'))); // stale artifact gone
});

// CRITICAL 2 (false-clean via empty resume diff): on `resume <ref>` the
// driver passes NO base token. Before the fix, round-start read only
// `rest[0]` and never fell back to the persisted `ledger.target.base`, so
// `gitDiff` fell back to `git diff HEAD` -- empty on a clean committed tree.
// This asserts the fallback: a resumed round-start with no base arg must
// still diff against the ORIGINAL base (persisted from the fresh start),
// and target.base must survive the resume, not be clobbered to undefined.
test('round-start: resume with no base arg falls back to the persisted target.base (does not review an empty diff)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  // Fresh start against HEAD~1 -- persists target.base = 'HEAD~1'.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const slug = review.targetSlug('feat/x');
  const afterFresh = review.readLedger(dir, slug);
  assert.strictEqual(afterFresh.target.base, 'HEAD~1');

  // Simulate a crash mid-round (phase left at 'gates') and a cross-session
  // resume: the driver calls round-start again with NO base token.
  let l = review.readLedger(dir, slug);
  l = { ...l, phase: 'gates' };
  review.writeLedger(dir, slug, l);

  const out = JSON.parse(run(['round-start', 'feat/x'], { env })); // no base arg -- resume form
  assert.strictEqual(out.decision, 'work');
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.target.base, 'HEAD~1'); // preserved, not clobbered to undefined
  const diffText = fs.readFileSync(path.join(dir, `round-${after.round}-diff.txt`), 'utf8');
  assert.ok(diffText.trim().length > 0, 'resumed round-start must diff against the persisted base, not an empty `git diff HEAD`');
});

test('review-cli unpark: reopens a parked finding', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.status = 'parked';
  ledger.findings.push({ id: 'f7', status: 'parked' });
  review.writeLedger(dir, slug, ledger);

  const out = run(['unpark', 'feat/x', 'f7'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  assert.ok(/f7/.test(out));
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.findings.find((f) => f.id === 'f7').status, 'open');
  assert.strictEqual(after.status, 'converging');
});

test('review-cli: missing ref argument exits non-zero with a message on stderr', () => {
  const dir = tmpDir();
  assert.throws(() => run(['show'], { env: { ...process.env, REVIEW_STATE_DIR: dir } }));
});

function seedGatesRound(repo, dir, ref, correctness, verify) {
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', ref, 'HEAD~1'], { env });
  const n = review.readLedger(dir, review.targetSlug(ref)).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify(correctness));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify(verify));
  return { env, n };
}

test('plan-fixes: returns confirmed, non-killed, still-open findings and sets phase fixes', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
      { id: 'correctness:fp', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' } ] },
    { status: 'ok', rejected: ['correctness:fp'] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:real']);
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(l.phase, 'fixes');
  assert.deepStrictEqual(l.planned, ['correctness:real']);
});

test('plan-fixes: a finding reopened after being marked fixed is not silently dropped as concluded', () => {
  const repo = initRepo(); const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const finding = { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' };
  // Pre-seed a ledger where this id is already status 'fixed' in both `findings`
  // and `seen`, so this round's re-detection of the same id makes
  // dedupeAgainstSeen mark it `reopened: true` (fix didn't hold / was reverted).
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings = [{ id: finding.id, status: 'fixed' }];
  ledger.seen = [{ id: finding.id, status: 'fixed', hash: review.seenHash(finding) }];
  review.writeLedger(dir, slug, ledger);

  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [finding] },
    { status: 'ok', rejected: [] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:real']);
  const l = review.readLedger(dir, slug);
  assert.deepStrictEqual(l.planned, ['correctness:real']);
});

test('plan-fixes: a missing correctness artifact is a harness-failure (never clean)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: a changed file never examined is a harness-failure (coverage)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: [], findings: [] },
    { status: 'ok', rejected: [] });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure|coverage/);
});

// DEFECT: a confirmed (not-killed) finding whose span is no longer present in
// its file was silently dropped from `planned`/`fixes` by the replay guard,
// but `record` built its outcome from ALL correctness candidates -- so the
// dropped finding still flowed into applyRoundOutcome, got no fixed/parked/
// killed status, and defaulted to 'open': a phantom finding that blocks
// convergence forever and never appears in the handoff (which only lists
// parked findings). The correct semantics (matching the deleted engine.js):
// a span-already-absent finding is an idempotent replay -- its fix already
// landed in a prior/crashed attempt -- so it must be recorded 'fixed', not
// 'open'.
test('plan-fixes + record: a confirmed finding whose span is already absent from the file is idempotent-fixed, not a phantom open', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:absent', gate: 'correctness', file: 'a.txt', span: 'this-span-is-not-in-the-file', summary: 'x' } ] },
    { status: 'ok', rejected: [] });

  const planOut = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(planOut.fixes, []); // span absent -- not in the fixable set
  const afterPlan = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(afterPlan.planned, []);
  assert.deepStrictEqual(afterPlan.resolved_absent, ['correctness:absent']);

  // No fix subagent, no commit-fix call -- there is nothing to commit.
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  const f = l.findings.find((x) => x.id === 'correctness:absent');
  assert.strictEqual(f.status, 'fixed'); // NOT 'open' -- the phantom-open bug
  assert.strictEqual(l.findings.filter((x) => x.status === 'open').length, 0);
  assert.strictEqual(out.decision.parked, false); // does not strand convergence
});

test('commit-fix: commits one fix and journals it', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true }));
  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, true);
  assert.match(out.sha, /^[0-9a-f]{7,40}$/);
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(l.journal.length, 1);
  assert.strictEqual(l.journal[0].id, 'correctness:real');
});

test('commit-fix: two findings in the same file get two separate commits', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:one', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
      { id: 'correctness:two', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' } ] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const before = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());

  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed-one\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:one.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:one'], { env });
  const afterFirst = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
  assert.strictEqual(afterFirst, before + 1);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed-two\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:two.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:two'], { env });
  const afterSecond = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
  assert.strictEqual(afterSecond, afterFirst + 1);

  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(l.journal.map((j) => j.id), ['correctness:one', 'correctness:two']);
});

test('commit-fix: scopes staging to the finding\'s file -- an unrelated dirty file is never swept into the commit', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });

  // The actual fix, to file A.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true }));
  // Unrelated dirty content in the working tree -- an untracked file, standing
  // in for a stray non-gitignored dir or a crash-recovery leftover.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'unrelated\n');

  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, true);

  const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', out.sha], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.deepStrictEqual(committedFiles, ['a.txt']);
  // b.txt was never staged or committed -- it is still dirty/untracked.
  const status = execFileSync('git', ['status', '--porcelain', '--', 'b.txt'], { cwd: repo, encoding: 'utf8' });
  assert.ok(status.trim().length > 0, 'b.txt should remain dirty/untracked after commit-fix');
});

// DEFECT: gitCommitFix staged only finding.file. If a fix subagent legitimately
// edited a second file (e.g. a caller/import that needed updating to make the
// fix correct), that companion edit was left uncommitted -- and record()'s
// gitCheckoutTree discards any leftover uncommitted edit at the end of the
// round, silently wiping the companion change even though the finding is
// reported fixed with a valid commit sha. The fix subagent now declares every
// file it touched via a `files` array on the fix artifact; commit-fix must
// stage and commit all of them (still never `-A`).
test('commit-fix: a fix that declares multiple files (finding.file + companion) commits all of them, still scoped', () => {
  const repo = initRepo(); const dir = tmpDir();
  // A second tracked file standing in for the companion edit (e.g. a caller
  // that needed updating alongside the finding's own file).
  fs.writeFileSync(path.join(repo, 'c.txt'), 'orig\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add c.txt'], { cwd: repo });

  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });

  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'companion-edit\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true, files: ['a.txt', 'c.txt'] }));
  // Unrelated dirty content that must still never be swept in.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'unrelated\n');

  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, true);
  const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', out.sha], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepStrictEqual(committedFiles, ['a.txt', 'c.txt']);
  const status = execFileSync('git', ['status', '--porcelain', '--', 'b.txt'], { cwd: repo, encoding: 'utf8' });
  assert.ok(status.trim().length > 0, 'b.txt should remain dirty/untracked -- companion staging must still be scoped, not -A');
});

test('commit-fix: idempotent -- a second call for an already-journaled id commits nothing new', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env });
  const shaCount1 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, false);
  const shaCount2 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.strictEqual(shaCount1, shaCount2);
});

test('record: a missing correctness artifact is a harness-failure (never a spurious clean decision)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.unlinkSync(path.join(dir, `round-${n}-correctness.json`)); // simulate a broken/missing gate artifact before record runs
  assert.throws(() => run(['record', 'feat/x'], { env }), /harness-failure/);
});

test('record: a corrupt (non-JSON) verify artifact is a harness-failure too', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), 'not json{{{');
  assert.throws(() => run(['record', 'feat/x'], { env }), /harness-failure/);
});

test('record: a journaled fix is reported fixed, and the fix-round never converges (stable-round)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env }); // driver calls this right after the fix subagent
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, true);     // fix-round never converges
  assert.strictEqual(out.decision.converged, false);
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(l.phase, 'done');
  assert.strictEqual(l.journal.length, 1);
  assert.strictEqual(l.budget.spent, 1);               // charged because continue:true
  assert.strictEqual(l.last_recorded_round, n);
});

test('record: idempotent -- a second record for the same round re-prints and does not double-commit or double-charge', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env });
  run(['record', 'feat/x'], { env });
  const shaCount1 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const spent1 = review.readLedger(dir, review.targetSlug('feat/x')).budget.spent;
  run(['record', 'feat/x'], { env }); // second call, same round, phase already 'done'
  const shaCount2 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const spent2 = review.readLedger(dir, review.targetSlug('feat/x')).budget.spent;
  assert.strictEqual(shaCount1, shaCount2); // no new commit
  assert.strictEqual(spent1, spent2);       // no double charge
});

test('record: tripping the park budget forces status parked and continue false, without charging a round', () => {
  const { REVIEW_PARK_BUDGET_DEFAULT } = require('../lib/config');
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:new', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  // Seed REVIEW_PARK_BUDGET_DEFAULT pre-existing needs-decision parks so this
  // round's one additional park (correctness:new, never fixed) trips the breaker.
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  const priorParks = [];
  for (let i = 0; i < REVIEW_PARK_BUDGET_DEFAULT; i += 1) {
    priorParks.push({ id: `correctness:old-${i}`, gate: 'correctness', file: 'a.txt', span: '', summary: 'x', status: 'parked', park_reason: { kind: 'needs-decision', text: 'prior' } });
  }
  ledger = { ...ledger, findings: priorParks };
  review.writeLedger(dir, slug, ledger);
  // no fix artifact and no commit-fix call for correctness:new -> it parks too
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, false);
  assert.strictEqual(out.decision.converged, false); // must not read as a stale/spurious clean
  assert.strictEqual(out.decision.parked, true);
  const l = review.readLedger(dir, slug);
  assert.strictEqual(l.status, 'parked');
  assert.strictEqual(l.budget.spent, 0); // park-budget-forced terminus does not consume a round
});

test('record: a fix-committing round that terminates re-runs DoD on the post-commit tree', () => {
  const repo = initRepo(); const dir = tmpDir();
  // Make the DoD command observe tree state instead of always passing.
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['grep -q fixed a.txt'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'dod checks tree state'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env }); // span 'two' still present at this point
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness:real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env });
  // Force this fix-committing round to be the terminus via round budget exhaustion.
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, budget: { ...ledger.budget, max_rounds: 1, spent: 1 } };
  review.writeLedger(dir, slug, ledger);
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.dod.passed, true); // re-ran against the post-commit tree, where a.txt now contains "fixed"
  assert.match(out.handoff, /DoD: passed/); // the final re-run DoD state must be surfaced in the handoff text
});

function initRepoWithIntent(intentCmd) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-intent-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], intent: { command: intentCmd } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

test('round-start: intent configured -> fetches intent-<slug>.md, sets intentHash, intentApplied:true', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.intentApplied, true);
  const slug = review.targetSlug('feat/x');
  assert.ok(fs.existsSync(path.join(dir, `intent-${slug}.md`)));
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${slug}.md`), 'utf8'), 'REQ: retry three times');
  const ledger = review.readLedger(dir, slug);
  assert.strictEqual(typeof ledger.intentHash, 'string');
  assert.ok(ledger.intentBytes > 0);
});

test('round-start: no intent config -> intentApplied:false, no artifact', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.intentApplied, false);
  assert.ok(!fs.existsSync(path.join(dir, `intent-${review.targetSlug('feat/x')}.md`)));
});

test('round-start: intent fetch that exits non-zero -> harness-failure abort', () => {
  const repo = initRepoWithIntent('exit 7');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  assert.throws(() => run(['round-start', 'feat/x', 'HEAD~1'], { env }), /harness-failure/);
});

test('round-start: intent-review re-entry re-fetches and advances a round', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const slug = review.targetSlug('feat/x');
  // simulate a prior intent-review terminus
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, status: 'intent-review', phase: 'done', intent_parked: [{ id: 'intent:x', file: 'a.txt', span: 'two', requirement: 'REQ', summary: 's' }] };
  review.writeLedger(dir, slug, ledger);
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work'); // re-entered, not "terminal"
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.intent_parked, []); // reset
  assert.ok(fs.existsSync(path.join(dir, `intent-${slug}.md`))); // re-fetched
});
