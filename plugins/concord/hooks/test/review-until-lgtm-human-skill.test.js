'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.join(__dirname, '..', '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const skill = read('plugins/concord/skills/review-until-lgtm/SKILL.md');
const section = (title) => { const start = skill.indexOf(`### ${title}`); assert.notStrictEqual(start, -1, title); const next = skill.indexOf('\n#', start + 4); return skill.slice(start, next === -1 ? undefined : next); };

test('the description names human reviewers', () => {
  assert.match(skill, /^description: Use when GitHub PR review feedback from automated or human reviewers/m);
});

test('the wait commands per host are exact and Monitor is not used for the human wait', () => {
  const wait = section('Wait');
  assert.match(wait, /node "\$STATE_CLI" wait-feedback <pr> --max-wait 6600/);
  assert.match(wait, /run_in_background/);
  assert.match(wait, /timeout: 7200000/);
  assert.match(wait, /node "\$STATE_CLI" wait-feedback <pr> --once/);
  assert.match(wait, /Codex and Copilot/);
  assert.doesNotMatch(wait, /under `Monitor`|start it with `Monitor`/);
  assert.match(wait, /never .*Monitor/i);
});

test('human threads are never resolved and replies carry the hidden marker', () => {
  const replies = section('Replies');
  assert.match(replies, /never resolve/i);
  assert.match(replies, /<!-- concord-lgtm-reply: <item-id> -->/);
  assert.match(replies, /claim-reply <pr> <item-id>/);
  assert.match(replies, /find-reply/);
});

test('the Approve prompt is asked once and a comment LGTM is not approval', () => {
  assert.match(section('Replies'), /claim-approve-prompt <pr> <head-sha> <reviewer-id>/);
  assert.match(skill, /comment-only LGTM .*not approval/i);
});

test("a person's minor is fixed in the head's round and a bot's minor is collected", () => {
  const feedback = section('Human feedback');
  assert.match(feedback, /minor.*from a person.*fixed in the head's fix round/is);
  assert.match(feedback, /collect-minor/);
});

test('reviewers come only from the selection and the empty selection observes every account', () => {
  const reviewers = section('Reviewers');
  assert.match(reviewers, /select-reviewers <pr> --reviewer <login>/);
  assert.match(reviewers, /--none/);
  assert.match(reviewers, /every account/);
  assert.doesNotMatch(skill, /only `chatgpt-codex-connector` is watched/);
});

test('the Codex and Copilot copies match the shared skill', () => {
  for (const host of ['concord-codex', 'concord-copilot']) assert.strictEqual(read(`plugins/${host}/skills/review-until-lgtm/SKILL.md`), skill);
});

test('background collection preserves the complete stored human and bot selection', () => {
  const background = section('Background collection');
  assert.match(background, /omit `--reviewer` after storing the complete selection/);
  assert.match(background, /every selected account, human and bot/);
  assert.doesNotMatch(background, /Pass one `--reviewer <login>` per configured automated reviewer/);
});
