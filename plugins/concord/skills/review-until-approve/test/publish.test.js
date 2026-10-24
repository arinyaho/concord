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

test('renderReview: a file outside the diff stays in the body, never REQUEST_CHANGES', () => {
  const r = publish.renderReview({ ...base, findings: [f('in', 'a.js', 2), f('out', 'a.js', 6), f('nofile', 'b.js', null)], approve: false }, 'inline');
  assert.equal(r.event, 'COMMENT');
  assert.equal(r.commit_id, 'abcdef1234');
  assert.deepEqual(r.threads.map((c) => c.path + c.line), ['a.js2', 'a.jsundefined']);
  assert.match(r.body.split('\n')[0], /^<!-- concord-approve: abcdef1234 round:2 base:b0 -->$/);
  assert.match(r.body, /`b\.js` \*\*correctness\*\* \(blocker\) sum nofile/);
  assert.doesNotMatch(r.body, /sum in\b/);
});

test('renderReview: the body fallback carries every finding; a clean round approves; fixed and open ids are listed', () => {
  const body = publish.renderReview({ ...base, findings: [f('in', 'a.js', 2)], approve: false }, 'body');
  assert.deepEqual(body.threads, []);
  assert.match(body.body, /sum in/);
  const clean = publish.renderReview({ ...base, findings: [], fixed: ['old:1'], stillOpen: [{ id: 'old:2', key: 'k2' }], approve: true }, 'inline');
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
  assert.equal(r.body.split('\n\n')[1], 'reviewed by [concord](https://github.com/arinyaho/concord) (codex)');
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

test('renderReview: a class label on every finding, minors listed as follow-ups only on an approving review', () => {
  const minor = { ...f('wording', 'a.js', 2), key: 'km', class: 'minor', reason: 'changes no behavior' };
  const bug = { ...f('bug', 'b.js', 6), class: 'blocker', releaseBlocking: ['serious-bug', 'security'], reason: 'breaks login' };
  const r = publish.renderReview({ ...base, findings: [minor, bug], approve: false, followUps: [minor] }, 'inline');
  assert.match(r.threads[0].body, /\(minor\)/);
  assert.match(r.threads[0].body, /changes no behavior/);
  assert.match(r.body, /\(blocker: serious-bug, security\)/);
  assert.match(r.body, /1 blocking/);
  assert.doesNotMatch(r.body, /Follow-ups/);
  const ok = publish.renderReview({ ...base, findings: [], stillOpen: [minor], approve: true, followUps: [minor] }, 'inline');
  assert.equal(ok.event, 'APPROVE');
  assert.match(ok.body, /No blocking finding is open/);
  assert.match(ok.body, /Follow-ups \(not blocking\)/);
  assert.match(ok.body, /`a\.js:2` .*sum wording.*changes no behavior.*`wording`/);
  assert.match(ok.body, /Still open: `wording` \(minor\)/);
});

test('renderReview: two open findings that share an id are told apart by key, so a blocker is never labeled minor', () => {
  const minorOne = { ...f('dup', 'a.js', 2), key: 'k-minor', class: 'minor', reason: 'wording' };
  const blockerOne = { ...f('dup', 'b.js', 3), key: 'k-blocker', class: 'blocker', reason: 'unclassified' };
  const r = publish.renderReview({ ...base, findings: [], stillOpen: [minorOne, blockerOne], followUps: [minorOne], approve: false }, 'inline');
  assert.match(r.body, /2 still open \(1 blocking\)/);
  assert.match(r.body, /Still open: `dup` \(minor\), `dup`(?! \(minor\))/);
});

test('renderReview: a hunk line is a line comment, a changed file outside the hunks a file comment, an unchanged file stays in the body', () => {
  const r = publish.renderReview({ ...base, findings: [f('in', 'a.js', 2), f('out', 'a.js', 6), f('nolinefile', 'a.js', null), f('other', 'b.js', 3)], approve: false }, 'inline');
  assert.deepEqual(r.threads.map((t) => [t.finding.id, t.subject, t.path, t.line]), [['in', 'LINE', 'a.js', 2], ['out', 'FILE', 'a.js', undefined], ['nolinefile', 'FILE', 'a.js', undefined]]);
  assert.match(r.threads[1].body, /^Line 6: /);
  assert.match(r.body, /`b\.js:3`/);
  assert.doesNotMatch(r.body, /sum out|sum in\b/);
});

test('renderReview: a rejected comment moves only its finding to the body', () => {
  const fs_ = [f('in', 'a.js', 2), f('out', 'a.js', 6)];
  const r = publish.renderReview({ ...base, findings: fs_, rejected: [fs_[1]], approve: false }, 'inline');
  assert.deepEqual(r.threads.map((t) => t.finding.id), ['in']);
  assert.match(r.body, /sum out/);
});

test('filesOf: lists a file with no added line; renderReview makes its finding a file comment', () => {
  const diff = 'diff --git a/gone.js b/gone.js\n--- a/gone.js\n+++ b/gone.js\n@@ -3,2 +2,0 @@\n-x\n-y\n';
  assert.deepEqual(publish.filesOf(diff), ['gone.js']);
  const r = publish.renderReview({ ...base, hunks: publish.hunksOf(diff), files: publish.filesOf(diff), findings: [f('d', 'gone.js', 2)], approve: false }, 'inline');
  assert.deepEqual(r.threads.map((t) => t.subject), ['FILE']);
});

test('filesOf: lists files whose entry has only a diff --git header, and never /dev/null', () => {
  const diff = [
    'diff --git a/mode.sh b/mode.sh\nold mode 100644\nnew mode 100755',
    'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js',
    'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ',
    'diff --git "a/q\\303\\251.js" "b/q\\303\\251.js"\nold mode 100644\nnew mode 100755',
    'diff --git a/del.js b/del.js\ndeleted file mode 100644\n--- a/del.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x',
  ].join('\n') + '\n';
  assert.deepEqual(publish.filesOf(diff), ['mode.sh', 'new.js', 'img.png', 'q\u00e9.js', 'del.js']);
});
