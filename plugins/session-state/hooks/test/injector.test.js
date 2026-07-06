'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INJECTOR = path.join(__dirname, '..', 'session-state-injector.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const stateDir = path.join(proj, 'state');
  fs.mkdirSync(stateDir);
  return { transcript: path.join(proj, 'sess.jsonl'), stateDir, id: 'sess' };
}

function run(input) {
  return execFileSync('node', [INJECTOR], { input: JSON.stringify(input), encoding: 'utf8' });
}

test('resume prints the session state file plus the tag convention', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(path.join(stateDir, `${id}.md`), 'STATE-BODY');
  const out = run({ session_id: id, transcript_path: transcript, source: 'resume' });
  assert.ok(out.includes('STATE-BODY'));
  assert.ok(out.includes('DECISION:')); // convention reminder always present
});

test('startup prints _latest under a prior-session header when recent', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(path.join(stateDir, '_latest.md'), 'ROLLING-BODY');
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(out.includes('Prior session state'));
  assert.ok(out.includes('ROLLING-BODY'));
  assert.ok(out.includes('DECISION:'));
});

test('startup with a stale _latest emits only the convention', () => {
  const { transcript, stateDir, id } = setup();
  const p = path.join(stateDir, '_latest.md');
  fs.writeFileSync(p, 'OLD');
  const old = Date.now() / 1000 - 72 * 3600;
  fs.utimesSync(p, old, old);
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(!out.includes('OLD'));
  assert.ok(out.includes('DECISION:'));
});
