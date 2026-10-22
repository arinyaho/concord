'use strict';
// Drift guard: plugins/concord/core/review-driver.md (prose the Claude Code
// session follows itself) and plugins/concord/core/round-plan.js (the prompt
// text codex-review-runner.js spawns) must stay byte-identical on every
// instruction they both carry. Without this test the two can silently drift
// apart, as review-driver.md and codex-review-runner.js's hand-written
// reviewerPrompt() already had before this file existed -- see the round-plan
// extraction PR's design note. A future edit to one side that is not mirrored
// to the other must fail here, loudly, not slip through unnoticed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'core');
const { GATE_SWEEP_CLAUSE, GATE_VERIFY_OWNERSHIP_CLAUSE, GATE_VERIFY_ADDED_CLAUSE, reviewerPrompt } = require(path.join(CORE, 'round-plan'));
const { allowedFindingPrefixes } = require(path.join(CORE, 'artifact-contract'));
const roundPlanText = fs.readFileSync(path.join(CORE, 'round-plan.js'), 'utf8');
const driverText = fs.readFileSync(path.join(CORE, 'review-driver.md'), 'utf8');
// plugins/concord/commands/review-and-fix.md is a hand-composed copy of
// review-driver.md (composed with the Claude Code spawn-include) that the
// live `/review-and-fix` slash command actually reads -- not generated
// by any build step, so it drifts silently unless a test checks it directly.
const composedCommandText = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'review-and-fix.md'), 'utf8');
const REPO = path.join(__dirname, '..', '..', '..', '..');
const codexCommandText = fs.readFileSync(path.join(REPO, 'plugins/concord-codex/commands/review-and-fix.md'), 'utf8');
const copilotDriverText = fs.readFileSync(
  path.join(REPO, 'plugins/concord-copilot/skills/review-and-fix/references/review-driver.md'),
  'utf8',
);

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
});

test('review-driver.md embeds GATE_SWEEP_CLAUSE byte-for-byte in the gate-review prompt', () => {
  assert.ok(
    driverText.includes(GATE_SWEEP_CLAUSE),
    'review-driver.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- update review-driver.md to embed the exact same text',
  );
});

test('composed commands/review-and-fix.md embeds GATE_SWEEP_CLAUSE byte-for-byte in the gate-review prompt', () => {
  assert.ok(
    composedCommandText.includes(GATE_SWEEP_CLAUSE),
    'commands/review-and-fix.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- recompose it from review-driver.md',
  );
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
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(GATE_VERIFY_OWNERSHIP_CLAUSE.trim()), `${name} gate-verify prompt has drifted from round-plan.js`);
  }
});

test('manual review drivers normalize gate-verify artifacts through the bounded retry contract', () => {
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    const boundary = text.match(/Immediately after every fail-closed reviewer[\s\S]*?(?:A failed, missing, or non-preserving candidate and any|A second retry response or any) `harness-failure` (?:is|are) terminal\.[^\n]*/)?.[0] || '';
    assert.match(boundary, /`gate-verify`/, `${name} does not normalize the gate-verify role`);
    assert.doesNotMatch(boundary, /Do not normalize `gate-verify`/, `${name} bypasses strict gate-verify normalization`);
  }
});

test('codex-review-runner.js re-exports the exact same reviewerPrompt as round-plan.js (no second hand-written copy)', () => {
  const runner = require(path.join(CORE, 'codex-review-runner'));
  assert.equal(runner.reviewerPrompt, reviewerPrompt, 'codex-review-runner.js must delegate to round-plan.js, not redefine reviewerPrompt itself');
});

test('all native review drivers document the :: reviewer-guidance boundary and prompt isolation', () => {
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.match(text, /literal separator `::`/i, `${name} does not document the guidance separator`);
    assert.match(text, /Never read that text as the target ref or base/i, `${name} can still misparse guidance as a ref`);
    assert.match(text, /only in the correctness, gate-review, and gate-panel lens prompts/i, `${name} does not limit guidance to finder prompts`);
    assert.match(text, /Do not include it in verify, gate-verify, intent, plan, fix, certify, record, or termination inputs/i, `${name} leaks guidance into decision inputs`);
  }
});

test('the vendored Codex engine copy of round-plan.js is byte-identical to core (run bin/bundle.mjs if this fails)', () => {
  const REPO = path.join(__dirname, '..', '..', '..', '..');
  const vendored = path.join(REPO, 'plugins/concord-codex/engine/round-plan.js');
  const src = fs.readFileSync(path.join(CORE, 'round-plan.js'));
  assert.ok(fs.readFileSync(vendored).equals(src), 'plugins/concord-codex/engine/round-plan.js drifted -- re-run node plugins/concord-codex/bin/bundle.mjs');
});

test('the Copilot-vendored review-driver.md copy embeds GATE_SWEEP_CLAUSE byte-for-byte', () => {
  // Unlike round-plan.js (a generic byte-identity test in copilot-package.test.js
  // already covers its vendored copies), this file is produced by a plain
  // fs.copyFileSync in plugins/concord-copilot/bin/bundle.mjs with no
  // byte-identity guard of its own -- so it must be checked directly here,
  // the same way core/review-driver.md and commands/review-and-fix.md are.
  assert.ok(
    copilotDriverText.includes(GATE_SWEEP_CLAUSE),
    'plugins/concord-copilot/skills/review-and-fix/references/review-driver.md gate-review prompt has drifted from round-plan.js GATE_SWEEP_CLAUSE -- re-run node plugins/concord-copilot/bin/bundle.mjs',
  );
});

test('review instructions do not terminalize foreground silence or a nested skill path', () => {
  for (const text of [driverText, composedCommandText, codexCommandText, copilotDriverText]) {
    assert.match(text, /30-second foreground wait or empty output is not a terminal result/);
    assert.match(text, /non-terminal ledger without a live driver is a stopped driver/);
    assert.match(text, /durable terminal disposition or the ledger's bounded no-progress decision/);
    assert.match(text, /resolve the installed skill path recursively to the actual `SKILL\.md`/);
  }
});

test('manual fix instructions use the same filesystem-safe ID as commit-fix', () => {
  for (const text of [driverText, composedCommandText]) {
    assert.match(text, /fix-<safe-group-id>\.json/);
    assert.match(text, /exact `groupId`/);
  }
});

test('every review driver artifact embeds the lite design-conformance gate prompt that round-plan.js builds', () => {
  const prompt = reviewerPrompt('gate', { stateDir: '<stateDir>', round: '<n>', slug: '<slug>', gateMode: 'design-conformance', targetType: 'git', dodPassed: true }).replaceAll('\\', '/');
  const shared = prompt.slice(0, prompt.indexOf(' Write ONLY'));
  assert.match(shared, /design-conformance gaps only/);
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(shared), `${name} lite gate prompt has drifted from round-plan.js`);
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

test('the composed Claude command preserves pending final DoD semantics', () => {
  assert.match(composedCommandText, /`dodPending:true` means the configured DoD is reserved for the final clean boundary/);
  assert.match(composedCommandText, /If `round-start` reported `dodPending:true`, tell it the configured DoD will run once after review convergence/);
  assert.doesNotMatch(composedCommandText, /If `dodPassed` is `false`, tell it DoD failed this round/);
});

test('manual drivers certify every authorized transaction before commit', () => {
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.match(text, /reserve one `fix` launch/i, name);
    assert.match(text, /independent `certify` launch/i, name);
    assert.match(text, /A partial or stale certificate never commits/, name);
    assert.doesNotMatch(text, /fix --count <number of fixes>/, name);
  }
});

test('every changeClass/action pair the plan prompt offers is accepted by the plan validator, and each driver carries the reconcile rule', () => {
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
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot driver', copilotDriverText]]) {
    assert.match(text, /local group[^.]*may also use `?action:"reconcile"`?/, `${name} plan step does not state that a local group may reconcile`);
  }
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
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(GATE_VERIFY_ADDED_CLAUSE.trim()), `${name} gate-verify prompt has drifted from round-plan.js`);
  }
});

test('every manual review driver hands verify the examined paths and certify the declared fix files', () => {
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.match(text, /Paste the correctness artifact's `examined` array verbatim into the verify prompt/, `${name} does not hand verify the examined paths`);
    assert.match(text, /paste the `files` arrays of the group's fix declarations verbatim into its prompt/, `${name} does not hand certify the declared fix files`);
  }
});

test('every native driver copy and the packaged plan prompt state the structural evidence binding plan-fixes enforces', () => {
  const { DESIGN_EVIDENCE_BINDING_CLAUSE } = require(path.join(CORE, 'round-plan'));
  assert.equal(typeof DESIGN_EVIDENCE_BINDING_CLAUSE, 'string');
  assert.match(DESIGN_EVIDENCE_BINDING_CLAUSE, /exactly `intent-<slug>\.md`/);
  assert.match(DESIGN_EVIDENCE_BINDING_CLAUSE, /verbatim/);
  for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
    assert.ok(text.includes(DESIGN_EVIDENCE_BINDING_CLAUSE), `${name} step 4 does not state the structural evidence binding byte-for-byte`);
  }
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

// #344: each manual driver hands its probe-capable reviewers the sandbox note ENV_CLAUSE_BY_ROLE gives the native prompt, byte for byte, under the role it belongs to.
test('every manual driver copy carries the sandbox uid note for each probe role, byte-for-byte', () => {
  const { ENV_CLAUSE_BY_ROLE } = require(path.join(CORE, 'round-plan'));
  const sections = [
    { label: '`correctness` and `gate-review`', roles: ['correctness', 'gate'] },
    { label: '`verify` and `gate-verify`', roles: ['verify', 'gate-verify'] },
    { label: '`certify`', roles: ['certify'] },
  ];
  for (const { label, roles } of sections) {
    const clause = ENV_CLAUSE_BY_ROLE[roles[0]];
    for (const role of roles) assert.equal(ENV_CLAUSE_BY_ROLE[role], clause, `${role} must share its note with ${roles[0]}`);
    for (const [name, text] of [['review-driver.md', driverText], ['commands/review-and-fix.md', composedCommandText], ['copilot review-driver.md', copilotDriverText]]) {
      assert.ok(text.includes(`For ${label}:\n\n>${clause}`), `${name} sandbox note for ${label} has drifted from round-plan.js ENV_CLAUSE_BY_ROLE`);
    }
  }
});

test('gate-panel lens prompt carries the review-language clause', () => {
  assert.equal(typeof require(path.join(CORE, 'round-plan')).reviewLanguageClause, 'function');
  const runner = fs.readFileSync(path.join(CORE, 'codex-review-runner.js'), 'utf8');
  assert.match(runner, /gate:\$\{lens\}:<slug>\.\$\{reviewLanguageClause\(context\.reviewLanguage\)\}\$\{BLOCKED_CLAUSE\}/);
});
