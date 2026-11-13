'use strict';
// One round of the runner (`runReview`) with a scripted reviewer: which roles run and what they are asked, how their
// artifacts fold into findings, the one correction a role may get, the anchors step, and the checks that fail the round.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');
const { runReview } = require('../scripts/runner/review');
const { artifactDestinationFromPrompt } = require('../scripts/runner/review-artifact');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

// A checkout as approve.js makes it: a base commit and a head commit on branch concord-pr-5.
// The head edits src/a.js, adds src/new.js, renames src/old.js to src/moved.js and deletes src/gone.js; src/same.js is untouched.
function checkout() {
  const repo = fs.realpathSync(tempDir('rua-review-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const one = 1;\nconst two = 2;\nmodule.exports = { one, two };\n');
  fs.writeFileSync(path.join(repo, 'src/same.js'), 'exports.same = () => "same";\n');
  fs.writeFileSync(path.join(repo, 'src/old.js'), 'exports.old = () => "a rather long body so the rename is detected as one";\n');
  fs.writeFileSync(path.join(repo, 'src/gone.js'), 'exports.gone = 1;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'concord-pr-5');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const one = 1;\nconst two = 3;\nconst twice = two * 2;\nconst again = two * 2;\nmodule.exports = { one, two, twice, again };\n');
  fs.writeFileSync(path.join(repo, 'src/new.js'), 'exports.fresh = (value) => value.trim();\n');
  git(repo, 'mv', 'src/old.js', 'src/moved.js');
  git(repo, 'rm', '-q', 'src/gone.js');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'head');
  return { repo, base };
}
const CHANGED = ['src/a.js', 'src/gone.js', 'src/moved.js', 'src/new.js', 'src/old.js'];

// Answers each launch with the scripted artifact for its role (an array is one answer per launch of that role), and records what it was asked.
function scripted(script, { before } = {}) {
  const calls = [];
  const counts = {};
  const spawn = async (input) => {
    calls.push({ role: input.role, prompt: input.prompt, provider: input.provider, untrustedCheckout: input.untrustedCheckout, model: input.requestedModel, effort: input.reasoningEffort, env: input.env });
    const n = counts[input.role] = (counts[input.role] || 0) + 1;
    const scriptedFor = script[input.role];
    const answer = Array.isArray(scriptedFor) ? scriptedFor[Math.min(n, scriptedFor.length) - 1] : scriptedFor;
    if (before) before(input);
    const artifact = input.role === 'anchors' ? input.prompt.match(/Write ONLY JSON to (\S+)\.$/)[1].replace(/\.$/, '') : artifactDestinationFromPrompt(input.prompt, input.stateDir);
    if (answer !== undefined && answer !== null) fs.writeFileSync(artifact, typeof answer === 'string' ? answer : JSON.stringify(answer));
    return { status: 0 };
  };
  return { spawn, calls };
}

// Runs one round on a fresh checkout; delta rounds (no gate pair) by default.
async function run(script, options = {}, hooks = {}) {
  const { repo, base } = checkout();
  const fake = scripted(typeof script === 'function' ? script(repo) : script, hooks);
  const { intent, ...rest } = options;
  const intentFile = intent ? path.join(tempDir('rua-review-intent-'), 'intent.md') : undefined;
  if (intentFile) fs.writeFileSync(intentFile, intent);
  let result; let error;
  try { result = await runReview({ ref: 'concord-pr-5', base, reviewer: 'claude', noBroad: true, ...rest, ...(intentFile && { intentFile }), repoRoot: repo, spawn: fake.spawn }); } catch (e) { error = String(e.message); }
  return { result, error, calls: fake.calls, roles: fake.calls.map((c) => c.role), repo };
}
const BROAD = { noBroad: false };

const clean = { correctness: { status: 'ok', examined: CHANGED, findings: [] }, verify: { status: 'ok', rejected: [], findings: [] }, intent: { status: 'ok', findings: [] }, gate: { status: 'ok', findings: [] }, 'gate-verify': { status: 'ok', rejected: [], findings: [] } };
const finding = (id, file, span, extra = {}) => ({ id, file, span, summary: `summary of ${id}`, ...extra });
const EMPTY = { decision: 'review-only', round: 1, findings: [] };

test('a clean broad round with an intent file runs intent, correctness, gate and gate-verify, and returns no findings', async () => {
  const r = await run(clean, { ...BROAD, intent: '# Title\n\nThe change must do X.\n' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.roles, ['intent', 'correctness', 'gate', 'gate-verify']);
  assert.deepEqual(r.result, EMPTY);
  assert.ok(r.calls.every((c) => c.provider === 'claude' && c.untrustedCheckout === true));
});

test('a delta round asks correctness and verify only, and the model, effort and prior findings reach the prompts', async () => {
  const script = { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:doubled', 'src/a.js', 'const twice = two * 2;')] } };
  const r = await run(script, { reviewerModel: 'opus', reasoningEffort: 'high', reviewLanguage: 'ko', priorFindings: [finding('correctness:earlier', 'src/a.js', 'x'), finding('gate:silent-gap:earlier', 'src/a.js', 'y')] });
  assert.deepEqual(r.roles, ['correctness', 'verify']);
  assert.ok(r.calls.every((c) => c.model === 'opus' && c.effort === 'high'));
  assert.match(r.calls[0].prompt, /correctness:earlier/);
  assert.doesNotMatch(r.calls[0].prompt, /gate:silent-gap:earlier/);
  assert.match(r.calls[0].prompt, /BCP 47 tag `ko`/);
  assert.deepEqual(r.result.findings.map((f) => [f.id, f.line]), [['correctness:doubled', 3]]);
});

test('correctness findings fold with verify rejections and additions, each with its class and line', async () => {
  const r = await run({
    correctness: { status: 'ok', examined: CHANGED, findings: [
      finding('correctness:kept-blocker', 'src/a.js', 'const two = 3;', { releaseBlocking: ['serious-bug'], rationale: 'breaks callers' }),
      finding('correctness:kept-minor', 'src/new.js', 'value.trim()', { releaseBlocking: [], rationale: 'the caller always passes a string' }),
      finding('correctness:rejected', 'src/a.js', 'const one = 1;'),
      finding('correctness:twice', 'src/a.js', 'two * 2'),
      finding('correctness:not-in-file', 'src/a.js', 'no such text'),
      finding('correctness:unclassified', 'src/moved.js', 'exports.old', { releaseBlocking: [] }),
    ] },
    verify: { status: 'ok', rejected: [{ id: 'correctness:rejected', reason: 'read the file' }, { id: 'correctness:unknown', reason: 'not a candidate' }], findings: [finding('correctness:added-by-verify', 'src/new.js', 'exports.fresh', { releaseBlocking: [], rationale: 'style only' }), finding('correctness:kept-blocker', 'src/a.js', 'another span')] },
    anchors: { anchors: [] },
  });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.result.findings.map((f) => [f.id, f.class, f.line]), [
    ['correctness:added-by-verify', 'minor', 1], ['correctness:kept-blocker', 'blocker', 2], ['correctness:kept-minor', 'minor', 1],
    ['correctness:twice', 'blocker', null], ['correctness:not-in-file', 'blocker', null], ['correctness:unclassified', 'blocker', 1],
  ]);
  const blocker = r.result.findings.find((f) => f.id === 'correctness:kept-blocker');
  assert.deepEqual([blocker.span, blocker.releaseBlocking, blocker.rationale], ['const two = 3;', ['serious-bug'], 'breaks callers']);
});

test('gate and gate-verify fold: rejections, additions, the blocking override, and duplicates of a surviving correctness finding', async () => {
  const r = await run({
    intent: { status: 'ok', findings: [] },
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:survives', 'src/a.js', 'const two = 3;'), finding('correctness:dies', 'src/a.js', 'const one = 1;')] },
    verify: { status: 'ok', rejected: [{ id: 'correctness:dies', reason: 'read it' }], findings: [] },
    gate: { status: 'ok', findings: [
      finding('gate:cross-context:minor-claim', 'src/same.js', 'exports.same', { releaseBlocking: [], rationale: 'unchanged sibling stays correct' }),
      finding('gate:silent-gap:overridden', 'src/same.js', 'same', { releaseBlocking: [], rationale: 'claimed harmless', requirement: 'must not regress' }),
      finding('gate:ac-coverage:rejected', 'src/a.js', 'x'),
      finding('gate:cross-context:dup-of-survivor', 'src/a.js', 'const two = 3;'),
      finding('gate:cross-context:dup-of-dead', 'src/a.js', 'const one = 1;'),
      finding('gate:two-segments', 'src/a.js', 'module.exports'),
    ] },
    'gate-verify': { status: 'ok', rejected: [{ id: 'gate:ac-coverage:rejected', reason: 'read it' }], findings: [finding('gate:threat-model:added', 'src/new.js', 'value.trim()', { releaseBlocking: ['security'], rationale: 'input is untrusted' })],
      blocking: [{ id: 'gate:silent-gap:overridden', reason: 'it does regress' }], duplicates: [{ id: 'gate:cross-context:dup-of-survivor', of: 'correctness:survives' }, { id: 'gate:cross-context:dup-of-dead', of: 'correctness:dies' }] },
    anchors: { anchors: [] },
  }, { ...BROAD, intent: 'intent text' });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.roles.slice(0, 5), ['intent', 'correctness', 'gate', 'verify', 'gate-verify']);
  assert.deepEqual(r.result.findings.map((f) => [f.id, f.category, f.class]), [
    ['correctness:survives', 'correctness', 'blocker'],
    ['gate:threat-model:added', 'threat-model', 'blocker'], ['gate:cross-context:minor-claim', 'cross-context', 'minor'], ['gate:silent-gap:overridden', 'silent-gap', 'blocker'],
    ['gate:cross-context:dup-of-dead', 'cross-context', 'blocker'], ['gate:two-segments', 'cross-context', 'blocker'],
  ]);
  const overridden = r.result.findings.find((f) => f.id === 'gate:silent-gap:overridden');
  assert.equal(overridden.blockingReason, 'it does regress');
  assert.equal(overridden.requirement, 'must not regress');
});

test('intent findings are kept on changed files and dropped on unchanged ones; with no finder candidate, verify does not run', async () => {
  const r = await run({ ...clean, intent: { status: 'ok', findings: [finding('intent:on-changed', 'src/a.js', 'const two = 3;', { requirement: 'two must stay 2' }), finding('intent:on-unchanged', 'src/same.js', 'exports.same', { requirement: 'r' })] } }, { ...BROAD, intent: 'two must stay 2' });
  assert.deepEqual(r.result.findings.map((f) => [f.id, f.class, f.requirement]), [['intent:on-changed', 'blocker', 'two must stay 2']]);
  assert.deepEqual(r.roles, ['intent', 'correctness', 'gate', 'gate-verify']);
});

test('an addressed verdict in the verify artifact is returned when verify runs', async () => {
  const addressable = [{ id: 'correctness:earlier', file: 'src/a.js', class: 'blocker', summary: 's', requirement: '', span: 'const one = 1;', authorReply: 'handled by again' }];
  const verdict = { id: 'correctness:earlier', evidence: { file: 'src/a.js', span: 'const again = two * 2;', reason: 'the value is recomputed' } };
  const r = await run({
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:new', 'src/new.js', 'value.trim()')] },
    verify: { status: 'ok', rejected: [], findings: [], addressed: [verdict] },
  }, { addressable, priorFindings: [finding('correctness:earlier', 'src/a.js', 'const one = 1;')] });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.result.addressed, [verdict]);
  assert.deepEqual(r.result.findings.map((f) => f.id), ['correctness:new']);
  assert.match(r.calls[1].prompt, /^Earlier findings of this pull request whose quoted code is still present/);
});

test('when every finder returns nothing, verify does not run and no addressed verdict is produced', async () => {
  const addressable = [{ id: 'correctness:earlier', file: 'src/a.js', class: 'blocker', summary: 's', requirement: '', span: 'const one = 1;', authorReply: 'handled by again' }];
  const verdict = { id: 'correctness:earlier', evidence: { file: 'src/a.js', span: 'const again = two * 2;', reason: 'the value is recomputed' } };
  const script = { ...clean, verify: { status: 'ok', rejected: [], findings: [], addressed: [verdict] } };
  for (const [options, roles] of [[{}, ['correctness']], [{ ...BROAD, intent: 'intent text' }, ['intent', 'correctness', 'gate', 'gate-verify']]]) {
    const r = await run(script, { ...options, addressable, priorFindings: [finding('correctness:earlier', 'src/a.js', 'const one = 1;')] });
    assert.deepEqual(r.roles, roles);
    assert.deepEqual(r.result, EMPTY);
  }
});

test('a verdict on another role\'s id is stripped by the one repair when the role\'s own verdicts remain, and fails the round otherwise', async () => {
  const stripped = await run({
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;'), finding('correctness:other', 'src/a.js', 'const one = 1;')] },
    gate: { status: 'ok', findings: [finding('gate:silent-gap:real', 'src/same.js', 'exports.same'), finding('gate:silent-gap:other', 'src/same.js', 'same')] },
    verify: { status: 'ok', rejected: [{ id: 'correctness:other', reason: 'read it' }, { id: 'gate:silent-gap:real', reason: 'not mine' }], findings: [] },
    'gate-verify': { status: 'ok', rejected: [{ id: 'gate:silent-gap:other', reason: 'read it' }, { id: 'correctness:real', reason: 'not mine' }], findings: [] },
  }, BROAD);
  assert.equal(stripped.error, undefined, stripped.error);
  assert.deepEqual(stripped.result.findings.map((f) => f.id), ['correctness:real', 'gate:silent-gap:real']);
  const onlyForeign = await run({
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;')] },
    verify: { status: 'ok', rejected: [{ id: 'gate:silent-gap:real', reason: 'not mine' }], findings: [] },
  });
  assert.match(onlyForeign.error, /^harness-failure: /);
  assert.equal(onlyForeign.result, undefined);
});

test('an id in the wrong role\'s artifact, or a blocking id that names no gate candidate, fails the round', async () => {
  const cases = [
    [{ ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('gate:silent-gap:wrong-place', 'src/a.js', 'x')] } }, /harness-failure/],
    [{ ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('intent:wrong-place', 'src/a.js', 'x')] } }, /harness-failure/],
    [{ ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:a', 'src/a.js', 'x')] }, verify: { status: 'ok', rejected: [], findings: [finding('intent:from-verify', 'src/a.js', 'x')] } }, /harness-failure/],
    [{ ...clean, gate: { status: 'ok', findings: [finding('correctness:in-gate', 'src/a.js', 'x')] } }, /harness-failure/],
    [{ ...clean, intent: { status: 'ok', findings: [finding('gate:silent-gap:in-intent', 'src/a.js', 'x')] } }, /harness-failure/],
    [{ ...clean, gate: { status: 'ok', findings: [finding('gate:silent-gap:g', 'src/a.js', 'x')] }, 'gate-verify': { status: 'ok', rejected: [], findings: [], blocking: [{ id: 'gate:silent-gap:unknown', reason: 'r' }] } }, /gate-verify blocking id "gate:silent-gap:unknown" is not a gate candidate/],
  ];
  for (const [script, expected] of cases) {
    const r = await run(script, { ...BROAD, intent: 'intent text' });
    assert.match(r.error || '', expected, JSON.stringify(r.result));
    assert.equal(r.result, undefined);
  }
});

test('a correctness artifact that leaves out changed paths gets one re-run naming them; a second miss fails the round', async () => {
  const partial = { status: 'ok', examined: ['src/a.js', 'src/moved.js'], findings: [] };
  const recovered = await run({ ...clean, correctness: [partial, clean.correctness] });
  assert.deepEqual(recovered.roles, ['correctness', 'correctness']);
  assert.match(recovered.calls[1].prompt, /\nThe previous correctness artifact omitted changed path\(s\): src\/gone\.js, src\/new\.js\. Examine them/);
  assert.equal(recovered.calls[1].prompt.startsWith(recovered.calls[0].prompt), true);
  assert.deepEqual(recovered.result, EMPTY);
  const exhausted = await run({ ...clean, correctness: partial });
  assert.match(exhausted.error, /correctness coverage is incomplete; missing changed file\(s\): src\/gone\.js, src\/new\.js; correctness coverage retry exhausted/);
  assert.deepEqual(exhausted.roles, ['correctness', 'correctness']);
  // The old path of a rename is covered by the new path.
  const renamed = await run({ ...clean, correctness: { status: 'ok', examined: CHANGED.filter((file) => file !== 'src/old.js'), findings: [] } });
  assert.deepEqual(renamed.roles, ['correctness']);
  assert.deepEqual(renamed.result, EMPTY);
  // A deleted path has no blob and must be named.
  const deleted = await run({ ...clean, correctness: { status: 'ok', examined: CHANGED.filter((file) => file !== 'src/gone.js'), findings: [] } });
  assert.match(deleted.error, /missing changed file\(s\): src\/gone\.js;/);
});

test('a representation slip is repaired once without a model; anything else fails the round', async () => {
  const candidate = finding('correctness:real', 'src/a.js', 'const two = 3;');
  const repaired = [
    { correctness: { status: 'OK', examined: CHANGED, findings: [candidate] }, verify: clean.verify },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: { status: 'Findings', rejected: [], findings: [] } },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: { status: 'ok', rejected: [], findings: [{ id: 'correctness:real' }] } },
    { correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:Bad_Slug', 'src/a.js', 'const two = 3;')] }, verify: clean.verify },
  ];
  const ids = [];
  for (const script of repaired) {
    const r = await run(script);
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.roles, ['correctness', 'verify']);
    ids.push(r.result.findings.map((f) => f.id));
  }
  assert.deepEqual(ids, [['correctness:real'], ['correctness:real'], ['correctness:real'], ['correctness:bad-slug']]);
  const failing = [
    { ...clean, correctness: { status: 'weird', examined: CHANGED, findings: [] } },
    { ...clean, correctness: 'not json' },
    { ...clean, correctness: null },
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [{ id: 'correctness:no-file', summary: 's' }] } },
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [], blocked: ['rg: denied'] } },
    { ...clean, correctness: { status: 'ok', examined: 'src/a.js', findings: [] } },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: null },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: { status: 'ok', rejected: [{ id: 'correctness:real' }], findings: [] } },
  ];
  for (const script of failing) {
    const r = await run(script);
    assert.match(r.error || '', /^harness-failure: /, JSON.stringify(script));
    assert.equal(r.result, undefined);
  }
});

test('a role gets one correction: a repaired correctness artifact is not re-run for coverage, and a coverage re-run is not repaired', async () => {
  const partial = ['src/a.js', 'src/moved.js'];
  const candidate = finding('correctness:real', 'src/a.js', 'const two = 3;');
  // Repairable and incomplete at once: the repair is the one correction, so the missing paths fail the round.
  const repairedThenIncomplete = await run({ ...clean, correctness: [{ status: 'OK', examined: partial, findings: [] }, clean.correctness] });
  assert.match(repairedThenIncomplete.error, /correctness coverage is incomplete; missing changed file\(s\): src\/gone\.js, src\/new\.js; the artifact was already repaired once/);
  assert.deepEqual(repairedThenIncomplete.roles, ['correctness']);
  // Incomplete first, then a re-run that needs a repair: the re-run was the one correction.
  for (const second of [{ status: 'OK', examined: CHANGED, findings: [] }, { status: 'ok', examined: CHANGED, findings: [finding('correctness:Bad_Slug', 'src/a.js', 'const two = 3;')] }]) {
    const rerunThenRepair = await run({ ...clean, correctness: [{ status: 'ok', examined: partial, findings: [] }, second] });
    assert.match(rerunThenRepair.error || '', /^harness-failure: /);
    assert.deepEqual(rerunThenRepair.roles, ['correctness', 'correctness']);
  }
  // The correction is counted per role: after a coverage re-run of correctness, verify may still take its repair.
  const otherRole = await run({ correctness: [{ status: 'ok', examined: partial, findings: [candidate] }, { status: 'ok', examined: CHANGED, findings: [candidate] }], verify: { status: 'Findings', rejected: [], findings: [] } });
  assert.equal(otherRole.error, undefined, otherRole.error);
  assert.deepEqual(otherRole.roles, ['correctness', 'correctness', 'verify']);
  assert.deepEqual(otherRole.result.findings.map((f) => f.id), ['correctness:real']);
  // Both correctness and verify may take a repair in one round, and one repair covers several slips of one artifact.
  const several = await run({
    correctness: { status: 'OK', examined: CHANGED, findings: [finding('correctness:Bad_Slug', 'src/a.js', 'const two = 3;'), finding('correctness:other', 'src/a.js', 'const one = 1;')] },
    gate: { status: 'ok', findings: [finding('gate:silent-gap:real', 'src/same.js', 'exports.same')] },
    verify: { status: 'CLEAN', rejected: [{ id: 'correctness:other', reason: 'read it' }, { id: 'gate:silent-gap:real', reason: 'not mine' }], findings: [{ id: 'correctness:bad-slug' }] },
    'gate-verify': clean['gate-verify'],
  }, BROAD);
  assert.equal(several.error, undefined, several.error);
  assert.deepEqual(several.result.findings.map((f) => f.id), ['correctness:bad-slug', 'gate:silent-gap:real']);
});

test('the anchors step asks once for the findings whose span is not in the file and applies only a span that occurs once', async () => {
  const script = {
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:paraphrased', 'src/a.js', 'two is doubled twice'), finding('correctness:verbatim', 'src/new.js', 'value.trim()'), finding('correctness:ambiguous-fix', 'src/a.js', 'doubling'), finding('correctness:multiline', 'src/a.js', 'the last two lines')] },
    verify: clean.verify,
    anchors: { anchors: [{ index: 0, span: 'const twice = two * 2;' }, { index: 2, span: 'two * 2' }, { index: 3, span: 'const again = two * 2;\nmodule.exports' }, { index: 9, span: 'const one = 1;' }] },
  };
  const r = await run(script);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.roles, ['correctness', 'verify', 'anchors']);
  assert.match(r.calls[2].prompt, /two is doubled twice/);
  assert.doesNotMatch(r.calls[2].prompt, /value\.trim\(\)/);
  assert.deepEqual(r.result.findings.map((f) => [f.id, f.span, f.line]), [
    ['correctness:paraphrased', 'const twice = two * 2;', 3], ['correctness:verbatim', 'value.trim()', 1], ['correctness:ambiguous-fix', 'doubling', null], ['correctness:multiline', 'const again = two * 2;\nmodule.exports', null],
  ]);
  // A malformed or missing anchors answer, or a failed launch, keeps the original spans and is not retried.
  for (const [anchors, before] of [['not json'], [null], [{ anchors: 'no' }], [undefined, (input) => { if (input.role === 'anchors') throw new Error('anchor launch failed'); }]]) {
    const kept = await run({ ...script, anchors }, {}, { before });
    assert.equal(kept.error, undefined, kept.error);
    assert.deepEqual(kept.roles, ['correctness', 'verify', 'anchors']);
    assert.equal(kept.result.findings[0].span, 'two is doubled twice');
    assert.equal(kept.result.findings[0].line, null);
  }
  // Every span verbatim in its file: no anchors launch.
  const verbatim = await run({ ...script, correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:verbatim', 'src/new.js', 'value.trim()')] } });
  assert.deepEqual(verbatim.roles, ['correctness', 'verify']);
});

test('a launch that fails is reported by its class, never with the raw error text', async () => {
  const thrown = await run(clean, {}, { before: (input) => { if (input.role === 'correctness') throw new Error('raw text from the provider: sk-secret'); } });
  assert.match(thrown.error, /^harness-failure: correctness provider execution failed; /);
  assert.doesNotMatch(thrown.error, /sk-secret|raw text/);
  assert.equal(thrown.result, undefined);
  const messages = [];
  for (const result of [{ status: 3 }, { status: null, timedOut: true }, { status: null, signal: 'SIGKILL' }, { status: 0, interrupted: 'SIGTERM' }]) {
    const { repo, base } = checkout();
    let error;
    try { await runReview({ ref: 'concord-pr-5', base, reviewer: 'claude', noBroad: true, repoRoot: repo, spawn: async () => result }); } catch (e) { error = String(e.message); }
    messages.push(error);
  }
  assert.deepEqual(messages, [
    'harness-failure: correctness subprocess exited 3; Provider execution failed without a recognized diagnostic.',
    'harness-failure: correctness subprocess timed out; Provider execution failed temporarily.',
    'harness-failure: correctness subprocess ended from SIGKILL; Provider execution failed without a recognized diagnostic.',
    'harness-failure: correctness subprocess interrupted; Provider execution failed without a recognized diagnostic.',
  ]);
});

// What a reviewer may do to the checkout or the state directory before it writes its artifact, and the error that stops the round.
const OVER_BOUND = 20 * 1024 * 1024 + 1;
const oversize = (file) => { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, OVER_BOUND); } finally { fs.closeSync(fd); } };
const tampering = [
  ['a tracked file edited', (i) => { if (i.role === 'correctness') fs.appendFileSync(path.join(i.repoRoot, 'src/a.js'), '// edited\n'); }, /reviewer left the checkout modified/],
  ['an untracked file added', (i) => { if (i.role === 'verify') fs.writeFileSync(path.join(i.repoRoot, 'untracked.txt'), 'x'); }, /reviewer left the checkout modified/],
  ['HEAD moved', (i) => { if (i.role === 'correctness') git(i.repoRoot, 'checkout', '-q', '--detach', 'HEAD~1'); }, /reviewer moved HEAD/],
  ['an edit hidden by --assume-unchanged', (i) => { if (i.role === 'correctness') { git(i.repoRoot, 'update-index', '--assume-unchanged', 'src/a.js'); fs.appendFileSync(path.join(i.repoRoot, 'src/a.js'), '// hidden\n'); } }, /reviewer left the checkout modified/],
  ['the sealed diff rewritten', (i) => { if (i.role === 'verify') fs.writeFileSync(path.join(i.stateDir, 'round-1-diff.txt'), 'another diff'); }, /protected review artifact changed: round-1-diff\.txt/],
  ['an accepted artifact rewritten', (i) => { if (i.role === 'verify') fs.writeFileSync(path.join(i.stateDir, 'round-1-correctness.json'), JSON.stringify(clean.correctness)); }, /protected review artifact changed: round-1-correctness\.json/],
  ['a later verifier artifact forged', (i) => { if (i.role === 'correctness') fs.writeFileSync(path.join(i.stateDir, 'round-1-verify.json'), '{"status":"ok","rejected":[],"findings":[]}'); }, /protected review artifact changed: round-1-verify\.json/],
  ['the anchors artifact planted', (i) => { if (i.role === 'correctness') fs.writeFileSync(path.join(i.stateDir, 'round-1-anchors.json'), '{"anchors":[]}\n'); }, /protected review artifact changed: round-1-anchors\.json/],
  ['the sealed diff swapped for an identical symlink', (i) => {
    if (i.role !== 'correctness') return;
    const file = path.join(i.stateDir, 'round-1-diff.txt');
    const copy = path.join(tempDir('rua-review-external-'), 'copy.txt');
    fs.copyFileSync(file, copy); fs.unlinkSync(file); fs.symlinkSync(copy, file);
  }, /protected review artifact changed: round-1-diff\.txt/],
  ['the sealed diff enlarged past the read bound', (i) => { if (i.role === 'correctness') oversize(path.join(i.stateDir, 'round-1-diff.txt')); }, /protected review artifact changed: round-1-diff\.txt/],
];
for (const [name, before, expected] of tampering) {
  test(`the round fails and returns nothing when a reviewer leaves ${name}`, { skip: process.platform === 'win32' && /symlink/.test(name) }, async () => {
    const r = await run({ correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;')] }, verify: clean.verify, anchors: { anchors: [] } }, {}, { before });
    assert.match(r.error || '', expected, JSON.stringify(r.result));
    assert.equal(r.result, undefined);
  });
}

test('a finder edit fails the round before a verifier can restore the checkout', async () => {
  let verifierRan = false;
  const r = await run({ correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;')] }, verify: clean.verify }, {}, { before: (i) => {
    if (i.role === 'correctness') fs.writeFileSync(path.join(i.repoRoot, 'src/a.js'), 'reviewer edit\n');
    if (i.role === 'verify') { verifierRan = true; git(i.repoRoot, 'checkout', '-q', '--', 'src/a.js'); }
  } });
  assert.match(r.error, /reviewer left the checkout modified/);
  assert.equal(verifierRan, false);
});

test('an edit hidden from git status fails the round right after the reviewer that made it, before a later one can undo it', async () => {
  let verifierRan = false;
  const r = await run({ correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;')] }, verify: clean.verify }, {}, { before: (i) => {
    const file = path.join(i.repoRoot, 'src/a.js');
    if (i.role === 'correctness') { git(i.repoRoot, 'update-index', '--skip-worktree', 'src/a.js'); fs.appendFileSync(file, '// hidden\n'); }
    if (i.role === 'verify') { verifierRan = true; fs.writeFileSync(file, git(i.repoRoot, 'show', 'HEAD:src/a.js') + '\n'); }
  } });
  assert.match(r.error, /reviewer left the checkout modified/);
  assert.equal(verifierRan, false);
});

test('a reviewer artifact over the read bound, or replaced by a symlink, is refused', { skip: process.platform === 'win32' }, async () => {
  const oversized = await run({}, {}, { before: (i) => { if (i.role === 'correctness') oversize(artifactDestinationFromPrompt(i.prompt, i.stateDir)); } });
  assert.match(oversized.error, /protected review artifact changed: round-1-correctness\.json/);
  const linked = await run({}, {}, { before: (i) => {
    if (i.role !== 'correctness') return;
    const copy = path.join(tempDir('rua-review-external-'), 'artifact.json');
    fs.writeFileSync(copy, JSON.stringify(clean.correctness));
    fs.symlinkSync(copy, artifactDestinationFromPrompt(i.prompt, i.stateDir));
  } });
  assert.match(linked.error, /protected review artifact changed: round-1-correctness\.json/);
  assert.deepEqual([oversized.roles, linked.roles], [['correctness'], ['correctness']]);
});

test('a Codex reviewer runs from a CODEX_HOME of its own under the real account home, holding the login copy and the confining configuration, removed afterwards', async () => {
  const realHome = fs.realpathSync(tempDir('rua-review-home-'));
  const inheritedHome = fs.realpathSync(tempDir('rua-review-inherited-'));
  const sourceHome = fs.realpathSync(tempDir('rua-review-codex-'));
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-test"}');
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), '[mcp_servers.user]\ncommand = "user-tool"\n');
  const seen = [];
  const saved = { home: process.env.HOME, codex: process.env.CODEX_HOME };
  process.env.HOME = inheritedHome;
  process.env.CODEX_HOME = sourceHome;
  let r;
  try {
    r = await run(clean, { reviewer: 'codex', reviewRealHome: realHome }, { before: (i) => {
      const home = i.env.CODEX_HOME;
      seen.push({ role: i.role, provider: i.provider, home, config: fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), auth: fs.readFileSync(path.join(home, 'auth.json'), 'utf8') });
    } });
  } finally {
    for (const [key, value] of [['HOME', saved.home], ['CODEX_HOME', saved.codex]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(seen.map((s) => [s.role, s.provider]), [['correctness', 'codex']]);
  const [launch] = seen;
  assert.ok(launch.home.startsWith(`${realHome}${path.sep}.concord-review-codex-home-`), launch.home);
  assert.equal(launch.auth, '{"OPENAI_API_KEY":"sk-test"}');
  assert.ok(launch.config.includes(`[projects.${JSON.stringify(r.repo)}]\ntrust_level = "untrusted"`), launch.config);
  assert.ok(launch.config.includes('default_permissions = "concord-review"'));
  assert.ok(launch.config.includes('approval_policy = "never"'));
  assert.ok(launch.config.includes('[permissions.concord-review.network]\nenabled = false'));
  assert.ok(launch.config.includes(`${JSON.stringify(launch.home)} = "read"\n`), 'the CODEX_HOME is read-only inside the sandbox');
  assert.ok(!launch.config.includes('mcp_servers'), 'the account\'s own Codex configuration stays out');
  assert.ok(!fs.existsSync(launch.home), 'the CODEX_HOME is removed when the round ends');
  assert.deepEqual(fs.readdirSync(realHome), []);
});

test('a Claude reviewer gets no CODEX_HOME, and the round leaves no state directory behind', async () => {
  let stateDir;
  const r = await run(clean, {}, { before: (i) => { stateDir = i.stateDir; } });
  assert.deepEqual(r.result, EMPTY);
  assert.equal(r.calls[0].env, undefined);
  assert.equal(fs.existsSync(stateDir), false);
});

test('a checkout already modified before the round, or a request without a base, is refused before any launch', async () => {
  const { repo, base } = checkout();
  fs.appendFileSync(path.join(repo, 'src/a.js'), '// local edit\n');
  const fake = scripted(clean);
  await assert.rejects(runReview({ ref: 'concord-pr-5', base, reviewer: 'claude', noBroad: true, repoRoot: repo, spawn: fake.spawn }), /the review checkout is modified before the review starts/);
  await assert.rejects(runReview({ ref: 'concord-pr-5', reviewer: 'claude', repoRoot: repo, spawn: fake.spawn }), /the review needs a ref and a base/);
  await assert.rejects(runReview({ ref: 'concord-pr-5', base, reviewer: 'copilot', repoRoot: repo, spawn: fake.spawn }), /unsupported reviewer "copilot"/);
  assert.equal(fake.calls.length, 0);
});
