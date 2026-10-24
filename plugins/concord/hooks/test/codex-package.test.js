'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODEX = path.join(__dirname, '..', '..', '..', 'concord-codex');

// Codex plugins surface skills, not slash commands (#441).
test('Codex package exposes review-and-fix and its alias as skills', () => {
  for (const name of ['review-and-fix', 'review-until-green']) {
    const skill = fs.readFileSync(path.join(CODEX, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`), name);
    assert.doesNotMatch(skill, /CLAUDE_PLUGIN_ROOT/, name);
    assert.ok(!fs.existsSync(path.join(CODEX, 'commands', `${name}.md`)), `${name} must not also ship as a command`);
  }
  const main = fs.readFileSync(path.join(CODEX, 'skills/review-and-fix/SKILL.md'), 'utf8');
  assert.match(main, /<plugin-root>\/bin\/review-and-fix\.js/);
  const alias = fs.readFileSync(path.join(CODEX, 'skills/review-until-green/SKILL.md'), 'utf8');
  assert.match(alias, /\.\.\/review-and-fix\/SKILL\.md/);
});
