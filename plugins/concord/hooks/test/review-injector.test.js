'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const review = require('../../core/review');

const INJECTOR = path.join(__dirname, '..', 'review-injector.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rproj-'));
  const stateDir = path.join(proj, 'state');
  fs.mkdirSync(stateDir);
  return { transcript: path.join(proj, 'sess.jsonl'), stateDir, id: 'sess' };
}

function run(input) {
  return execFileSync('node', [INJECTOR], { input: JSON.stringify(input), encoding: 'utf8' });
}

test('review-injector: surfaces a converging ledger with a resume invitation', () => {
  const { transcript, stateDir, id } = setup();
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.round = 2;
  ledger.findings.push({ id: 'f1', status: 'open' });
  review.writeLedger(stateDir, review.targetSlug('feat/x'), ledger);

  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(out.includes('feat/x'));
  assert.ok(/resume/i.test(out));
});

test('review-injector: surfaces a parked ledger report-only (no resume invitation)', () => {
  const { transcript, stateDir, id } = setup();
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/y' });
  ledger.status = 'parked';
  ledger.findings.push({ id: 'f2', status: 'parked' });
  review.writeLedger(stateDir, review.targetSlug('feat/y'), ledger);

  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(out.includes('feat/y'));
  assert.ok(!/resume with/i.test(out));
});

test('review-injector: no ledgers -> empty stdout, never blocks session start', () => {
  const { transcript, id } = setup();
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.strictEqual(out, '');
});

test('review-injector: missing transcript_path exits cleanly with no output', () => {
  const out = execFileSync('node', [INJECTOR], { input: JSON.stringify({ session_id: 'x' }), encoding: 'utf8' });
  assert.strictEqual(out, '');
});

test('review-injector: malformed stdin does not throw and exits 0', () => {
  assert.doesNotThrow(() => execFileSync('node', [INJECTOR], { input: 'not json', encoding: 'utf8' }));
});

test('review-injector: uses the transcript-derived state dir, not cwd', () => {
  const { transcript, stateDir, id } = setup();
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/z' });
  review.writeLedger(stateDir, review.targetSlug('feat/z'), ledger);
  const out = run({ session_id: id, transcript_path: transcript, source: 'resume' });
  assert.ok(out.includes('feat/z'));
});
