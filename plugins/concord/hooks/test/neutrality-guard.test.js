// plugins/concord/hooks/test/neutrality-guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'core');
const BANNED = ['CLAUDE_', 'transcript_path', 'session_id', 'last_assistant_message', 'Task tool'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

test('no file under core/ contains a vendor symbol', () => {
  const offenders = [];
  for (const file of walk(CORE)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const sym of BANNED) {
      if (text.includes(sym)) offenders.push(`${path.relative(CORE, file)}: ${sym}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `core/ must be vendor-clean; found: ${offenders.join(', ')}`);
});
