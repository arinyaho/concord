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

test('all provider handoff contracts require a complete substantive reconciliation packet', () => {
  const canonical = read('concord', 'references/handoff-contract.md');
  for (const provider of ['concord-codex', 'concord-copilot']) assert.equal(read(provider, 'references/handoff-contract.md'), canonical);
  assert.match(canonical, /supporting evidence, every realistic option with its consequence, the recommendation and rationale, and the exact decision required/);
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
  assert.match(stages, /Write the design.*lite eligibility and escalation rules.*Commit the initial design note.*file-target review/is);
  assert.doesNotMatch(stages, /Before dependent implementation, apply the lite eligibility/i);
  assert.match(stages, /synthetic.*teardown.*read-back.*authorization.*retain.*named owner/is);
  assert.match(stages, /contract review supplements rather than replaces `review-until-green`/i);
  assert.match(stages, /apply the fix.*one fresh independent review.*one bounded fix pass followed by one fresh verification, not a loop.*human reconciliation/is);
  assert.doesNotMatch(`${skill}\n${stages}`, /repeat until clean/i);
  assert.match(stages, /new revision pair.*same run budget/is);
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
  assert.match(routing, /bounded implementation batch.*approved.*contract.*clear.*lowest-cost capable implementation model.*focused self-checks.*without pausing for status/is);
  assert.match(routing, /higher-cost capability.*architecture or scope decisions.*new P1 or material findings.*fresh independent verification after the batch/is);
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

test('initiative-to-prs passes the run key on every review call and records the delivery mode', () => {
  const skill = read('concord', 'SKILL.md');
  const stages = read('concord', 'references/stages.md');
  const handoff = read('concord', 'references/handoff-contract.md');

  assert.match(skill, /Pass the run key to EVERY `review-until-green` call.*file-target note reviews and diff reviews.*--initiative-run-key.*--initiative-state-dir.*--initiative-max-launches.*--initiative-max-rounds.*--initiative-mode <base\|lite>/is);
  assert.match(skill, /A review call without the run key is outside the plan/i);
  assert.match(skill, /`base` is the default.*`lite` runs only when the user explicitly asks.*never select it automatically/is);
  assert.match(skill, /recorded in `state\.md` and in the keyed run ledger, and the completion report names it/i);
  assert.match(skill, /`state\.md` there with the run key, delivery mode, review budgets, any escalation trigger/i);
  assert.match(skill, /Report the delivery mode \(and the escalation trigger when the run escalated\)/i);
  assert.match(handoff, /Delivery mode \(`base` or `lite`\), review run key, budgets, and any lite-to-base escalation trigger/i);
  assert.match(stages, /initiative run options as `ticket-to-pr`'s required diff-local gate/i);
});

test('initiative-to-prs documents lite eligibility and escalation before dependent implementation', () => {
  const skill = read('concord', 'SKILL.md');

  assert.match(skill, /one repository and one independently testable outcome.*settled contract.*no public API or deployment-boundary change.*no security, authorization, identity, or cryptography change.*no data migration.*no legal, regulatory, or external-data-rights decision.*no cross-repository integration/is);
  assert.match(skill, /exclusion condition is escalated to base before that implementation.*`escalate <trigger>`.*`public-api`.*`schema`.*`security`.*`legal`.*`cross-package`.*`cross-repository`.*`multi-outcome`.*`unsettled-contract`.*`migration`/is);
  assert.match(skill, /Record the trigger and the exclusion.*handoff/is);
  assert.match(skill, /Escalation is refused after the first launch and never reverses.*after reconciliation.*new base run key.*separate target review state directory.*retain the old target ledger/is);
  assert.match(skill, /start each ref normally when no ledger exists; use `rerun` only when.*matching binding/is);
  assert.match(skill, /never downgrade a base run to lite/i);
  assert.match(skill, /After `escalate`, replace the mode and budgets recorded in `state\.md` with base and the base budgets.*every later call/is);
});

test('initiative-to-prs parks dependent work on a confirmed contract finding and forbids unplanned reviewers', () => {
  const skill = read('concord', 'SKILL.md');
  const stages = read('concord', 'references/stages.md');

  assert.match(skill, /confirmed contract or architecture finding parks dependent work for reconciliation.*launch no further fixer.*return to the user/is);
  assert.match(stages, /confirmed contract or architecture finding parks every dependent unit and fix for reconciliation instead of entering a fix pass/i);
  assert.match(skill, /Never launch a reviewer outside the plan, and never launch one under a new task name/i);
  assert.match(skill, /host can still spawn agents.*cannot prevent.*kept from producing accepted evidence.*unreserved evidence is rejected.*fails closed/is);
  assert.match(skill, /acknowledge each delivered disposition with `consume <claim>` and end the run with `finalise`/i);
  assert.doesNotMatch(`${skill}\n${stages}`, /repeat until clean/i);
  assert.match(stages, /one bounded fix pass followed by one fresh verification, not a loop/i);
});

test('all provider copies of the initiative-to-prs skill, stages and handoff contract match the canonical source', () => {
  for (const provider of ['concord-codex', 'concord-copilot']) {
    for (const file of ['SKILL.md', 'references/stages.md', 'references/handoff-contract.md']) assert.equal(read(provider, file), read('concord', file), `${provider}/${file}`);
  }
});
