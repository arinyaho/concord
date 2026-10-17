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

test('hunksOf: an added line that looks like a file header does not change the file', () => {
  const diff = DIFF + '@@ -20,0 +30,1 @@\n+++ b/evil.js\n@@ -40,0 +50,1 @@\n+x\n';
  assert.deepEqual(publish.hunksOf(diff).slice(-1), [{ file: 'a.js', from: 50, to: 50 }]);
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

test('hunksOf: a path with spaces and non-ASCII characters keeps its real name', () => {
  const diff = 'diff --git a/dir name/é.js b/dir name/é.js\n--- a/dir name/é.js\t\n+++ b/dir name/é.js\t\n@@ -1,0 +1,1 @@\n+x\n';
  assert.deepEqual(publish.hunksOf(diff), [{ file: 'dir name/é.js', from: 1, to: 1 }]);
});

test('hunksOf: a git-quoted header names its real file and an unparseable one never inherits the previous file', () => {
  const quoted = 'diff --git "a/d\\303\\251 \\"q\\".js" "b/d\\303\\251 \\"q\\".js"\n--- "a/d\\303\\251 \\"q\\".js"\n+++ "b/d\\303\\251 \\"q\\".js"\n@@ -1,0 +1,1 @@\n+x\n';
  assert.deepEqual(publish.hunksOf(quoted), [{ file: 'dé "q".js', from: 1, to: 1 }]);
  const bad = 'diff --git a/a.js b/a.js\n+++ b/a.js\n@@ -1,0 +1,1 @@\n+x\ndiff --git x y\n+++ "weird\n@@ -1,0 +5,1 @@\n+y\n';
  assert.deepEqual(publish.hunksOf(bad), [{ file: 'a.js', from: 1, to: 1 }]);
});

test('renderReview: LGTM only on an approving review; a clean round that does not approve says approval is withheld', () => {
  const round = { head: 'h', round: 1, rangeBase: 'b', reviewer: 'bot', hunks: [], findings: [], fixed: [], stillOpen: [], previousHead: 'h' };
  assert.match(publish.renderReview({ ...round, approve: true }, 'body').body, /LGTM/);
  const held = publish.renderReview({ ...round, approve: false }, 'body');
  assert.equal(held.event, 'COMMENT');
  assert.doesNotMatch(held.body, /LGTM/);
});

const hunks = [{ file: 'a.js', from: 5, to: 8 }];

test('placeLine: a span repeated in the file is placed at the occurrence inside a hunk', () => {
  const text = 'x\nbad\nx\nx\nbad\nx\nx\nx\n';
  assert.equal(publish.placeLine(text, 'bad', 'a.js', hunks), 5);
});

test('placeLine: a multi-line span is placed at its first line inside a hunk; one outside every hunk gets no line', () => {
  const text = 'a\nb\nc\nd\ne\nfoo(\n  1)\ng\nh\n';
  assert.equal(publish.placeLine(text, 'foo(\n  1)', 'a.js', hunks), 6);
  assert.equal(publish.placeLine(text, 'a', 'a.js', hunks), null);
  assert.equal(publish.placeLine(text, 'missing', 'a.js', hunks), null);
  assert.equal(publish.placeLine(text, 'foo(', 'b.js', hunks), null);
});

test('renderReview: the header signs the review as concord and names the engine', () => {
  const r = publish.renderReview({ ...base, reviewer: 'codex', findings: [], approve: false }, 'inline');
  assert.equal(r.body.split('\n\n')[1], 'reviewed by concord (codex)');
});

test('placeLine: a trailing or leading newline in the span does not move the line', () => {
  assert.equal(publish.placeLine('x\nbad\nok\n', 'bad\n', 'a.js', [{ file: 'a.js', from: 3, to: 3 }]), null);
  assert.equal(publish.placeLine('x\nbad\nok\n', '\nbad', 'a.js', [{ file: 'a.js', from: 1, to: 1 }]), null);
  assert.equal(publish.placeLine('x\nbad\nok\n', 'bad\n', 'a.js', [{ file: 'a.js', from: 2, to: 2 }]), 2);
});

test('placeLine: a common span in a large file outside every hunk returns quickly', () => {
  const t = Date.now();
  assert.equal(publish.placeLine('}\n'.repeat(200000), '}', 'a.js', [{ file: 'a.js', from: 999999, to: 999999 }]), null);
  assert.ok(Date.now() - t < 2000);
});
