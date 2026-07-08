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
  const sha = cli.gitCommitFix(repo, 'correctness:x', 'fix it');
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

test('review-cli round-start: reads target+diff JSON from stdin, persists a ledger, prints round info', () => {
  const dir = tmpDir();
  const payload = JSON.stringify({ target: { kind: 'local', ref: 'feat/x', base: 'main', head_sha: 'abc' }, diff: 'diff --git a b' });
  const out = run(['round-start', 'feat/x'], { input: payload, env: { ...process.env, REVIEW_STATE_DIR: dir } });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.round, 1);
  assert.strictEqual(parsed.noOp, false);

  const slug = review.targetSlug('feat/x');
  const ledger = review.readLedger(dir, slug);
  assert.strictEqual(ledger.round, 1);
  assert.strictEqual(ledger.target.head_sha, 'abc');
});

test('review-cli round-start: a second call with the identical diff is a no-op round (no budget burn)', () => {
  const dir = tmpDir();
  const payload = JSON.stringify({ target: { kind: 'local', ref: 'feat/x' }, diff: 'same diff' });
  run(['round-start', 'feat/x'], { input: payload, env: { ...process.env, REVIEW_STATE_DIR: dir } });
  const out2 = run(['round-start', 'feat/x'], { input: payload, env: { ...process.env, REVIEW_STATE_DIR: dir } });
  const parsed2 = JSON.parse(out2);
  assert.strictEqual(parsed2.noOp, true);
  assert.strictEqual(parsed2.budget.spent, 1);
});

test('review-cli record: applies a round outcome from stdin JSON and persists the resulting ledger', () => {
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  run(['round-start', 'feat/x'], { input: JSON.stringify({ target: { kind: 'local', ref: 'feat/x' }, diff: 'd1' }), env });

  const outcome = JSON.stringify({
    dodPassed: true,
    findings: [{ id: 'f1', gate: 'correctness', file: 'a.js', span: 'bad code', summary: 'bug', status: 'confirmed' }],
    fixedIds: ['f1'],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'none',
  });
  const out = run(['record', 'feat/x'], { input: outcome, env });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.decision.converged, true);

  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.status, 'clean');
  assert.strictEqual(ledger.findings[0].status, 'fixed');
});

test('review-cli record: shell-injection-safe -- a finding summary containing shell metacharacters never reaches a shell', () => {
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  run(['round-start', 'feat/x'], { input: JSON.stringify({ target: { kind: 'local', ref: 'feat/x' }, diff: 'd1' }), env });
  const dangerous = '`rm -rf /`; $(whoami); "; echo pwned #';
  const outcome = JSON.stringify({
    dodPassed: false,
    findings: [{ id: 'f1', gate: 'correctness', file: 'a.js', span: dangerous, summary: dangerous, status: 'confirmed' }],
    fixedIds: [],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'none',
  });
  assert.doesNotThrow(() => run(['record', 'feat/x'], { input: outcome, env }));
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.findings.find((f) => f.id === 'f1').status, 'open');
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

test('review-cli: REVIEW_STATE_DIR overrides the cwd-derived state dir', () => {
  const dir = tmpDir();
  run(['round-start', 'feat/y'], {
    input: JSON.stringify({ target: { kind: 'local', ref: 'feat/y' }, diff: 'x' }),
    env: { ...process.env, REVIEW_STATE_DIR: dir },
  });
  assert.ok(fs.existsSync(review.ledgerPath(dir, review.targetSlug('feat/y'))));
});
