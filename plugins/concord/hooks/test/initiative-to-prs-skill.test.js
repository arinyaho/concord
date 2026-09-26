'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SKILL_FILES = require('./initiative-to-prs-files.json');

const REPO = path.join(__dirname, '..', '..', '..', '..');

function read(packageName, file) {
  return fs.readFileSync(path.join(REPO, 'plugins', packageName, 'skills', 'initiative-to-prs', file), 'utf8');
}

test('initiative-to-prs manifest covers every canonical source file', () => {
  const root = path.join(REPO, 'plugins/concord/skills/initiative-to-prs');
  const files = fs.readdirSync(root, { recursive: true })
    .filter((file) => fs.statSync(path.join(root, file)).isFile())
    .sort();
  assert.deepEqual(SKILL_FILES.map((file) => path.normalize(file)).sort(), files);
});

test('Claude and Codex ship the same initiative-to-prs skill', () => {
  const root = path.join(REPO, 'plugins/concord-codex/skills/initiative-to-prs');
  const files = fs.readdirSync(root, { recursive: true })
    .filter((file) => fs.statSync(path.join(root, file)).isFile())
    .sort();
  assert.deepEqual(SKILL_FILES.map((file) => path.normalize(file)).sort(), files);
  for (const file of SKILL_FILES) assert.equal(read('concord-codex', file), read('concord', file));
});

test('initiative-to-prs composes the existing ticket contracts and stops at verified PRs', () => {
  const skill = read('concord', 'SKILL.md');
  const stages = read('concord', 'references/stages.md');
  const codexReviewCommand = fs.readFileSync(path.join(REPO, 'plugins', 'concord-codex', 'commands', 'review-until-green.md'), 'utf8');

  assert.match(skill, /^---\nname: initiative-to-prs\ndescription: /);
  assert.match(skill, /ticket-writing/);
  assert.match(skill, /ticket-to-pr/);
  assert.match(skill, /branch from the prerequisite PR head/i);
  assert.match(skill, /target the downstream PR at the prerequisite branch/i);
  assert.match(skill, /review-until-green <downstream-branch> <fetched-prerequisite-head-sha>/i);
  assert.doesNotMatch(skill, /review-until-green <downstream-branch> <prerequisite-branch>/i);
  assert.match(skill, /verified stacked PR is a completion disposition/i);
  assert.match(skill, /ordinary.*fetch.*base.*immutable fetched commit SHA/is);
  assert.doesNotMatch(skill, /remote-tracking ref or an immutable fetched SHA/i);
  assert.match(skill, /named owner.*After the prerequisite merges.*fetches.*live downstream PR head.*integrated base/is);
  assert.match(skill, /clean worktree.*no unpushed commits.*reset/is);
  assert.match(skill, /discriminating acceptance check.*fetched integrated base.*no longer red.*reconciliation/is);
  assert.match(skill, /integrate.*exact fetched integrated base.*repository policy.*`BLOCKED`.*full stage 3 review cycle/is);
  assert.match(skill, /restack.*force-with-lease.*fetched.*head SHA.*repository policy.*`BLOCKED`/is);
  assert.match(skill, /final head.*resolved base SHA.*recorded review pair.*drift.*integration.*full stage 3 review cycle/is);
  assert.match(skill, /drift.*restart.*live downstream PR head.*integrated base.*clean[- ]worktree.*reset.*discriminating acceptance check/is);
  assert.match(skill, /restacks.*locally.*full stage 3 review cycle.*independent review.*required checks.*push(?:es)?.*retarget(?:s)?.*read(?:s)? back/is);
  assert.match(skill, /follow-up is outside initiative completion/i);
  assert.match(skill, /maps each immutable source URL or tracker identifier.*stable run key/is);
  assert.match(skill, /project-scoped index.*normalized objective fingerprint.*run key/is);
  assert.match(skill, /search the index before creating/i);
  assert.match(skill, /On every reuse.*authoritative source.*version.*persisted.*invalidate.*contract.*approvals.*tickets.*execution.*stage 1/is);
  assert.match(skill, /source version.*current initiative objective.*authorization envelope.*invalidation.*affected file-target and diff review ledger.*rerun <ref>.*runtime-specific packaged review CLI path.*stage 1/is);
  assert.match(skill, /objective.*authorization envelope.*differs.*reconciliation.*before any mutation/is);
  assert.match(skill, /before each mutation-capable stage.*recheck.*authoritative source.*version.*same invalidation.*reconciliation/is);
  assert.match(codexReviewCommand, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/review-cli\.js" rerun <ref>/);
  assert.match(skill, /durable user-state root.*deterministic project fingerprint.*run key/is);
  assert.match(skill, /Do not use.*temporary directory/i);
  assert.match(skill, /Never reuse one run directory for another key/i);
  assert.match(skill, /two mandatory human checkpoints/i);
  assert.match(skill, /Checkpoint 1 authorizes creation or update of the approved tickets/i);
  assert.match(skill, /Checkpoint 2 authorizes implementation mutations/i);
  assert.match(skill, /approved tickets and external design records have been written and read back/i);
  assert.match(skill, /repository-backed design records.*assigned ticket and repository unit.*planned branch.*PR disposition/is);
  assert.match(stages, /No tracker or design-document mutation occurs before this checkpoint/i);
  assert.match(stages, /Write and read back the Stage 1 handoff before presenting this checkpoint/is);
  assert.match(stages, /missing or unreadable handoff.*unresolved model identity.*incomplete or unsuccessful specialist.*uncovered decision.*missing required independent review blocks checkpoint 1 and Stage 2.*user approval cannot replace/is);
  assert.match(stages, /proposed design-record mutation.*specific approval/i);
  assert.match(stages, /Continue only after the user approves implementation of that exact set/i);
  assert.match(skill, /repository boundary requires a separate implementation unit and PR, not automatically another outcome ticket/i);
  assert.match(skill, /one owner can verify the combined result.*ordered implementation record/is);
  assert.match(stages, /one execution handoff per implementation unit.*artifact\/version prerequisites/is);
  assert.match(stages, /not `READY FOR TEST` until the exact combined artifacts are deployed.*runnable QA hand-off/is);
  assert.match(stages, /file-target review.*before planning or implementation begins/i);
  assert.match(stages, /Write the design.*Commit.*initial design note.*file-target review.*commit.*accepted review fixes.*before planning/is);
  assert.match(stages, /synthetic.*teardown.*read-back.*authorization.*retain.*named owner/is);
  assert.match(stages, /contract review supplements rather than replaces `review-until-green`/i);
  assert.match(stages, /apply the fix.*fresh independent review.*repeat until clean/is);
  assert.match(stages, /commit.*accepted (?:fix|change).*re-arm.*review-until-green/is);
  assert.match(stages, /rerun <ref>.*runtime-specific packaged review CLI path/is);
  assert.doesNotMatch(`${skill}\n${stages}`, /`review-cli\.js /);
  assert.match(stages, /invalidate.*ticket.*downstream handoffs.*ticket set.*checkpoint 2/is);
  assert.match(stages, /Every approved contract revision.*ticket set.*update and read back.*ticket.*checkpoint 2/is);
  assert.match(stages, /Only a revision.*design record.*checkpoint 1/is);
  assert.match(skill, /one or more verified PR URLs/i);
  assert.match(skill, /Never merge, release, or deploy to production/);
  assert.match(stages, /Evidence and contract/);
  assert.match(stages, /For PR-backed dispositions only.*live PR revision pair/is);
  assert.match(stages, /acceptance check.*no longer red.*existing PR.*authoriz.*clos.*read[- ]back.*`BLOCKED`/is);
  assert.match(stages, /Ticket set/);
  assert.match(stages, /Execute each repository unit/);
  assert.match(stages, /every required PR check.*successful terminal state/i);
  assert.match(stages, /pending.*in progress.*terminal failure.*missing required check.*expired.*`BLOCKED`/is);
  assert.match(stages, /wait.*required PR checks.*final head.*base.*bounded.*terminal failure.*expired.*`BLOCKED`/is);
  assert.match(stages, /integration rewrote history.*force-with-lease.*fetched live head SHA.*repository policy.*`BLOCKED`/is);
});

test('initiative-to-prs reconciles approved tickets before a no-PR exit', () => {
  const stages = read('concord', 'references/stages.md');

  assert.match(stages, /already satisfies.*repository unit's contract check.*do not enter `ticket-to-pr`'s PR exit/is);
  assert.match(stages, /Re-run the relevant discriminating check.*unit's contract check.*exact fetched live base/is);
  assert.match(stages, /do not enter `ticket-to-pr`'s PR exit/i);
  assert.match(stages, /`NO PR NEEDED` only after.*approved work.*explicitly approved no-change closure or supersession.*removal of an unnecessary unit.*read.*back/is);
  assert.match(stages, /without that authorization or read-back.*`BLOCKED`/is);
  assert.match(stages, /`NO PR NEEDED`, supported by a discriminating current-behavior check and a read-back of the explicitly approved ticket closure or supersession, or removal of an unnecessary unit through checkpoint 2 without closing the outcome ticket/);
});

test('initiative-to-prs routes models by task shape and bounds delegation', () => {
  const skill = read('concord', 'SKILL.md');
  const routing = read('concord', 'references/model-routing.md');

  for (const modelClass of ['Fast', 'General', 'Deep']) {
    assert.match(routing, new RegExp(`\\| ${modelClass} \\|`));
  }
  assert.match(routing, /current model catalog.*newest suitable model/is);
  assert.match(routing, /confirm.*selected model and reasoning effort are callable/is);
  assert.match(routing, /Do not infer capability from a model name, version number, or price alone/i);
  assert.match(routing, /before checkpoint 1.*deep-capability model.*before.*approved contract/is);
  assert.match(routing, /separate deep-capability specialist.*clean context/is);
  assert.match(routing, /active root agent cannot satisfy a Deep decision gate/i);
  assert.doesNotMatch(routing, /active agent may perform that pass/i);
  assert.match(routing, /child invocation or agent identity.*requested and resolved model.*provider and catalog basis.*reasoning effort.*successful completion.*conclusion.*covered decision identities/is);
  assert.match(routing, /material cryptography, security, or migration decision.*second independent deep-capability reviewer/is);
  assert.match(routing, /distinct second-reviewer evidence record.*invocation or agent identity.*requested and resolved model.*provider and catalog basis.*reasoning effort.*successful completion.*conclusion.*covered decision identities/is);
  assert.match(routing, /Apply this gate throughout execution, including implementation and review/is);
  assert.match(read('concord', 'references/stages.md'), /architecture decision gate.*requires a separate deep-capability specialist for material decisions/is);
  assert.match(routing, /maximum delegation depth is two/i);
  assert.match(routing, /at most two specialist children/i);
  assert.match(routing, /Record the role, required class, requested and resolved model/i);
  assert.match(skill, /independent review.*omit the implementer's handoff.*approved contract.*source evidence.*reviewed head and base.*verification commands/is);
});

test('initiative-to-prs handoffs carry evidence without copying session history', () => {
  const handoff = read('concord', 'references/handoff-contract.md');

  assert.match(handoff, /Do not copy the parent conversation/i);
  assert.match(handoff, /Evidence references/);
  assert.match(handoff, /Decisions/);
  assert.match(handoff, /Exit verdict/);
  assert.match(handoff, /Requested and resolved model/);
  assert.match(handoff, /Requested and resolved model[^\n]*provider and catalog basis[^\n]*reasoning effort[^\n]*separate child invocation or agent identity[^\n]*successful completion[^\n]*conclusion[^\n]*covered decision identities[^\n]*second independent Deep reviewer[^\n]*same fields[^\n]*distinct second-reviewer evidence record/i);
  assert.match(handoff, /active root agent.*not resolved model evidence/i);
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
