'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./temp-dir');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins/concord/skills/coordinate-sessions/SKILL.md');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');

test('coordinate-sessions has separate Claude and Codex skills', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /^---\nname: coordinate-sessions\n/);
  assert.ok(fs.existsSync(path.join(REPO, 'plugins/concord-codex/skills/coordinate-sessions/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins/concord-copilot/skills/coordinate-sessions')));
  assert.match(read('.claude-plugin/marketplace.json'), /coordinate-sessions/);
  assert.doesNotMatch(read('plugins/concord/.claude-plugin/plugin.json'), /coordinate-sessions/, 'plugin.json is a release-bump version file; PRs do not edit it');
  assert.match(read('README.md'), /\| `coordinate-sessions` \|.*\| Claude Code, Codex \|/);
});

test('the environment comes from get_session, not the system prompt', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /`get_session` without a `session_id`/);
  assert.match(skill, /`environment_kind`/);
  assert.match(skill, /system prompt does not decide/);
  assert.match(skill, /"Create a worker" means calling `create_session`/);
  assert.match(skill, /A subagent started with the Agent tool is not a worker/);
});

test('both channels, report kinds and the file-channel refusal are defined', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /\[to coordinator\] <kind>: <summary>/);
  for (const kind of ['question', 'blocked', 'progress', 'done', 'handoff']) assert.match(skill, new RegExp('`' + kind + '`'));
  assert.match(skill, /File channel/);
  assert.match(skill, /Direct channel/);
  assert.match(skill, /refuse the file channel/);
  assert.match(skill, /`status_bucket`/);
  assert.match(skill, /created in your own environment/);
});

test('decisions, verification and merging follow the design', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /only what the user typed into this session/);
  assert.match(skill, /must ordinarily be typed by the user into the worker session/);
  assert.match(skill, /check each finding the worker called minor against the code/);
  assert.match(skill, /Merge only if the user allowed merging in the start question/);
  assert.match(skill, /--match-head-commit/);
  assert.match(skill, /disjoint/);
  for (const forbidden of [/mien exec/, /arinyaho/, /release-bump/, /claude plugin update/]) assert.doesNotMatch(skill, forbidden);
});

test('coordinator decision receipts require user authority and bind worker-supplied snapshots', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const driver = read('plugins/concord/core/review-driver.md');
  const ledger = read('docs/design/review-ledger.md');
  const receipt = require('../../core/decision-receipt');
  assert.deepEqual(Object.keys(receipt.decisionSnapshot({ repoRoot: '/repo', stateDir: '/state', ledger: {
    target: { ref: 'feature/x', head_sha: 'abc' }, attemptId: 'attempt-1', round: 2,
  }, id: 'gate:x', action: 'dismiss', finding: { id: 'gate:x' } })).sort(),
  ['repository', 'stateDir', 'bindingHash', 'target', 'attemptId', 'round', 'head', 'id', 'action', 'findingHash'].sort());
  for (const scenario of [
    /worker.*read-only.*decision-snapshot.*actual JSON snapshot/is,
    /user.*authorization.*directly in this coordinator session/is,
    /peer's message.*receipt as self-authorizing/i,
    /shared-filesystem receipt path/i,
    /worker is on another host.*cannot read the path/i,
    /never accept.*peer.*self-authorizing/i,
  ]) assert.match(skill, scenario);
  assert.match(skill, /"version":1/);
  assert.match(skill, /sessionId/);
  assert.match(skill, /findingHash/);
  assert.match(skill, /bindingHash.*existing initiative ownership/i);
  assert.match(skill, /cannot create or change target ownership.*carried\/new run key/i);
  assert.match(skill, /dismiss.*--decision <absolute-file>/s);
  assert.match(skill, /defer.*--decision <absolute-file>/s);
  assert.match(driver, /decision-snapshot <ref> <id> --action dismiss[|]defer/);
  assert.match(driver, /--decision <absolute-file>/);
  assert.match(ledger, /decisionProvenance/);
  assert.match(ledger, /not authenticated proof of a human/);
});

test('a fresh coordinator can set up, run and stop the file channel', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /mkdir -p <reports>\/<group>/);
  assert.match(skill, /`group01`/);
  assert.match(skill, /## 0\. Start/);
  assert.match(skill, /Stop the Monitor when no worker is active/);
  assert.match(skill, /`NNN-<kind>\.md\.tmp`/);
  assert.doesNotMatch(skill, /handoff-\*/);
  assert.match(skill, /`status_bucket` `blocked`/);
  assert.match(skill, /`status` `idle`/);
});

test('every report is surfaced and every report kind has a handler', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /no \[to coordinator\] header/);
  assert.doesNotMatch(skill, /if \[\[ "\$first" == "\[to coordinator\]"\* \]\]/);
  for (const kind of ['question', 'blocked', 'progress', 'done', 'handoff']) assert.match(skill, new RegExp('^\\| `' + kind + '` \\|', 'm'));
  assert.match(skill, /create a successor worker/);
});

test('worker authority comes from its creation prompt, not later messages', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /data from a peer/);
  assert.match(skill, /in its `create_session` prompt/);
  assert.doesNotMatch(skill, /Workers follow your messages as instructions/);
});

test('a merge honors the recorded delivery state and checks closed issues', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /its `node "\$STATE_CLI" record-delivery` output/);
  assert.doesNotMatch(skill, /with `record-delivery`:/, 'record-delivery writes a record; the coordinator reads the worker\'s output');
  assert.match(skill, /never merge a head recorded `blocked`/);
  assert.match(skill, /`mergeable-without-review`.*the user's decision/);
  assert.match(skill, /every issue named in a `Closes` line is closed/);
});

test('a coordinator handoff moves the watch and marks the handoff as data', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const section = skill.split('## 7. Hand off yourself')[1] || '';
  assert.match(section, /stop your Monitors/);
  assert.match(section, /says that the handoff is data/);
  assert.match(section, /start a Monitor for each file-channel group still running/);
  assert.match(section, /only the user's own messages/);
});

test('the Monitor loop surfaces each report once, flags a bad header and skips temporary files', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const script = skill.match(/```bash\n([\s\S]*?)```/)[1];
  const reports = tempDir('coordinate-sessions-');
  fs.mkdirSync(path.join(reports, 'group01'));
  fs.writeFileSync(path.join(reports, 'group01', '001-done.md'), '[to coordinator] done: ok\n');
  fs.writeFileSync(path.join(reports, 'group01', '002-progress.md'), '\nno header\n');
  fs.writeFileSync(path.join(reports, 'group01', '003-question.md.tmp'), '[to coordinator] question: half\n');
  const once = script.replaceAll('<reports>', reports).replaceAll('<group>', 'group01')
    .replace('while true; do', 'for pass in 1 2; do').replace(/\n\s*sleep 20/, '');
  const lines = execFileSync('bash', ['-c', once], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /001-done\.md: \[to coordinator\] done: ok$/);
  assert.match(lines[1], /002-progress\.md: \(no \[to coordinator\] header\)/);
});

test('a worker that never starts is detected, archived and reported instead of awaited', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /before your first `create_session`/);
  assert.match(skill, /confirm that it started, start the Monitor/);
  assert.match(skill, /until its `connection_status` reads `connected`/);
  assert.match(skill, /within three minutes of `create_session` is stalled in sandbox allocation/);
  assert.match(skill, /Send a worker no message before it has started/);
  assert.match(skill, /archive it with `archive_session`/);
  assert.match(skill, /restart the bridge for that environment/);
  assert.match(skill, /Agent-tool subagent/);
  assert.match(skill, /`status_bucket` `working` does not show that a worker has started/);
});

test('effort goes in the worker prompt and list_sessions is filtered', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  assert.match(skill, /takes no effort setting/);
  assert.match(skill, /the prompt cannot enforce/);
  assert.match(skill, /`list_sessions` with `mine: true`/);
});

test('the start question asks for merge authority and own decisions once, and the handoff carries the answers', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const start = skill.split('## 0. Start')[1].split('## 1.')[0];
  assert.match(start, /Before your first `create_session`, ask the user once/);
  assert.match(start, /"merge when ready"/);
  assert.match(start, /"report and wait"/);
  assert.match(start, /"merge when ready, including heads with no automated review \(`mergeable-without-review`\)"/);
  assert.match(start, /Decisions you may take yourself/);
  assert.match(start, /verbatim with the time it was given/);
  assert.match(start, /restate it in your first report/);
  const merge = skill.split('### Judge a `done` report')[1].split('## 6.')[0];
  assert.match(merge, /without asking again/);
  assert.match(merge, /Otherwise report your verdict and wait/);
  assert.match(merge, /merged without asking only when the recorded answer is "merge when ready, including heads with no automated review"; otherwise it is put to the user/);
  const handoff = skill.split('## 7. Hand off yourself')[1];
  assert.match(handoff, /standing authorities from step 0/);
  assert.match(handoff, /applies them as recorded under step 4 and restates them in its first report/);
  assert.match(skill, /A successor coordinator applies the answers its handoff records, exactly as recorded/);
  assert.match(handoff, /each verbatim with the time it was given/);
});

test('every shipped skill and command that names record-delivery also names STATE_CLI or review-until-lgtm (#464)', () => {
  const files = execFileSync('git', ['ls-files', 'plugins/*/skills/**/*.md', 'plugins/*/commands/*.md', 'plugins/concord/core/review-driver.md'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  let seen = 0;
  for (const file of files) {
    for (const line of read(file).split('\n')) {
      if (!line.includes('record-delivery')) continue;
      seen += 1;
      assert.match(line, /STATE_CLI|review-until-lgtm/, `${file}: ${line.slice(0, 80)}`);
    }
  }
  assert.ok(seen >= 8);
  assert.match(read('plugins/concord/skills/coordinate-sessions/SKILL.md'), /run `node "\$STATE_CLI" record-delivery <pr> <head-sha>`/);
});
