'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { prepareAnchors, applyAnchors, readCommittedSource } = require('../../core/review-anchors');

const finding = { id: 'gate:cross-context:mode', category: 'cross-context', file: 'main.go', line: null, span: 'if hesmAddr != "" { ... } else if devSecret != "" {', summary: 'The dev secret is silently ignored.', requirement: 'Pick one mode.' };
const source = 'package main\nif hesmAddr != "" {\n  serveHESM()\n} else if devSecret != "" {\n  serveDev()\n}\n';
const prepare = (findings = [finding], text = source) => prepareAnchors(findings, (file) => file === 'main.go' ? text : null);

test('only non-verbatim spans in readable committed files need extraction; literal ellipses are valid code', () => {
  const findings = [finding, { ...finding, id: 'good', span: 'serveHESM()', line: 3 }, { ...finding, file: 'missing.go' }, { ...finding, id: 'ellipsis', span: 'func(values...)', file: 'variadic.go' }];
  const request = prepareAnchors(findings, (file) => ({ 'main.go': source, 'variadic.go': 'func(values...)' })[file] ?? null);
  assert.deepEqual(request.candidates.map((item) => item.index), [0]);
  assert.match(request.prompt, /verbatim/);
  assert.match(request.prompt, /no.*ellipsis|no.*ellipses/i);
});

test('anchor extraction is capped at twenty findings', () => {
  const findings = Array.from({ length: 25 }, (_, index) => ({ ...finding, id: `finding-${index}`, span: `missing-${index}` }));
  const request = prepareAnchors(findings, () => source);
  assert.equal(request.candidates.length, 20);
  assert.deepEqual(request.candidates.map((item) => item.index), Array.from({ length: 20 }, (_, index) => index));
});

test('a unique exact correction changes only span and its derived line, never reviewer-supplied identity or semantics', () => {
  const originals = [finding];
  const before = JSON.stringify(originals);
  const result = applyAnchors(originals, prepare(), { anchors: [{ index: 0, span: 'if hesmAddr != "" {', file: '/secret', id: 'other', summary: 'changed', line: 100 }] });
  assert.deepEqual(result, [{ ...finding, span: 'if hesmAddr != "" {', line: 2 }]);
  assert.equal(JSON.stringify(originals), before);
});

test('missing, ambiguous, duplicate and unknown corrections preserve the original finding', () => {
  for (const anchors of [[], [{ index: 0, span: 'invented' }], [{ index: 0, span: 'serve' }], [{ index: 3, span: 'package main' }], [{ index: 0, span: 'package main' }, { index: 0, span: 'serveHESM()' }], [{ index: 0, span: '' }]]) {
    assert.deepEqual(applyAnchors([finding], prepare(), { anchors }), [finding]);
  }
  for (const value of [null, {}, { anchors: 'invalid' }]) assert.deepEqual(applyAnchors([finding], prepare(), value), [finding]);
});

test('an existing verbatim out-of-diff line is left unchanged even if extraction offers another location', () => {
  const good = { ...finding, line: 196, span: 'serveHESM()' };
  const request = prepare([good]);
  assert.deepEqual(request.candidates, []);
  assert.deepEqual(applyAnchors([good], request, { anchors: [{ index: 0, span: 'package main' }] }), [good]);
});

test('source snapshot, not a later changed checkout, validates the correction', () => {
  let text = source;
  const request = prepareAnchors([finding], () => text);
  text = 'invented';
  assert.deepEqual(applyAnchors([finding], request, { anchors: [{ index: 0, span: 'invented' }] }), [finding]);
  assert.equal(applyAnchors([finding], request, { anchors: [{ index: 0, span: 'package main' }] })[0].line, 1);
});

test('large correction spans are ignored', () => {
  const text = 'x'.repeat(9000);
  const request = prepare([finding], text);
  assert.deepEqual(applyAnchors([finding], request, { anchors: [{ index: 0, span: text }] }), [finding]);
});

test('committed source ignores working-tree edits and refuses symlinks and paths outside the repository', () => {
  const dir = tempDir('review-anchors-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'main.go'), source);
  git('add', 'main.go');
  // A committed symlink is enough; avoid requiring host symlink privileges.
  const link = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'main.go', encoding: 'utf8' }).trim();
  git('update-index', '--add', '--cacheinfo', `120000,${link},link.go`);
  git('commit', '-q', '-m', 'source');
  const head = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'main.go'), 'invented');
  assert.equal(readCommittedSource(dir, head, 'main.go'), source);
  for (const file of ['link.go', '../main.go', '/etc/passwd', 'missing.go', ':main.go']) assert.equal(readCommittedSource(dir, head, file), null, file);
});

test('committed source larger than one MiB is skipped', () => {
  const dir = tempDir('review-anchors-large-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'large.go'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  git('add', 'large.go');
  git('commit', '-q', '-m', 'large source');
  const head = git('rev-parse', 'HEAD');
  assert.equal(readCommittedSource(dir, head, 'large.go'), null);
});
