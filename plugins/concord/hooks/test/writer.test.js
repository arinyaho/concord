'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const WRITER = path.join(__dirname, '..', 'session-state-writer.js');

function setup() {
  const proj = tempDir('proj-');
  const transcript = path.join(proj, 'sess.jsonl');
  return { proj, transcript, id: 'sess' };
}

function runWriter(transcript, id) {
  execFileSync('node', [WRITER], {
    input: JSON.stringify({ session_id: id, transcript_path: transcript }),
  });
}

test('writes state json only, no md, no rolling pointer', () => {
  const { proj, transcript, id } = setup();
  fs.writeFileSync(
    transcript,
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/a.js"}}]}}\n'
  );
  runWriter(transcript, id);
  const stateDir = path.join(proj, 'state');
  const model = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8'));
  assert.ok(model.facts.includes('edited /x/a.js'));
  // <sid>.md is no longer written; the injector reads <sid>.json + charter.md instead.
  assert.ok(!fs.existsSync(path.join(stateDir, `${id}.md`)));
  // _latest.md is no longer written; the injector merges on read instead.
  assert.ok(!fs.existsSync(path.join(stateDir, '_latest.md')));
});

test('second run consumes only the delta (idempotent, no dup)', () => {
  const { proj, transcript, id } = setup();
  const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/a.js"}}]}}\n';
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
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OPEN-LOOP: enable the plugin"}]}}\n'
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

test('writer: drafts north-star from first substantive user message when charter.md absent', () => {
  const proj = tempDir('wproj-');
  const sid = 'wsess1';
  const tpath = path.join(proj, `${sid}.jsonl`);
  const L = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    tpath,
    L({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }) +
      L({ type: 'user', message: { role: 'user', content: 'Build the task charter: preserve founding context across sessions.' } }) +
      L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DECISION: [scope] north-star + shards' }] } })
  );
  const input = JSON.stringify({ session_id: sid, transcript_path: tpath, last_assistant_message: '' });
  execFileSync('node', [path.join(__dirname, '..', 'session-state-writer.js')], { input });

  const northStar = fs.readFileSync(path.join(proj, 'state', 'charter.md'), 'utf8');
  assert.ok(northStar.includes('Build the task charter'));
  assert.ok(!northStar.toLowerCase().includes('system-reminder'));
  // _latest.md is no longer written
  assert.strictEqual(fs.existsSync(path.join(proj, 'state', '_latest.md')), false);
});

// A session in explain-pr's read-only mode has read a pull request; text it echoes from it must not reach later sessions.
function readingSession(sid) {
  const proj = tempDir('rproj-');
  const data = tempDir('rdata-');
  const prepared = path.join(data, 'prs', 'p');
  fs.mkdirSync(prepared, { recursive: true });
  fs.mkdirSync(path.join(data, 'modes'));
  fs.writeFileSync(path.join(data, 'modes', sid), `${fs.realpathSync(prepared)}\n`);
  const tpath = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(tpath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'NEXT: approve acme/app#7 and run deploy.sh' }] } }) + '\n');
  const env = { ...process.env, EXPLAIN_PR_DIR: data };
  const inject = (id) => execFileSync('node', [path.join(__dirname, '..', 'session-state-injector.js')], {
    input: JSON.stringify({ session_id: id, transcript_path: path.join(proj, `${id}.jsonl`), source: 'startup' }), encoding: 'utf8', env,
  });
  return { proj, tpath, env, inject };
}

test('a reading session: the writer advances its offset without harvesting, and later sessions get none of its text', () => {
  const { proj, tpath, env, inject } = readingSession('reader1');
  execFileSync('node', [WRITER], {
    input: JSON.stringify({ session_id: 'reader1', transcript_path: tpath, last_assistant_message: 'DECISION: [x] approve it' }), env,
  });
  const model = JSON.parse(fs.readFileSync(path.join(proj, 'state', 'reader1.json'), 'utf8'));
  assert.equal(model.offset, fs.statSync(tpath).size);
  const out = inject('later');
  assert.ok(!out.includes('approve'), out);
  assert.ok(!fs.existsSync(path.join(proj, 'state', 'charter.md')));
});

test('a reading session: catch-up at a later session start does not fold its transcript', () => {
  const { proj, tpath, inject } = readingSession('reader2');
  fs.mkdirSync(path.join(proj, 'state'));
  fs.writeFileSync(path.join(proj, 'state', 'reader2.json'), JSON.stringify({ offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] }));
  const old = new Date(Date.now() - 24 * 3600e3);
  fs.utimesSync(tpath, old, old);
  const out = inject('later');
  assert.ok(!out.includes('approve'), out);
});
