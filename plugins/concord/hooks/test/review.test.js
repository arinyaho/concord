'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const review = require('../../core/review');

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
}

function finding(overrides) {
  return {
    id: 'f1',
    gate: 'correctness',
    file: 'src/a.js',
    line: 10,
    span: 'if (x = 1) { doThing(); }',
    summary: 'assignment used where comparison intended',
    status: 'confirmed',
    ...overrides,
  };
}

// ---- targetSlug ----

test('targetSlug: branch names with "/" become "-"', () => {
  assert.strictEqual(review.targetSlug('feat/review-until-green-shell'), 'feat-review-until-green-shell');
});

test('targetSlug: PR ref "#123" strips the "#"', () => {
  assert.strictEqual(review.targetSlug('#123'), '123');
});

test('targetSlug: empty/absent ref falls back to "unknown"', () => {
  assert.strictEqual(review.targetSlug(''), 'unknown');
  assert.strictEqual(review.targetSlug(undefined), 'unknown');
});

test('targetSlug: collapses runs of unsafe chars and trims edges', () => {
  assert.strictEqual(review.targetSlug('weird//: name!!'), 'weird-name');
});

// ---- ledger read/write ----

test('ledger: readLedger returns null when absent; writeLedger + readLedger round-trips', () => {
  const dir = tmpStateDir();
  const slug = review.targetSlug('feat/x');
  assert.strictEqual(review.readLedger(dir, slug), null);
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x', base: 'main', head_sha: 'abc' });
  review.writeLedger(dir, slug, ledger);
  const back = review.readLedger(dir, slug);
  assert.deepStrictEqual(back, ledger);
  assert.ok(fs.existsSync(review.ledgerPath(dir, slug)));
  assert.ok(path.basename(review.ledgerPath(dir, slug)).startsWith('review-'));
});

test('ledger: readLedger returns null on corrupt JSON rather than throwing', () => {
  const dir = tmpStateDir();
  const slug = 'broken';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(review.ledgerPath(dir, slug), '{not json');
  assert.strictEqual(review.readLedger(dir, slug), null);
});

test('emptyLedger: sane defaults, status converging, every field present', () => {
  const target = { kind: 'local', ref: 'feat/x', base: 'main', head_sha: 'abc' };
  const l = review.emptyLedger(target);
  assert.deepStrictEqual(l.target, target);
  assert.strictEqual(l.status, 'converging');
  assert.strictEqual(l.round, 0);
  assert.strictEqual(l.budget.spent, 0);
  assert.ok(l.budget.max_rounds > 0);
  assert.strictEqual(l.diff_content_hash, null);
  assert.deepStrictEqual(l.findings, []);
  assert.deepStrictEqual(l.seen, []);
  assert.deepStrictEqual(l.history, []);
});

test('emptyLedger: carries the new phase/dod/planned/journal/last_recorded_round fields', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  assert.strictEqual(l.phase, 'idle');
  assert.strictEqual(l.dod, null);
  assert.deepStrictEqual(l.planned, []);
  assert.deepStrictEqual(l.journal, []);
  assert.strictEqual(l.last_recorded_round, null);
});

test('emptyLedger: carries the new gateApplied field, defaulting false', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  assert.strictEqual(l.gateApplied, false);
});

// ---- seenHash: line-number independence ----

test('seenHash: identical gate/file/span/summary hash the same regardless of line number', () => {
  const a = finding({ line: 10 });
  const b = finding({ line: 999 });
  assert.strictEqual(review.seenHash(a), review.seenHash(b));
});

test('seenHash: whitespace-only differences in span/summary normalize to the same hash', () => {
  const a = finding({ span: 'if (x = 1) { doThing(); }', summary: 'assignment used where comparison intended' });
  const b = finding({ span: '  if (x = 1) {   doThing();   }  ', summary: 'Assignment used where comparison intended' });
  assert.strictEqual(review.seenHash(a), review.seenHash(b));
});

test('seenHash: different span content hashes differently', () => {
  const a = finding({ span: 'if (x = 1) { doThing(); }' });
  const b = finding({ span: 'if (x === 1) { doThing(); }' });
  assert.notStrictEqual(review.seenHash(a), review.seenHash(b));
});

test('seenHash: different gate or file hashes differently even with identical span+summary', () => {
  const a = finding({ gate: 'correctness' });
  const b = finding({ gate: 'dod' });
  const c = finding({ file: 'src/b.js' });
  assert.notStrictEqual(review.seenHash(a), review.seenHash(b));
  assert.notStrictEqual(review.seenHash(a), review.seenHash(c));
});

// ---- dedupeAgainstSeen ----
//
// Identity is PRIMARY-keyed on `finding.id` (the gate-emitted stable slug), not
// on seenHash prose. This is the finding-id correction: an LLM rephrasing the
// same bug's summary between rounds must not mint a phantom "new" finding.
// seenHash survives as a SECONDARY signal (content-drift diagnostic only).

test('dedupeAgainstSeen: an id match on a "killed" seen entry is suppressed', () => {
  const f = finding();
  const seen = [{ id: f.id, hash: review.seenHash(f), status: 'killed' }];
  const survivors = review.dedupeAgainstSeen([f], seen);
  assert.strictEqual(survivors.length, 0);
});

test('dedupeAgainstSeen: an id match on a "parked" seen entry is suppressed', () => {
  const f = finding();
  const seen = [{ id: f.id, hash: review.seenHash(f), status: 'parked' }];
  const survivors = review.dedupeAgainstSeen([f], seen);
  assert.strictEqual(survivors.length, 0);
});

test('dedupeAgainstSeen: a "killed" match is suppressed even when the summary prose is reworded (the phantom-finding bug the correction fixes)', () => {
  const f = finding({ summary: 'assignment used where comparison intended' });
  const reworded = finding({ summary: 'uses = instead of == in the condition' });
  const seen = [{ id: f.id, hash: review.seenHash(f), status: 'killed' }];
  // Different prose -> different seenHash -- but the SAME stable id -> still suppressed.
  assert.notStrictEqual(review.seenHash(f), review.seenHash(reworded));
  const survivors = review.dedupeAgainstSeen([reworded], seen);
  assert.strictEqual(survivors.length, 0);
});

test('dedupeAgainstSeen: an unknown id passes through unchanged (fresh finding)', () => {
  const f = finding();
  const survivors = review.dedupeAgainstSeen([f], []);
  assert.strictEqual(survivors.length, 1);
  assert.strictEqual(survivors[0].id, 'f1');
  assert.ok(!survivors[0].reopened);
});

test('dedupeAgainstSeen: an id match on a "fixed" seen entry re-opens instead of being suppressed', () => {
  // The bug pattern was fixed (seen recorded against the pre-fix span content).
  // A later regression reintroduces byte-identical content -> same id, same
  // hash -> must NOT stay suppressed forever, unlike killed/parked.
  const f = finding();
  const seen = [{ id: f.id, hash: review.seenHash(f), status: 'fixed' }];
  const survivors = review.dedupeAgainstSeen([f], seen);
  assert.strictEqual(survivors.length, 1);
  assert.strictEqual(survivors[0].reopened, true);
  assert.strictEqual(survivors[0].contentChanged, false);
});

test('dedupeAgainstSeen: an id match on a "fixed" seen entry re-opens even when the content has since changed (partial/regressed fix), flagged contentChanged', () => {
  const before = finding({ span: 'if (x = 1) { doThing(); }' });
  const after = finding({ span: 'if (x = 1) { doOtherThing(); }' }); // same id, different span: the "fix" didn't hold
  const seen = [{ id: before.id, hash: review.seenHash(before), status: 'fixed' }];
  const survivors = review.dedupeAgainstSeen([after], seen);
  assert.strictEqual(survivors.length, 1);
  assert.strictEqual(survivors[0].reopened, true);
  assert.strictEqual(survivors[0].contentChanged, true);
});

test('dedupeAgainstSeen: a different id is never matched, regardless of content overlap -- always a fresh finding', () => {
  const before = finding({ id: 'correctness:assignment-in-condition', span: 'if (x = 1) { doThing(); }' });
  const after = finding({ id: 'correctness:other-bug', span: 'if (x === 1) { doThing(); }' });
  const seen = [{ id: before.id, hash: review.seenHash(before), status: 'fixed' }];
  const survivors = review.dedupeAgainstSeen([after], seen);
  assert.strictEqual(survivors.length, 1);
  assert.ok(!survivors[0].reopened);
});

// ---- decideTermination ----

function outcome(overrides) {
  return {
    dodPassed: false,
    openFindingsCount: 1,
    specDoubtScope: 'none',
    noProgress: false,
    budgetSpent: 1,
    maxRounds: 5,
    ...overrides,
  };
}

test('decideTermination: dod passed and zero open findings -> converged/clean', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0 }));
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, parked: d.parked, abandoned: d.abandoned },
    { continue: false, converged: true, parked: false, abandoned: false }
  );
});

test('decideTermination: reviewer silence alone (dod NOT passed) is not clean', () => {
  const d = review.decideTermination(outcome({ dodPassed: false, openFindingsCount: 0 }));
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.continue, true);
});

test('decideTermination: budget exhausted -> parked', () => {
  const d = review.decideTermination(outcome({ budgetSpent: 5, maxRounds: 5 }));
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, parked: d.parked, abandoned: d.abandoned },
    { continue: false, converged: false, parked: true, abandoned: false }
  );
});

test('decideTermination: no progress (zero fixes, same findings) -> parked', () => {
  const d = review.decideTermination(outcome({ noProgress: true, budgetSpent: 2, maxRounds: 5 }));
  assert.strictEqual(d.parked, true);
  assert.strictEqual(d.continue, false);
});

test('decideTermination: whole-diff spec-doubt -> abandoned, takes priority over everything else', () => {
  const d = review.decideTermination(outcome({ specDoubtScope: 'whole-diff', dodPassed: true, openFindingsCount: 0 }));
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, parked: d.parked, abandoned: d.abandoned },
    { continue: false, converged: false, parked: false, abandoned: true }
  );
});

test('decideTermination: item-scoped spec-doubt does not abandon the whole run', () => {
  const d = review.decideTermination(outcome({ specDoubtScope: 'item', budgetSpent: 1, maxRounds: 5 }));
  assert.strictEqual(d.abandoned, false);
  assert.strictEqual(d.continue, true);
});

test('decideTermination: otherwise continue (converging)', () => {
  const d = review.decideTermination(outcome({ budgetSpent: 1, maxRounds: 5 }));
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, parked: d.parked, abandoned: d.abandoned },
    { continue: true, converged: false, parked: false, abandoned: false }
  );
});

test('decideTermination: dod passed, zero open findings, gate.panel configured and not yet run -> panelPending (not converged)', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, panelConfigured: true, panelDone: false }));
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, panelPending: d.panelPending },
    { continue: false, converged: false, panelPending: true }
  );
});

test('decideTermination: panelConfigured but panelDone -> falls through to normal clean check, no panelPending', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, panelConfigured: true, panelDone: true }));
  assert.strictEqual(d.panelPending, undefined);
  assert.strictEqual(d.converged, true);
});

test('decideTermination: panel NOT configured -> normal clean check unaffected, no panelPending', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, panelConfigured: false }));
  assert.strictEqual(d.panelPending, undefined);
  assert.strictEqual(d.converged, true);
});

test('decideTermination: open lightweight GATE findings take priority over panelPending (gatePending wins)', () => {
  const d = review.decideTermination(outcome({ dodPassed: true, openFindingsCount: 0, gateOpenCount: 1, panelConfigured: true, panelDone: false }));
  assert.strictEqual(d.gatePending, true);
  assert.strictEqual(d.panelPending, undefined);
});

// ---- beginRound: round accounting ----

test('beginRound: first round on a fresh ledger increments round but does NOT charge budget (budget is charged at record now)', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: next, noOp } = review.beginRound(ledger, 'hash-1');
  assert.strictEqual(noOp, false);
  assert.strictEqual(next.round, 1);
  assert.strictEqual(next.budget.spent, 0); // was 1 before this change
  assert.strictEqual(next.diff_content_hash, 'hash-1');
});

test('beginRound: advances round but does NOT charge budget (budget is charged at record now)', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: after } = review.beginRound(l, 'hash1');
  assert.strictEqual(after.round, 1);
  assert.strictEqual(after.budget.spent, 0); // was 1 before this change
});

test('beginRound: a noOp (unchanged hash) still neither advances round nor charges budget', () => {
  let l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  l = review.beginRound(l, 'h').ledger;
  const { ledger: after, noOp } = review.beginRound(l, 'h');
  assert.strictEqual(noOp, true);
  assert.strictEqual(after.round, 1);
  assert.strictEqual(after.budget.spent, 0);
});

test('beginRound: unchanged diff_content_hash is a no-op round and does NOT consume budget', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: r1 } = review.beginRound(ledger, 'hash-1');
  const { ledger: r2, noOp } = review.beginRound(r1, 'hash-1');
  assert.strictEqual(noOp, true);
  assert.strictEqual(r2.round, r1.round); // round counter unchanged
  assert.strictEqual(r2.budget.spent, r1.budget.spent); // budget unchanged
});

test('beginRound: a changed diff_content_hash after a no-op resumes advancing the round (still no budget charge)', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: r1 } = review.beginRound(ledger, 'hash-1');
  const { ledger: r2 } = review.beginRound(r1, 'hash-1'); // no-op
  const { ledger: r3, noOp } = review.beginRound(r2, 'hash-2');
  assert.strictEqual(noOp, false);
  assert.strictEqual(r3.round, r1.round + 1);
  assert.strictEqual(r3.budget.spent, r1.budget.spent); // budget is charged at record now, not here
});

test('beginRound: does not mutate the input ledger', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const snapshot = JSON.parse(JSON.stringify(ledger));
  review.beginRound(ledger, 'hash-1');
  assert.deepStrictEqual(ledger, snapshot);
});

test('beginRound: workHappened is true exactly for a real (non-no-op, non-terminal) round', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const r1 = review.beginRound(ledger, 'hash-1');
  assert.strictEqual(r1.workHappened, true);
  assert.strictEqual(r1.terminal, false);
  const r2 = review.beginRound(r1.ledger, 'hash-1'); // same diff -> no-op
  assert.strictEqual(r2.workHappened, false);
  assert.strictEqual(r2.terminal, false);
});

test('beginRound: a ledger already in a terminal status (clean) short-circuits -- terminal:true, no round/budget increment, no work', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'hash-1').ledger;
  ledger = { ...ledger, status: 'clean' };
  const { ledger: next, noOp, workHappened, terminal } = review.beginRound(ledger, 'hash-2');
  assert.strictEqual(terminal, true);
  assert.strictEqual(workHappened, false);
  assert.strictEqual(noOp, true);
  assert.strictEqual(next.round, ledger.round);
  assert.strictEqual(next.budget.spent, ledger.budget.spent);
  assert.strictEqual(next, ledger); // returned as-is, not a new object
});

test('beginRound: terminal short-circuit also applies to parked and abandoned ledgers', () => {
  const base = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  for (const status of ['parked', 'abandoned']) {
    const ledger = { ...base, status };
    const { terminal, workHappened } = review.beginRound(ledger, 'hash-1');
    assert.strictEqual(terminal, true, `expected terminal for status ${status}`);
    assert.strictEqual(workHappened, false, `expected no work for status ${status}`);
  }
});

// This is the exact spike bug reproduced against the shell: an outer loop that
// treats "round-start reported terminal" as a real round would otherwise
// double-count. workHappened + terminal let a caller loop `while (workHappened)`
// and never miscount the terminal-discovery iteration as a round.
test('beginRound: a caller loop counting only workHappened rounds does not off-by-one on convergence', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  let workingRounds = 0;
  let r = review.beginRound(ledger, 'hash-1');
  if (r.workHappened) workingRounds++;
  ledger = { ...r.ledger, status: 'clean' }; // round 1 converged
  r = review.beginRound(ledger, 'hash-1'); // the loop's "are we done" check
  if (r.workHappened) workingRounds++;
  assert.strictEqual(workingRounds, 1);
  assert.strictEqual(r.terminal, true);
});

// ---- findingStillOpen ----

test('findingStillOpen: true for a finding recorded as open', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings.push({ id: 'f1', status: 'open' });
  assert.strictEqual(review.findingStillOpen(ledger, 'f1'), true);
});

test('findingStillOpen: false once fixed, false once parked, false when unknown', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings.push({ id: 'f1', status: 'fixed' });
  ledger.findings.push({ id: 'f2', status: 'parked' });
  assert.strictEqual(review.findingStillOpen(ledger, 'f1'), false);
  assert.strictEqual(review.findingStillOpen(ledger, 'f2'), false);
  assert.strictEqual(review.findingStillOpen(ledger, 'nope'), false);
});

// ---- applyRoundOutcome: full round processing ----

test('applyRoundOutcome: a confirmed finding with no fix stays open, status converging', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'hash-1').ledger;
  const { ledger: after, decision } = review.applyRoundOutcome(ledger, {
    dodPassed: false,
    findings: [finding({ id: 'f1', status: 'confirmed' })],
    fixedIds: [],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'none',
  });
  assert.strictEqual(after.status, 'converging');
  assert.strictEqual(decision.continue, true);
  const f1 = after.findings.find((f) => f.id === 'f1');
  assert.strictEqual(f1.status, 'open');
});

test('applyRoundOutcome: dod passed and all findings fixed -> NOT clean yet (confirmation round follows)', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'h').ledger;
  const { ledger: after, decision } = review.applyRoundOutcome(ledger, {
    dodPassed: true,
    findings: [{ id: 'correctness:f1', gate: 'correctness', file: 'a.js', span: 'x', summary: 'b', status: 'confirmed' }],
    fixedIds: ['correctness:f1'],
    parkedIds: [], killedIds: [], specDoubtScope: 'none',
  });
  assert.strictEqual(decision.converged, false);
  assert.strictEqual(decision.continue, true);
  assert.strictEqual(after.status, 'converging');
});

test('applyRoundOutcome: a zero-fix round with dod passed and no open findings converges (the confirmation round)', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'h').ledger;
  const { decision } = review.applyRoundOutcome(ledger, {
    dodPassed: true, findings: [], fixedIds: [], parkedIds: [], killedIds: [], specDoubtScope: 'none',
  });
  assert.strictEqual(decision.converged, true);
});

test('decideTermination: fixedCount>0 blocks converge even with dod passed and zero open', () => {
  const d = review.decideTermination({ dodPassed: true, openFindingsCount: 0, fixedCount: 2, specDoubtScope: 'none', noProgress: false, budgetSpent: 0, maxRounds: 5 });
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.continue, true);
});

// CRITICAL 1 (false-clean via needs-decision park): a round that parked a
// finding must never converge/clean, even when the clean predicate
// (dodPassed && openFindingsCount===0 && fixedCount===0) would otherwise be
// satisfied -- a parked finding is excluded from openFindingsCount, so
// without this check a single needs-decision park below the park-budget
// threshold silently escapes as "clean".
test('decideTermination: parkedCount>0 terminates parked, never converges, even though dodPassed/openFindingsCount/fixedCount all say "clean"', () => {
  const d = review.decideTermination({
    dodPassed: true,
    openFindingsCount: 0,
    fixedCount: 0,
    parkedCount: 1,
    specDoubtScope: 'none',
    noProgress: false,
    budgetSpent: 0,
    maxRounds: 5,
  });
  assert.deepStrictEqual(
    { continue: d.continue, converged: d.converged, parked: d.parked, abandoned: d.abandoned },
    { continue: false, converged: false, parked: true, abandoned: false }
  );
});

test('decideTermination: parkedCount===0 (or absent) does not itself force parked -- clean branch is reachable', () => {
  const d = review.decideTermination({ dodPassed: true, openFindingsCount: 0, fixedCount: 0, specDoubtScope: 'none', noProgress: false, budgetSpent: 0, maxRounds: 5 });
  assert.strictEqual(d.converged, true);
});

test('decideTermination: a deferred DoD converges without claiming the gate ran', () => {
  const base = { openFindingsCount: 0, fixedCount: 0, specDoubtScope: 'none', noProgress: false, budgetSpent: 0, maxRounds: 5 };
  const ran = review.decideTermination({ ...base, dodPassed: true });
  const deferred = review.decideTermination({ ...base, dodPassed: true, dodDeferred: true });
  assert.strictEqual(deferred.converged, true);
  // The decision object must not contradict the handoff's "DoD: DEFERRED" line.
  assert.ok(!/ran and passed/.test(deferred.reason), `deferred reason claims the gate ran: ${deferred.reason}`);
  assert.match(deferred.reason, /deferred/i);
  // A real pass keeps its existing wording verbatim.
  assert.strictEqual(ran.reason, 'DoD-exec ran and passed, zero open findings, and no fixes this round (stable)');
});

test('parkBudgetExceeded: true once needs-decision parks reach the threshold', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'x' });
  ledger.findings = [
    { id: 'correctness:a', status: 'parked', park_reason: { kind: 'needs-decision', text: 't' } },
    { id: 'correctness:b', status: 'parked', park_reason: { kind: 'needs-decision', text: 't' } },
  ];
  assert.strictEqual(review.parkBudgetExceeded(ledger, 2), true);
  assert.strictEqual(review.parkBudgetExceeded(ledger, 3), false);
});

test('resetUnreachable: fixed/parked findings go back to open, their seen entries drop, status converging', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'x' });
  ledger.status = 'parked';
  ledger.findings = [
    { id: 'correctness:a', status: 'fixed', fix_commit: 'sha', park_reason: null },
    { id: 'correctness:b', status: 'open' },
  ];
  ledger.seen = [{ id: 'correctness:a', hash: 'h', status: 'fixed' }];
  const out = review.resetUnreachable(ledger);
  assert.strictEqual(out.findings.find((f) => f.id === 'correctness:a').status, 'open');
  assert.strictEqual(out.findings.find((f) => f.id === 'correctness:a').fix_commit, null);
  assert.strictEqual(out.seen.length, 0);
  assert.strictEqual(out.status, 'converging');
});

test('applyRoundOutcome: a killed finding is recorded in seen and does not resurface next round', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'hash-1').ledger;
  const f = finding({ id: 'f2', status: 'confirmed' });
  const round1 = review.applyRoundOutcome(ledger, {
    dodPassed: false,
    findings: [f],
    fixedIds: [],
    parkedIds: [],
    killedIds: ['f2'],
    specDoubtScope: 'none',
  }).ledger;
  assert.ok(round1.seen.some((s) => s.status === 'killed'));

  // Round 2: the SAME raw finding (verifier rejects it again, content unchanged) must be deduped away.
  const round2started = review.beginRound(round1, 'hash-2').ledger;
  const { ledger: round2 } = review.applyRoundOutcome(round2started, {
    dodPassed: true,
    findings: [finding({ id: 'f2', status: 'confirmed' })],
    fixedIds: [],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'none',
  });
  // f2 must not reappear as an open finding this round -- it was deduped as already-killed.
  const reopened = round2.findings.find((x) => x.id === 'f2');
  assert.ok(!reopened || reopened.status !== 'open');
});

test('applyRoundOutcome: budget exhausted parks remaining open findings', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.budget.max_rounds = 1;
  ledger = review.beginRound(ledger, 'hash-1').ledger; // round=1
  ledger.budget.spent = 1; // budget is charged at record now, not beginRound; simulate a prior record charge
  const { ledger: after, decision } = review.applyRoundOutcome(ledger, {
    dodPassed: false,
    findings: [finding({ id: 'f3', status: 'confirmed' })],
    fixedIds: [],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'none',
  });
  assert.strictEqual(decision.parked, true);
  assert.strictEqual(after.status, 'parked');
});

// CRITICAL 1, applyRoundOutcome-level reproduction: a round whose net effect
// is exactly one needs-decision park (dodPassed true, the parked finding is
// excluded from openFindingsCount, zero fixes) must land status 'parked' and
// decision.continue===false/converged===false -- NOT the false-clean this
// bug previously produced.
test('applyRoundOutcome: a round that parks one finding (needs-decision) never converges clean, even with dodPassed and zero open findings', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'hash-1').ledger;
  const f = finding({ id: 'correctness:park-me', status: 'confirmed' });
  const { ledger: after, decision } = review.applyRoundOutcome(ledger, {
    dodPassed: true,
    findings: [f],
    fixedIds: [],
    parkedIds: ['correctness:park-me'],
    killedIds: [],
    specDoubtScope: 'none',
    parkReasons: { 'correctness:park-me': { kind: 'needs-decision', text: 'fix artifact missing' } },
  });
  assert.strictEqual(decision.converged, false);
  assert.strictEqual(decision.continue, false);
  assert.strictEqual(decision.parked, true);
  assert.strictEqual(after.status, 'parked');
  const parked = after.findings.find((x) => x.id === 'correctness:park-me');
  assert.strictEqual(parked.status, 'parked');
});

test('applyRoundOutcome: panelPending decision sets ledger status to "gate-panel-pending"', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: next } = review.applyRoundOutcome(
    { ...ledger, budget: { max_rounds: 5, spent: 0 }, phase: 'fixes' },
    { dodPassed: true, findings: [], fixedIds: [], parkedIds: [], killedIds: [], panelConfigured: true, panelDone: false }
  );
  assert.strictEqual(next.status, 'gate-panel-pending');
});

test('applyRoundOutcome: whole-diff spec-doubt abandons the run', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'hash-1').ledger;
  const { ledger: after, decision } = review.applyRoundOutcome(ledger, {
    dodPassed: false,
    findings: [],
    fixedIds: [],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'whole-diff',
  });
  assert.strictEqual(decision.abandoned, true);
  assert.strictEqual(after.status, 'abandoned');
});

test('applyRoundOutcome: appends a history entry per round', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'hash-1').ledger;
  const { ledger: after } = review.applyRoundOutcome(ledger, {
    dodPassed: false,
    findings: [finding({ id: 'f1', status: 'confirmed' }), finding({ id: 'f4', status: 'confirmed', span: 'other', summary: 'other' })],
    fixedIds: ['f1'],
    parkedIds: [],
    killedIds: [],
    specDoubtScope: 'none',
  });
  assert.strictEqual(after.history.length, 1);
  assert.strictEqual(after.history[0].round, 1);
  assert.strictEqual(after.history[0].fixes, 1);
});

// ---- unparkFinding ----

test('unparkFinding: reopens a parked finding and un-terminals a parked ledger', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.status = 'parked';
  ledger.findings.push({ id: 'f9', status: 'parked' });
  const after = review.unparkFinding(ledger, 'f9');
  assert.strictEqual(after.findings.find((f) => f.id === 'f9').status, 'open');
  assert.strictEqual(after.status, 'converging');
});

test('unparkFinding: drops the finding\'s seen entry so a re-report is not suppressed', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.status = 'parked';
  ledger.findings.push({ id: 'f9', status: 'parked' });
  ledger.seen.push({ id: 'f9', hash: 'h', status: 'parked' });
  const after = review.unparkFinding(ledger, 'f9');
  // Finding stays 'open' (re-evaluated next round); its seen entry is dropped so
  // dedupeAgainstSeen will not suppress the gate re-reporting it.
  assert.strictEqual(after.findings.find((f) => f.id === 'f9').status, 'open');
  assert.ok(!after.seen.some((s) => s.id === 'f9'));
});

test('unparkFinding: throws for an unknown finding id', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  assert.throws(() => review.unparkFinding(ledger, 'nope'));
});

// ---- listLedgers / renderReviewReport (injector support) ----

test('listLedgers: reads every review-*.json in the state dir, skips non-matching files', () => {
  const dir = tmpStateDir();
  const l1 = review.emptyLedger({ kind: 'local', ref: 'feat/a' });
  review.writeLedger(dir, 'feat-a', l1);
  fs.writeFileSync(path.join(dir, 'charter.md'), 'not a ledger');
  fs.writeFileSync(path.join(dir, 'sess1.json'), '{}'); // a session-state file, not a review ledger
  const found = review.listLedgers(dir);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].slug, 'feat-a');
});

test('listLedgers: returns [] for a missing state dir', () => {
  assert.deepStrictEqual(review.listLedgers(path.join(os.tmpdir(), 'does-not-exist-xyz')), []);
});

test('renderReviewReport: converging ledgers get a resume invitation', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/a' });
  l.round = 2;
  l.findings.push({ id: 'f1', status: 'open' });
  const out = review.renderReviewReport([{ slug: 'feat-a', ledger: l }]);
  assert.ok(out.includes('feat/a'));
  assert.ok(/resume/i.test(out));
});

test('renderReviewReport: parked ledgers are report-only, no resume invitation', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/b' });
  l.status = 'parked';
  l.findings.push({ id: 'f2', status: 'parked' });
  const out = review.renderReviewReport([{ slug: 'feat-b', ledger: l }]);
  assert.ok(out.includes('feat/b'));
  assert.ok(!/resume with/i.test(out));
});

test('renderReviewReport: clean and abandoned ledgers are terminal and not surfaced', () => {
  const clean = review.emptyLedger({ kind: 'local', ref: 'feat/c' });
  clean.status = 'clean';
  const abandoned = review.emptyLedger({ kind: 'local', ref: 'feat/d' });
  abandoned.status = 'abandoned';
  const out = review.renderReviewReport([
    { slug: 'feat-c', ledger: clean },
    { slug: 'feat-d', ledger: abandoned },
  ]);
  assert.strictEqual(out, '');
});

test('renderReviewReport: empty list renders empty string', () => {
  assert.strictEqual(review.renderReviewReport([]), '');
});

test('renderReviewReport: a converging ledger mid-round shows its phase', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.status = 'converging'; ledger.round = 2; ledger.phase = 'fixes';
  const out = review.renderReviewReport([{ slug: 'feat-x', ledger }]);
  assert.match(out, /phase fixes/);
});

test('renderReviewReport: intent-review ledgers surface a design-conformance reminder, not silently omitted', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/e' });
  l.status = 'intent-review';
  l.round = 3;
  l.intent_parked = [{ id: 'intent:1', file: 'a.js', summary: 'contradicts spec' }];
  const out = review.renderReviewReport([{ slug: 'feat-e', ledger: l }]);
  assert.ok(out.includes('feat/e'));
  assert.match(out, /intent|design.conformance/i);
});

test('renderReviewReport: gate-pending ledgers surface an advisory broad review reminder, not silently omitted', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/g' });
  l.status = 'gate-pending';
  l.round = 3;
  l.gate_open = [{ id: 'gate:cross-context:1', file: 'a.js', summary: 'unchanged sibling breaks' }];
  const out = review.renderReviewReport([{ slug: 'feat-g', ledger: l }]);
  assert.ok(out.includes('feat/g'));
  assert.match(out, /broad review/i);
  assert.match(out, /dismiss feat\/g/);
});

test('renderReviewReport: gate-panel-pending ledgers surface a resume/panel reminder, not silently omitted', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/p' });
  l.status = 'gate-panel-pending';
  l.round = 3;
  const out = review.renderReviewReport([{ slug: 'feat-p', ledger: l }]);
  assert.ok(out.includes('feat/p'));
  assert.match(out, /panel pending or interrupted/);
});

test('decideTermination: an open intent finding -> intent-review (blocks clean, before the clean branch)', () => {
  const d = review.decideTermination({
    dodPassed: true, openFindingsCount: 0, specDoubtScope: 'none',
    noProgress: false, budgetSpent: 0, maxRounds: 8, fixedCount: 0, parkedCount: 0,
    intentReviewCount: 1,
  });
  assert.strictEqual(d.continue, false);
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.intentReview, true);
});

test('decideTermination: a needs-decision park still wins over intent-review', () => {
  const d = review.decideTermination({
    dodPassed: true, openFindingsCount: 0, specDoubtScope: 'none',
    noProgress: false, budgetSpent: 0, maxRounds: 8, fixedCount: 0, parkedCount: 1, intentReviewCount: 1,
  });
  assert.strictEqual(d.parked, true);
  assert.strictEqual(d.intentReview, undefined);
});

test('applyRoundOutcome: intentReviewCount -> status intent-review', () => {
  const ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  const { ledger: next } = review.applyRoundOutcome(ledger, {
    dodPassed: true, findings: [], fixedIds: [], parkedIds: [], killedIds: [], intentReviewCount: 2,
  });
  assert.strictEqual(next.status, 'intent-review');
});

test('emptyLedger: has intentHash, intentBytes, intent_parked', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'r' });
  assert.strictEqual(l.intentHash, null);
  assert.strictEqual(l.intentBytes, null);
  assert.deepStrictEqual(l.intent_parked, []);
});

test('emptyLedger initializes gate_open and gate_dismissed to empty arrays', () => {
  const l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  assert.deepStrictEqual(l.gate_open, []);
  assert.deepStrictEqual(l.gate_dismissed, []);
});

// ---- decideTermination: gate-pending ----

test('decideTermination: would-converge + open gate findings -> gate-pending, not clean', () => {
  const d = review.decideTermination({
    dodPassed: true, openFindingsCount: 0, specDoubtScope: 'none', noProgress: false,
    budgetSpent: 0, maxRounds: 5, fixedCount: 0, parkedCount: 0, intentReviewCount: 0, gateOpenCount: 2,
  });
  assert.strictEqual(d.gatePending, true);
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.continue, false);
});

test('decideTermination: would-converge + zero gate findings -> clean', () => {
  const d = review.decideTermination({
    dodPassed: true, openFindingsCount: 0, specDoubtScope: 'none', noProgress: false,
    budgetSpent: 0, maxRounds: 5, fixedCount: 0, parkedCount: 0, intentReviewCount: 0, gateOpenCount: 0,
  });
  assert.strictEqual(d.converged, true);
  assert.ok(!d.gatePending);
});

test('decideTermination: open CORRECTNESS findings ignore gate count (loop continues, no early halt)', () => {
  const d = review.decideTermination({
    dodPassed: false, openFindingsCount: 1, specDoubtScope: 'none', noProgress: false,
    budgetSpent: 0, maxRounds: 5, fixedCount: 0, parkedCount: 0, intentReviewCount: 0, gateOpenCount: 5,
  });
  assert.strictEqual(d.continue, true); // gate does NOT terminate mid-loop
});

// ---- dry-round convergence for no-DoD (file) targets (Task 3) ----

test('decideTermination: hasDoD git path unchanged (converges on a clean stable round)', () => {
  // hasDoD omitted -> defaults to the git path; a clean stable round converges
  // exactly as before, and dryStreak is never consulted.
  const d = review.decideTermination({ dodPassed: true, openFindingsCount: 0, fixedCount: 0, budgetSpent: 1, maxRounds: 5 });
  assert.strictEqual(d.converged, true);
});

test('decideTermination: git path ignores dryStreak entirely (byte-identical to no-dryStreak call)', () => {
  // A git round that would NOT converge (dodPassed false) must stay continue
  // regardless of a stray dryStreak value -- the git clause never reads it.
  const withStreak = review.decideTermination({ dodPassed: false, openFindingsCount: 0, dryStreak: 5, budgetSpent: 1, maxRounds: 5 });
  const without = review.decideTermination({ dodPassed: false, openFindingsCount: 0, budgetSpent: 1, maxRounds: 5 });
  assert.deepStrictEqual(withStreak, without);
});

test('decideTermination: no-DoD target needs 2 dry rounds to converge', () => {
  const one = review.decideTermination({ hasDoD: false, openFindingsCount: 0, dryStreak: 1, budgetSpent: 1, maxRounds: 5 });
  assert.strictEqual(one.converged, false);
  assert.strictEqual(one.continue, true);
  const two = review.decideTermination({ hasDoD: false, openFindingsCount: 0, dryStreak: 2, budgetSpent: 2, maxRounds: 5 });
  assert.strictEqual(two.converged, true);
  assert.strictEqual(two.continue, false);
});

test('decideTermination: no-DoD target with open findings does not converge even at dryStreak>=2', () => {
  const d = review.decideTermination({ hasDoD: false, openFindingsCount: 1, dryStreak: 2, budgetSpent: 2, maxRounds: 5 });
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.continue, true);
});

test('decideTermination: no-DoD target parks when the round budget is exhausted before running dry', () => {
  const d = review.decideTermination({ hasDoD: false, openFindingsCount: 1, dryStreak: 0, budgetSpent: 5, maxRounds: 5 });
  assert.strictEqual(d.parked, true);
  assert.strictEqual(d.continue, false);
  assert.strictEqual(d.converged, false);
});

test('decideTermination: no-DoD dry-clean but an open GATE finding -> gatePending (same boundary hook as git)', () => {
  const d = review.decideTermination({ hasDoD: false, openFindingsCount: 0, dryStreak: 2, gateOpenCount: 1, budgetSpent: 2, maxRounds: 5 });
  assert.strictEqual(d.gatePending, true);
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.continue, false);
});

test('decideTermination: no-DoD dry-clean but the holistic panel has not run -> panelPending', () => {
  const d = review.decideTermination({ hasDoD: false, openFindingsCount: 0, dryStreak: 2, panelConfigured: true, panelDone: false, budgetSpent: 2, maxRounds: 5 });
  assert.strictEqual(d.panelPending, true);
  assert.strictEqual(d.converged, false);
  assert.strictEqual(d.continue, false);
});

test('applyRoundOutcome: dryStreak increments on a zero-new round and resets on a new finding (no-DoD target)', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'file:n.md', type: 'file', hasDoD: false });
  ledger = review.beginRound(ledger, 'h1').ledger;
  // No new findings -> dryStreak advances to 1.
  ledger = review.applyRoundOutcome(ledger, { findings: [], fixedIds: [], parkedIds: [], killedIds: [] }).ledger;
  assert.strictEqual(ledger.dryStreak, 1);
  // A genuinely new finding -> dryStreak resets to 0.
  ledger = review.beginRound(ledger, 'h2').ledger;
  ledger = review.applyRoundOutcome(ledger, {
    findings: [{ id: 'docreview:x', gate: 'correctness', file: 'n.md', span: 's', summary: 't', status: 'confirmed' }],
    fixedIds: [], parkedIds: [], killedIds: [],
  }).ledger;
  assert.strictEqual(ledger.dryStreak, 0);
});

test('applyRoundOutcome: two consecutive zero-new rounds converge a no-DoD target (dryStreak reaches 2)', () => {
  let ledger = review.emptyLedger({ kind: 'local', ref: 'file:n.md', type: 'file', hasDoD: false });
  ledger = review.beginRound(ledger, 'h1').ledger;
  let r = review.applyRoundOutcome(ledger, { findings: [], fixedIds: [], parkedIds: [], killedIds: [] });
  assert.strictEqual(r.ledger.dryStreak, 1);
  assert.strictEqual(r.decision.converged, false);
  assert.strictEqual(r.decision.continue, true);
  ledger = review.beginRound(r.ledger, 'h2').ledger;
  r = review.applyRoundOutcome(ledger, { findings: [], fixedIds: [], parkedIds: [], killedIds: [] });
  assert.strictEqual(r.ledger.dryStreak, 2);
  assert.strictEqual(r.decision.converged, true);
  assert.strictEqual(r.ledger.status, 'clean');
});

test('applyRoundOutcome: git target (target.hasDoD true) never sets a truthy dryStreak path -- git convergence rules apply', () => {
  // A git target with a zero-new, zero-fix, DoD-passed round converges via the
  // git clause; the presence of a dryStreak counter must not change that.
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' }); // no target.hasDoD -> git
  ledger = review.beginRound(ledger, 'h').ledger;
  const { decision } = review.applyRoundOutcome(ledger, {
    dodPassed: true, findings: [], fixedIds: [], parkedIds: [], killedIds: [], specDoubtScope: 'none',
  });
  assert.strictEqual(decision.converged, true); // git path, unchanged
});

test('applyRoundOutcome: roundOutcome threading -- ledger with an extended target round-trips dryStreak through readLedger/writeLedger', () => {
  const dir = tmpStateDir();
  const slug = review.targetSlug('file:n.md');
  let ledger = review.emptyLedger({ kind: 'local', ref: 'file:n.md', type: 'file', hasDoD: false });
  ledger = review.beginRound(ledger, 'h1').ledger;
  ledger = review.applyRoundOutcome(ledger, { findings: [], fixedIds: [], parkedIds: [], killedIds: [] }).ledger;
  review.writeLedger(dir, slug, ledger);
  const back = review.readLedger(dir, slug);
  assert.strictEqual(back.dryStreak, 1);
  assert.strictEqual(back.target.hasDoD, false);
  assert.strictEqual(back.target.type, 'file');
  assert.deepStrictEqual(back, ledger); // full-fidelity round-trip
});

// ---- beginRound: reReviewOnStableContent flag (Task 7) ----

test('beginRound: reReviewOnStableContent:true with identical hash is NOT a no-op -- round advances (file target fluke-guard)', () => {
  // A file target's 2nd consecutive dry round runs on identical content.
  // Without this flag, beginRound would no-op and dryStreak could never reach 2.
  let ledger = review.emptyLedger({ kind: 'local', ref: 'file:n.md', type: 'file', hasDoD: false });
  ledger = review.beginRound(ledger, 'same-hash').ledger; // round 1
  const { ledger: r2, noOp, workHappened } = review.beginRound(ledger, 'same-hash', { reReviewOnStableContent: true });
  assert.strictEqual(noOp, false, 'reReviewOnStableContent:true must not no-op on identical content');
  assert.strictEqual(workHappened, true, 'reReviewOnStableContent:true must mark workHappened');
  assert.strictEqual(r2.round, 2, 'round must advance to 2');
  assert.strictEqual(r2.diff_content_hash, 'same-hash');
});

test('beginRound: default (no opts) with identical hash is still a no-op -- git path unchanged', () => {
  // Confirm the default behavior (reReviewOnStableContent=false) is byte-identical
  // to the pre-Task-7 behavior: an unchanged diff hash is still a no-op for git targets.
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger = review.beginRound(ledger, 'same-hash').ledger;
  const { noOp } = review.beginRound(ledger, 'same-hash');
  assert.strictEqual(noOp, true, 'default (git) path must remain a no-op on identical content');
});

test('applyRoundOutcome + readLedger: a pre-existing ledger without dryStreak reads dryStreak as absent (backward-compat, treated as 0)', () => {
  const dir = tmpStateDir();
  const slug = review.targetSlug('feat/legacy');
  // emptyLedger has NO dryStreak field and NO target.hasDoD (git) -- simulates a
  // ledger written before this feature existed.
  const legacy = review.emptyLedger({ kind: 'local', ref: 'feat/legacy' });
  assert.strictEqual('dryStreak' in legacy, false);
  review.writeLedger(dir, slug, legacy);
  const back = review.readLedger(dir, slug);
  assert.strictEqual(back.dryStreak, undefined); // absent -> read sites default it to 0
  assert.strictEqual(back.target.hasDoD, undefined); // absent -> derived as git/true
});
