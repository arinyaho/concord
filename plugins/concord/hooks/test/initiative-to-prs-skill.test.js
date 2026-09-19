'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SKILL_FILES = [
  'SKILL.md',
  'references/stages.md',
  'references/model-routing.md',
  'references/handoff-contract.md',
];

function read(packageName, file) {
  return fs.readFileSync(path.join(REPO, 'plugins', packageName, 'skills', 'initiative-to-prs', file), 'utf8');
}

test('Claude and Codex ship the same initiative-to-prs skill', () => {
  for (const file of SKILL_FILES) assert.equal(read('concord-codex', file), read('concord', file));
});

test('initiative-to-prs composes the existing ticket contracts and stops at verified PRs', () => {
  const skill = read('concord', 'SKILL.md');
  const stages = read('concord', 'references/stages.md');

  assert.match(skill, /^---\nname: initiative-to-prs\ndescription: /);
  assert.match(skill, /ticket-writing/);
  assert.match(skill, /ticket-to-pr/);
  assert.match(skill, /branch from the prerequisite PR head/i);
  assert.match(skill, /target the downstream PR at the prerequisite branch/i);
  assert.match(skill, /retarget.*normal base.*after the prerequisite merges/i);
  assert.match(skill, /two mandatory human checkpoints/i);
  assert.match(skill, /one or more verified PR URLs/i);
  assert.match(skill, /Never merge, release, or deploy to production/);
  assert.match(stages, /Evidence and contract/);
  assert.match(stages, /Ticket set/);
  assert.match(stages, /Execute each ticket/);
});

test('initiative-to-prs routes models by task shape and bounds delegation', () => {
  const routing = read('concord', 'references/model-routing.md');

  for (const role of [
    'orchestrator',
    'source extraction',
    'readiness audit',
    'contract decision',
    'implementation',
    'independent review',
    'final mutations',
  ]) assert.match(routing, new RegExp(role, 'i'));

  for (const model of ['Luna', 'Terra', 'Sol', 'Astra', 'Haiku', 'Sonnet', 'Opus']) {
    assert.match(routing, new RegExp(model));
  }
  assert.match(routing, /maximum delegation depth is two/i);
  assert.match(routing, /at most two specialist children/i);
  assert.match(routing, /Record the requested and resolved model/i);
});

test('initiative-to-prs handoffs carry evidence without copying session history', () => {
  const handoff = read('concord', 'references/handoff-contract.md');

  assert.match(handoff, /Do not copy the parent conversation/i);
  assert.match(handoff, /Evidence references/);
  assert.match(handoff, /Decisions/);
  assert.match(handoff, /Exit verdict/);
  assert.match(handoff, /Requested and resolved model/);
});

test('initiative-to-prs remains provider-neutral and project-neutral', () => {
  const files = SKILL_FILES.map((file) => read('concord', file));
  const forbidden = [
    /SEBIT/i,
    /ChemCopilot/i,
    /CryptoLab/i,
    /Confluence/i,
    /\/Users\//,
    /customfield_\d+/i,
  ];

  for (const contents of files) {
    for (const pattern of forbidden) assert.doesNotMatch(contents, pattern);
  }
});
