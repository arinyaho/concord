'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeArtifact, ArtifactError, retryPrompt } = require('../../core/artifact-contract');

test('canonical correctness artifact is preserved except unsupported top-level fields', () => {
  const finding = { id: 'correctness:real-bug', file: 'a.js', span: 'bad()', summary: 'wrong result', evidence: 'keep' };
  assert.deepStrictEqual(normalizeArtifact('correctness', JSON.stringify({ status: 'ok', examined: ['a.js'], findings: [finding], noise: true })), { status: 'ok', examined: ['a.js'], findings: [finding] });
});

test('findings status canonicalizes without changing finding meaning', () => {
  const finding = { id: 'correctness:real-bug', file: 'a.js', span: 'bad()', summary: 'wrong result' };
  assert.deepStrictEqual(normalizeArtifact('correctness', JSON.stringify({ status: 'findings', examined: ['a.js'], findings: [finding] })).findings[0], finding);
});

test('clean status canonicalizes to ok', () => {
  assert.deepStrictEqual(normalizeArtifact('verify', '{"status":"clean"}'), { status: 'ok', rejected: [], findings: [] });
});

test('correctness retry prompt names both valid namespaces without inventing a prefix', () => {
  const prompt = retryPrompt('correctness', 'correctness:|docreview:');
  assert.match(prompt, /correctness:.*or.*docreview:/);
  assert.doesNotMatch(prompt, /correctness:\|docreview:/);
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
  assert.match(retryPrompt('verify', 'correctness:|docreview:'), /"blocked"/);
});

test('the verify retry prompt spells out the rejection object shape', () => {
  assert.match(retryPrompt('verify', 'correctness:|docreview:'), /"reason"/);
  assert.doesNotMatch(retryPrompt('correctness', 'correctness:|docreview:'), /"reason"/);
});
