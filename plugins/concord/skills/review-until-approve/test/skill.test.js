'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');

test('SKILL.md names the skill and instructs the whole loop with scripts that exist', () => {
  assert.match(skill, /^---\nname: review-until-approve\n/);
  for (const verb of ['start', 'round', 'approve', 'waive', 'stop']) assert.match(skill, new RegExp(`approve\\.js" ${verb} `));
  assert.match(skill, /watch\.js/);
  for (const file of ['approve.js', 'watch.js']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', file)));
  assert.match(skill, /never request changes, merge, push/i);
});

test('the description does not promise a wait without model calls on every harness', () => {
  const description = skill.slice(0, skill.indexOf('\n---', 4));
  assert.doesNotMatch(description, /without spending tokens/);
  assert.match(description, /Codex/);
});
