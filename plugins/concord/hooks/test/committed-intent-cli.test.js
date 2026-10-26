'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { readLedger, writeLedger, targetSlug } = require('../../core/review');

const CLI = path.join(__dirname, '..', 'review-cli.js');
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function setup(t, { config = { dod: null }, note = 'Approved requirement v1' } = {}) {
  const repo = tempDir('committed-intent-cli-repo-');
  const state = tempDir('committed-intent-cli-state-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'before');
  fs.mkdirSync(path.join(repo, 'requirements'));
  fs.writeFileSync(path.join(repo, 'requirements/spec.md'), note);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'after');
  git(repo, 'commit', '-qam', 'target');
  const env = { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: state };
  function call(args, cwd = repo) { return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' }); }
  return { repo, state, env, call, target: 'feat/committed-intent', base: 'HEAD~1', notePath: 'requirements/spec.md', ledger(ref = 'feat/committed-intent') { return readLedger(state, targetSlug(ref)); } };
}
function start(f, ref = f.target, extra = []) { return f.call(['round-start', ref, f.base, '--no-broad', ...extra]); }
function receiptDismiss(f) {
  const id = 'gate:design-conformance:scope';
  const ledger = f.ledger();
  writeLedger(f.state, targetSlug(f.target), { ...ledger, phase: 'done', status: 'gate-pending', gate_open: [{
    id, file: 'a.txt', span: 'scope', summary: 'Scope question', rationale: 'Only scope needs a human decision.',
    releaseBlocking: ['contract-choice'],
  }] });
  const snapshotCall = f.call(['decision-snapshot', f.target, id, '--action', 'dismiss']);
  assert.equal(snapshotCall.status, 0, snapshotCall.stderr);
  const decision = JSON.parse(snapshotCall.stdout);
  const receipt = path.join(f.repo, 'decision.json');
  fs.writeFileSync(receipt, JSON.stringify({
    version: 1, by: 'human', sessionId: 'scope-decision-session',
    text: 'Only the scope question is dismissed; retain the approved contract.',
    decisions: [{ ...decision, classification: 'design-decision', classificationReason: 'The existing contract remains approved.' }],
  }));
  const dismissed = f.call(['dismiss', f.target, id, '--decision', receipt]);
  assert.equal(dismissed.status, 0, dismissed.stderr);
  fs.unlinkSync(receipt);
}

test('round-start loads the exact committed note and records its source identity', (t) => {
  const f = setup(t);
  const result = start(f, f.target, ['--intent-path', f.notePath]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout); const ledger = f.ledger();
  assert.equal(fs.readFileSync(path.join(f.state, `intent-${targetSlug(f.target)}.md`), 'utf8'), 'Approved requirement v1');
  assert.equal(output.intentSource.kind, 'committed-file');
  assert.equal(ledger.intentSource.path, f.notePath);
  assert.equal(ledger.intentSource.commit, git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(ledger.intentSource.blob, git(f.repo, 'rev-parse', `HEAD:${f.notePath}`));
  assert.equal(output.intentHash, ledger.intentHash);
  assert.equal(ledger.intentBytes, Buffer.byteLength('Approved requirement v1'));
});

test('configured project command wins over the committed-path fallback', (t) => {
  const f = setup(t, { config: { dod: null, intent: { command: "printf 'configured requirement'" } } });
  const result = start(f, f.target, ['--intent-path', f.notePath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.state, `intent-${targetSlug(f.target)}.md`), 'utf8'), 'configured requirement');
  assert.equal(f.ledger().intentSource.kind, 'project-command');
});

test('legacy command-backed ledger without source metadata resumes when the fetched hash matches', (t) => {
  const f = setup(t, { config: { dod: null, intent: { command: "printf 'stable configured requirement'" } } });
  const first = start(f, f.target);
  assert.equal(first.status, 0, first.stderr);
  const ledger = f.ledger();
  delete ledger.intentSource; // beta52 ledger shape
  writeLedger(f.state, targetSlug(f.target), ledger);
  const before = fs.readFileSync(path.join(f.state, `intent-${targetSlug(f.target)}.md`));
  const resumed = f.call(['round-start', f.target]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.state, `intent-${targetSlug(f.target)}.md`)), before);
  assert.equal(f.ledger().intentHash, ledger.intentHash);
  assert.equal(f.ledger().intentSource.kind, 'project-command');
});

test('legacy same-content switch from configured command to explicit intent file remains compatible', (t) => {
  const text = 'same legacy intent text';
  const f = setup(t, { config: { dod: null, intent: { command: `printf '${text}'` } } });
  assert.equal(start(f).status, 0);
  const fileDir = tempDir('legacy-command-to-file-'); const intentFile = path.join(fileDir, 'intent.md');
  fs.writeFileSync(intentFile, text);
  const switched = f.call(['round-start', f.target, '--no-intent-command', '--intent-file', intentFile]);
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(f.ledger().intentHash, require('../../core/review').contentHash(text));
});

test('legacy same-content switch from explicit intent file to configured command remains compatible', (t) => {
  const text = 'same legacy intent text';
  const f = setup(t, { config: { dod: null, intent: { command: `printf '${text}'` } } });
  const fileDir = tempDir('legacy-file-to-command-'); const intentFile = path.join(fileDir, 'intent.md');
  fs.writeFileSync(intentFile, text);
  assert.equal(start(f, f.target, ['--intent-file', intentFile]).status, 0);
  const switched = f.call(['round-start', f.target]);
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(f.ledger().intentHash, require('../../core/review').contentHash(text));
});

test('legacy configured-command ledger migrates with a persisted but unused fallback selector', (t) => {
  const f = setup(t, { config: { dod: null, intent: { command: "printf 'stable configured requirement'" } } });
  const first = start(f, f.target, ['--intent-path', f.notePath]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(f.ledger().intentSource.kind, 'project-command');
  const ledger = f.ledger();
  delete ledger.intentSource; // prior ledger has a selector but no source metadata
  writeLedger(f.state, targetSlug(f.target), ledger);
  const cachedPath = path.join(f.state, `intent-${targetSlug(f.target)}.md`);
  const before = fs.readFileSync(cachedPath);
  const resumed = f.call(['round-start', f.target]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(fs.readFileSync(cachedPath), before);
  assert.equal(f.ledger().intentHash, ledger.intentHash);
  assert.equal(f.ledger().intentSource.kind, 'project-command');
  assert.equal(f.ledger().intentPath, f.notePath);
});

test('broken configured source fails closed without falling back to the committed path', (t) => {
  const f = setup(t, { config: { dod: null, intent: { command: 'exit 9' } } });
  const result = start(f, f.target, ['--intent-path', f.notePath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /intent fetch command exited 9/);
  assert.equal(f.ledger(), null);
});

test('--no-intent-command suppresses configuration and still permits the committed path', (t) => {
  const f = setup(t, { config: { dod: null, intent: { command: 'exit 9' } } });
  const result = start(f, f.target, ['--no-intent-command', '--intent-path', f.notePath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ledger().intentSource.kind, 'committed-file');
});

test('rejects untracked committed-path selectors, file targets, and mixed legacy selectors', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.repo, 'untracked.md'), 'uncommitted');
  assert.notEqual(start(f, f.target, ['--intent-path', 'untracked.md']).status, 0);
  assert.notEqual(start(f, 'file:requirements/spec.md', ['--intent-path', f.notePath]).status, 0);
  assert.notEqual(start(f, f.target, ['--intent-path', f.notePath, '--intent-file', '/tmp/unused']).status, 0);
});

test('resume inherits the persisted committed-path selector without a repeated flag', (t) => {
  const f = setup(t); const first = start(f, f.target, ['--intent-path', f.notePath]);
  assert.equal(first.status, 0, first.stderr);
  const resumed = f.call(['round-start', f.target]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.ledger().intentSource.path, f.notePath);
});

test('same committed bytes at a new reviewed head refresh source commit metadata', (t) => {
  const f = setup(t); assert.equal(start(f, f.target, ['--intent-path', f.notePath]).status, 0);
  const oldCommit = f.ledger().intentSource.commit;
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'another target change');
  git(f.repo, 'add', 'a.txt'); git(f.repo, 'commit', '-qm', 'advance target');
  const resumed = f.call(['round-start', f.target]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.notEqual(f.ledger().intentSource.commit, oldCommit);
  assert.equal(f.ledger().intentSource.blob, git(f.repo, `rev-parse`, `HEAD:${f.notePath}`));
});

test('changing committed path authority mid-attempt is refused even before a new read', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.repo, 'requirements/other.md'), 'Approved requirement v1');
  git(f.repo, 'add', 'requirements/other.md'); git(f.repo, 'commit', '-qm', 'add alternate note');
  assert.equal(start(f, f.target, ['--intent-path', f.notePath]).status, 0);
  const result = f.call(['round-start', f.target, '--intent-path', 'requirements/other.md']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the active run/);
});

test('changed committed note fails drift check and preserves the cached intent', (t) => {
  const f = setup(t); assert.equal(start(f, f.target, ['--intent-path', f.notePath]).status, 0);
  const before = f.ledger(); const cachedPath = path.join(f.state, `intent-${targetSlug(f.target)}.md`);
  fs.writeFileSync(path.join(f.repo, f.notePath), 'Approved requirement v2');
  git(f.repo, 'add', f.notePath); git(f.repo, 'commit', '-qm', 'change requirement');
  const changed = f.call(['round-start', f.target]);
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /intent source changed/);
  assert.equal(fs.readFileSync(cachedPath, 'utf8'), 'Approved requirement v1');
  assert.equal(f.ledger().intentHash, before.intentHash);
  assert.equal(f.ledger().intentSource.blob, before.intentSource.blob);
});

test('explicit rerun adopts the current committed note while retaining the selector', (t) => {
  const f = setup(t); assert.equal(start(f, f.target, ['--intent-path', f.notePath]).status, 0);
  fs.writeFileSync(path.join(f.repo, f.notePath), 'Approved requirement v2');
  git(f.repo, 'add', f.notePath); git(f.repo, 'commit', '-qm', 'change requirement');
  const rerun = f.call(['rerun', f.target]); assert.equal(rerun.status, 0, rerun.stderr);
  const next = f.call(['round-start', f.target]); assert.equal(next.status, 0, next.stderr);
  const ledger = f.ledger();
  assert.equal(ledger.intentPath, f.notePath);
  assert.equal(fs.readFileSync(path.join(f.state, `intent-${targetSlug(f.target)}.md`), 'utf8'), 'Approved requirement v2');
});

test('receipt dismissal keeps committed intent pinned through fresh-look drift; rerun adopts changes', (t) => {
  const f = setup(t); assert.equal(start(f, f.target, ['--intent-path', f.notePath]).status, 0);
  const oldLedger = f.ledger(); const cache = path.join(f.state, `intent-${targetSlug(f.target)}.md`);
  receiptDismiss(f);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'Approved requirement v1');
  assert.equal(f.ledger().intentHash, oldLedger.intentHash);
  assert.equal(f.ledger().intentSource.blob, oldLedger.intentSource.blob);
  fs.writeFileSync(path.join(f.repo, f.notePath), 'Approved requirement v2');
  git(f.repo, 'add', f.notePath); git(f.repo, 'commit', '-qm', 'change approved note');
  const attempted = f.call(['round-start', f.target]);
  assert.notEqual(attempted.status, 0); assert.match(attempted.stderr, /intent source changed/);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'Approved requirement v1');
  assert.equal(f.ledger().intentHash, oldLedger.intentHash);
  assert.equal(f.ledger().intentSource.blob, oldLedger.intentSource.blob);
  const rerun = f.call(['rerun', f.target]); assert.equal(rerun.status, 0, rerun.stderr);
  const adopted = f.call(['round-start', f.target]); assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'Approved requirement v2');
});

test('receipt fresh-look does not switch configured intent to its stored committed fallback', (t) => {
  const f = setup(t, { config: { dod: null, intent: { command: "printf 'Approved requirement v1'" } } });
  assert.equal(start(f, f.target, ['--intent-path', f.notePath]).status, 0);
  const oldLedger = f.ledger(); const cache = path.join(f.state, `intent-${targetSlug(f.target)}.md`);
  assert.equal(oldLedger.intentSource.kind, 'project-command');
  receiptDismiss(f);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'Approved requirement v1');
  fs.writeFileSync(path.join(f.repo, 'review.config.json'), JSON.stringify({ dod: null }));
  git(f.repo, 'add', 'review.config.json'); git(f.repo, 'commit', '-qm', 'remove configured intent');
  const attempted = f.call(['round-start', f.target]);
  assert.notEqual(attempted.status, 0); assert.match(attempted.stderr, /intent source authority changed/);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'Approved requirement v1');
  assert.equal(f.ledger().intentHash, oldLedger.intentHash);
  assert.equal(f.ledger().intentSource.kind, 'project-command');
});
