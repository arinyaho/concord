'use strict';
// The prompt text plugins/concord/core/round-plan.js builds for each reviewer role, and its agreement with the artifact validator.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'core');
const { GATE_SWEEP_CLAUSE, GATE_VERIFY_OWNERSHIP_CLAUSE, GATE_VERIFY_ADDED_CLAUSE, reviewerPrompt } = require(path.join(CORE, 'round-plan'));
const { allowedFindingPrefixes } = require(path.join(CORE, 'artifact-contract'));
const roundPlanText = fs.readFileSync(path.join(CORE, 'round-plan.js'), 'utf8');

test('finding-producing prompts require continuous verbatim spans and preserve source formatting', () => {
  const context = {
    stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x',
    fixGroup: { groupId: 'g1', findingIds: ['correctness:a'], rootCause: 'r', invariants: [] },
    finding: { id: 'correctness:a', summary: 's' }, fixFiles: [],
  };
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
  for (const role of ['plan', 'fix', 'certify']) {
    const prompt = reviewerPrompt(role, context);
    assert.doesNotMatch(prompt, /continuous verbatim source snippet/i, `${role} prompt should not carry finding-anchor guidance`);
  }
});

test('a review language is asked for in the finding text of the finding-producing prompts only, and spans stay verbatim', () => {
  const context = {
    stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateMode: 'pair',
    fixGroup: { groupId: 'g1', findingIds: ['correctness:a'], rootCause: 'r', invariants: [] },
    finding: { id: 'correctness:a', summary: 's' }, fixFiles: [],
  };
  for (const role of ['correctness', 'verify', 'intent', 'gate', 'gate-verify']) {
    const prompt = reviewerPrompt(role, { ...context, reviewLanguage: 'ko' });
    assert.match(prompt, /BCP 47 tag `ko`/, role);
    assert.match(prompt, /`span`.*never translate/s, role);
    assert.doesNotMatch(reviewerPrompt(role, context), /BCP 47/, role);
  }
  for (const role of ['plan', 'fix', 'certify']) assert.doesNotMatch(reviewerPrompt(role, { ...context, reviewLanguage: 'ko' }), /BCP 47/, role);
});

test('GATE_SWEEP_CLAUSE is non-trivial and role-agnostic text', () => {
  assert.equal(typeof GATE_SWEEP_CLAUSE, 'string');
  assert.ok(GATE_SWEEP_CLAUSE.length > 40, 'GATE_SWEEP_CLAUSE should be a real instruction, not a stub');
  assert.match(GATE_SWEEP_CLAUSE, /enumerate.*actually exist/i);
  assert.match(GATE_SWEEP_CLAUSE, /missing.*skip|skip.*missing/i);
  assert.match(GATE_SWEEP_CLAUSE, /report each occurrence as its own finding/i);
  assert.match(GATE_SWEEP_CLAUSE, /exit status 1.*no matches/i);
  assert.match(GATE_SWEEP_CLAUSE, /exit status 2.*blocked/i);
});

test('round-plan.js reviewerPrompt("gate", ...) embeds GATE_SWEEP_CLAUSE byte-for-byte', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '/state', round: 3, targetType: 'git', dodPassed: true, slug: 'feat-x' });
  assert.ok(
    prompt.includes(GATE_SWEEP_CLAUSE),
    'round-plan.js reviewerPrompt("gate") has drifted from its own exported GATE_SWEEP_CLAUSE constant',
  );
});

test('every gate verifier prompt embeds the namespace ownership clause byte-for-byte', () => {
  assert.match(roundPlanText, /allowedFindingPrefixes\('correctness'\)/, 'gate-verify context namespaces must come from the artifact registry');
  for (const prefix of allowedFindingPrefixes('correctness')) assert.ok(GATE_VERIFY_OWNERSHIP_CLAUSE.includes(`${prefix}*`));
  const generated = reviewerPrompt('gate-verify', { stateDir: '/state', round: 3, targetType: 'git', slug: 'feat-x' });
  assert.ok(generated.includes(GATE_VERIFY_OWNERSHIP_CLAUSE));
});

test('codex-review-runner.js re-exports the exact same reviewerPrompt as round-plan.js (no second hand-written copy)', () => {
  const runner = require(path.join(CORE, 'codex-review-runner'));
  assert.equal(runner.reviewerPrompt, reviewerPrompt, 'codex-review-runner.js must delegate to round-plan.js, not redefine reviewerPrompt itself');
});

test('the vendored Codex engine copy of round-plan.js is byte-identical to core (run bin/bundle.mjs if this fails)', () => {
  const REPO = path.join(__dirname, '..', '..', '..', '..');
  const vendored = path.join(REPO, 'plugins/concord-codex/engine/round-plan.js');
  const src = fs.readFileSync(path.join(CORE, 'round-plan.js'));
  assert.ok(fs.readFileSync(vendored).equals(src), 'plugins/concord-codex/engine/round-plan.js drifted -- re-run node plugins/concord-codex/bin/bundle.mjs');
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

test('every changeClass/action pair the plan prompt offers is accepted by the plan validator', () => {
  const { normalizeArtifact } = require(path.join(CORE, 'artifact-contract'));
  const prompt = reviewerPrompt('plan', { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', intentHash: 'h' });
  const offered = (key) => prompt.match(new RegExp(`"${key}":"([a-z|]+)"`))[1].split('|');
  for (const changeClass of offered('changeClass')) for (const action of offered('action')) {
    const group = {
      groupId: 'g', findingIds: ['correctness:a'], rootCause: 'r', invariants: ['i'], changeClass, action,
      ...(changeClass === 'structural' ? { structuralEffects: ['identity'] } : {}),
      ...(action === 'reconcile' ? { reason: 'unsettled decision' } : {}),
      ...(changeClass === 'structural' && action === 'fix' ? { designEvidence: { source: 'intent-feat-x.md', sourceHash: 'h', requirements: ['q'], uniqueness: 'u' } } : {}),
    };
    assert.doesNotThrow(() => normalizeArtifact('plan', JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [group] })), `${changeClass}+${action} is offered by the plan prompt but rejected by the validator`);
  }
  assert.match(prompt, /local group[^.]*may also use action:"reconcile"/);
});

test('gate-verify records a gate candidate that restates a correctness candidate as a duplicate, not a rejection', () => {
  assert.match(GATE_VERIFY_OWNERSHIP_CLAUSE, /restates the same defect .* correctness candidate/);
  assert.match(GATE_VERIFY_OWNERSHIP_CLAUSE, /"duplicates" as \{"id":"<gate id>","of":"<correctness id>"\}/);
  assert.doesNotMatch(GATE_VERIFY_OWNERSHIP_CLAUSE, /Reject a gate candidate that restates/);
});

test('the correctness verifier given the gate batch may disposition only correctness ids', () => {
  const base = reviewerPrompt('verify', { stateDir: '/state', round: 1, targetType: 'git', gateMode: 'pair', gateApplied: true });
  for (const prefix of allowedFindingPrefixes('correctness')) assert.ok(base.includes(`${prefix}*`), `verify prompt must name ${prefix}* as its own namespace`);
  assert.match(base, /Do not copy, accept, or reject gate:\* IDs in this artifact; their disposition belongs to the gate verifier\./);
  const alone = reviewerPrompt('verify', { stateDir: '/state', round: 2, targetType: 'git', gateMode: 'pair', gateApplied: false });
  assert.doesNotMatch(alone, /gate verifier/, 'without the gate batch there is nothing to keep out');
});

test('every gate verifier prompt asks an added finding for its follow-up classification byte-for-byte', () => {
  assert.match(GATE_VERIFY_ADDED_CLAUSE, /releaseBlocking.*rationale/);
  assert.match(GATE_VERIFY_ADDED_CLAUSE, /a candidate you keep needs no entry.*only the gate: findings you newly add.*"id", "file", "span"/i);
  for (const word of ['acceptance-criterion', 'unproven-premise', 'stage-exit', 'rationale', 'approved outcome']) assert.ok(GATE_VERIFY_ADDED_CLAUSE.includes(word), `the verifier clause lacks ${word}`);
  const generated = reviewerPrompt('gate-verify', { stateDir: '/state', round: 3, targetType: 'git', slug: 'feat-x' });
  assert.ok(generated.includes(GATE_VERIFY_ADDED_CLAUSE));
});

test('the packaged plan prompt states the structural evidence binding plan-fixes enforces', () => {
  const { DESIGN_EVIDENCE_BINDING_CLAUSE } = require(path.join(CORE, 'round-plan'));
  assert.equal(typeof DESIGN_EVIDENCE_BINDING_CLAUSE, 'string');
  assert.match(DESIGN_EVIDENCE_BINDING_CLAUSE, /exactly `intent-<slug>\.md`/);
  assert.match(DESIGN_EVIDENCE_BINDING_CLAUSE, /verbatim/);
  assert.ok(reviewerPrompt('plan', { stateDir: '/state', round: 1, slug: 'feat-x', intentHash: 'h' }).includes(DESIGN_EVIDENCE_BINDING_CLAUSE));
});

test('the plan prompt says gate: findings are never planned and only verify/correctness ids are listed', () => {
  const prompt = reviewerPrompt('plan', { stateDir: '/state', round: 3, targetType: 'git', slug: 'feat-x' });
  assert.match(prompt, /`?gate:`? findings are never planned/);
  assert.match(prompt, /only (?:the )?(?:correctness|docreview)/i);
});

// #342: every role that can run a probe in the reviewer sandbox is told that a uid-65534 result is not a failed method.
const ENV_CTX = { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateApplied: true, gateMode: 'pair', fixGroup: { groupId: 'g1', findingIds: ['correctness:a'], invariants: [], rootCause: 'r' }, fixFiles: [], finding: { id: 'correctness:a', summary: 's' } };

test('every role in ROLE_SEQUENCE has an explicit sandbox uid decision', () => {
  const { ROLE_SEQUENCE, ENV_CLAUSE_BY_ROLE } = require(path.join(CORE, 'round-plan'));
  assert.deepEqual(Object.keys(ENV_CLAUSE_BY_ROLE || {}).sort(), [...ROLE_SEQUENCE].sort());
});

test('gate and correctness prompts keep uid-65534 probes from ending as blocked, without an unverifiable field', () => {
  for (const role of ['gate', 'correctness']) {
    const prompt = reviewerPrompt(role, ENV_CTX);
    assert.match(prompt, /uid 65534/, role);
    assert.match(prompt, /do not declare blocked/, role);
    assert.doesNotMatch(prompt, /"unverifiable"/, role);
  }
});

test('certify prompt explains uid 65534 and still reports blocked for an unproven fix', () => {
  const prompt = reviewerPrompt('certify', ENV_CTX);
  assert.match(prompt, /uid 65534/);
  assert.match(prompt, /"status":"blocked"/);
});

test('verify and gate-verify keep the unverifiable clause; intent, plan and fix carry no uid clause', () => {
  for (const role of ['verify', 'gate-verify']) assert.match(reviewerPrompt(role, ENV_CTX), /"unverifiable"/, role);
  for (const role of ['intent', 'plan', 'fix']) assert.doesNotMatch(reviewerPrompt(role, ENV_CTX), /65534/, role);
});

test('gate-panel lens prompt carries the review-language clause', () => {
  assert.equal(typeof require(path.join(CORE, 'round-plan')).reviewLanguageClause, 'function');
  const runner = fs.readFileSync(path.join(CORE, 'codex-review-runner.js'), 'utf8');
  assert.match(runner, /gate:\$\{lens\}:<slug>\.\$\{reviewLanguageClause\(context\.reviewLanguage\)\}\$\{BLOCKED_CLAUSE\}/);
});

test('classify asks correctness and verify for releaseBlocking and rationale; without it their prompts are byte-identical to the ones before the flag', () => {
  const crypto = require('node:crypto');
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const context = { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateApplied: false, cliPath: '/cli.js' };
  const golden = {
    correctness: 'e334addedf8506cc6796c0a3a942e51b7f0983fecaeb0d0503584b6c22292178',
    verify: '229140f1fc69198f2fe25482f5359217955f5d3f054350b3f6779e6bfa2f1bb9',
  };
  const goldenBroad = {
    correctness: 'd7c2233aa782f92de827947cdaaa6f150d0089172ecc7324f1a11096f30aa0ad',
    verify: '854242f6306384680bb42f60c2aed6a751f96cb8de9e4981092a19bf0a47ebd4',
  };
  for (const role of ['correctness', 'verify']) {
    assert.equal(sha(reviewerPrompt(role, context)), golden[role], `${role} prompt changed without classify`);
    assert.equal(sha(reviewerPrompt(role, { ...context, classify: false })), golden[role]);
    assert.equal(sha(reviewerPrompt(role, { ...context, gateApplied: true, gateMode: 'pair', reviewLanguage: 'ko' })), goldenBroad[role]);
    const classified = reviewerPrompt(role, { ...context, classify: true });
    assert.match(classified, /"releaseBlocking": an array of the release-blocking classes/);
    assert.match(classified, /"rationale": a non-empty sentence/);
  }
  for (const role of ['intent', 'plan', 'fix', 'certify']) {
    const withFlag = reviewerPrompt(role, { ...context, classify: true, fixGroup: { groupId: 'g1', findingIds: ['correctness:a'], rootCause: 'r', invariants: [] }, finding: { id: 'correctness:a', summary: 's' }, fixFiles: [] });
    assert.doesNotMatch(withFlag, /"releaseBlocking": an array/, `${role} must not be asked for a class`);
  }
});

test('every prompt that writes or cites finding ids states the id rule (#414)', () => {
  const { FINDING_ID_RULE } = require(path.join(CORE, 'gate-contract'));
  const context = {
    stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateMode: 'pair',
    fixGroup: { groupId: 'g1', findingIds: ['correctness:a'], rootCause: 'r', invariants: [] },
    finding: { id: 'correctness:a', summary: 's' }, fixFiles: [],
  };
  for (const [role, extra] of [['correctness', {}], ['verify', {}], ['plan', {}], ['intent', {}], ['gate', {}], ['gate', { gateMode: 'design-conformance' }], ['gate-verify', {}]]) {
    assert.ok(reviewerPrompt(role, { ...context, ...extra }).includes(FINDING_ID_RULE), `${role} prompt lacks the finding id rule`);
  }
  for (const role of ['fix', 'certify']) assert.ok(!reviewerPrompt(role, context).includes(FINDING_ID_RULE), `${role} prompt should not carry the id rule`);
});

test('the plan prompt spells the plan artifact envelope the validator requires', () => {
  const envelope = '{"status":"ok","protocolVersion":2,"groups":[]}';
  assert.ok(reviewerPrompt('plan', { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x' }).includes(envelope));
});

test('file-target reviewers are told the artifact framing, and a blocked method is correctable', () => {
  const context = { stateDir: '/state', round: 1, targetType: 'file', slug: 'doc', finding: { id: 'docreview:a', summary: 's' }, fixFiles: [] };
  for (const role of ['correctness', 'verify']) {
    const prompt = reviewerPrompt(role, context);
    assert.ok(prompt.includes('===== <path> =====') && prompt.includes('trailing newline'), `${role} prompt states the file artifact framing`);
    assert.ok(prompt.includes('never a reason to declare blocked'), `${role} prompt forbids blocking on the framing mismatch`);
    assert.ok(!reviewerPrompt(role, { ...context, targetType: 'git' }).includes('===== <path> ====='), `${role} git prompt is unchanged`);
  }
  const { normalizeArtifact } = require(path.join(CORE, 'artifact-contract'));
  assert.throws(
    () => normalizeArtifact('correctness', JSON.stringify({ status: 'ok', blocked: ['equality probe: whole artifact differs from file'] })),
    /re-run the reviewer with a corrected method and leave the target, ledger, and prior review evidence unchanged/,
  );
});
