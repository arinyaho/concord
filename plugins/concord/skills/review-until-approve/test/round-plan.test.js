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
const ENV_CTX = { stateDir: '/state', round: 1, slug: 'feat-x', gateApplied: true };

test('finding-producing prompts require continuous verbatim spans and preserve source formatting', () => {
  const context = { stateDir: '/state', round: 1, slug: 'feat-x' };
  const prompts = [
    reviewerPrompt('correctness', context),
    reviewerPrompt('verify', context),
    reviewerPrompt('intent', context),
    reviewerPrompt('gate', { ...context }),
        reviewerPrompt('gate-verify', context),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /continuous verbatim source snippet/i);
    assert.match(prompt, /preserve whitespace/i);
    assert.match(prompt, /no explanatory ellipses/i);
  }
});

test('a review language is asked for in the finding text of the finding-producing prompts only, and spans stay verbatim', () => {
  const context = { stateDir: '/state', round: 1, slug: 'feat-x' };
  for (const role of ['correctness', 'verify', 'intent', 'gate', 'gate-verify']) {
    const prompt = reviewerPrompt(role, { ...context, reviewLanguage: 'ko' });
    assert.match(prompt, /BCP 47 tag `ko`/, role);
    assert.match(prompt, /`span`.*never translate/s, role);
    assert.doesNotMatch(reviewerPrompt(role, context), /BCP 47/, role);
  }
});

test('the correctness verifier given the gate batch may disposition only correctness ids', () => {
  const base = reviewerPrompt('verify', { stateDir: '/state', round: 1, gateApplied: true });
  for (const prefix of allowedFindingPrefixes('correctness')) assert.ok(base.includes(`${prefix}*`), `verify prompt must name ${prefix}* as its own namespace`);
  assert.match(base, /Do not copy, accept, or reject gate:\* IDs in this artifact; their disposition belongs to the gate verifier\./);
  const alone = reviewerPrompt('verify', { stateDir: '/state', round: 2, gateApplied: false });
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
  const context = { stateDir: '/state', round: 1, slug: 'feat-x' };
  for (const [role, extra] of [['correctness', {}], ['verify', {}], ['intent', {}], ['gate', {}], ['gate-verify', {}]]) {
    assert.ok(reviewerPrompt(role, { ...context, ...extra }).includes(FINDING_ID_RULE), `${role} prompt lacks the finding id rule`);
  }
});

test('correctness prompt requires every changed path, rename sources and deleted files included, in examined', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7 });
  assert.match(prompt, /every changed path.*examined.*old path of every renamed file and every deleted file/i);
});

test('correctness prompt says no build or test gate ran and allows one run of the repository\'s own command', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7 });
  assert.ok(!/do not rerun tests/i.test(prompt));
  assert.match(prompt, /no executable.*gate.*ran this run/i);
  assert.match(prompt, /single run of the repo's own already-configured build\/test command/i);
});

test('correctness prompt states the finding shape -- a finding with no file is fatal, not retried', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 3 });
  assert.match(prompt, /"file":"<path>"/);
  assert.match(prompt, /"span":"<exact offending text>"/);
  assert.match(prompt, /"summary":"<one sentence>"/);
});

test('verify prompt asks for the distrust-green findings channel the fold reads', () => {
  const prompt = reviewerPrompt('verify', { stateDir: '/state', round: 3 });
  // The fold merges verify's `findings` into the candidate set; a prompt that says "write ONLY {status,rejected}" loses them silently.
  assert.match(prompt, /"findings":\[\]/);
  assert.match(prompt, /catch a bug the first pass missed/);
});

test('correctness and verify prompts exclude the intent artifact -- the state dir is on --add-dir', () => {
  for (const role of ['correctness', 'verify']) {
    const prompt = reviewerPrompt(role, { stateDir: '/state', round: 3, slug: 'feat-x' });
    // Without this the reviewer can read intent-<slug>.md and raise a design objection under a correctness: id.
    assert.match(prompt, /Ignore (?:any|every) intent-\*\.md/);
  }
});

test('gate prompt states the three-segment id shape -- a two-segment id defaults the class silently', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '/state', round: 3, slug: 'feat-x' });
  assert.match(prompt, /gate:<class>:<slug>/);
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
