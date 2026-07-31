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
  assert.deepStrictEqual(normalizeArtifact('verify', '{"status":"clean"}'), { status: 'ok', rejected: [] });
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
  assert.deepStrictEqual(normalizeArtifact('verify', raw), { status: 'ok', rejected: [{ id: 'correctness:x', reason: 'measured with playwright: box is 320px' }] });
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
  assert.deepStrictEqual(normalizeArtifact('verify', '{"status":"ok","rejected":[],"blocked":[]}'), { status: 'ok', rejected: [] });
});

test('the verify retry prompt spells out the rejection object shape', () => {
  assert.match(retryPrompt('verify', 'correctness:|docreview:'), /"reason"/);
  assert.doesNotMatch(retryPrompt('correctness', 'correctness:|docreview:'), /"reason"/);
});
