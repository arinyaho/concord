'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeArtifact, ArtifactError, allowedFindingPrefixes, preservesArtifact, repairCandidate } = require('../scripts/runner/artifact-contract');

test('repair preservation accepts clean verdicts and reordered object keys', () => {
  const verify = { status: 'OK', rejected: [{ id: 'correctness:x', reason: 'ran it' }], findings: [] };
  assert.ok(preservesArtifact('verify', JSON.stringify(verify), { findings: [], rejected: [{ reason: 'ran it', id: 'correctness:x' }], status: 'ok' }));
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

test('a verify probe decided by the reviewer sandbox is recorded as unverifiable, not as a failed round (#332)', () => {
  const entry = { id: 'correctness:x', reason: 'python probe: ValueError unsafe root ancestor (uid 65534 in the sandbox user namespace)' };
  const out = normalizeArtifact('verify', JSON.stringify({ status: 'ok', rejected: [], findings: [], unverifiable: [{ ...entry, reason: `  ${entry.reason}  ` }] }));
  assert.deepStrictEqual(out, { status: 'ok', rejected: [], findings: [], unverifiable: [entry] });
});

test('unverifiable is accepted from gate-verify only for gate ids', () => {
  const ok = normalizeArtifact('gate-verify', '{"status":"ok","rejected":[],"findings":[],"unverifiable":[{"id":"gate:y","reason":"ownership probe"}]}');
  assert.deepStrictEqual(ok.unverifiable, [{ id: 'gate:y', reason: 'ownership probe' }]);
  assert.throws(() => normalizeArtifact('gate-verify', '{"status":"ok","unverifiable":[{"id":"correctness:x","reason":"r"}]}'), (e) => e instanceof ArtifactError && e.kind === 'retry');
});

for (const [label, raw] of [
  ['a candidate that is also rejected', '{"status":"ok","rejected":[{"id":"correctness:x","reason":"ran it"}],"unverifiable":[{"id":"correctness:x","reason":"env"}]}'],
  ['a foreign id prefix', '{"status":"ok","unverifiable":[{"id":"gate:x","reason":"env"}]}'],
  ['an empty reason', '{"status":"ok","unverifiable":[{"id":"correctness:x","reason":" "}]}'],
  ['a bare id string', '{"status":"ok","unverifiable":["correctness:x"]}'],
]) test(`an unverifiable entry with ${label} retries`, () => {
  assert.throws(() => normalizeArtifact('verify', raw), (e) => e instanceof ArtifactError && e.kind === 'retry');
});

test('a non-array unverifiable field is fatal, like the other verdict arrays', () => {
  assert.throws(() => normalizeArtifact('verify', '{"status":"ok","unverifiable":"x"}'), (e) => e instanceof ArtifactError && e.kind === 'fatal');
});

test('blocked stays fatal for a missing or crashed probe tool even when unverifiable is present (#332)', () => {
  const raw = '{"status":"ok","rejected":[],"blocked":["python probe: ValueError unsafe root ancestor"],"unverifiable":[{"id":"correctness:x","reason":"env"}]}';
  assert.throws(() => normalizeArtifact('verify', raw), (e) => e instanceof ArtifactError && e.kind === 'fatal' && /could not run/.test(e.message));
});

test('only the verifiers accept unverifiable; other roles drop it as an unsupported field', () => {
  assert.deepStrictEqual(normalizeArtifact('correctness', '{"status":"ok","examined":[],"findings":[],"unverifiable":[{"id":"correctness:x","reason":"r"}]}'), { status: 'ok', examined: [], findings: [] });
});

test('an empty blocked array is a clean reviewer, not a failure', () => {
  assert.deepStrictEqual(normalizeArtifact('verify', '{"status":"ok","rejected":[],"blocked":[]}'), { status: 'ok', rejected: [], findings: [] });
});

test('blocked wins over an unsupported status, so the reviewer is never retried into dropping it', () => {
  const raw = '{"status":"blocked","rejected":[],"blocked":["playwright: browser launch denied by sandbox"]}';
  assert.throws(() => normalizeArtifact('verify', raw), (e) => e instanceof ArtifactError && e.kind === 'fatal' && /browser launch denied/.test(e.message));
});

test('gate-verify keeps a duplicates entry that names the correctness candidate it restates', () => {
  const out = normalizeArtifact('gate-verify', JSON.stringify({ status: 'ok', rejected: [], findings: [], duplicates: [{ id: 'gate:design-conformance:x', of: 'correctness:x' }] }));
  assert.deepStrictEqual(out.duplicates, [{ id: 'gate:design-conformance:x', of: 'correctness:x' }]);
});

test('gate-verify duplicates must pair a gate id with a correctness id, and not also reject it', () => {
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ status: 'ok', rejected: [], findings: [], duplicates: [{ id: 'gate:a:x', of: 'gate:b:y' }] })), ArtifactError);
  assert.throws(() => normalizeArtifact('gate-verify', JSON.stringify({ status: 'ok', rejected: [{ id: 'gate:a:x', reason: 'r' }], findings: [], duplicates: [{ id: 'gate:a:x', of: 'correctness:x' }] })), ArtifactError);
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

test('repairCandidate builds exactly the preserving candidate for each eligible failure (#318)', () => {
  const cases = [
    ['correctness', { status: 'OK', examined: ['a.txt'], findings: [] }, { status: 'ok', examined: ['a.txt'], findings: [] }],
    ['verify', { status: 'ok', rejected: [{ id: 'correctness:a', reason: 'ran it' }, { id: 'gate:cross-context:b', reason: 'foreign' }] }, { status: 'ok', rejected: [{ id: 'correctness:a', reason: 'ran it' }] }],
    ['gate-verify', { status: 'ok', rejected: [{ id: 'gate:cross-context:a', reason: 'ran it' }], findings: [{ id: 'gate:silent-gap:kept', rationale: 'kept' }] }, { status: 'ok', rejected: [{ id: 'gate:cross-context:a', reason: 'ran it' }], findings: [] }],
  ];
  for (const [name, original, expected] of cases) {
    const candidate = repairCandidate(name, JSON.stringify(original));
    assert.deepStrictEqual(candidate, expected, name);
    assert.ok(preservesArtifact(name, JSON.stringify(original), candidate), name);
    assert.doesNotThrow(() => normalizeArtifact(name, JSON.stringify(candidate)), name);
  }
});

test('a verify/gate-verify artifact whose only finding lacks id is repaired by deleting it (#319)', () => {
  const raw = JSON.stringify({ status: 'ok', rejected: [], findings: [{ file: 'a', summary: 's' }] });
  const candidate = { status: 'ok', rejected: [], findings: [] };
  for (const name of ['verify', 'gate-verify']) {
    assert.ok(preservesArtifact(name, raw, candidate), name);
    assert.deepStrictEqual(repairCandidate(name, raw), candidate, name);
  }
});

test('repairCandidate deletes only entries proven foreign or explicitly invalid and leaves malformed ones for normalization (#329)', () => {
  const cases = [
    ['verify', { status: 'ok', rejected: [{ id: 'correctness:a', reason: 'r' }, null], findings: [] }],
    ['gate-verify', { status: 'ok', rejected: [{ reason: 'no id' }], findings: [] }],
    ['correctness', { status: 'ok', examined: [], findings: [null] }],
  ];
  for (const [name, original] of cases) {
    const raw = JSON.stringify(original);
    const candidate = repairCandidate(name, raw);
    assert.deepStrictEqual(candidate, original, name);
    assert.throws(() => normalizeArtifact(name, JSON.stringify(candidate)), ArtifactError, name);
  }
  const foreign = { status: 'ok', rejected: [{ id: 'gate:cross-context:x', reason: 'r' }], findings: [] };
  assert.deepStrictEqual(repairCandidate('verify', JSON.stringify(foreign)).rejected, []);
  const tampered = { status: 'ok', rejected: [{ id: 'correctness:a', reason: 'r' }, null], findings: [] };
  assert.equal(preservesArtifact('verify', JSON.stringify(tampered), { ...tampered, rejected: [{ id: 'correctness:a', reason: 'r' }] }), false);
});

test('verify and gate-verify prompts tell the reviewer about the sandbox user namespace and "unverifiable" (#332)', () => {
  const { reviewerPrompt } = require('../scripts/runner/round-plan');
  for (const role of ['verify', 'gate-verify']) {
    const prompt = reviewerPrompt(role, { stateDir: '/state', round: 1, slug: 'feat-x' });
    assert.match(prompt, /user namespace/);
    assert.match(prompt, /"unverifiable"/);
  }
});

test('repairCandidate normalizes an invalid slug across every id-bearing field and preservesArtifact accepts exactly that candidate (#414)', () => {
  const raw = JSON.stringify({ status: 'ok', examined: ['a.js'], findings: [{ id: 'correctness:Probe_timeoutSeconds', file: 'a.js', span: 'x', summary: 's' }] });
  const candidate = repairCandidate('correctness', raw);
  assert.equal(candidate.findings[0].id, 'correctness:probe-timeoutseconds');
  assert.ok(preservesArtifact('correctness', raw, candidate));
  assert.ok(!preservesArtifact('correctness', raw, { ...candidate, findings: [{ ...candidate.findings[0], id: 'correctness:other' }] }));
  assert.equal(normalizeArtifact('correctness', JSON.stringify(candidate)).findings[0].id, 'correctness:probe-timeoutseconds');
  const verify = repairCandidate('verify', JSON.stringify({ status: 'ok', rejected: [{ id: 'correctness:A_b', reason: 'ran' }, 'correctness:ok-id'], findings: [], unverifiable: [{ id: 'correctness:A_b', reason: 'uid' }] }));
  assert.equal(verify.rejected[0].id, 'correctness:a-b');
  assert.equal(verify.rejected[1], 'correctness:ok-id');
  assert.equal(verify.unverifiable[0].id, 'correctness:a-b');
  const gate = repairCandidate('gate', JSON.stringify({ status: 'ok', findings: [{ id: 'gate:Silent_Gap:Foo.Bar', file: 'a', span: 's', summary: 's' }] }));
  assert.equal(gate.findings[0].id, 'gate:silent-gap:foo-bar');
});

test('slug normalization truncates to 80, leaves valid ids alone and refuses empty or colliding results (#414)', () => {
  const long = repairCandidate('correctness', JSON.stringify({ status: 'ok', findings: [{ id: `correctness:${'A'.repeat(90)}`, file: 'a', span: 's', summary: 's' }] }));
  assert.equal(long.findings[0].id, `correctness:${'a'.repeat(80)}`);
  const doubleDash = JSON.stringify({ status: 'ok', findings: [{ id: 'correctness:keep--double', file: 'a', span: 's', summary: 's' }] });
  assert.equal(repairCandidate('correctness', doubleDash).findings[0].id, 'correctness:keep--double');
  const unrepairable = (findings) => JSON.stringify({ status: 'ok', findings: findings.map((id) => ({ id, file: 'a', span: 's', summary: 's' })) });
  for (const ids of [['correctness:___'], ['correctness:Foo_bar', 'correctness:foo-bar'], ['correctness:Foo_bar', 'correctness:FOO.bar']]) {
    const raw = unrepairable(ids);
    assert.deepStrictEqual(repairCandidate('correctness', raw).findings.map((f) => f.id), ids);
    assert.throws(() => normalizeArtifact('correctness', raw), /invalid id/);
  }
});

test('a legacy two-segment gate id with an invalid slug is normalized, not left terminal (#414)', () => {
  const gate = repairCandidate('gate', JSON.stringify({ status: 'ok', findings: [{ id: 'gate:Foo_bar', file: 'a', span: 's', summary: 's' }] }));
  assert.equal(gate.findings[0].id, 'gate:foo-bar');
});
