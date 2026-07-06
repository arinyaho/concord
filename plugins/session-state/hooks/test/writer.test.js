'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WRITER = path.join(__dirname, '..', 'session-state-writer.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const transcript = path.join(proj, 'sess.jsonl');
  return { proj, transcript, id: 'sess' };
}

function runWriter(transcript, id) {
  execFileSync('node', [WRITER], {
    input: JSON.stringify({ session_id: id, transcript_path: transcript }),
  });
}

test('writes state json, md, and rolling pointer', () => {
  const { proj, transcript, id } = setup();
  fs.writeFileSync(
    transcript,
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/a.js"}}]}}\n'
  );
  runWriter(transcript, id);
  const stateDir = path.join(proj, 'state');
  const model = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8'));
  assert.ok(model.facts.includes('edited /x/a.js'));
  assert.ok(fs.readFileSync(path.join(stateDir, `${id}.md`), 'utf8').includes('edited /x/a.js'));
  assert.ok(fs.existsSync(path.join(stateDir, '_latest.md')));
});

test('second run consumes only the delta (idempotent, no dup)', () => {
  const { proj, transcript, id } = setup();
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/a.js"}}]}}\n';
  fs.writeFileSync(transcript, line);
  runWriter(transcript, id);
  runWriter(transcript, id); // no new bytes
  const model = JSON.parse(fs.readFileSync(path.join(proj, 'state', `${id}.json`), 'utf8'));
  assert.equal(model.facts.filter((f) => f === 'edited /x/a.js').length, 1);
});

test('malformed stdin exits 0 without throwing', () => {
  // execFileSync throws if the process exits non-zero; absence of throw = pass.
  execFileSync('node', [WRITER], { input: 'not json' });
});

test('harvests tags from last_assistant_message and dedups against the transcript', () => {
  const { proj, transcript, id } = setup();
  // Transcript already carries one open loop (the flushed path)...
  fs.writeFileSync(
    transcript,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"OPEN-LOOP: enable the plugin"}]}}\n'
  );
  // ...and stdin carries the same loop (unflushed path) plus a new decision.
  execFileSync('node', [WRITER], {
    input: JSON.stringify({
      session_id: id,
      transcript_path: transcript,
      last_assistant_message: 'OPEN-LOOP: enable the plugin\nDECISION: [scope] ship v1',
    }),
  });
  const model = JSON.parse(fs.readFileSync(path.join(proj, 'state', `${id}.json`), 'utf8'));
  assert.equal(model.openLoops.filter((o) => o === 'enable the plugin').length, 1); // deduped
  assert.ok(model.decisions.includes('[scope] ship v1')); // harvested from stdin
});
