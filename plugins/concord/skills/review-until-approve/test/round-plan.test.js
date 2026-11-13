'use strict';
// The prompt text the runner's round-plan.js builds for each reviewer role, and its agreement with the artifact validator.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RUNNER = path.join(__dirname, '..', 'scripts', 'runner');
const { reviewerPrompt } = require(path.join(RUNNER, 'round-plan'));
const { allowedFindingPrefixes, normalizeArtifact } = require(path.join(RUNNER, 'artifact-contract'));
const { FINDING_ID_RULE } = require(path.join(RUNNER, 'gate-contract'));

// #342: every role that can run a probe in the reviewer sandbox is told that a uid-65534 result is not a failed method.
const ENV_CTX = { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateApplied: true, gateMode: 'pair' };

test('finding-producing prompts require continuous verbatim spans and preserve source formatting', () => {
  const context = { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x' };
  const prompts = [
    reviewerPrompt('correctness', context),
    reviewerPrompt('verify', context),
    reviewerPrompt('intent', context),
    reviewerPrompt('gate', { ...context, gateMode: 'pair' }),
    reviewerPrompt('gate', { ...context, gateMode: 'design-conformance' }),
    reviewerPrompt('gate-verify', context),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /continuous verbatim source snippet/i);
    assert.match(prompt, /preserve whitespace/i);
    assert.match(prompt, /no explanatory ellipses/i);
  }
});

test('a review language is asked for in the finding text of the finding-producing prompts only, and spans stay verbatim', () => {
  const context = { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateMode: 'pair' };
  for (const role of ['correctness', 'verify', 'intent', 'gate', 'gate-verify']) {
    const prompt = reviewerPrompt(role, { ...context, reviewLanguage: 'ko' });
    assert.match(prompt, /BCP 47 tag `ko`/, role);
    assert.match(prompt, /`span`.*never translate/s, role);
    assert.doesNotMatch(reviewerPrompt(role, context), /BCP 47/, role);
  }
});

test('lite correctness verification does not depend on the concurrently running design-conformance gate', () => {
  const lite = reviewerPrompt('verify', {
    stateDir: '/state', round: 1, targetType: 'git', gateMode: 'design-conformance', gateApplied: true,
  });
  const base = reviewerPrompt('verify', {
    stateDir: '/state', round: 1, targetType: 'git', gateMode: 'pair', gateApplied: true,
  });

  assert.doesNotMatch(lite, /round-1-gate\.json/);
  assert.match(base, /round-1-gate\.json/);
});

test('the correctness verifier given the gate batch may disposition only correctness ids', () => {
  const base = reviewerPrompt('verify', { stateDir: '/state', round: 1, targetType: 'git', gateMode: 'pair', gateApplied: true });
  for (const prefix of allowedFindingPrefixes('correctness')) assert.ok(base.includes(`${prefix}*`), `verify prompt must name ${prefix}* as its own namespace`);
  assert.match(base, /Do not copy, accept, or reject gate:\* IDs in this artifact; their disposition belongs to the gate verifier\./);
  const alone = reviewerPrompt('verify', { stateDir: '/state', round: 2, targetType: 'git', gateMode: 'pair', gateApplied: false });
  assert.doesNotMatch(alone, /gate verifier/, 'without the gate batch there is nothing to keep out');
});

test('gate and correctness prompts keep uid-65534 probes from ending as blocked, without an unverifiable field', () => {
  for (const role of ['gate', 'correctness']) {
    const prompt = reviewerPrompt(role, ENV_CTX);
    assert.match(prompt, /uid 65534/, role);
    assert.match(prompt, /do not declare blocked/, role);
    assert.doesNotMatch(prompt, /"unverifiable"/, role);
  }
});

test('verify and gate-verify keep the unverifiable clause; intent carries no uid clause', () => {
  for (const role of ['verify', 'gate-verify']) assert.match(reviewerPrompt(role, ENV_CTX), /"unverifiable"/, role);
  assert.doesNotMatch(reviewerPrompt('intent', ENV_CTX), /65534/);
});

test('every reviewer prompt states the finding id rule (#414)', () => {
  const context = { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateMode: 'pair' };
  for (const [role, extra] of [['correctness', {}], ['verify', {}], ['intent', {}], ['gate', {}], ['gate', { gateMode: 'design-conformance' }], ['gate-verify', {}]]) {
    assert.ok(reviewerPrompt(role, { ...context, ...extra }).includes(FINDING_ID_RULE), `${role} prompt lacks the finding id rule`);
  }
});

test('file-target reviewers are told the artifact framing, and a blocked method is correctable', () => {
  const context = { stateDir: '/state', round: 1, targetType: 'file', slug: 'doc' };
  for (const role of ['correctness', 'verify']) {
    const prompt = reviewerPrompt(role, context);
    assert.ok(prompt.includes('===== <path> =====') && prompt.includes('trailing newline'), `${role} prompt states the file artifact framing`);
    assert.ok(prompt.includes('never a reason to declare blocked'), `${role} prompt forbids blocking on the framing mismatch`);
    assert.ok(!reviewerPrompt(role, { ...context, targetType: 'git' }).includes('===== <path> ====='), `${role} git prompt is unchanged`);
  }
  assert.throws(
    () => normalizeArtifact('correctness', JSON.stringify({ status: 'ok', blocked: ['equality probe: whole artifact differs from file'] })),
    /re-run the reviewer with a corrected method and leave the target, ledger, and prior review evidence unchanged/,
  );
});

test('the lite gate prompt asks for design-conformance gaps only', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '<stateDir>', round: '<n>', slug: '<slug>', gateMode: 'design-conformance', targetType: 'git', dodPassed: true });
  assert.match(prompt, /design-conformance gaps only/);
});

test('correctness prompt requires every changed path, rename sources and deleted files included, in examined', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: true });
  assert.match(prompt, /every changed path.*examined.*old path of every renamed file and every deleted file/i);
});

test('correctness prompt never claims the DoD passed when the gate was deferred', () => {
  // A prompt built from dodPassed alone would tell the reviewer "DoD already passed; do not rerun tests"
  // on a run where nothing was ever executed.
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: true, dodDeferred: true });
  assert.ok(!/do not rerun tests/i.test(prompt), 'a deferred gate must not be reported as an already-passed one');
  assert.match(prompt, /no executable.*gate.*ran this run/i);
  assert.match(prompt, /single run of the repo's own already-configured build\/test command/i);
});

test('correctness prompt reserves a pending DoD for the final clean boundary', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: false, dodDeferred: false, dodPending: true });
  assert.match(prompt, /run once after review convergence/i);
  assert.match(prompt, /do not run the build or test suite/i);
  assert.doesNotMatch(prompt, /DoD already failed/i);
});

test('file-target correctness prompt requires contract-complete docreview findings', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'file', dodPassed: true });
  assert.match(prompt, /EVERY reviewed target.*examined/i);
  assert.match(prompt, /docreview:<stable-slug>/);
  assert.match(prompt, /"examined"/);
  assert.match(prompt, /"findings"/);
  // The artifact contract rejects a finding with no file, so a prompt that asks
  // only for an id and an examined list fails the round before verification.
  assert.match(prompt, /"file":"<path>"/);
  assert.match(prompt, /"span":"<exact offending text>"/);
  assert.match(prompt, /"summary":"<one sentence>"/);
});

test('git-target correctness prompt states the finding shape too -- a finding with no file is fatal, not retried', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true });
  assert.match(prompt, /"file":"<path>"/);
  assert.match(prompt, /"span":"<exact offending text>"/);
  assert.match(prompt, /"summary":"<one sentence>"/);
});

test('verify prompt asks for the distrust-green findings channel the fold reads', () => {
  const prompt = reviewerPrompt('verify', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true });
  // The fold merges verify's `findings` into the candidate set; a prompt that says "write ONLY {status,rejected}" loses them silently.
  assert.match(prompt, /"findings":\[\]/);
  assert.match(prompt, /catch a bug the first pass missed/);
});

test('correctness and verify prompts exclude the intent artifact -- the state dir is on --add-dir', () => {
  for (const role of ['correctness', 'verify']) {
    const prompt = reviewerPrompt(role, { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
    // Without this the reviewer can read intent-<slug>.md and raise a design objection under a correctness: id.
    assert.match(prompt, /Ignore (?:any|every) intent-\*\.md/);
  }
});

test('gate prompt states the three-segment id shape -- a two-segment id defaults the class silently', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
  assert.match(prompt, /gate:<class>:<slug>/);
});

test('reviewer guidance reaches only correctness and gate finder prompts', () => {
  const context = { stateDir: '/state', round: 3, targetType: 'git', slug: 'feat-x', reviewerGuidance: 'UI only; focus on accessibility' };
  for (const role of ['correctness', 'gate']) assert.match(reviewerPrompt(role, context), /UI only; focus on accessibility/);
  for (const role of ['correctness', 'gate']) assert.match(reviewerPrompt(role, context), /every changed file must still be examined/);
  for (const role of ['verify', 'gate-verify', 'intent']) assert.doesNotMatch(reviewerPrompt(role, context), /UI only; focus on accessibility/);
});

test('intent and gate prompts preserve their full role contracts', () => {
  const base = { stateDir: '/state', round: 2, slug: 'feature-x' };
  const intent = reviewerPrompt('intent', base);
  const gate = reviewerPrompt('gate', base);
  const verify = reviewerPrompt('gate-verify', base);
  assert.match(intent, /exact changed line/i);
  assert.match(intent, /verbatim requirement/i);
  assert.match(intent, /intent:/);
  assert.match(reviewerPrompt('intent', { ...base, priorIntentIds: ['intent:scope-not-a-key-listing'] }), /REUSE that id verbatim/i);
  assert.match(reviewerPrompt('intent', { ...base, priorIntentIds: ['intent:scope-not-a-key-listing'] }), /\["intent:scope-not-a-key-listing"\]/);
  assert.match(gate, /cross-context.*silent-gap.*ac-coverage.*design-conformance/i);
  assert.match(gate, /Read\/Grep.*repository/i);
  assert.match(gate, /intent-feature-x\.md/);
  assert.match(gate, /requirement/);
  assert.match(verify, /Reject false positives/i);
  assert.match(verify, /new.*gate:/i);
  assert.match(verify, /rejected/);
  assert.match(verify, /correctness candidates only as context/i);
  assert.match(verify, /disposition only gate:\*/i);
  assert.match(verify, /Do not copy, accept, or reject correctness:\*/i);
  assert.match(verify, /belongs to the correctness verifier/i);
  assert.match(reviewerPrompt('verify', { ...base, gateApplied: true }), /round-2-gate\.json/);
  assert.match(reviewerPrompt('gate-verify', { ...base, gateApplied: true }), /round-2-correctness\.json/);
});
