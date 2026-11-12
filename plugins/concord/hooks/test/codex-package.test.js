'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const SHARED = path.join(REPO, 'plugins/concord/skills');
const CODEX = path.join(REPO, 'plugins/concord-codex');

const bundled = fs.readFileSync(path.join(CODEX, 'bin/bundle.mjs'), 'utf8').match(/for \(const skill of \[([^\]]+)\]\)/)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
const files = (root) => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => path.relative(root, path.join(e.parentPath, e.name))).filter((f) => !f.startsWith(`test${path.sep}`)).sort();

test('the Codex package ships exactly the bundled shared skills, byte for byte and without their tests', () => {
  assert.deepEqual(fs.readdirSync(path.join(CODEX, 'skills')).sort(), [...bundled].sort());
  for (const skill of bundled) {
    const src = path.join(SHARED, skill);
    const copy = path.join(CODEX, 'skills', skill);
    assert.deepEqual(files(copy), files(src), skill);
    for (const f of files(src)) assert.ok(fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(copy, f))), `${skill}/${f} drifted: re-run node plugins/concord-codex/bin/bundle.mjs`);
    assert.ok(!fs.existsSync(path.join(copy, 'test')), skill);
  }
});

// Codex plugins surface skills, not slash commands or agent definitions.
test('the Codex package carries the workflows as skills and needs no agent definition', () => {
  for (const name of ['review-and-fix', 'coordinate-sessions', 'ticket-to-pr', 'initiative-to-prs', 'pr-to-merge']) {
    const skill = fs.readFileSync(path.join(CODEX, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: >-\\n`), name);
    assert.doesNotMatch(skill, /CLAUDE_PLUGIN_ROOT/, name);
    assert.ok(!fs.existsSync(path.join(CODEX, 'commands', `${name}.md`)), `${name} must not also ship as a command`);
  }
  for (const gone of ['review-until-green', 'review-until-lgtm', 'project-manager']) assert.ok(!fs.existsSync(path.join(CODEX, 'skills', gone)), gone);
  assert.ok(!fs.existsSync(path.join(CODEX, 'agents')));
  assert.ok(fs.existsSync(path.join(CODEX, 'skills/review-and-fix/references/reviewer.md')));
  assert.ok(fs.existsSync(path.join(CODEX, 'skills/coordinate-sessions/references/worker.md')));
});
