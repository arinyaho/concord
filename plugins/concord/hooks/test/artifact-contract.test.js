'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeArtifact, ArtifactError, retryPrompt, allowedFindingPrefixes, preservesArtifact, repairPacket } = require('../../core/artifact-contract');

test('repair preservation accepts plan findingIds, clean verdicts, and reordered object keys', () => {
  const plan = { status: 'OK', protocolVersion: 2, groups: [{ groupId: 'g', findingIds: ['correctness:x'], rootCause: 'one', invariants: [], changeClass: 'local', structuralEffects: [], action: 'fix' }] };
  const candidate = { protocolVersion: 2, groups: [{ action: 'fix', structuralEffects: [], changeClass: 'local', invariants: [], rootCause: 'one', findingIds: ['correctness:x'], groupId: 'g' }], status: 'ok' };
  assert.ok(preservesArtifact('plan', JSON.stringify(plan), candidate));
  assert.ok(preservesArtifact('gate', JSON.stringify({ status: 'OK', findings: [] }), { status: 'ok', findings: [] }));
});

test('canonical correctness artifact is preserved except unsupported top-level fields', () => {
  const finding = { id: 'correctness:real-bug', file: 'a.js', span: 'bad()', summary: 'wrong result', evidence: 'keep' };
  assert.deepStrictEqual(normalizeArtifact('correctness', JSON.stringify({ status: 'ok', examined: ['a.js'], findings: [finding], noise: true })), { status: 'ok', examined: ['a.js'], findings: [finding] });
});

test('status repair preserves correctness examined paths as evidence', () => {
  const original = JSON.stringify({ status: 'OK', examined: ['changed-file.js'], findings: [] });
  assert.ok(preservesArtifact('correctness', original, { status: 'ok', examined: ['changed-file.js'], findings: [] }));
});

test('findings status canonicalizes without changing finding meaning', () => {
  const finding = { id: 'correctness:real-bug', file: 'a.js', span: 'bad()', summary: 'wrong result' };
  assert.deepStrictEqual(normalizeArtifact('correctness', JSON.stringify({ status: 'findings', examined: ['a.js'], findings: [finding] })).findings[0], finding);
});

test('clean status canonicalizes to ok', () => {
  assert.deepStrictEqual(normalizeArtifact('verify', '{"status":"clean"}'), { status: 'ok', rejected: [], findings: [] });
});

test('correctness retry prompt names both valid namespaces without inventing a prefix', () => {
  const prompt = retryPrompt('correctness');
  assert.match(prompt, /correctness:.*or.*docreview:/);
  assert.doesNotMatch(prompt, /correctness:\|docreview:/);
});

test('artifact roles retain their finding namespace ownership', () => {
  assert.deepStrictEqual(allowedFindingPrefixes('correctness'), ['correctness:', 'docreview:']);
  assert.deepStrictEqual(allowedFindingPrefixes('verify'), ['correctness:', 'docreview:']);
  assert.deepStrictEqual(allowedFindingPrefixes('gate'), ['gate:']);
  assert.deepStrictEqual(allowedFindingPrefixes('gate-verify'), ['gate:']);
  assert.deepStrictEqual(allowedFindingPrefixes('intent'), ['intent:']);
});

for (const [role, field, allowedId, rejectedId] of [
  ['correctness', 'findings', 'correctness:owned', 'gate:foreign'],
  ['verify', 'rejected', 'correctness:owned', 'gate:foreign'],
  ['gate', 'findings', 'gate:owned', 'correctness:foreign'],
  ['gate-verify', 'rejected', 'gate:owned', 'correctness:foreign'],
  ['intent', 'findings', 'intent:owned', 'gate:foreign'],
]) test(`${role} validation accepts only its owned finding namespace`, () => {
  const entry = (id) => field === 'rejected'
    ? { id, reason: 'read the candidate and repository evidence' }
    : { id, file: 'a.js', summary: 'candidate summary' };
  const raw = (id) => JSON.stringify({ status: 'ok', [field]: [entry(id)] });
  assert.doesNotThrow(() => normalizeArtifact(role, raw(allowedId)));
  assert.throws(
    () => normalizeArtifact(role, raw(rejectedId)),
    (error) => error instanceof ArtifactError && error.kind === 'retry' && error.message.includes(rejectedId),
  );
});

test('gate-verify retry prompt restates its role and context-only namespace boundary', () => {
  const prompt = retryPrompt('gate-verify');
  assert.match(prompt, /role is gate-verify/i);
  assert.match(prompt, /allowed.*gate:/i);
  assert.match(prompt, /correctness:\*.*must not.*disposition/i);
  assert.match(prompt, /correctness verifier/i);
  assert.match(prompt, /preserve.*evidence/i);
  assert.match(prompt, /gate.*candidates/i);
});

for (const [name, raw, kind] of [
  ['correctness', '{bad', 'fatal'],
  ['correctness', '{"status":"ok","findings":[{"id":"correctness:x","summary":"s"}]}', 'fatal'],
  ['correctness', '{"status":"ok","findings":[{"id":"gate:x","file":"a","summary":"s"}]}', 'retry'],
]) test(`${name} invalid artifact is classified ${kind}`, () => {
  assert.throws(() => normalizeArtifact(name, raw), (error) => error instanceof ArtifactError && error.kind === kind);
});

test('a rejection carries its stated basis and canonicalizes to {id, reason}', () => {
  const raw = '{"status":"ok","rejected":[{"id":"correctness:x","reason":"  measured with playwright: box is 320px  "}]}';
  assert.deepStrictEqual(normalizeArtifact('verify', raw), { status: 'ok', rejected: [{ id: 'correctness:x', reason: 'measured with playwright: box is 320px' }], findings: [] });
});

test('verify preserves root-cause groups and structural reconciliation', () => {
  const raw = JSON.stringify({
    status: 'ok', rejected: [], findings: [], groups: [{
      findingIds: ['correctness:a', 'correctness:b'],
      rootCause: 'message identity is not attempt identity',
      invariants: ['a stale delivery cannot fail the active attempt'],
      changeClass: 'structural', action: 'reconcile',
      reason: 'the approved design does not choose an attempt-identity contract',
    }],
  });
  assert.deepStrictEqual(normalizeArtifact('verify', raw).groups, [{
    findingIds: ['correctness:a', 'correctness:b'],
    rootCause: 'message identity is not attempt identity',
    invariants: ['a stale delivery cannot fail the active attempt'],
    changeClass: 'structural', action: 'reconcile',
    reason: 'the approved design does not choose an attempt-identity contract',
  }]);
});

test('plan artifacts require v2 structural design evidence', () => {
  assert.throws(() => normalizeArtifact('plan', JSON.stringify({
    status: 'ok', protocolVersion: 2, groups: [{
      groupId: 'attempt-identity', findingIds: ['correctness:a'],
      rootCause: 'attempt identity is undefined', invariants: ['only the active attempt may decide the result'],
      changeClass: 'structural', structuralEffects: ['identity'], action: 'fix',
    }],
  })), /designEvidence/);

  const normalized = normalizeArtifact('plan', JSON.stringify({
    status: 'ok', protocolVersion: 2, groups: [{
      groupId: 'attempt-identity', findingIds: ['correctness:a'],
      rootCause: 'attempt identity is undefined', invariants: ['only the active attempt may decide the result'],
      changeClass: 'structural', structuralEffects: ['identity'], action: 'fix',
      designEvidence: { source: 'intent-feat.md', sourceHash: 'abc123', requirements: ['attempt generation owns completion'], uniqueness: 'the requirement names one owner' },
    }],
  }));
  assert.strictEqual(normalized.protocolVersion, 2);
  assert.strictEqual(normalized.groups[0].groupId, 'attempt-identity');
});

for (const [label, raw] of [
  ['a bare id string', '{"status":"ok","rejected":["correctness:x"]}'],
  ['an empty reason', '{"status":"ok","rejected":[{"id":"correctness:x","reason":"  "}]}'],
]) test(`a rejection with ${label} retries instead of killing the finding`, () => {
  assert.throws(() => normalizeArtifact('verify', raw), (e) => e instanceof ArtifactError && e.kind === 'retry' && /reason/.test(e.message));
});

test('a reviewer that reports a blocked tool fails the round instead of producing a verdict', () => {
  const raw = '{"status":"ok","rejected":[],"blocked":["playwright: browser launch denied by sandbox"]}';
  assert.throws(() => normalizeArtifact('verify', raw), (e) => e instanceof ArtifactError && e.kind === 'fatal' && /browser launch denied/.test(e.message));
});

test('an empty blocked array is a clean reviewer, not a failure', () => {
  assert.deepStrictEqual(normalizeArtifact('verify', '{"status":"ok","rejected":[],"blocked":[]}'), { status: 'ok', rejected: [], findings: [] });
});

test('blocked wins over an unsupported status, so the reviewer is never retried into dropping it', () => {
  const raw = '{"status":"blocked","rejected":[],"blocked":["playwright: browser launch denied by sandbox"]}';
  assert.throws(() => normalizeArtifact('verify', raw), (e) => e instanceof ArtifactError && e.kind === 'fatal' && /browser launch denied/.test(e.message));
});

test('the retry prompt never tells a blocked reviewer to drop "blocked"', () => {
  assert.match(retryPrompt('verify'), /"blocked"/);
});

test('the verify retry prompt spells out the rejection object shape', () => {
  assert.match(retryPrompt('verify'), /"reason"/);
  assert.doesNotMatch(retryPrompt('correctness'), /"reason"/);
});

test('plan artifacts accept a local group that needs a human decision and name the missing reason', () => {
  const group = { groupId: 'delivery-evidence', findingIds: ['correctness:a'], rootCause: 'empty evidence classification is undecided', invariants: ['a packet with no evidence is never mergeable-clean'], changeClass: 'local', action: 'reconcile' };
  const plan = (extra) => JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [{ ...group, ...extra }] });
  assert.throws(() => normalizeArtifact('plan', plan({})), /human reconciliation is required/);
  const [normalized] = normalizeArtifact('plan', plan({ reason: 'whether empty acceptance evidence may classify as mergeable is a product decision' })).groups;
  assert.strictEqual(normalized.changeClass, 'local');
  assert.strictEqual(normalized.action, 'reconcile');
});

test('plan artifacts name the rule when action is neither fix nor reconcile', () => {
  assert.throws(() => normalizeArtifact('plan', JSON.stringify({
    status: 'ok', protocolVersion: 2, groups: [{ groupId: 'g', findingIds: ['correctness:a'], rootCause: 'r', invariants: ['i'], changeClass: 'local', action: 'park' }],
  })), /action must be "fix" or "reconcile"/);
});

test('gate-verify keeps a duplicates entry that names the correctness candidate it restates', () => {
  const out = normalizeArtifact('gate-verify', JSON.stringify({ status: 'ok', rejected: [], findings: [], duplicates: [{ id: 'gate:design-conformance:x', of: 'correctness:x' }] }));
  assert.deepStrictEqual(out.duplicates, [{ id: 'gate:design-conformance:x', of: 'correctness:x' }]);
});

test('gate-verify duplicates must pair a gate id with a correctness id, and not also reject it', () => {
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ status: 'ok', rejected: [], findings: [], duplicates: [{ id: 'gate:a:x', of: 'gate:b:y' }] })), ArtifactError);
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ status: 'ok', rejected: [{ id: 'gate:a:x', reason: 'r' }], findings: [], duplicates: [{ id: 'gate:a:x', of: 'correctness:x' }] })), ArtifactError);
});

test('plan artifacts reject group ids that repeat or share an artifact file name', () => {
  const group = (groupId, id) => ({ groupId, findingIds: [id], rootCause: 'r', invariants: ['i'], changeClass: 'local', structuralEffects: [], action: 'fix' });
  for (const ids of [['same', 'same'], ['foo:bar', 'foo_bar']]) {
    assert.throws(() => normalizeArtifact('plan', JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [group(ids[0], 'correctness:a'), group(ids[1], 'correctness:b')] })),
      (error) => error instanceof ArtifactError && error.kind === 'retry' && /group\[0\] and group\[1\]/.test(error.message));
  }
});

test('gate-verify finding in the verdict shape (kept candidate listed in findings) is retried, naming the missing file', () => {
  const raw = JSON.stringify({ status: 'ok', rejected: [], findings: [{ id: 'gate:cross-context:x', rationale: 'kept', releaseBlocking: [] }] });
  assert.throws(() => normalizeArtifact('gate-verify', raw), (error) => error instanceof ArtifactError && error.kind === 'retry' && /finding\[0\] is missing "file"/.test(error.message));
});

test('a missing finding field is retried for verify and gate-verify but stays fatal for the primary reviewers', () => {
  const raw = (id) => JSON.stringify({ status: 'ok', rejected: [], examined: [], findings: [{ id, summary: 's' }] });
  assert.throws(() => normalizeArtifact('verify', raw('correctness:x')), (error) => error.kind === 'retry');
  for (const [name, id] of [['correctness', 'correctness:x'], ['gate', 'gate:cross-context:x'], ['intent', 'intent:x']]) {
    assert.throws(() => normalizeArtifact(name, raw(id)), (error) => error.kind === 'fatal', name);
  }
});

test('repair packet names an evidence-less finding by its index in the original findings array', () => {
  const raw = JSON.stringify({ status: 'ok', rejected: [], findings: [{ id: 'gate:cross-context:new', file: 'a', summary: 's' }, { id: 'gate:silent-gap:kept', rationale: 'kept' }] });
  assert.deepStrictEqual(repairPacket('gate-verify', 'e', raw).invalidFindings, [{ index: 1, id: 'gate:silent-gap:kept' }]);
});

test('group validation messages name the artifact role, not a literal "verify"', () => {
  const group = { groupId: 'g', findingIds: ['gate:cross-context:x'], rootCause: 'one', invariants: ['i'], changeClass: 'local', action: 'fix' };
  const planErr = () => normalizeArtifact('plan', JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [group] }));
  assert.throws(planErr, (error) => error.kind === 'retry' && /^plan group\[0\]/.test(error.message));
  assert.throws(() => normalizeArtifact('plan', JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [null] })), /plan group\[0\] is not an object/);
  assert.throws(() => normalizeArtifact('verify', JSON.stringify({ status: 'ok', rejected: [], findings: [], groups: [{ ...group, findingIds: ['gate:cross-context:x'] }] })), /verify group\[0\]/);
});
