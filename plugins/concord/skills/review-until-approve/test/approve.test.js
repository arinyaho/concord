'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

const APPROVE = path.join(__dirname, '..', 'scripts', 'approve.js');
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

// A local remote with refs/pull/5/head, a fake gh, and a fake runner that reports FAKE_FINDINGS.
function world() {
  const dir = tempDir('rua-approve-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  sh(src, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(src, 'a.js'), 'one\nbad\nthree\n');
  sh(src, 'add', '.'); sh(src, 'commit', '-q', '-m', 'c0');
  const c0 = sh(src, 'rev-parse', 'HEAD');
  sh(src, 'checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(src, 'a.js'), 'one\nbad\nthree\nfour\n');
  sh(src, 'commit', '-q', '-am', 'c1');
  const bare = path.join(dir, 'remote', 'o', 'r.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  sh(dir, 'clone', '-q', '--bare', src, bare);
  const c1 = sh(src, 'rev-parse', 'HEAD');
  sh(bare, 'update-ref', 'refs/pull/5/head', c1);
  const state = { head: c1, baseTip: c0, mergeBase: c0, author: 'dev', state: 'OPEN', isDraft: false, title: 'T', body: 'B' };
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  write('state.json', state);
  fs.writeFileSync(path.join(dir, 'bin-gh'), '');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const j = (v) => console.log(JSON.stringify(v));
if (a[0] === 'auth') console.log('ghp_secret');
else if (a[0] === 'api' && a[1] === 'user') console.log('bot');
else if (a[0] === 'repo') console.log('WRITE');
else if (a[0] === 'pr') j({ headRefOid: s.head, baseRefOid: s.baseTip, title: s.title, body: s.body, state: s.state, isDraft: s.isDraft, author: { login: s.author } });
else if (a[0] === 'api' && /compare/.test(a[1])) console.log(s.mergeBase);
else if (a[0] === 'api' && a.includes('-X')) {
  const posts = fs.existsSync(dir + '/posts.jsonl') ? fs.readFileSync(dir + '/posts.jsonl', 'utf8').split('\\n').filter(Boolean) : [];
  fs.appendFileSync(dir + '/posts.jsonl', fs.readFileSync(0, 'utf8') + '\\n');
  j({ id: 100 + posts.length, submitted_at: new Date().toISOString() });
} else if (a[0] === 'api') j([[{ id: 7 }]]);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'runner.js'), `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runner-calls.jsonl'))}, process.argv[2] + '\\n');
const findings = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'findings.json'))}, 'utf8'));
console.log(JSON.stringify({ decision: 'review-only', round: 1, findings }));
`);
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, REVIEW_APPROVE_STATE_DIR: path.join(dir, 'ledgers'), REVIEW_APPROVE_REMOTE: path.join(dir, 'remote'), REVIEW_APPROVE_RUNNER: path.join(dir, 'runner.js') };
  const approve = (...args) => spawnSync('node', [APPROVE, ...args], { env, encoding: 'utf8' });
  const lines = (name) => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { dir, src, bare, c1, state, write, approve, posts: () => lines('posts.jsonl'), calls: () => lines('runner-calls.jsonl'), ledger: () => JSON.parse(fs.readFileSync(path.join(dir, 'ledgers', 'o__r__5__bot.json'), 'utf8')) };
}

const finding = { id: 'correctness:bad', category: 'correctness', file: 'a.js', line: 2, span: 'bad', summary: 'bad line', requirement: '' };

test('round 1 reviews broad against the merge base and publishes a COMMENT; a push that fixes it is reviewed as a diff and approved', () => {
  const w = world();
  w.write('findings.json', [finding]);
  assert.equal(JSON.parse(w.approve('start', 'o/r', '5').stdout).action, 'round');
  const r1 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r1.event, r1.mode, r1.review, r1.new], ['published', 'broad', 'COMMENT', 1]);
  assert.deepEqual([w.calls()[0].broad, w.calls()[0].base], [true, w.state.mergeBase]);
  assert.equal(w.posts()[0].event, 'COMMENT');
  assert.equal(w.posts()[0].comments[0].path, 'a.js');
  assert.equal(w.ledger().findings[0].status, 'open');
  assert.equal(w.ledger().approval, null);

  // The author fixes the line and pushes.
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\ngood\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  const c2 = sh(w.src, 'rev-parse', 'HEAD');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: c2 });
  w.write('findings.json', []);
  assert.equal(JSON.parse(w.approve('start', 'o/r', '5').stdout).action, 'round');
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.mode, r2.review, r2.fixed], ['diff', 'APPROVE', 1]);
  assert.deepEqual([w.calls()[1].broad, w.calls()[1].base], [false, w.c1]);
  assert.equal(w.posts()[1].event, 'APPROVE');
  assert.equal(w.posts()[1].commit_id, c2);
  assert.equal(w.ledger().approval.head, c2);
  assert.equal(w.ledger().findings[0].status, 'fixed');
});

test('start refuses when the reviewing account is the author', () => {
  const w = world();
  w.write('state.json', { ...w.state, author: 'bot' });
  const r = w.approve('start', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /author/);
});

test('a waived finding lets the unchanged head be approved; a returning fixed finding is published again', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('approve', 'o/r', '5').stdout).reason, 'open-findings');
  assert.equal(JSON.parse(w.approve('waive', 'o/r', '5', 'correctness:bad').stdout).event, 'approved');
  assert.equal(w.posts()[1].event, 'APPROVE');
});

test('a review containing a credential is never posted', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, summary: 'leaked ghp_secret here' }]);
  w.approve('start', 'o/r', '5');
  const r = w.approve('round', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.equal(w.posts().length, 0);
});
