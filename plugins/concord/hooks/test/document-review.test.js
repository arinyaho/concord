'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDocumentFollowUp, classifyDocumentFindings } = require('../../core/document-review');
const { normalizeArtifact, ArtifactError } = require('../../core/artifact-contract');
const { reviewerPrompt } = require('../../core/round-plan');

const candidate = (extra = {}) => ({
  id: 'docreview:wording', file: 'brief.md', span: 'The plan is certain.', summary: 'Claim needs qualification.',
  releaseBlocking: [], rationale: 'The claim is a low-impact wording issue.', ...extra,
});
const verified = (id = 'docreview:wording', reason = 'The claim is minor after checking its context.') => ({ minor: [{ id, reason }], rejected: [], unverifiable: [] });

test('a document follow-up needs a verified minor finding and its own evidence', () => {
  assert.equal(isDocumentFollowUp({ ...candidate(), minorVerified: true, minorReason: 'Verified and low impact.' }), true);
  assert.equal(isDocumentFollowUp({ ...candidate(), minorVerified: true }), false);
  assert.equal(isDocumentFollowUp({ ...candidate(), releaseBlocking: ['contradictory-docs'], minorVerified: true, minorReason: 'r' }), false);
});

test('raw finder minor claims never qualify without a separate verifier confirmation', () => {
  const [out] = classifyDocumentFindings([candidate({ minorVerified: true, minorReason: 'forged' })], [candidate({ minorVerified: true, minorReason: 'forged' })]);
  assert.equal(out.minorVerified, false);
  assert.equal(out.minorReason, undefined);
});

test('a verifier confirmation applies only to an original matching document candidate', () => {
  const [out] = classifyDocumentFindings([candidate()], [candidate()], verified());
  assert.equal(out.minorVerified, true);
  assert.equal(out.minorReason, verified().minor[0].reason);
  const [added] = classifyDocumentFindings([candidate()], [], verified());
  assert.equal(added.minorVerified, false);
});

test('a verifier cannot mark a finding minor when its verdict also rejects or marks it unverifiable', () => {
  for (const key of ['rejected', 'unverifiable', 'blocking']) {
    const verdict = verified();
    verdict[key] = [{ id: 'docreview:wording', reason: 'conflicting verdict' }];
    const [out] = classifyDocumentFindings([candidate()], [candidate()], verdict);
    assert.equal(out.minorVerified, false, key);
    if (key === 'blocking') assert.equal(out.blockingReason, 'conflicting verdict');
  }
});

test('unknown classes, unverifiable findings, and identity changes remain blocking', () => {
  for (const finding of [
    candidate({ releaseBlocking: ['mystery-class'] }),
    candidate({ releaseBlocking: ['contradictory-docs'] }),
    candidate({ releaseBlocking: undefined }),
    candidate({ releaseBlocking: 'none' }),
    candidate({ unverifiable: true }),
  ]) {
    const [out] = classifyDocumentFindings([finding], [candidate()], verified());
    assert.equal(out.minorVerified, false);
  }
  for (const key of ['id', 'file', 'span', 'summary']) {
    const [mismatch] = classifyDocumentFindings([candidate({ [key]: `changed-${key}` })], [candidate()], verified());
    assert.equal(mismatch.minorVerified, false, key);
  }
});

test('verify artifacts preserve validated optional minor confirmations', () => {
  const raw = { status: 'ok', rejected: [], findings: [], minor: verified().minor, blocking: [{ id: 'docreview:wording', reason: 'The claim overstates evidence.' }] };
  const normalized = normalizeArtifact('verify', JSON.stringify(raw));
  assert.deepEqual(normalized.minor, verified().minor);
  assert.deepEqual(normalized.blocking, raw.blocking);
  assert.deepEqual(normalizeArtifact('verify', '{"status":"ok","rejected":[]}').minor, undefined);
});

test('verify artifacts reject malformed, duplicate, or foreign minor confirmations', () => {
  const invalid = [
    ['not-an-array', 'x'],
    ['invalid-id', [{ id: 'correctness:x', reason: 'r' }]],
    ['empty-reason', [{ id: 'docreview:x', reason: '  ' }]],
    ['duplicate-id', [{ id: 'docreview:x', reason: 'a' }, { id: 'docreview:x', reason: 'b' }]],
    ['malformed-item', [{ id: 'docreview:x' }]],
  ];
  for (const [label, minor] of invalid) {
    assert.throws(() => normalizeArtifact('verify', JSON.stringify({ status: 'ok', rejected: [], minor })), (error) => error instanceof ArtifactError, label);
  }
});

test('file review prompts ask for separate minor confirmation while git prompts stay unchanged', () => {
  const context = { stateDir: '/tmp/review', round: 1, targetType: 'file', slug: 'x' };
  assert.match(reviewerPrompt('verify', context), /minor.*\[\{.*reason/s);
  assert.match(reviewerPrompt('correctness', context), /releaseBlocking.*rationale/s);
  const git = { ...context, targetType: 'git' };
  assert.doesNotMatch(reviewerPrompt('verify', git), /minorVerified|"minor"/);
  assert.doesNotMatch(reviewerPrompt('correctness', git), /minorVerified|"minor"/);
});

test('document and file-verifier prompt envelopes contain valid JSON, while git verify has no minor field', () => {
  const context = { stateDir: '/tmp/review', round: 1, targetType: 'file', slug: 'x' };
  const finder = reviewerPrompt('correctness', context);
  const finderJson = finder.match(/Write ONLY JSON to .*?: (\{[^}]*\})\./)?.[1];
  assert.deepEqual(JSON.parse(finderJson).findings, []);

  const fileVerify = reviewerPrompt('verify', context);
  const verifyJson = fileVerify.match(/Write ONLY (\{[^}]*\}) to /)?.[1];
  assert.deepEqual(JSON.parse(verifyJson).minor, []);
  assert.deepEqual(JSON.parse(verifyJson).blocking, []);

  const gitVerify = reviewerPrompt('verify', { ...context, targetType: 'git' });
  const gitJson = gitVerify.match(/Write ONLY (\{[^}]*\}) to /)?.[1];
  assert.equal(Object.hasOwn(JSON.parse(gitJson), 'minor'), false);
});
