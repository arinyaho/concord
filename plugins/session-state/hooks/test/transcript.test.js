'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDelta } = require('../lib/transcript');

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-')), 't.jsonl');
  fs.writeFileSync(p, contents);
  return p;
}

test('reads all complete lines from offset 0 and advances to EOF', () => {
  const p = tmpFile('{"a":1}\n{"a":2}\n');
  const r = readDelta(p, 0);
  assert.deepEqual(r.entries.map((e) => e.a), [1, 2]);
  assert.equal(r.newOffset, fs.statSync(p).size);
});

test('reads only the delta on the second call', () => {
  const p = tmpFile('{"a":1}\n');
  const first = readDelta(p, 0);
  fs.appendFileSync(p, '{"a":2}\n');
  const second = readDelta(p, first.newOffset);
  assert.deepEqual(second.entries.map((e) => e.a), [2]);
});

test('does not consume a partial trailing line', () => {
  const p = tmpFile('{"a":1}\n{"a":2}');           // no trailing newline
  const r = readDelta(p, 0);
  assert.deepEqual(r.entries.map((e) => e.a), [1]); // only the complete line
  assert.equal(r.newOffset, 8);                     // '{"a":1}\n'
});

test('skips malformed lines', () => {
  const p = tmpFile('{"a":1}\nnot json\n{"a":3}\n');
  const r = readDelta(p, 0);
  assert.deepEqual(r.entries.map((e) => e.a), [1, 3]);
});

test('resets to 0 when the file is smaller than the offset', () => {
  const p = tmpFile('{"a":1}\n');
  const r = readDelta(p, 9999);
  assert.deepEqual(r.entries.map((e) => e.a), [1]);
});

test('missing file returns empty and keeps the offset', () => {
  const r = readDelta('/no/such/file.jsonl', 42);
  assert.deepEqual(r, { entries: [], newOffset: 42 });
});
