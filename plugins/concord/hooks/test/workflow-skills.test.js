'use strict';
// Properties of the workflow skills a user invokes (docs/design/workflow-state-and-stops.md, independent-review.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');
const skill = (name) => read(`plugins/concord/skills/${name}/SKILL.md`);
const body = (file) => read(file).replace(/^---\n[\s\S]*?\n---\n\n/, '');
const section = (text, heading) => text.split(`\n${heading}\n`)[1]?.split(/\n## /)[0] ?? '';

const WORKFLOWS = ['review-and-fix', 'ticket-to-pr', 'initiative-to-prs', 'coordinate-sessions'];

test('nothing a user invokes calls the review CLI, a ledger, a budget, or a removed workflow', () => {
  // review-until-approve keeps its own implementation and is excluded.
  const invoked = execFileSync('git', ['ls-files', 'plugins/*/skills/**/*.md', 'plugins/*/commands/*.md', 'plugins/*/agents/*.md', 'README.md', 'docs/install.md'], { cwd: REPO, encoding: 'utf8' })
    .trim().split('\n').filter((f) => fs.existsSync(path.join(REPO, f)) && !f.includes('/review-until-approve/') && f !== 'plugins/concord/agents/pr-reviewer.md');
  assert.ok(invoked.length > 20, String(invoked.length));
  for (const file of invoked) {
    assert.doesNotMatch(read(file), /review-cli|record-delivery|STATE_CLI|--initiative-|review-until-lgtm|review-until-green|create_session|send_message|round-start/, file);
  }
  for (const name of WORKFLOWS) {
    for (const file of fs.readdirSync(path.join(REPO, 'plugins/concord/skills', name), { recursive: true }).filter((f) => String(f).endsWith('.md'))) {
      assert.doesNotMatch(read(`plugins/concord/skills/${name}/${file}`), /\bledgers?\b|\bbudgets?\b|run key|reviewerUnavailable|delivery disposition|\blite\b/i, `${name}/${file}`);
    }
  }
  for (const gone of ['plugins/concord/commands/review-and-fix.md', 'plugins/concord/commands/review-until-green.md', 'plugins/concord/agents/project-manager.md', 'plugins/concord/skills/review-until-lgtm']) {
    assert.ok(!fs.existsSync(path.join(REPO, gone)), gone);
  }
});

test('every workflow skill states the three stop cases or defers to the skill that does', () => {
  for (const name of ['ticket-to-pr', 'initiative-to-prs']) {
    assert.match(skill(name), /Stop and ask only for a product decision.*something only the user holds.*hard-to-reverse action the user has not authorized/s, name);
    assert.match(skill(name), /Record every other obstacle on the ticket and continue/, name);
  }
  assert.match(skill('review-and-fix'), /Nothing here ends your run/);
  assert.match(skill('coordinate-sessions'), /Ask only for product decisions, things only the user holds, and hard-to-reverse actions that are not authorized/);
});

test('review-and-fix is one broad review with a narrow recheck, recorded on the ticket and the pull request', () => {
  const text = skill('review-and-fix');
  assert.match(text, /^---\nname: review-and-fix\ndescription: >-\n/);
  for (const row of ['Target kind', 'Target', 'Must satisfy', 'Related repositories', 'Evidence', 'Not done', 'Focus (optional)']) assert.ok(text.includes(`\n${row}: `) || text.includes(`\n${row}:\n`), row);
  assert.match(text, /Never copy the target into another file/);
  assert.match(text, /fresh context/);
  for (const severity of ['blocker', 'should-fix', 'minor']) assert.match(text, new RegExp(`\`${severity}\``));
  assert.match(text, /Check each finding against the code or the documents before acting on it/);
  assert.match(text, /Recheck\. Do not repeat the broad review\./);
  assert.match(text, /run one more recheck\. After the second recheck, stop rechecking/);
  assert.match(text, /one follow-up ticket in the project's tracker/);
  const record = section(text, '## 6. Record');
  assert.match(record, /\*\*Ticket:\*\*/);
  assert.match(record, /\*\*Pull request body\*\*/);
  assert.match(record, /Nothing else is stored/);
  assert.match(record, /keep the pull request a draft/);
  assert.match(text, /does not run the test suite as a gate/);
  assert.match(text, /does not decide whether a pull request may merge/);
  assert.match(text, /author the user does not trust goes to `review-until-approve`/);
});

test('the reviewer and the worker instructions are one text on both harnesses', () => {
  // Codex ships no agent definitions, so each skill carries the instructions as a reference file.
  assert.equal(body('plugins/concord/agents/reviewer.md'), read('plugins/concord/skills/review-and-fix/references/reviewer.md'));
  assert.equal(body('plugins/concord/agents/implementer.md'), read('plugins/concord/skills/coordinate-sessions/references/worker.md'));
  assert.match(skill('review-and-fix'), /`references\/reviewer\.md` next to this file/);
  assert.match(skill('coordinate-sessions'), /`references\/worker\.md` next to this file/);
  for (const name of ['review-and-fix', 'coordinate-sessions']) assert.match(skill(name), /Never start another vendor's agent|never another vendor's agent/, name);
  const reviewer = read('plugins/concord/agents/reviewer.md');
  assert.match(reviewer, /^---\nname: reviewer\n/);
  assert.match(reviewer, /^tools: Read, Glob, Grep, Bash$/m);
  assert.match(reviewer, /Do not edit files, commit, push, or post anywhere/);
  for (const part of ['Findings', 'Unverified', 'Covered']) assert.match(reviewer, new RegExp(`\\*\\*${part}\\.\\*\\*`));
  for (const check of ['Conformance', 'Correctness', 'Security', 'Consistency across repositories', 'Documents']) assert.match(reviewer, new RegExp(`\\*\\*${check}\\.\\*\\*`));
  assert.match(read('plugins/concord/agents/implementer.md'), /^---\nname: implementer\n/);
});

test('coordinate-sessions uses subagent workers, the report-file protocol, and a state document', () => {
  const text = skill('coordinate-sessions');
  const worker = read('plugins/concord/skills/coordinate-sessions/references/worker.md');
  const kinds = ['question', 'blocked', 'progress', 'done', 'handoff'];
  for (const source of [section(text, '## 4. Handle a report'), worker]) {
    assert.deepEqual(source.split('\n').filter((l) => /^\| `/.test(l)).map((l) => l.match(/^\| `([a-z]+)`/)[1]), kinds);
    assert.match(source, /`\[to coordinator\] <kind>: <(?:one-line )?summary>`/);
    assert.match(source, /\.tmp/);
  }
  assert.match(worker, /write `NNN-<kind>\.md\.tmp`, then rename it to `NNN-<kind>\.md`/);
  assert.match(worker, /Never write the coordinating session's state document/);
  assert.match(worker, /pull request URL, the head commit, the CI result for that head, the review findings with how each was handled, and each acceptance criterion with its evidence/);
  assert.match(text, /subagent of your own harness working in its own git worktree; it is never a separate session/);
  assert.match(text, /`state\.md`, the state document\. Only you write it/);
  assert.match(text, /Record an authorization only from words the user wrote in this conversation/);
  assert.match(text, /the user's words verbatim, and the date/);
  assert.match(text, /Never read one back from there/);
  const check = section(text, '## 5. Check a `done` report');
  assert.match(check, /head on the remote is the reported head commit/);
  assert.match(check, /check runs for the head SHA, not for the branch/);
  assert.match(check, /Each acceptance criterion has the evidence/);
  assert.match(check, /You do not merge\. `pr-to-merge` carries the pull requests/);
  assert.match(section(text, '## 7. Hand over'), /state document/);
  assert.doesNotMatch(text, /get_session|environment_kind|bridge|Monitor|receipt|decision-snapshot|archive_session/);
});

test('initiative-to-prs has one checkpoint, before any tracker write, and composes the other workflows', () => {
  const text = skill('initiative-to-prs');
  assert.deepEqual(text.split('\n').filter((l) => /^## \d\. /.test(l)).map((l) => l.replace(/^## \d\. /, '')),
    ['Find the ground', 'Gather evidence', 'Write the design', 'Propose the ticket set', 'The checkpoint', 'Write the tickets', 'Run the units', 'Carry the pull requests', 'Report']);
  assert.equal(text.match(/checkpoint/gi).length, 2, 'the heading and "without a second checkpoint"');
  assert.match(section(text, '## 5. The checkpoint'), /the one point where you wait for the user\. Nothing has been written to the tracker/);
  assert.match(section(text, '## 6. Write the tickets'), /without a second checkpoint/);
  assert.match(section(text, '## 6. Write the tickets'), /`ticket-writing` skill/);
  assert.match(section(text, '## 6. Write the tickets'), /parent issue: a checklist/);
  assert.match(section(text, '## 6. Write the tickets'), /Read every ticket back/);
  assert.match(section(text, '## 3. Write the design'), /under `docs\/`/);
  assert.match(section(text, '## 4. Propose the ticket set'), /Check every acceptance criterion/);
  const run = section(text, '## 7. Run the units');
  assert.match(run, /`coordinate-sessions` skill: one worker per unit, each in its own worktree, each running `ticket-to-pr`/);
  assert.match(run, /its pull request targets the prerequisite's branch/);
  assert.match(section(text, '## 8. Carry the pull requests'), /`pr-to-merge`.*`--no-merge` unless the state document records the user's merge authorization/s);
  for (const cls of ['observed current behavior', 'proven reachable', 'not proven reachable', 'accepted product or design intent', 'no independent evidence', 'decisions that remain open']) assert.ok(text.includes(cls), cls);
  for (const file of require('./initiative-to-prs-files.json').filter((f) => f !== 'SKILL.md')) {
    assert.ok(text.includes(`(${file})`), file);
    assert.ok(fs.existsSync(path.join(REPO, 'plugins/concord/skills/initiative-to-prs', file)), file);
  }
  assert.deepEqual(fs.readdirSync(path.join(REPO, 'plugins/concord/skills/initiative-to-prs/references')).sort(), ['context-discipline.md', 'model-routing.md']);
  const routing = read('plugins/concord/skills/initiative-to-prs/references/model-routing.md');
  for (const cls of ['Fast', 'General', 'Deep']) assert.match(routing, new RegExp(`^\\| ${cls} \\|`, 'm'));
  assert.match(routing, /hands back a task that proves harder than its scope suggested/);
  assert.doesNotMatch(routing, /opus|sonnet|haiku|gpt|Astra/i);
});

test('the workflow skills are a fraction of the size they replace', () => {
  const size = (name) => fs.readdirSync(path.join(REPO, 'plugins/concord/skills', name), { recursive: true }).filter((f) => String(f).endsWith('.md'))
    .reduce((sum, f) => sum + fs.statSync(path.join(REPO, 'plugins/concord/skills', name, String(f))).size, 0);
  assert.ok(size('ticket-to-pr') < 18000, String(size('ticket-to-pr')));
  assert.ok(size('initiative-to-prs') < 18000, String(size('initiative-to-prs')));
  assert.ok(size('coordinate-sessions') < 10000, String(size('coordinate-sessions')));
  assert.ok(size('review-and-fix') < 10000, String(size('review-and-fix')));
});
