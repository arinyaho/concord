'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../../core/review');
const { openInitiativeRun } = require('../../core/initiative-review-run');

const CORE = path.join(__dirname, '..', '..', 'core');
const CLI = path.join(__dirname, '..', 'review-cli.js');
const INJECTOR = path.join(__dirname, '..', 'review-injector.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-safety-'));
const tmpFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

// Fails the first `failures` renames with `code`; Infinity fails every rename.
function withRenameFailing(code, failures, fn) {
  const real = fs.renameSync;
  let n = 0;
  fs.renameSync = (from, to) => {
    if (failures === Infinity || n++ < failures) throw Object.assign(new Error(`${code}: injected`), { code });
    return real(from, to);
  };
  try { return fn(); } finally { fs.renameSync = real; }
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`writeLedger retries a transient ${code} rename failure and never exposes partial JSON`, () => {
    const dir = tmp();
    const slug = 'feat-x';
    const before = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
    review.writeLedger(dir, slug, before);
    withRenameFailing(code, 2, () => review.writeLedger(dir, slug, { ...before, round: 3 }));
    assert.strictEqual(review.readLedger(dir, slug).round, 3);
    assert.deepStrictEqual(tmpFiles(dir), []);
  });
}

test('writeLedger fails after bounded retries on a persistent rename failure and leaves no temp file', () => {
  const dir = tmp();
  const slug = 'feat-x';
  const before = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  review.writeLedger(dir, slug, before);
  assert.throws(() => withRenameFailing('EPERM', Infinity, () => review.writeLedger(dir, slug, { ...before, round: 9 })), /EPERM/);
  assert.deepStrictEqual(tmpFiles(dir), []);
  assert.strictEqual(review.readLedger(dir, slug).round, 0, 'previous ledger stays intact');
});

test('a non-retryable rename error is not retried and leaves no temp file', () => {
  const dir = tmp();
  let calls = 0;
  const real = fs.renameSync;
  fs.renameSync = () => { calls++; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  try { assert.throws(() => review.writeLedger(dir, 'a', {}), /ENOSPC/); } finally { fs.renameSync = real; }
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(tmpFiles(dir), []);
});

test('initiative run write retries a transient rename failure', () => {
  const dir = tmp();
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const run = withRenameFailing('EBUSY', 2, () => openInitiativeRun({ stateDir: dir, repository: repo, key: 'i', maxLaunches: 3, maxRounds: 3 }));
  assert.ok(run);
  assert.deepStrictEqual(tmpFiles(dir), []);
});

test('all four write sites route through the shared atomic-write helper', () => {
  for (const f of ['review.js', 'initiative-review-run.js', 'codex-review-runner.js', 'review-cli.js']) {
    const src = fs.readFileSync(path.join(CORE, f), 'utf8');
    assert.ok(!/fs\.renameSync\(/.test(src), `${f} must not rename directly`);
    assert.match(src, /require\('\.\/atomic-write'\)/, `${f} must use the shared helper`);
  }
});

test('readLedger returns null only for a missing file and throws on unreadable content', () => {
  const dir = tmp();
  assert.strictEqual(review.readLedger(dir, 'nope'), null);
  fs.writeFileSync(review.ledgerPath(dir, 'bad'), '{"trunc');
  assert.throws(() => review.readLedger(dir, 'bad'), /review-bad\.json/);
});

test('readLedger throws on valid JSON that is not an object', () => {
  const dir = tmp();
  for (const body of ['null', '[]', '0', '"x"']) {
    fs.writeFileSync(review.ledgerPath(dir, 'nonobj'), body);
    assert.throws(() => review.readLedger(dir, 'nonobj'), /unreadable review ledger/, body);
  }
});

function repoWithCommit() {
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'i'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'c'], { cwd: repo });
  return repo;
}

test('round-start on a present but unreadable ledger fails and does not start a fresh run', () => {
  const repo = repoWithCommit();
  const dir = tmp();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const file = review.ledgerPath(dir, review.targetSlug('feat/x'));
  fs.writeFileSync(file, '{"trunc');
  const r = spawnSync('node', [CLI, 'round-start', 'feat/x', 'HEAD~1', '--no-broad'], { encoding: 'utf8', env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /review-feat-x\.json/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"trunc', 'unreadable ledger is left untouched');
  fs.unlinkSync(file);
  const ok = spawnSync('node', [CLI, 'round-start', 'feat/x', 'HEAD~1', '--no-broad'], { encoding: 'utf8', env });
  assert.strictEqual(ok.status, 0, ok.stderr);
});

test('reset and rerun replace an unreadable ledger with a valid state', () => {
  const dir = tmp();
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  const slug = review.targetSlug('feat/x');
  const file = review.ledgerPath(dir, slug);
  fs.writeFileSync(file, '{"trunc');
  const out = execFileSync('node', [CLI, 'reset', 'feat/x'], { encoding: 'utf8', env });
  assert.match(out, /reset ref "feat\/x"/);
  assert.strictEqual(review.readLedger(dir, slug), null);

  fs.writeFileSync(file, '{"trunc');
  execFileSync('node', [CLI, 'rerun', 'feat/x'], { encoding: 'utf8', env });
  const l = review.readLedger(dir, slug);
  assert.strictEqual(l.status, 'converging');
  assert.strictEqual(l.round, 0);
});

test('SessionStart lists the valid ledger and names the corrupt one without throwing', () => {
  const proj = tmp();
  const stateDir = path.join(proj, 'state');
  fs.mkdirSync(stateDir);
  review.writeLedger(stateDir, review.targetSlug('feat/ok'), review.emptyLedger({ kind: 'local', ref: 'feat/ok' }));
  fs.writeFileSync(path.join(stateDir, 'review-feat-bad.json'), '{"trunc');
  const out = execFileSync('node', [INJECTOR], { input: JSON.stringify({ session_id: 'sess', transcript_path: path.join(proj, 'sess.jsonl'), source: 'startup' }), encoding: 'utf8' });
  assert.match(out, /feat\/ok/);
  assert.match(out, /review-feat-bad\.json/);
});
