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
  assert.match(skill, /verified stacked PR is a completion disposition/i);
  assert.match(skill, /ordinary.*fetch.*base.*remote-tracking ref.*immutable fetched SHA/is);
  assert.match(skill, /named owner.*After the prerequisite merges.*fetches.*live downstream PR head.*integrated base/is);
  assert.match(skill, /clean worktree.*no unpushed commits.*reset/is);
  assert.match(skill, /discriminating acceptance check.*fetched integrated base.*no longer red.*reconciliation/is);
  assert.match(skill, /integrate.*exact fetched integrated base.*repository policy.*`BLOCKED`.*full stage 3 review cycle/is);
  assert.match(skill, /restacks.*locally.*full stage 3 review cycle.*independent review.*required checks.*push(?:es)?.*retarget(?:s)?.*read(?:s)? back/is);
  assert.match(skill, /follow-up is outside initiative completion/i);
  assert.match(skill, /maps each immutable source URL or tracker identifier.*stable run key/is);
  assert.match(skill, /project-scoped index.*normalized objective fingerprint.*run key/is);
  assert.match(skill, /search the index before creating/i);
  assert.match(skill, /On every reuse.*authoritative source.*version.*persisted.*invalidate.*contract.*approvals.*tickets.*execution.*stage 1/is);
  assert.match(skill, /source changed.*re-arm.*affected file-target review ledger.*review-cli\.js rerun file:<path>.*stage 3/is);
  assert.match(skill, /durable user-state root.*deterministic project fingerprint.*run key/is);
  assert.match(skill, /Do not use.*temporary directory/i);
  assert.match(skill, /Never reuse one run directory for another key/i);
  assert.match(skill, /two mandatory human checkpoints/i);
  assert.match(skill, /Checkpoint 1 authorizes creation or update of the approved tickets/i);
  assert.match(skill, /Checkpoint 2 authorizes implementation mutations/i);
  assert.match(skill, /approved tickets and external design records have been written and read back/i);
  assert.match(skill, /repository-backed design records.*assigned ticket.*branch and PR/is);
  assert.match(stages, /No tracker or design-document mutation occurs before this checkpoint/i);
  assert.match(stages, /proposed design-record mutation.*specific approval/i);
  assert.match(stages, /Continue only after the user approves implementation of that exact set/i);
  assert.match(stages, /file-target review.*before planning or implementation begins/i);
  assert.match(stages, /writes the design.*commit.*initial design note.*file-target review.*commit.*accepted review fixes.*before planning/is);
  assert.match(stages, /synthetic.*teardown.*read-back.*authorization.*retain.*named owner/is);
  assert.match(stages, /contract review supplements rather than replaces `review-until-green`/i);
  assert.match(stages, /apply the fix.*fresh independent review.*repeat until clean/is);
  assert.match(stages, /commit.*accepted (?:fix|change).*re-arm.*review-until-green/is);
  assert.match(stages, /invalidate.*ticket.*downstream handoffs.*ticket set.*checkpoint 2/is);
  assert.match(skill, /one or more verified PR URLs/i);
  assert.match(skill, /Never merge, release, or deploy to production/);
  assert.match(stages, /Evidence and contract/);
  assert.match(stages, /Ticket set/);
  assert.match(stages, /Execute each ticket/);
  assert.match(stages, /every required PR check.*successful terminal state/i);
  assert.match(stages, /pending, failed, or missing required check.*`BLOCKED`/i);
});

test('initiative-to-prs reconciles approved tickets before a no-PR exit', () => {
  const stages = read('concord', 'references/stages.md');

  assert.match(stages, /do not enter `ticket-to-pr`'s PR exit/i);
  assert.match(stages, /`NO PR NEEDED` only after.*approved ticket.*explicitly approved no-change closure or supersession.*read.*back/is);
  assert.match(stages, /without that authorization or read-back.*`BLOCKED`/is);
  assert.match(stages, /`NO PR NEEDED`, supported by a discriminating current-behavior check and a read-back of the ticket's explicitly approved no-change closure or supersession/);
});

test('initiative-to-prs routes models by task shape and bounds delegation', () => {
  const skill = read('concord', 'SKILL.md');
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
  assert.match(routing, /initiative-level optional specialists.*composed Concord commands.*do not count/is);
  assert.match(routing, /at most two specialist children/i);
  assert.match(routing, /at most two children total/i);
  assert.match(routing, /one source-extraction child plus one contract-decision child/i);
  assert.match(routing, /Record the requested and resolved model/i);
  assert.doesNotMatch(routing, /\b(?:FAST|BALANCED)\b/);
  assert.match(routing, /orchestrator, source extraction, readiness audit, implementation, independent review, or final mutations/i);
  assert.match(skill, /independent review.*omit the implementer's handoff.*approved contract.*source evidence.*reviewed head and base.*verification commands/is);
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
