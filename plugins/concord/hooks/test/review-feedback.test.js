'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { emptyLedger } = require(path.resolve(__dirname, '../../core/review'));
const { openInitiativeRun, runPath } = require(path.resolve(__dirname, '../../core/initiative-review-run'));
const plugins = path.resolve(__dirname, '../../..');
const providers = { claude: path.join(plugins, 'concord/hooks/review-cli.js'), copilot: path.join(plugins, 'concord-copilot/bin/review-cli.js') };
function setup(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-feedback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'feedback');
  const ledgerPath = path.join(root, 'target.json');
  const initiativeDir = path.join(root, 'initiative');
  const bind = (runKey, repository = root, stateDir = initiativeDir) => {
    openInitiativeRun({ stateDir, key: runKey, repository, maxLaunches: 20, maxRounds: 5 });
    return { key: runKey, stateDir };
  };
  const ledger = { ...emptyLedger('feat/test'), initiative_binding: bind('run-a'), status: 'clean', findings: [{ id: 'correctness:race', status: 'fixed', fix_commit: 'abc123', file: 'state.js', summary: 'Concurrent writes lose the budget' }] };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const evidencePath = path.join(root, 'proof.md');
  fs.writeFileSync(evidencePath, 'Observed race, accepted fix and regression result.');
  const packet = { pattern: 'state-race', category: 'design', stage: 'design', tags: ['state', 'concurrency'],
    rule: 'Specify concurrent writers and the lock boundary before implementation.', rationale: 'Known parallel calls could have been covered in the original design.',
    earlierAvailable: true, preventable: true, runKey: 'run-a', findingId: 'correctness:race', ledgerPath, evidencePath };
  const call = (verb, value, cwd = root) => {
    if (value?.runKey && value.runKey !== 'run-a' && value.ledgerPath === ledgerPath) {
      const otherLedger = path.join(root, `target-${require('node:crypto').createHash('sha256').update(value.runKey).digest('hex')}.json`);
      if (!fs.existsSync(otherLedger)) fs.writeFileSync(otherLedger, JSON.stringify({ ...JSON.parse(fs.readFileSync(ledgerPath)), attemptId: `${ledger.attemptId}-${value.runKey}`, initiative_binding: bind(value.runKey) }));
      value = { ...value, ledgerPath: otherLedger };
    }
    const args = [providers[provider], 'feedback', verb, store];
    if (value !== undefined) { const file = path.join(root, 'packet.json'); fs.writeFileSync(file, JSON.stringify(value)); args.push(file); }
    return spawnSync(process.execPath, args, { cwd, env: { ...process.env, REVIEW_REPO_ROOT: cwd, REVIEW_STATE_DIR: path.join(root, 'must-not-open-target') }, encoding: 'utf8' });
  };
  const ok = (verb, value) => { const result = call(verb, value); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const record = (value = packet) => ok('record', value);
  const promote = () => {
    const first = record(); record({ ...packet, runKey: 'run-b' });
    const decisionPath = path.join(root, 'decision.md');
    fs.writeFileSync(decisionPath, 'Independent review of both confirmed resolutions supports the proposed lesson.');
    ok('decide', { id: first.id, decision: 'accept', reviewedBy: 'independent-reviewer', reason: 'Repeated confirmed evidence supports prevention.', evidencePath: decisionPath });
    return first.id;
  };
  return { root, store, ledgerPath, ledger, initiativeDir, bind, evidencePath, packet, call, ok, record, promote };
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
  for (const accepted of [false, true]) {
    test(`${provider}: duplicate ${accepted ? 'accepted' : 'candidate'} occurrence preserves original proof after telemetry changes`, t => {
      const s = setup(t, provider); const id = accepted ? s.promote() : s.record().id;
      const storeFile = path.join(s.store, 'review-feedback.json');
      const storeBefore = fs.readFileSync(storeFile, 'utf8');
      const evidenceFiles = fs.readdirSync(s.store).sort();
      const initiativeBefore = fs.readFileSync(runPath(s.initiativeDir, 'run-a'), 'utf8');
      fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, telemetry: [{ invocationId: 'unrelated-progress', calls: 20 }] }));
      assert.equal(s.record().id, id);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), storeBefore);
      assert.deepEqual(fs.readdirSync(s.store).sort(), evidenceFiles);
      assert.equal(fs.readFileSync(runPath(s.initiativeDir, 'run-a'), 'utf8'), initiativeBefore);
    });
  }
  for (const mutation of ['proof', 'status', 'fix-commit']) {
    test(`${provider}: duplicate occurrence rejects changed ${mutation} without replacing original proof`, t => {
      const s = setup(t, provider); s.record();
      const storeFile = path.join(s.store, 'review-feedback.json');
      const before = fs.readFileSync(storeFile, 'utf8');
      if (mutation === 'proof') fs.writeFileSync(s.evidencePath, 'A different causal claim needs explicit reconciliation.');
      else fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, ...(mutation === 'status' ? { status: 'open' } : { fix_commit: 'different-fix' }) })) }));
      assert.notEqual(s.call('record', s.packet).status, 0);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    });
  }
  const proposalChanges = { pattern: 'changed-pattern', category: 'requirements', stage: 'ticket', tags: ['state', 'changed-tag'],
    rule: 'A different unreviewed prevention rule.', rationale: 'A different unreviewed rationale.', earlierAvailable: false, preventable: false };
  for (const accepted of [false, true]) for (const [field, value] of Object.entries(proposalChanges)) {
    test(`${provider}: ${accepted ? 'accepted' : 'candidate'} proposal ${field} cannot change under the original receipt`, t => {
      const s = setup(t, provider); accepted ? s.promote() : s.record();
      const storeFile = path.join(s.store, 'review-feedback.json');
      const stored = JSON.parse(fs.readFileSync(storeFile)); stored.lessons[0][field] = value;
      fs.writeFileSync(storeFile, JSON.stringify(stored));
      const before = fs.readFileSync(storeFile, 'utf8');
      const result = s.call('select', { stage: value === 'ticket' ? 'ticket' : 'design', tags: ['state'] });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /feedback:/);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
      s.ok('decide', { id: stored.lessons[0].id, decision: 'retire', reviewedBy: 'reviewer', reason: 'Disable altered proposal', evidencePath: s.evidencePath });
      assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
    });
  }
  for (const accepted of [false, true]) {
    test(`${provider}: ${accepted ? 'accepted' : 'candidate'} proposal edit cannot be hidden by recomputing its mutable ID`, t => {
      const s = setup(t, provider); accepted ? s.promote() : s.record();
      const storeFile = path.join(s.store, 'review-feedback.json');
      const stored = JSON.parse(fs.readFileSync(storeFile)); const lesson = stored.lessons[0];
      lesson.pattern = 'rehash-edited-pattern';
      lesson.id = require('node:crypto').createHash('sha256').update(JSON.stringify([lesson.pattern, lesson.category, lesson.stage, lesson.tags])).digest('hex');
      fs.writeFileSync(storeFile, JSON.stringify(stored));
      assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }).status, 0);
    });
  }
  for (const artifact of ['proposal', 'approval']) for (const mutation of ['deleted', 'modified', 'missing-reference']) {
    test(`${provider}: ${artifact} immutable receipt ${mutation} fails reuse and remains explicitly retireable`, t => {
      const s = setup(t, provider); const id = s.promote();
      const storeFile = path.join(s.store, 'review-feedback.json');
      const stored = JSON.parse(fs.readFileSync(storeFile));
      const holder = artifact === 'proposal' ? stored.lessons[0] : stored.lessons[0].decisions.at(-1);
      const key = artifact === 'proposal' ? 'proposalEvidence' : 'approval';
      const reference = holder[key];
      assert.ok(reference, 'native creation and approval must save proposal receipts');
      if (mutation === 'deleted') fs.unlinkSync(reference.path);
      else if (mutation === 'modified') fs.appendFileSync(reference.path, '\nChanged receipt.');
      else { delete holder[key]; fs.writeFileSync(storeFile, JSON.stringify(stored)); }
      assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }).status, 0);
      const evidencePath = path.join(s.root, 'proposal-retirement.md');
      fs.writeFileSync(evidencePath, 'Disable the lesson whose immutable proposal proof is invalid.');
      assert.equal(s.ok('decide', { id, decision: 'retire', reviewedBy: 'reviewer', reason: 'Disable invalid proposal receipt', evidencePath }).status, 'retired');
      assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
    });
  }
  test(`${provider}: tampered accepted proposal can retire while intact lessons remain reusable`, t => {
    const s = setup(t, provider); const id = s.promote();
    const secondPacket = { ...s.packet, pattern: 'intact-lesson' };
    const second = s.record(secondPacket); s.record({ ...secondPacket, runKey: 'run-b' });
    s.ok('decide', { id: second.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Approve intact lesson', evidencePath: s.evidencePath });
    const storeFile = path.join(s.store, 'review-feedback.json');
    const stored = JSON.parse(fs.readFileSync(storeFile)); stored.lessons.find(l => l.id === id).rule = 'Silently changed approved rule.';
    fs.writeFileSync(storeFile, JSON.stringify(stored));
    assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }).status, 0);
    s.ok('decide', { id, decision: 'retire', reviewedBy: 'reviewer', reason: 'Disable altered proposal', evidencePath: s.evidencePath });
    assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons.map(l => l.id), [second.id]);
    assert.notEqual(s.call('decide', { id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Cannot restore altered proposal silently', evidencePath: s.evidencePath }).status, 0);
  });
  test(`${provider}: acceptance replay after telemetry changes retains one immutable approval`, t => {
    const s = setup(t, provider); const id = s.promote();
    const storeFile = path.join(s.store, 'review-feedback.json');
    const before = fs.readFileSync(storeFile, 'utf8'); const files = fs.readdirSync(s.store).sort();
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, telemetry: [{ calls: 30 }] }));
    s.ok('decide', { id, decision: 'accept', reviewedBy: 'independent-reviewer', reason: 'Repeated confirmed evidence supports prevention.', evidencePath: path.join(s.root, 'decision.md') });
    assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(s.store).sort(), files);
  });
  test(`${provider}: relabelling one review attempt as two runs cannot promote a rule`, (t) => {
    const s = setup(t, provider); const first = s.record();
    const copied = path.join(s.root, 'copied-ledger.json');
    fs.writeFileSync(copied, JSON.stringify({ ...s.ledger, initiative_binding: s.bind('run-b') }));
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
  for (const artifact of ['ledger', 'evidence', 'decision']) {
    for (const mutation of ['deleted', 'modified']) {
      test(`${provider}: accepted reuse fails visibly when ${artifact} snapshot is ${mutation}`, (t) => {
        const s = setup(t, provider); s.promote();
        const stored = JSON.parse(fs.readFileSync(path.join(s.store, 'review-feedback.json')));
        const lesson = stored.lessons[0];
        const reference = artifact === 'decision' ? lesson.decisions.at(-1).evidence : lesson.occurrences[0][artifact];
        if (mutation === 'deleted') fs.unlinkSync(reference.path);
        else fs.appendFileSync(reference.path, '\nChanged immutable evidence.');
        const before = fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8');
        const result = s.call('select', { stage: 'design', tags: ['state'] });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /feedback:/);
        assert.equal(fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8'), before);
      });
    }
  }
  for (const status of ['killed', 'open']) {
    test(`${provider}: accepted reuse blocks same-attempt ${status} contradictions`, (t) => {
      const s = setup(t, provider); s.promote();
      fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, status })) }));
      assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }).status, 0);
    });
  }
  test(`${provider}: changed same-attempt fix commit blocks accepted reuse and remains retireable`, t => {
    const s = setup(t, provider); const id = s.promote();
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, fix_commit: 'later-different-fix' })) }));
    const storeFile = path.join(s.store, 'review-feedback.json'); const before = fs.readFileSync(storeFile, 'utf8');
    for (const [verb, packet] of [['select', { stage: 'design', tags: ['state'] }], ['report', undefined],
      ['decide', { id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt unchanged acceptance', evidencePath: s.evidencePath }]]) {
      const result = s.call(verb, packet); assert.notEqual(result.status, 0); assert.match(result.stderr, /feedback:/);
    }
    assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    assert.equal(s.ok('decide', { id, decision: 'retire', reviewedBy: 'reviewer', reason: 'Reconcile changed intervention evidence', evidencePath: s.evidencePath }).status, 'retired');
    assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
  });
  test(`${provider}: changed same-attempt fix commit blocks promotion with two independent supports`, t => {
    const s = setup(t, provider); const first = s.record(); s.record({ ...s.packet, runKey: 'run-b' });
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, fix_commit: 'later-different-fix' })) }));
    const result = s.call('decide', { id: first.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt promotion', evidencePath: s.evidencePath });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /feedback:/);
  });
  test(`${provider}: archived support origins preserve immutable accepted proof`, t => {
    const s = setup(t, provider); const id = s.promote();
    fs.renameSync(s.ledgerPath, path.join(s.root, 'archived-target.json'));
    assert.equal(s.ok('select', { stage: 'design', tags: ['state'] }).lessons[0].id, id);
    assert.equal(s.ok('report').statuses.accepted, 1);
    assert.equal(fs.existsSync(s.ledgerPath), false);
  });
  for (const mutation of ['deleted-proof', 'killed', 'open']) {
    for (const decision of ['retire', 'reject']) {
      test(`${provider}: explicit ${decision} reconciles accepted ${mutation} evidence`, (t) => {
        const s = setup(t, provider); const id = s.promote();
        if (mutation === 'deleted-proof') {
          const stored = JSON.parse(fs.readFileSync(path.join(s.store, 'review-feedback.json')));
          fs.unlinkSync(stored.lessons[0].occurrences[0].evidence.path);
        } else {
          fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, findings: s.ledger.findings.map(f => ({ ...f, status: mutation })) }));
        }
        assert.notEqual(s.call('select', { stage: 'design', tags: ['state'] }).status, 0);
        const reconciliationPath = path.join(s.root, 'reconciliation.md');
        fs.writeFileSync(reconciliationPath, 'Reviewed the invalid evidence and explicitly disabled this lesson.');
        assert.equal(s.ok('decide', { id, decision, reviewedBy: 'reviewer', reason: 'Reconcile invalid accepted evidence', evidencePath: reconciliationPath }).status, decision === 'retire' ? 'retired' : 'rejected');
        assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
      });
    }
  }
  for (const decision of ['retire', 'reject']) {
    test(`${provider}: sequential ${decision} disables shared invalid proof while all reuse remains blocked`, t => {
      const s = setup(t, provider); const id = s.promote();
      const secondPacket = { ...s.packet, pattern: 'second-lesson' };
      const second = s.record(secondPacket); s.record({ ...secondPacket, runKey: 'run-b' });
      s.ok('decide', { id: second.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Verified second lesson', evidencePath: s.evidencePath });
      const storeFile = path.join(s.store, 'review-feedback.json');
      const stored = JSON.parse(fs.readFileSync(storeFile));
      const shared = stored.lessons[0].occurrences[0].evidence.path;
      assert.equal(stored.lessons[1].occurrences[0].evidence.path, shared);
      fs.unlinkSync(shared);
      const reconciliationPath = path.join(s.root, 'reconciliation.md');
      fs.writeFileSync(reconciliationPath, 'Explicitly disable lessons sharing invalid support without enabling reuse.');
      const disable = lessonId => s.ok('decide', { id: lessonId, decision, reviewedBy: 'reviewer', reason: 'Disable invalid proof', evidencePath: reconciliationPath });
      const checkBlocked = () => {
        const before = fs.readFileSync(storeFile, 'utf8');
        for (const [verb, packet] of [
          ['select', { stage: 'design', tags: ['state'] }], ['report', undefined],
          ['decide', { id: second.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt reuse', evidencePath: reconciliationPath }],
          ['record', { ...s.packet, pattern: 'third-lesson' }],
          ['observe', { runKey: 'run-c', unit: 'ticket', ledgerPath: s.ledgerPath, evidencePath: reconciliationPath, outcomes: [{ id: second.id, outcome: 'not-observed' }] }],
        ]) assert.notEqual(s.call(verb, packet).status, 0, `${verb} must reject invalid accepted proof`);
        assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
      };
      checkBlocked();
      assert.equal(disable(id).status, decision === 'retire' ? 'retired' : 'rejected');
      checkBlocked();
      assert.equal(disable(second.id).status, decision === 'retire' ? 'retired' : 'rejected');
      assert.deepEqual(s.ok('select', { stage: 'design', tags: ['state'] }).lessons, []);
      assert.equal(s.ok('report').statuses[decision === 'retire' ? 'retired' : 'rejected'], 2);
      assert.notEqual(s.call('decide', { id: second.id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt reacceptance', evidencePath: reconciliationPath }).status, 0);
    });
  }
  test(`${provider}: accepted reuse preserves original proof across telemetry updates and a new attempt`, (t) => {
    const s = setup(t, provider); const id = s.promote();
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, telemetry: [{ calls: 20 }] }));
    assert.equal(s.ok('select', { stage: 'design', tags: ['state'] }).lessons[0].id, id);
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, attemptId: 'later-native-attempt', findings: s.ledger.findings.map(f => ({ ...f, status: 'killed' })) }));
    assert.equal(s.ok('select', { stage: 'design', tags: ['state'] }).lessons[0].id, id);
  });
  for (const verb of ['record', 'observe']) {
    for (const provenance of ['foreign', 'unbound', 'missing']) {
      test(`${provider}: ${verb} rejects ${provenance} native repository provenance without changing review budgets`, (t) => {
        const s = setup(t, provider); const id = s.promote();
        const other = path.join(s.root, 'other-repository'); fs.mkdirSync(other);
        const foreignDir = path.join(s.root, 'foreign-initiative');
        const foreignBinding = s.bind('foreign-run', other, foreignDir);
        const foreignFile = runPath(foreignDir, 'foreign-run');
        const foreignBefore = fs.readFileSync(foreignFile, 'utf8');
        const localFile = runPath(s.initiativeDir, 'run-a');
        const localBefore = fs.readFileSync(localFile, 'utf8');
        const binding = provenance === 'foreign' ? foreignBinding : provenance === 'missing' ? { key: 'foreign-run', stateDir: path.join(s.root, 'missing-run') } : undefined;
        const inputLedger = path.join(s.root, 'input-ledger.json');
        fs.writeFileSync(inputLedger, JSON.stringify({ ...s.ledger, initiative_binding: binding }));
        const targetBefore = fs.readFileSync(inputLedger, 'utf8');
        const packet = verb === 'record' ? { ...s.packet, pattern: 'foreign-pattern', runKey: 'foreign-run', ledgerPath: inputLedger }
          : { runKey: 'foreign-run', unit: 'ticket-foreign', ledgerPath: inputLedger, evidencePath: s.evidencePath, outcomes: [{ id, outcome: 'recurred', findingId: s.packet.findingId }] };
        const storeBefore = fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8');
        const result = s.call(verb, packet);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /feedback:/);
        assert.equal(fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8'), storeBefore);
        assert.equal(fs.readFileSync(foreignFile, 'utf8'), foreignBefore);
        assert.equal(fs.readFileSync(localFile, 'utf8'), localBefore);
        assert.equal(fs.readFileSync(inputLedger, 'utf8'), targetBefore);
      });
    }
  }
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
  test(`${provider}: native panel-pending state supports fixed feedback and unmeasured outcomes without budget mutation`, t => {
    const s = setup(t, provider);
    fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, status: 'gate-panel-pending' }));
    const targetBefore = fs.readFileSync(s.ledgerPath, 'utf8');
    const initiativeFile = runPath(s.initiativeDir, 'run-a'); const initiativeBefore = fs.readFileSync(initiativeFile, 'utf8');
    const id = s.promote();
    const observation = { runKey: 'run-c', unit: 'pending-panel', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath, outcomes: [{ id, outcome: 'unmeasured' }] };
    assert.equal(s.ok('observe', observation).recorded, 1);
    assert.equal(s.ok('report').outcomes.unmeasured, 1);
    assert.equal(fs.readFileSync(s.ledgerPath, 'utf8'), targetBefore);
    assert.equal(fs.readFileSync(initiativeFile, 'utf8'), initiativeBefore);
    const before = fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8');
    assert.notEqual(s.call('observe', { ...observation, unit: 'incomplete-absence', outcomes: [{ id, outcome: 'not-observed' }] }).status, 0);
    assert.equal(fs.readFileSync(path.join(s.store, 'review-feedback.json'), 'utf8'), before);
  });
  for (const status of ['made-up-pending', 'finalized']) {
    test(`${provider}: unknown target state ${status} cannot become feedback evidence`, t => {
      const s = setup(t, provider); fs.writeFileSync(s.ledgerPath, JSON.stringify({ ...s.ledger, status }));
      const before = fs.readFileSync(s.ledgerPath, 'utf8');
      assert.notEqual(s.call('record', s.packet).status, 0);
      assert.equal(fs.readFileSync(s.ledgerPath, 'utf8'), before);
    });
  }
  for (const mutation of ['killed', 'missing-finding', 'reopened-review', 'foreign-repository', 'changed-run-key']) {
    test(`${provider}: contradictory live observation ${mutation} blocks normal feedback until original evidence is reconciled`, t => {
      const s = setup(t, provider); const id = s.promote(); const outcome = mutation === 'reopened-review' ? 'not-observed' : 'recurred';
      const packet = { runKey: 'run-c', unit: 'live-contradiction', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath,
        outcomes: [{ id, outcome, ...(outcome === 'recurred' ? { findingId: s.packet.findingId } : {}) }] };
      s.ok('observe', packet);
      const storeFile = path.join(s.store, 'review-feedback.json'); const before = fs.readFileSync(storeFile, 'utf8');
      const origin = JSON.parse(before).observations[0].ledger.originalPath;
      const original = fs.readFileSync(origin, 'utf8'); const ledger = JSON.parse(original);
      if (mutation === 'killed') ledger.findings[0].status = 'killed';
      else if (mutation === 'missing-finding') ledger.findings = [];
      else if (mutation === 'reopened-review') ledger.status = 'converging';
      else if (mutation === 'changed-run-key') ledger.initiative_binding.key = 'unrelated-run';
      else {
        const other = path.join(s.root, 'foreign-repository'); fs.mkdirSync(other);
        ledger.initiative_binding = s.bind('run-c', other, path.join(s.root, 'foreign-initiative'));
      }
      fs.writeFileSync(origin, JSON.stringify(ledger));
      for (const [verb, value] of [['report', undefined], ['select', { stage: 'design', tags: ['state'] }], ['record', { ...s.packet, pattern: 'new-lesson' }],
        ['observe', packet], ['decide', { id, decision: 'accept', reviewedBy: 'reviewer', reason: 'Attempt unaffected acceptance', evidencePath: s.evidencePath }]]) {
        const result = s.call(verb, value); assert.notEqual(result.status, 0, `${verb} must reject contradictory observation proof`); assert.match(result.stderr, /feedback:/);
      }
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
      fs.writeFileSync(origin, original); // explicit restoration of the original native review evidence
      assert.equal(s.ok('report').outcomes.applied, 1);
    });
  }
  for (const outcome of ['recurred', 'not-observed', 'unmeasured']) for (const recovery of ['rerun', 'archive']) {
    test(`${provider}: observation ${outcome} retains past proof after origin ${recovery}`, t => {
      const s = setup(t, provider); const id = s.promote();
      s.ok('observe', { runKey: 'run-c', unit: 'historical-observation', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath,
        outcomes: [{ id, outcome, ...(outcome === 'recurred' ? { findingId: s.packet.findingId } : {}) }] });
      const storeFile = path.join(s.store, 'review-feedback.json'); const before = fs.readFileSync(storeFile, 'utf8');
      const origin = JSON.parse(before).observations[0].ledger.originalPath;
      if (recovery === 'archive') fs.renameSync(origin, path.join(s.root, 'archived-observation.json'));
      else {
        const current = JSON.parse(fs.readFileSync(origin));
        fs.writeFileSync(origin, JSON.stringify({ ...current, attemptId: 'later-native-review-attempt', status: 'converging', findings: current.findings.map(f => ({ ...f, status: 'killed' })) }));
      }
      assert.equal(s.ok('report').outcomes.applied, 1);
      assert.equal(s.ok('select', { stage: 'design', tags: ['state'] }).lessons[0].id, id);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    });
  }
  test(`${provider}: a later legitimate fix does not invalidate an actual recurrence`, t => {
    const s = setup(t, provider); const id = s.promote();
    const origin = path.join(s.root, 'open-recurrence.json');
    const ledger = { ...s.ledger, attemptId: 'independent-observation-attempt', initiative_binding: s.bind('run-c'), status: 'converging', findings: s.ledger.findings.map(f => ({ ...f, status: 'open', fix_commit: null })) };
    fs.writeFileSync(origin, JSON.stringify(ledger));
    s.ok('observe', { runKey: 'run-c', unit: 'eventual-fix', ledgerPath: origin, evidencePath: s.evidencePath, outcomes: [{ id, outcome: 'recurred', findingId: s.packet.findingId }] });
    fs.writeFileSync(origin, JSON.stringify({ ...ledger, status: 'clean', findings: ledger.findings.map(f => ({ ...f, status: 'fixed', fix_commit: 'actual-later-fix' })) }));
    assert.equal(s.ok('report').outcomes.recurred, 1);
  });
  for (const outcome of ['recurred', 'not-observed', 'unmeasured']) {
    test(`${provider}: unchanged ${outcome} observation retry survives unrelated telemetry`, t => {
      const s = setup(t, provider); const id = s.promote();
      const packet = { runKey: 'run-c', unit: 'ticket-telemetry', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath,
        outcomes: [{ id, outcome, ...(outcome === 'recurred' ? { findingId: s.packet.findingId } : {}) }] };
      s.ok('observe', packet);
      const storeFile = path.join(s.store, 'review-feedback.json');
      const before = fs.readFileSync(storeFile, 'utf8'); const files = fs.readdirSync(s.store).sort();
      const observation = JSON.parse(before).observations[0];
      const source = JSON.parse(fs.readFileSync(observation.ledger.originalPath));
      fs.writeFileSync(observation.ledger.originalPath, JSON.stringify({ ...source, telemetry: [{ calls: 40 }] }));
      assert.equal(s.ok('observe', packet).duplicate, true);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
      assert.deepEqual(fs.readdirSync(s.store).sort(), files);
      assert.equal(s.ok('report').outcomes.applied, 1);
    });
  }
  for (const outcome of ['recurred', 'not-observed']) for (const receipt of ['ledger', 'evidence']) for (const mutation of ['deleted', 'modified']) {
    test(`${provider}: report rejects ${mutation} observation-only ${receipt} for ${outcome}`, t => {
      const s = setup(t, provider); const id = s.promote();
      const evidencePath = path.join(s.root, 'observation.md');
      fs.writeFileSync(evidencePath, 'Independent later review measurement.');
      s.ok('observe', { runKey: 'run-c', unit: 'ticket-receipt', ledgerPath: s.ledgerPath, evidencePath,
        outcomes: [{ id, outcome, ...(outcome === 'recurred' ? { findingId: s.packet.findingId } : {}) }] });
      const storeFile = path.join(s.store, 'review-feedback.json');
      const before = fs.readFileSync(storeFile, 'utf8');
      const stored = JSON.parse(before); const observation = stored.observations[0];
      assert.equal(stored.lessons[0].occurrences.some(o => o[receipt].path === observation[receipt].path), false);
      assert.equal(s.ok('report').outcomes.applied, 1);
      if (mutation === 'deleted') fs.unlinkSync(observation[receipt].path);
      else if (receipt === 'ledger') {
        const saved = JSON.parse(fs.readFileSync(observation.ledger.path));
        fs.writeFileSync(observation.ledger.path, JSON.stringify({ ...saved, status: 'parked' }));
      } else fs.writeFileSync(observation.evidence.path, 'Changed measurement evidence.');
      const result = s.call('report');
      assert.notEqual(result.status, 0, 'unsupported measurement must not be reported');
      assert.match(result.stderr, /feedback:/);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    });
  }
  for (const mutation of ['run-key', 'origin', 'repository', 'incomplete-review', 'missing-finding', 'killed-finding']) {
    test(`${provider}: report rejects observation receipt with inconsistent ${mutation}`, t => {
      const s = setup(t, provider); const id = s.promote();
      const outcome = mutation === 'incomplete-review' ? 'not-observed' : 'recurred';
      s.ok('observe', { runKey: 'run-c', unit: 'ticket-provenance', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath,
        outcomes: [{ id, outcome, ...(outcome === 'recurred' ? { findingId: s.packet.findingId } : {}) }] });
      const storeFile = path.join(s.store, 'review-feedback.json');
      const stored = JSON.parse(fs.readFileSync(storeFile)); const observation = stored.observations[0];
      if (mutation === 'run-key') observation.runKey = 'different-run';
      else if (mutation === 'origin') observation.ledger.originalSha256 = '0'.repeat(64);
      else {
        const saved = JSON.parse(fs.readFileSync(observation.ledger.path));
        if (mutation === 'repository') saved.repository = 'different-repository';
        else if (mutation === 'incomplete-review') saved.status = 'parked';
        else if (mutation === 'missing-finding') saved.findings = [];
        else saved.findings[0].status = 'killed';
        const bytes = Buffer.from(JSON.stringify(saved));
        fs.writeFileSync(observation.ledger.path, bytes);
        observation.ledger.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      }
      fs.writeFileSync(storeFile, JSON.stringify(stored));
      const before = fs.readFileSync(storeFile, 'utf8');
      const result = s.call('report');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /feedback:/);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    });
  }
  for (const mutation of ['proof', 'outcome', 'ledger-status', 'recurrence-status', 'recurrence-commit']) {
    test(`${provider}: observation retry rejects changed ${mutation} while retaining the original receipt`, t => {
      const s = setup(t, provider); const id = s.promote();
      const packet = { runKey: 'run-c', unit: 'ticket-negative', ledgerPath: s.ledgerPath, evidencePath: s.evidencePath,
        outcomes: [{ id, outcome: 'recurred', findingId: s.packet.findingId }] };
      s.ok('observe', packet);
      const storeFile = path.join(s.store, 'review-feedback.json');
      const before = fs.readFileSync(storeFile, 'utf8');
      const observation = JSON.parse(before).observations[0];
      const source = JSON.parse(fs.readFileSync(observation.ledger.originalPath));
      let retry = packet;
      if (mutation === 'proof') fs.writeFileSync(s.evidencePath, 'Different observation evidence.');
      else if (mutation === 'outcome') retry = { ...packet, outcomes: [{ id, outcome: 'not-observed' }] };
      else if (mutation === 'ledger-status') source.status = 'parked';
      else source.findings[0] = { ...source.findings[0], ...(mutation === 'recurrence-status' ? { status: 'open' } : { fix_commit: 'changed-commit' }) };
      fs.writeFileSync(observation.ledger.originalPath, JSON.stringify(source));
      assert.notEqual(s.call('observe', retry).status, 0);
      assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    });
  }
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
