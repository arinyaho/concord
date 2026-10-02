'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { emptyLedger } = require('../../core/review');
const plugins = path.resolve(__dirname, '../../..');
const providers = { claude: path.join(plugins, 'concord/hooks/review-cli.js'), copilot: path.join(plugins, 'concord-copilot/bin/review-cli.js') };
function setup(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-feedback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'feedback');
  const ledgerPath = path.join(root, 'target.json');
  const ledger = { ...emptyLedger('feat/test'), status: 'clean', findings: [{ id: 'correctness:race', status: 'fixed', fix_commit: 'abc123', file: 'state.js', summary: 'Concurrent writes lose the budget' }] };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const evidencePath = path.join(root, 'proof.md');
  fs.writeFileSync(evidencePath, 'Observed race, accepted fix and regression result.');
  const packet = { pattern: 'state-race', category: 'design', stage: 'design', tags: ['state', 'concurrency'],
    rule: 'Specify concurrent writers and the lock boundary before implementation.', rationale: 'Known parallel calls could have been covered in the original design.',
    earlierAvailable: true, preventable: true, runKey: 'run-a', findingId: 'correctness:race', ledgerPath, evidencePath };
  const call = (verb, value, cwd = root) => {
    if (value?.runKey && value.runKey !== 'run-a' && value.ledgerPath === ledgerPath) {
      const otherLedger = path.join(root, `target-${require('node:crypto').createHash('sha256').update(value.runKey).digest('hex')}.json`);
      if (!fs.existsSync(otherLedger)) fs.writeFileSync(otherLedger, JSON.stringify({ ...JSON.parse(fs.readFileSync(ledgerPath)), attemptId: `${ledger.attemptId}-${value.runKey}` }));
      value = { ...value, ledgerPath: otherLedger };
    }
    const args = [providers[provider], 'feedback', verb, store];
    if (value !== undefined) { const file = path.join(root, 'packet.json'); fs.writeFileSync(file, JSON.stringify(value)); args.push(file); }
    return spawnSync(process.execPath, args, { cwd, env: { ...process.env, REVIEW_REPO_ROOT: cwd, REVIEW_STATE_DIR: path.join(root, 'must-not-open-target') }, encoding: 'utf8' });
  };
  const ok = (verb, value) => { const result = call(verb, value); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const record = (value = packet) => ok('record', value);
  const promote = () => { const first = record(); record({ ...packet, runKey: 'run-b' }); ok('decide', { id: first.id, decision: 'accept', reviewedBy: 'independent-reviewer', reason: 'Repeated confirmed evidence supports prevention.', evidencePath }); return first.id; };
  return { root, store, ledgerPath, ledger, evidencePath, packet, call, ok, record, promote };
}
for (const provider of Object.keys(providers)) {
  test(`${provider}: feedback is opt-in storage and does not create review state`, (t) => {
    const s = setup(t, provider);
    assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
    assert.equal(fs.existsSync(s.store), false);
    const before = fs.readFileSync(s.ledgerPath, 'utf8');
    const candidate = s.record();
    assert.equal(candidate.status, 'candidate');
    assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
    assert.equal(fs.readFileSync(s.ledgerPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(s.root, 'must-not-open-target')), false);
  });
  test(`${provider}: promotion needs independent support and explicit evidence review`, (t) => {
    const s = setup(t, provider); const first = s.record();
    assert.equal(s.record().id, first.id);
    const decision = { id: first.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Verified', evidencePath: s.evidencePath };
    assert.notEqual(s.call('decide', decision).status, 0);
    s.record({ ...s.packet, runKey: 'run-b' });
    assert.notEqual(s.call('decide', { ...decision, reviewedBy: '' }).status, 0);
    assert.equal(s.ok('decide', decision).status, 'accepted');
    const lessons = s.ok('select', { stage: 'design', tags: ['state'] }).lessons;
    assert.equal(lessons.length, 1); assert.equal(lessons[0].id, first.id); assert.equal(lessons[0].rule, s.packet.rule);
    assert.equal(lessons[0].occurrences, undefined);
    assert.deepEqual(s.ok('select', { stage: 'ticket', tags: ['state'] }).lessons, []);
    assert.deepEqual(s.ok('select', { stage: 'design', tags: ['unrelated'] }).lessons, []);
    s.ok('decide', { ...decision, decision: 'retire' });
    assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
  });
  test(`${provider}: relabelling one review attempt as two runs cannot promote a rule`, (t) => {
    const s = setup(t, provider); const first = s.record();
    const copied = path.join(s.root, 'copied-ledger.json');
    fs.copyFileSync(s.ledgerPath, copied);
    s.record({ ...s.packet, runKey: 'run-b', ledgerPath: copied });
    const result = s.call('decide', { id: first.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt', evidencePath: s.evidencePath });
    assert.notEqual(result.status, 0);
  });

  test(`${provider}: immutable support survives ordinary ledger and evidence updates`, (t) => {
    const s = setup(t, provider); const c = s.record(); s.record({ ...s.packet, runKey: 'run-b' });
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, telemetry: [{ calls: 10 }] }));
    fs.writeFileSync(s.evidencePath, 'Later execution notes changed; original resolution remains valid.');
    assert.equal(s.ok('decide', { id: c.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Review original resolution snapshots', evidencePath: s.evidencePath }).status, 'accepted');
    const stored = JSON.parse(fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8'));
    const occurrence = stored.lessons[0].occurrences[0];
    assert.equal(occurrence.ledger.originalPath, s.ledgerPath);
    assert.notEqual(occurrence.ledger.path, s.ledgerPath);
    assert.equal(fs.readFileSync(occurrence.evidence.path, 'utf8'), 'Observed race, accepted fix and regression result.');
  });
  test(`${provider}: malformed accepted support cannot be selected`, (t) => {
    const s = setup(t, provider); s.promote();
    const file = path.join(s.store, 'review-feedback.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.lessons[0].occurrences = [];
    fs.writeFileSync(file, JSON.stringify(value));
    assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }).status, 0);
  });
  test(`${provider}: explicit later rejection of the same finding blocks promotion`, (t) => {
    const s = setup(t, provider); const c = s.record(); s.record({ ...s.packet, runKey: 'run-b' });
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, status: 'killed' })) }));
    assert.notEqual(s.call('decide', { id: c.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt', evidencePath: s.evidencePath }).status, 0);
  });

  test(`${provider}: killed findings, environment and unavailable earlier evidence cannot become design rules`, (t) => {
    const s = setup(t, provider);
    for (const change of [{ category: 'environment' }, { category: 'review-noise' }, { earlierAvailable: false }, { preventable: false }]) {
      const packet = { ...s.packet, ...change, pattern: `case-${Object.keys(change)[0]}-${String(Object.values(change)[0])}`.toLowerCase() };
      const c = s.record(packet); s.record({ ...packet, runKey: 'run-b' });
      assert.notEqual(s.call('decide', { id: c.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt', evidencePath: s.evidencePath }).status, 0);
    }
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, status: 'killed' })) }));
    const c = s.record({ ...s.packet, pattern: 'killed' }); s.record({ ...s.packet, pattern: 'killed', runKey: 'run-b' });
    assert.notEqual(s.call('decide', { id: c.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt', evidencePath: s.evidencePath }).status, 0);
  });
  test(`${provider}: retrieval is bounded and corrupted or cross-project memory fails visibly`, (t) => {
    const s = setup(t, provider);
    for (let i = 0; i < 5; i++) {
      const packet = { ...s.packet, pattern: `lesson-${i}` }; const c = s.record(packet); s.record({ ...packet, runKey: 'run-b' });
      s.ok('decide', { id: c.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Verified', evidencePath: s.evidencePath });
    }
    assert.equal(s.ok('select', { stage: 'design', tags: ['state'] }).lessons.length, 3);
    const other = path.join(s.root, 'other'); fs.mkdirSync(other);
    assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }, other).status, 0);
    fs.writeFileSync(path.join(s.store, 'review-feedback.json'), '{bad');
    const result = s.call('record', s.packet); assert.notEqual(result.status, 0); assert.match(result.stderr, /feedback:/);
    assert.equal(fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8'), '{bad');
  });
  test(`${provider}: provenance and rule edits cannot silently overwrite reviewed knowledge`, (t) => {
    const s = setup(t, provider); s.record();
    assert.notEqual(s.call('record', { ...s.packet, rule: 'Silently change approved scope' }).status, 0);
    assert.notEqual(s.call('record', { ...s.packet, findingId: 'correctness:invented' }).status, 0);
    assert.notEqual(s.call('record', { ...s.packet, rule: 'x'.repeat(501), pattern: 'too-long' }).status, 0);
    assert.notEqual(s.call('record', { ...s.packet, evidencePath: path.join(s.root, 'missing') }).status, 0);
  });
  test(`${provider}: outcomes count reported recurrence separately from round count and missing measurements`, (t) => {
    const s = setup(t, provider); const id = s.promote();
    const observation = { runKey: 'run-c', unit: 'ticket-1', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath, outcomes: [{ id, outcome: 'recurred', findingId: 'correctness:race' }] };
    s.ok('observe', observation); s.ok('observe', observation);
    s.ok('observe', { ...observation, runKey: 'run-d', outcomes: [{ id, outcome: 'not-observed' }] });
    s.ok('observe', { ...observation, runKey: 'run-e', outcomes: [{ id, outcome: 'unmeasured' }] });
    const report = s.ok('report');
    assert.deepEqual(report.outcomes, { applied: 3, recurred: 1, notObserved: 1, unmeasured: 1 });
    assert.equal(report.categories.design, 1);
    assert.equal(report.causalSavings, undefined);
    assert.notEqual(s.call('observe', { ...observation, runKey: 'run-f', outcomes: [{ id, outcome: 'recurred', findingId: 'correctness:invented' }] }).status, 0);
  });
}
