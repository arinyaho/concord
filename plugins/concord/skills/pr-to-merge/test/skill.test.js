'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pr-to-merge.js'), 'utf8');

test('SKILL.md names the skill and starts the script as one background command', () => {
  assert.match(skill, /^---\nname: pr-to-merge\ndescription: >-\n/);
  assert.match(skill, /Do NOT use/);
  assert.match(skill, /`scripts\/pr-to-merge\.js`/);
  assert.match(skill, /run_in_background/);
  const deadline = Number(skill.match(/--deadline (\d+) OWNER/)?.[1]);
  const timeout = Number(skill.match(/`timeout: (\d+)`/)?.[1]);
  assert.ok(deadline > 0 && timeout / 1000 - deadline >= 600, `deadline ${deadline}, timeout ${timeout}`);
});

test('SKILL.md says what to do with every kind of line the script prints', () => {
  const kinds = new Set([...script.matchAll(/emit\(`([a-z]+(?: failed)?) /g), ...script.matchAll(/notice\([^,]+, `([a-z]+(?: failed)?) /g)].map((m) => m[1]));
  assert.ok(kinds.size >= 10, [...kinds].join(','));
  for (const kind of kinds) assert.match(skill, new RegExp(`^\\|.*\`${kind} `, 'm'), kind);
  for (const reason of script.matchAll(/head \$\{h\}: ([a-z][^`$]+)`/g)) assert.ok(skill.includes(reason[1]), reason[1]);
});

test('SKILL.md has every section the design lists for the skill', () => {
  for (const heading of ['Approved, with open points', 'Approved, with a conflict', 'Approval on an older head', 'Answering a review on the user\'s own pull request', 'Failed required checks', 'After a merge', 'Authorization', 'Scheduled form']) {
    assert.match(skill, new RegExp(`^##+ ${heading}$`, 'm'), heading);
  }
});
