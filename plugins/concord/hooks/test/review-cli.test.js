'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../lib/review');
const cli = require('../review-cli'); // must be requirable without running main()

const CLI = path.join(__dirname, '..', 'review-cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
}

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

function runCapture(args, opts = {}) {
  // Like run() but also captures stderr so tests can assert on warning messages.
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
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

// A confirmed finding whose span is absent from the file is an idempotent replay
// ONLY when this run's journal proves a prior commit for it. Without journal
// evidence, plan-fixes routes it to the fixer (not resolved_absent) to prevent
// silently converging green when a confirmed bug is still live. This test covers
// the journal-proven replay path: absent + journaled -> resolved_absent -> fixed.
// The no-journal path (absent + no journal -> planned -> parked) is covered by
// the phantom-fix regression-lock tests added below.
test('plan-fixes + record: a confirmed finding whose span is already absent from the file is idempotent-fixed, not a phantom open', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:absent', gate: 'correctness', file: 'a.txt', span: 'this-span-is-not-in-the-file', summary: 'x' } ] },
    { status: 'ok', rejected: [] });
  // Seed the journal with a prior commit that proves this absent span was already
  // fixed in a crashed run. plan-fixes requires this evidence to classify an
  // absent span as an idempotent replay rather than routing it to the fixer.
  let ll = review.readLedger(dir, review.targetSlug('feat/x'));
  ll = { ...ll, journal: [{ id: 'correctness:absent', sha: 'priorsha123' }] };
  review.writeLedger(dir, review.targetSlug('feat/x'), ll);

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

// --- Phantom-fix false-green regression lock (3 tests) ---
// Prior to the fix, plan-fixes used only spanPresent() to split confirmed
// findings: absent span -> resolvedAbsent, and record() blindly stamped every
// resolvedAbsent id as 'fixed' with a sentinel commit string. An additive or
// absence finding (span never in the file) or a finding with reviewer span that
// drifted from the actual text was silently marked fixed with no patch.
// The fix: absent span is an idempotent replay ONLY when this run's journal
// proves a commit for it. Without that evidence, route it to the fixer.

test('plan-fixes routes an absent-span finding with no journal evidence to the fixer, not resolved_absent', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/absent-no-journal',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:additive', gate: 'correctness', file: 'a.txt', span: 'MISSING_FUNC_XYZ', summary: 'required function is absent' }
    ]},
    { status: 'ok', rejected: [] });
  // a.txt contains 'two\n' from seedGatesRound -- confirm the span is not present.
  assert.ok(!fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').includes('MISSING_FUNC_XYZ'));

  const planOut = JSON.parse(run(['plan-fixes', 'feat/absent-no-journal'], { env }));
  // No journal evidence: absent span must go to the fixer (fixes), NOT resolved_absent.
  assert.deepStrictEqual(planOut.fixes.map((f) => f.id), ['correctness:additive']);

  const l = review.readLedger(dir, review.targetSlug('feat/absent-no-journal'));
  assert.deepStrictEqual(l.planned, ['correctness:additive']);
  assert.deepStrictEqual(l.resolved_absent, []);
});

test('absent-span finding with no journal and no fix is parked needs-decision, never marked fixed or converged', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/absent-parked',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:additive', gate: 'correctness', file: 'a.txt', span: 'MISSING_FUNC_XYZ', summary: 'required function is absent' }
    ]},
    { status: 'ok', rejected: [] });
  // plan-fixes with no journal evidence routes the absent-span finding to planned.
  run(['plan-fixes', 'feat/absent-parked'], { env });
  const afterPlan = review.readLedger(dir, review.targetSlug('feat/absent-parked'));
  assert.deepStrictEqual(afterPlan.planned, ['correctness:additive']);
  assert.deepStrictEqual(afterPlan.resolved_absent, []);

  // No fix artifact and no commit-fix -- the bug was that record silently marked
  // this fixed even though no patch ever landed.
  const out = JSON.parse(run(['record', 'feat/absent-parked'], { env }));
  const l = review.readLedger(dir, review.targetSlug('feat/absent-parked'));
  const f = l.findings.find((x) => x.id === 'correctness:additive');
  assert.strictEqual(f.status, 'parked'); // must NOT be 'fixed' -- no patch landed
  assert.notStrictEqual(out.decision.converged, true); // must not converge green with a live bug
});

test('journal-proven absent-span finding is stamped fixed with the real commit sha, not a sentinel string', () => {
  const repo = initRepo(); const dir = tmpDir();
  const slug = review.targetSlug('feat/absent-journaled');
  const { env } = seedGatesRound(repo, dir, 'feat/absent-journaled',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:absent', gate: 'correctness', file: 'a.txt', span: 'MISSING_FUNC_XYZ', summary: 'code was missing; prior run fixed it' }
    ]},
    { status: 'ok', rejected: [] });
  // Seed the journal with a commit that proves the fix already landed in a prior
  // crashed run -- this is the legitimate idempotent-replay path.
  const realSha = 'abc123def456abc123def456abc123def456abc123';
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, journal: [{ id: 'correctness:absent', sha: realSha }] };
  review.writeLedger(dir, slug, ledger);

  // plan-fixes: absent + journal-proven -> idempotent replay -> resolvedAbsent, not fixes.
  const planOut = JSON.parse(run(['plan-fixes', 'feat/absent-journaled'], { env }));
  assert.deepStrictEqual(planOut.fixes, []);
  const afterPlan = review.readLedger(dir, slug);
  assert.deepStrictEqual(afterPlan.resolved_absent, ['correctness:absent']);
  assert.deepStrictEqual(afterPlan.planned, []);

  // record: replay is stamped fixed with the REAL journal sha, not the old sentinel string.
  run(['record', 'feat/absent-journaled'], { env });
  const l = review.readLedger(dir, slug);
  const f = l.findings.find((x) => x.id === 'correctness:absent');
  assert.strictEqual(f.status, 'fixed');
  assert.strictEqual(f.fix_commit, realSha); // must be the real sha, not 'span already absent ...'
});

// --- end phantom-fix regression lock ---

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

function writeArtifact(dir, n, name, obj) {
  fs.writeFileSync(path.join(dir, `round-${n}-${name}.json`), JSON.stringify(obj));
}

test('plan-fixes: intent finding on a changed file -> ledger.intent_parked with requirement', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const rs = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  const n = rs.round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.intent_parked.length, 1);
  assert.strictEqual(ledger.intent_parked[0].id, 'intent:retry-count');
  assert.strictEqual(ledger.intent_parked[0].requirement, 'retry three times');
});

test('plan-fixes: intent finding on an UNCHANGED file -> dropped', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:elsewhere', file: 'other.txt', span: 'x', summary: 's', requirement: 'r' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  assert.strictEqual(review.readLedger(dir, review.targetSlug('feat/x')).intent_parked.length, 0);
});

test('plan-fixes: intentHash set but intent artifact missing -> harness-failure', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  // NO round-n-intent.json written -> detector was skipped
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: an intent: id in the CORRECTNESS artifact -> harness-failure (symmetric guard)', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [
    { id: 'intent:sneaky', file: 'a.txt', summary: 'should not auto-fix' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('record: an intent finding terminates intent-review and the handoff shows it', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, false);
  assert.strictEqual(out.decision.intentReview, true);
  assert.match(out.handoff, /status: intent-review/);
  assert.match(out.handoff, /intent: applied/);
  assert.match(out.handoff, /retry three times/);
  assert.match(out.handoff, /intent:retry-count/);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.status, 'intent-review');
});

test('record: park-budget override on an intent-review round clears intentReview, leaving only parked', () => {
  // A round whose OWN decision would be intent-review (an intent finding, no
  // this-round needs-decision parks) must still get force-terminated to
  // "parked" once REVIEW_PARK_BUDGET_DEFAULT prior parks are on the books --
  // and the override must not leave a stale intentReview:true riding along
  // with parked:true, or the command prompt would print "resolve and re-run"
  // intent guidance while the ledger truthfully refuses to resume until `unpark`.
  const { REVIEW_PARK_BUDGET_DEFAULT } = require('../lib/config');
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });

  // Seed REVIEW_PARK_BUDGET_DEFAULT pre-existing needs-decision parks so the
  // breaker trips on this record call, same technique as the plain park-budget test.
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  const priorParks = [];
  for (let i = 0; i < REVIEW_PARK_BUDGET_DEFAULT; i += 1) {
    priorParks.push({ id: `correctness:old-${i}`, gate: 'correctness', file: 'a.txt', span: '', summary: 'x', status: 'parked', park_reason: { kind: 'needs-decision', text: 'prior' } });
  }
  ledger = { ...ledger, findings: priorParks };
  review.writeLedger(dir, slug, ledger);

  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.parked, true);
  assert.ok(!out.decision.intentReview); // must be cleared, not left riding along with parked:true
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.status, 'parked'); // not the stale 'intent-review'
});

test('renderHandoff: no intent config -> "intent: not configured"', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /intent: not configured/);
});

test('renderHandoff: a FAILED DoD surfaces the failing command, exit code, and output tail', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  // A DoD command that fails deterministically with identifiable output on stderr.
  // Commit the config change on its own so it is not part of the reviewed diff
  // (else the coverage gate flags review.config.json as an unexamined change).
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['echo OUTPUT_NEEDLE 1>&2; exit 3'] }));
  execFileSync('git', ['commit', '-aqm', 'set failing dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /DoD: FAILED/);
  // the failing command + its exit code, on the line right after "DoD: FAILED"
  assert.match(out.handoff, /DoD: FAILED\n {2}\$ echo OUTPUT_NEEDLE 1>&2; exit 3 {2}\(exit 3\)/);
  // a tail of the runner's captured output, rendered as an indented line
  assert.match(out.handoff, /\n {4}OUTPUT_NEEDLE/);
});

test('e2e: intent contradiction -> intent-review; fix code + re-run -> clean', () => {
  const repo = initRepoWithIntent('printf "REQ: the retry count must be three"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const slug = review.targetSlug('feat/x');

  // A change that contradicts the requirement (retries once).
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry(1)\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  // --- drive 1: detector raises the contradiction ---
  let n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'retry(1)', summary: 'retries once', requirement: 'the retry count must be three' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  let out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.intentReview, true);
  assert.strictEqual(review.readLedger(dir, slug).status, 'intent-review');

  // --- human fixes the code, re-runs ---
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry(3)\n');
  execFileSync('git', ['commit', '-aqm', 'fix retry count'], { cwd: repo });
  n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~2'], { env })).round; // now two commits past base
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] }); // contradiction gone
  run(['plan-fixes', 'feat/x'], { env });
  out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.converged, true);
  assert.strictEqual(review.readLedger(dir, slug).status, 'clean');
});

test('e2e: no intent config -> the same diff does NOT surface an intent finding (behaves as v0.5.0)', () => {
  const repo = initRepo(); // no intent in config
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry(1)\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env }); // no intent artifact needed; intentHash is null
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.converged, true);
  assert.match(out.handoff, /intent: not configured/);
});

// --- stale-base footgun warning ---
// When the base is a LOCAL branch that is behind its upstream, git diff
// base...HEAD sweeps in every commit merged upstream since the branch point --
// a phantom diff of unrelated files. round-start must emit a non-fatal warning
// to stderr so the user knows to pass the remote ref instead.

test('round-start warns when the base branch is behind its upstream', () => {
  // Set up a repo where local branch `stalebase` is 1 commit behind its
  // upstream `up`, without a real remote (simpler + deterministic).
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-stale-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  // stalebase: anchored at the initial commit.
  execFileSync('git', ['checkout', '-qb', 'stalebase'], { cwd: repo });
  // up: one extra commit ahead of stalebase.
  execFileSync('git', ['checkout', '-qb', 'up'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'extra\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'extra on up'], { cwd: repo });
  // Return to stalebase and declare up as its upstream.
  execFileSync('git', ['checkout', '-q', 'stalebase'], { cwd: repo });
  execFileSync('git', ['branch', '--set-upstream-to=up', 'stalebase'], { cwd: repo });
  // stalebase@{upstream} = up; stalebase is now 1 commit behind up.

  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const r = runCapture(['round-start', 'feat/x', 'stalebase'], { env });

  // Warning is non-fatal: round-start must still exit 0.
  assert.strictEqual(r.status, 0, `round-start must not abort on a stale-base warning; stderr: ${r.stderr}`);
  // Warning text must identify the branch, the commit count, and the root cause.
  assert.match(r.stderr, /behind its upstream/);
  assert.match(r.stderr, /stalebase/);
  assert.match(r.stderr, /\b1\b/); // 1 commit behind

  // Companion: a base ref with NO configured upstream (e.g. HEAD~1) must produce
  // no warning and must not throw (exercises the try/catch in the warning block).
  const repo2 = initRepo();
  fs.writeFileSync(path.join(repo2, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo2 });
  const dir2 = tmpDir();
  const r2 = runCapture(['round-start', 'feat/x', 'HEAD~1'], {
    env: { ...process.env, REVIEW_STATE_DIR: dir2, REVIEW_REPO_ROOT: repo2 },
  });
  assert.strictEqual(r2.status, 0);
  assert.ok(!r2.stderr.includes('behind its upstream'), 'no stale-base warning for a ref without a configured upstream');
  // The upstream lookup fails for a no-upstream base (git prints "fatal: ..." to
  // its own stderr); the warning block must SWALLOW that noise, not leak it. The
  // default base is origin/<main>, which has no upstream, so this path runs every
  // round -- a leaked "fatal:" reads as an error though the run is fine.
  assert.ok(!/fatal|no such branch|no upstream/i.test(r2.stderr), `a no-upstream base must not leak git's stderr; got: ${r2.stderr}`);
});

// ---- dod:null deferred opt-out integration ----

test('a review.config.json with "dod": null converges with the DoD reported DEFERRED, never passed', () => {
  // Infra/VTL/CDK repos have no honest executable DoD (validated only by
  // post-deploy e2e). dod:null is the explicit opt-out: the review gates still
  // run; the executable DoD is skipped and labeled deferred, never faked.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-dod-defer-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: null }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };

  // Commit a change so there is a real diff.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  // round-start: before the fix this throws because loadDodConfig throws on dod:null.
  const rsOut = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(rsOut.decision, 'work');

  const n = rsOut.round;

  // Write gate artifacts: zero correctness findings, zero rejections.
  fs.writeFileSync(
    path.join(dir, `round-${n}-correctness.json`),
    JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }),
  );
  fs.writeFileSync(
    path.join(dir, `round-${n}-verify.json`),
    JSON.stringify({ status: 'ok', rejected: [] }),
  );

  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));

  // A deferred DoD must not block convergence: zero open findings -> converged.
  assert.strictEqual(out.decision.converged, true, 'dod:null should allow convergence when no findings remain');
  // The handoff must clearly label the DoD deferred, never fake it as "passed".
  assert.match(out.handoff, /DEFERRED/);
  assert.ok(!out.handoff.includes('DoD: passed'), 'deferred DoD must never be reported as "DoD: passed"');
});
