'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeArtifact, ArtifactError, retryPrompt, allowedFindingPrefixes, preservesArtifact } = require('../../core/artifact-contract');

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
