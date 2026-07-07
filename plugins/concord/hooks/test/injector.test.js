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

test('resume prints the session model as charter output plus the tag convention', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(
    path.join(stateDir, `${id}.json`),
    JSON.stringify({ offset: 1, openLoops: [], decisions: ['[body] STATE-BODY'], nexts: [], facts: [] })
  );
  const out = run({ session_id: id, transcript_path: transcript, source: 'resume' });
  assert.ok(out.includes('# Task charter'));
  assert.ok(out.includes('[body] STATE-BODY'));
  assert.ok(out.includes('DECISION:')); // convention reminder always present
});

test('startup unions recent session models under the charter header', () => {
  const { transcript, stateDir, id } = setup();
  fs.writeFileSync(
    path.join(stateDir, 'other.json'),
    JSON.stringify({ offset: 1, openLoops: [], decisions: ['[body] ROLLING-BODY'], nexts: [], facts: [] })
  );
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(out.includes('Prior task context'));
  assert.ok(out.includes('ROLLING-BODY'));
  assert.ok(out.includes('DECISION:'));
});

test('startup with no charter or session state emits only the convention', () => {
  const { transcript, id } = setup();
  const out = run({ session_id: id, transcript_path: transcript, source: 'startup' });
  assert.ok(!out.includes('# Task charter'));
  assert.ok(out.includes('DECISION:'));
});

function runInjector(input) {
  return execFileSync('node', [path.join(__dirname, '..', 'session-state-injector.js')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('injector startup: emits north-star + merged decisions, not _latest.md', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'iproj-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'charter.md'), 'preserve founding context');
  fs.writeFileSync(path.join(dir, 'sessX.json'), JSON.stringify({ offset: 1, openLoops: ['drift'], decisions: ['[scope] v1 small'], nexts: [], facts: [] }));
  const out = runInjector({ session_id: 'new1', transcript_path: path.join(proj, 'new1.jsonl'), source: 'startup' });
  assert.ok(out.includes('# Task charter'));
  assert.ok(out.includes('preserve founding context'));
  assert.ok(out.includes('[scope] v1 small'));
  assert.ok(out.includes('DECISION:')); // convention line still delivered
});

test('injector resume: includes the resuming session own decisions (P1 regression guard)', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'iproj2-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'selfSess';
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ offset: 1, openLoops: ['self loop'], decisions: ['[self] my decision'], nexts: [], facts: [] }));
  const out = runInjector({ session_id: sid, transcript_path: path.join(proj, `${sid}.jsonl`), source: 'resume' });
  assert.ok(out.includes('[self] my decision')); // own state must survive resume
  assert.ok(out.includes('self loop'));
});
