'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const charter = require('../lib/charter');

function tmpStateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-'));
  return d;
}

test('north-star: writeIfAbsent creates when absent, refuses when present (CS1 guard)', () => {
  const dir = tmpStateDir();
  assert.strictEqual(charter.readNorthStar(dir), null);
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'draft framing'), true);
  assert.strictEqual(charter.readNorthStar(dir), 'draft framing');
  // second writer (parallel fresh session) must NOT clobber
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'other draft'), false);
  assert.strictEqual(charter.readNorthStar(dir), 'draft framing');
});

test('north-star: setNorthStar overwrites', () => {
  const dir = tmpStateDir();
  charter.writeNorthStarIfAbsent(dir, 'draft');
  charter.setNorthStar(dir, 'the real crystallized framing');
  assert.strictEqual(charter.readNorthStar(dir), 'the real crystallized framing');
});

test('north-star: empty/whitespace file counts as absent', () => {
  const dir = tmpStateDir();
  fs.writeFileSync(charter.charterPath(dir), '   \n');
  assert.strictEqual(charter.readNorthStar(dir), null);
  assert.strictEqual(charter.writeNorthStarIfAbsent(dir, 'framing'), true);
});

test('north-star: writes are capped at NORTH_STAR_MAX', () => {
  const dir = tmpStateDir();
  charter.setNorthStar(dir, 'x'.repeat(5000));
  assert.strictEqual(charter.readNorthStar(dir).length, 4000);
});

test('firstSubstantiveUserMessage: skips boilerplate, returns first real user message', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: '<system-reminder>hi</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: 'Base directory for this skill: /x/y' } },
    { type: 'user', message: { role: 'user', content: 'Caveat: local command output below' } },
    { type: 'user', message: { role: 'user', content: 'ok' } }, // too short
    { type: 'user', message: { role: 'user', content: 'Start the D-track charter work: preserve founding context.' } },
    { type: 'user', message: { role: 'user', content: 'a later message' } },
  ];
  assert.strictEqual(
    charter.firstSubstantiveUserMessage(entries),
    'Start the D-track charter work: preserve founding context.'
  );
});

test('firstSubstantiveUserMessage: array content, all-boilerplate returns null', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'CAVEMAN MODE ACTIVE (lite)' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'SessionStart hook fired' }] } },
  ];
  assert.strictEqual(charter.firstSubstantiveUserMessage(entries), null);
});

function writeSessionModel(dir, sid, model, mtimeMs) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sid}.json`);
  fs.writeFileSync(p, JSON.stringify(model));
  if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

test('mergeSessions: unions decisions/openLoops across sessions, newest wins per topic', () => {
  const dir = tmpStateDir();
  writeSessionModel(dir, 'sessA', { openLoops: ['loop-a'], decisions: ['[scope] old scope'], nexts: [], facts: [] }, Date.now() - 20000);
  writeSessionModel(dir, 'sessB', { openLoops: ['loop-b'], decisions: ['[scope] new scope', '[trigger] use compact'], nexts: ['ship v1'], facts: [] }, Date.now() - 10000);
  const m = charter.mergeSessions(dir);
  assert.ok(m.openLoops.includes('loop-a') && m.openLoops.includes('loop-b'));
  assert.ok(m.decisions.includes('[scope] new scope')); // newest topic wins
  assert.ok(!m.decisions.includes('[scope] old scope'));
  assert.ok(m.decisions.includes('[trigger] use compact'));
  assert.ok(m.nexts.includes('ship v1'));
});

test('mergeSessions: excludeSid and non-json files ignored', () => {
  const dir = tmpStateDir();
  writeSessionModel(dir, 'sessA', { openLoops: ['loop-a'], decisions: [], nexts: [], facts: [] });
  writeSessionModel(dir, 'sessB', { openLoops: ['loop-b'], decisions: [], nexts: [], facts: [] });
  fs.writeFileSync(path.join(dir, 'charter.md'), 'north star'); // must be skipped
  const m = charter.mergeSessions(dir, { excludeSid: 'sessB' });
  assert.ok(m.openLoops.includes('loop-a'));
  assert.ok(!m.openLoops.includes('loop-b'));
});

test('renderCharter: includes north-star and non-empty sections only', () => {
  const md = charter.renderCharter('preserve founding context', {
    openLoops: ['drift kills flat-file'],
    decisions: ['[scope] north-star + shards'],
    nexts: ['ship v1'],
    facts: [],
  });
  assert.ok(md.includes('# Task charter'));
  assert.ok(md.includes('preserve founding context'));
  assert.ok(md.includes('## Open loops'));
  assert.ok(md.includes('- drift kills flat-file'));
  assert.ok(md.includes('## Decisions'));
  assert.ok(md.includes('## Next'));
  assert.ok(!md.includes('## Recent activity')); // facts not rendered in the charter view
});

test('renderCharter: null north-star renders a placeholder line', () => {
  const md = charter.renderCharter(null, { openLoops: [], decisions: [], nexts: [], facts: [] });
  assert.ok(md.includes('# Task charter'));
  assert.ok(md.toLowerCase().includes('no north star set'));
});

test('catchUpSessions: harvests an abandoned session un-watermarked tail; idempotent', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  // abandoned session: transcript has a tagged decision past the model offset
  const sid = 'abandoned1';
  const line = (o) => JSON.stringify(o) + '\n';
  const transcript =
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'DECISION: [x] chose B over A' }] } });
  const tpath = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(tpath, transcript);
  // stale mtime so it is not treated as active
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(tpath, new Date(old), new Date(old));
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] }));

  charter.catchUpSessions(dir, { currentSid: 'other', now: Date.now() });
  const after = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.ok(after.decisions.includes('[x] chose B over A'));
  assert.ok(after.offset > 0);

  // idempotent: a second scan changes nothing
  const before2 = fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8');
  charter.catchUpSessions(dir, { currentSid: 'other', now: Date.now() });
  assert.strictEqual(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'), before2);
});

test('catchUpSessions: skips a recently-active session (race guard)', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = path.join(proj, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'live1';
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DECISION: [y] live' }] } }) + '\n');
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ offset: 0, openLoops: [], decisions: [], nexts: [], facts: [] }));
  // transcript mtime is "now" => active => skipped
  charter.catchUpSessions(dir, { currentSid: 'other', now: Date.now() });
  const after = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.strictEqual(after.decisions.length, 0);
});
