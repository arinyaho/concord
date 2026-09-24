'use strict';
// Proves the three acceptance criteria from the "PreToolUse 훅으로 grep 스윕 임계치
// 리마인더 강제" ticket: (1) no reminder under threshold, (2) a reminder is injected at/after
// threshold, (3) the Bash call is never blocked regardless of threshold state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'grep-sweep-reminder.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-'));
  return { transcript: path.join(proj, 'sess.jsonl'), sessionId: 'sess-1' };
}

function bashEvent(sessionId, transcript, command) {
  return { session_id: sessionId, transcript_path: transcript, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
}

function run(event) {
  const out = execFileSync('node', [HOOK], { input: JSON.stringify(event), encoding: 'utf8' });
  return out ? JSON.parse(out) : null;
}

test('grep-sweep-reminder: no reminder while under the threshold', () => {
  const { transcript, sessionId } = setup();
  for (let i = 0; i < 9; i += 1) {
    const out = run(bashEvent(sessionId, transcript, 'grep -rn foo src/'));
    assert.equal(out, null, `unexpected reminder at call ${i + 1}`);
  }
});

test('grep-sweep-reminder: a reminder is injected once the threshold is reached', () => {
  const { transcript, sessionId } = setup();
  let out = null;
  for (let i = 0; i < 10; i += 1) out = run(bashEvent(sessionId, transcript, 'grep -rn foo src/'));
  assert.ok(out, 'expected a reminder at the 10th matching call');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /delegate-verbose-work/);
});

test('grep-sweep-reminder: keeps reminding periodically past the threshold, not just once', () => {
  const { transcript, sessionId } = setup();
  const reminders = [];
  for (let i = 0; i < 25; i += 1) {
    const out = run(bashEvent(sessionId, transcript, 'rg foo src/'));
    if (out) reminders.push(i + 1);
  }
  assert.deepEqual(reminders, [10, 20]);
});

test('grep-sweep-reminder: never sets a deny/ask permissionDecision, at or past threshold', () => {
  const { transcript, sessionId } = setup();
  for (let i = 0; i < 12; i += 1) {
    const out = run(bashEvent(sessionId, transcript, 'grep -rn foo src/'));
    if (out) assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  }
});

test('grep-sweep-reminder: a non-sweep Bash command is never counted or reminded', () => {
  const { transcript, sessionId } = setup();
  for (let i = 0; i < 20; i += 1) {
    const out = run(bashEvent(sessionId, transcript, 'ls -la'));
    assert.equal(out, null);
  }
});

test('grep-sweep-reminder: separate sessions get independent counters', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-'));
  const transcriptA = path.join(proj, 'sess-a.jsonl');
  const transcriptB = path.join(proj, 'sess-b.jsonl');
  for (let i = 0; i < 9; i += 1) run(bashEvent('sess-a', transcriptA, 'grep foo .'));
  const outA = run(bashEvent('sess-a', transcriptA, 'grep foo .'));
  const outB = run(bashEvent('sess-b', transcriptB, 'grep foo .'));
  assert.ok(outA, 'session A should hit its own 10th call');
  assert.equal(outB, null, 'session B has its own independent counter, starting at 1');
});

test('grep-sweep-reminder: malformed stdin does not throw and exits cleanly', () => {
  assert.doesNotThrow(() => execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8' }));
});
