'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const publish = require('../scripts/publish');

const DIFF = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,2 +1,3 @@
 one
+two
 three
@@ -10,0 +12,2 @@
+x
+y
`;

test('hunksOf: lists the new-side line ranges per file', () => {
  assert.deepEqual(publish.hunksOf(DIFF), [{ file: 'a.js', from: 1, to: 3 }, { file: 'a.js', from: 12, to: 13 }]);
});

const f = (id, file, line, extra = {}) => ({ id, category: 'correctness', file, line, span: 's', summary: `sum ${id}`, requirement: '', ...extra });
const base = { head: 'abcdef1234', round: 2, rangeBase: 'b0', reviewer: 'codex', hunks: publish.hunksOf(DIFF), fixed: [], stillOpen: [], previousHead: '1111111222' };

test('renderReview: inline only inside a hunk, the rest in the body, never REQUEST_CHANGES', () => {
  const r = publish.renderReview({ ...base, findings: [f('in', 'a.js', 2), f('out', 'a.js', 6), f('nofile', 'b.js', null)], approve: false }, 'inline');
  assert.equal(r.event, 'COMMENT');
  assert.equal(r.commit_id, 'abcdef1234');
  assert.deepEqual(r.comments.map((c) => c.path + c.line), ['a.js2']);
  assert.match(r.body.split('\n')[0], /^<!-- concord-approve: abcdef1234 round:2 base:b0 -->$/);
  assert.match(r.body, /`a\.js:6` \*\*correctness\*\* sum out/);
  assert.match(r.body, /`b\.js` \*\*correctness\*\* sum nofile/);
  assert.doesNotMatch(r.body, /sum in\b/);
});

test('renderReview: the body fallback carries every finding; a clean round approves; fixed and open ids are listed', () => {
  const body = publish.renderReview({ ...base, findings: [f('in', 'a.js', 2)], approve: false }, 'body');
  assert.deepEqual(body.comments, []);
  assert.match(body.body, /sum in/);
  const clean = publish.renderReview({ ...base, findings: [], fixed: ['old:1'], stillOpen: ['old:2'], approve: true }, 'inline');
  assert.equal(clean.event, 'APPROVE');
  assert.match(clean.body, /Fixed since `1111111`: `old:1`/);
  assert.match(clean.body, /Still open: `old:2`/);
});

test('containsSecret: refuses text holding a credential', () => {
  assert.equal(publish.containsSecret('xx tok123 yy', ['tok123']), true);
  assert.equal(publish.containsSecret('clean', ['tok123', '']), false);
});
