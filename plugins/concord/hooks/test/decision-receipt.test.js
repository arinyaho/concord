'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('../../core/review');
const decisionReceipt = require('../../core/decision-receipt');
const { tempDir } = require('./temp-dir');
const cli = path.resolve(__dirname, '../review-cli.js');
function fixture(action = 'dismiss') {
  const repo = tempDir('decision-repo-'), state = tempDir('decision-state-'), ref = 'feature/receipt';
  const id = action === 'dismiss' ? 'gate:design-conformance:scope' : 'correctness:scope';
  const finding = { id, file: 'a.js', span: 'old', summary: 'scope question', requirement: 'approved outcome', releaseBlocking: ['contract-choice'], rationale: 'Needs a human decision.' };
  const ledger = { ...R.emptyLedger({ type: 'git', ref, head_sha: 'reviewed-head' }), round: 2, phase: 'done', status: 'gate-pending',
    gate_open: action === 'dismiss' ? [finding] : [], findings: action === 'defer' ? [{ ...finding, status: 'open' }] : [],
    ...(action === 'defer' ? { reconciliation: { trigger: 'group-reconcile', groups: [{ groupId: 'g', findingIds: [id] }] } } : {}) };
  const slug = R.targetSlug(ref); R.writeLedger(state, slug, ledger);
  const read = () => R.readLedger(state, slug), write = x => R.writeLedger(state, slug, x);
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: state }, encoding: 'utf8', timeout: 2000 });
  const json = (...args) => { const p = invoke(...args); assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout); };
  const snapshot = () => json('decision-snapshot', ref, id, '--action', action);
  const receipt = (mutate = x => x) => { const value = mutate({ version: 1, by: 'human', sessionId: 'coordinator-session', text: 'Keep this out of this PR; track the named issue.', decisions: [{ ...snapshot(), ...(action === 'dismiss' ? { classification: 'design-decision', classificationReason: 'The approved contract covers it.' } : { reason: 'Outside approved scope.', ref: 'https://example.test/issues/1' }) }] }); const file = path.join(repo, 'decision.json'); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  return { repo, state, ref, id, finding, read, write, invoke, json, snapshot, receipt, bytes: () => fs.readFileSync(R.ledgerPath(state, slug), 'utf8') };
}
test('decision snapshots are read-only and receipt-based dismiss/defer preserve exact human provenance', () => {
  for (const action of ['dismiss', 'defer']) {
    const h = fixture(action), before = h.bytes(), snap = h.snapshot();
    assert.equal(h.bytes(), before); assert.equal(snap.action, action); assert.match(snap.findingHash, /^[a-f0-9]{64}$/); assert.match(snap.bindingHash, /^[a-f0-9]{64}$/);
    const file = h.receipt(), out = h.invoke(action, h.ref, h.id, '--decision', file);
    assert.equal(out.status, 0, out.stderr);
    const entry = action === 'dismiss' ? h.read().gate_dismissed[0] : h.read().findings[0].deferral;
    assert.equal(entry.decisionProvenance.by, 'human'); assert.equal(entry.decisionProvenance.sessionId, 'coordinator-session');
    assert.equal(entry.decisionProvenance.text, 'Keep this out of this PR; track the named issue.');
    const accepted = h.bytes(); assert.equal(h.invoke(action, h.ref, h.id, '--decision', file).status, 0); assert.equal(h.bytes(), accepted);
    const changed = JSON.parse(fs.readFileSync(file)); changed.text = 'Different decision'; fs.writeFileSync(file, JSON.stringify(changed));
    assert.notEqual(h.invoke(action, h.ref, h.id, '--decision', file).status, 0); assert.equal(h.bytes(), accepted);
  }
});
test('a receipt cannot authorize another target, worker, round, action, or changed finding', () => {
  for (const field of ['repository', 'stateDir', 'bindingHash', 'target', 'attemptId', 'round', 'head', 'id', 'action', 'findingHash']) {
    const h = fixture(), file = h.receipt(x => { x.decisions[0][field] = field === 'round' ? 3 : field === 'findingHash' ? '0'.repeat(64) : 'other'; return x; }), before = h.bytes();
    assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file).status, 0, field); assert.equal(h.bytes(), before);
  }
  const h = fixture(), file = h.receipt(); h.write({ ...h.read(), gate_open: [{ ...h.finding, blockingReason: 'Verifier found a blocker.' }] });
  const before = h.bytes(); assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file).status, 0); assert.equal(h.bytes(), before);
});
test('malformed/ambiguous receipts, unsafe files and CLI overrides fail without mutation', () => {
  for (const mutate of [x => ({ ...x, text: '' }), x => ({ ...x, sessionId: '' }), x => ({ ...x, extra: true }), x => ({ ...x, decisions: [...x.decisions, x.decisions[0]] })]) {
    const h = fixture(), file = h.receipt(mutate), before = h.bytes(); assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file).status, 0); assert.equal(h.bytes(), before);
  }
  const h = fixture(), file = h.receipt(), before = h.bytes();
  for (const extra of [['--by', 'other'], ['--classification', 'defect'], ['--reason', 'override'], ['--decision', file]]) assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file, ...extra).status, 0);
  const link = path.join(h.repo, 'link.json'); fs.symlinkSync(file, link); assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', link).status, 0);
  if (process.platform !== 'win32') {
    const fifo = path.join(h.repo, 'receipt.fifo'), made = spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, made.stderr?.toString());
    const start = Date.now(), result = h.invoke('dismiss', h.ref, h.id, '--decision', fifo);
    assert.notEqual(result.status, 0); assert.ok(Date.now() - start < 2000, 'FIFO receipt refusal must not block');
  }
  fs.writeFileSync(file, ' '.repeat(65537)); assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file).status, 0); assert.equal(h.bytes(), before);
});
test('legacy --by remains supported and missing snapshot state creates nothing', () => {
  const h = fixture(); assert.equal(h.invoke('dismiss', h.ref, h.id, '--by', 'legacy-human').status, 0); assert.equal(h.read().gate_dismissed[0].dismissedBy, 'legacy-human');
  const repo = tempDir('decision-missing-'), state = path.join(repo, 'absent');
  const out = spawnSync(process.execPath, [cli, 'decision-snapshot', 'missing', 'gate:scope', '--action', 'dismiss'], { cwd: repo, env: { ...process.env, REVIEW_STATE_DIR: state }, encoding: 'utf8' });
  assert.notEqual(out.status, 0); assert.equal(fs.existsSync(state), false);
});

test('one coordinator receipt can contain identically named findings in different workers', () => {
  const a = fixture(), b = fixture();
  const entries = [a.snapshot(), b.snapshot()];
  const file = path.join(a.repo, 'batch.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, by: 'human', sessionId: 'coordinator', text: 'Dismiss both explicitly named snapshots.', decisions: entries }));
  for (const h of [a, b]) assert.equal(h.invoke('dismiss', h.ref, h.id, '--decision', file).status, 0);
});

test('receipt actions cannot create or change initiative ownership', () => {
  const h = fixture(), file = h.receipt(), initiative = path.join(h.repo, 'initiative');
  const flags = ['--initiative-run-key', 'new-key', '--initiative-state-dir', initiative, '--initiative-max-launches', '10', '--initiative-max-rounds', '3'];
  const before = h.bytes();
  assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file, ...flags).status, 0);
  assert.equal(h.bytes(), before); assert.equal(fs.existsSync(initiative), false);
  assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', path.join(h.repo, 'missing.json'), ...flags).status, 0);
  assert.equal(fs.existsSync(initiative), false);
  h.write({ ...h.read(), initiative_binding: { key: 'owned', stateDir: initiative } });
  const bound = h.bytes();
  assert.notEqual(h.invoke('dismiss', h.ref, h.id, '--decision', file, ...flags.slice(0, 0), '--initiative-run-key', 'owned', ...flags.slice(2)).status, 0);
  assert.equal(h.bytes(), bound); assert.equal(fs.existsSync(initiative), false);
});

test('a copied ledger or changed initiative binding cannot reuse the old receipt', () => {
  const original = fixture(), file = original.receipt();
  const copied = fixture();
  const copiedBefore = copied.bytes();
  assert.notEqual(copied.invoke('dismiss', copied.ref, copied.id, '--decision', file).status, 0);
  assert.equal(copied.bytes(), copiedBefore);

  const originalBefore = original.bytes();
  const changedBinding = { ...original.read(), initiative_binding: { key: 'carried-key', stateDir: path.join(original.repo, 'initiative') } };
  assert.throws(() => decisionReceipt.resolveDecision({ file, repoRoot: original.repo, stateDir: original.state, ledger: changedBinding,
    id: original.id, action: 'dismiss', finding: original.finding }), /exact worker, finding, action, attempt, round and revision/);
  assert.equal(original.bytes(), originalBefore, 'binding mismatch is a read-only refusal');
});
