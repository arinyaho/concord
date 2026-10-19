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
function world(extraEnv = {}, { sub } = {}) {
  const dir = tempDir('rua-approve-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  sh(src, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(src, 'a.js'), 'one\nbad\nthree\n');
  let libShas = null;
  if (sub) {
    // A submodule `lib` served by a second local remote: commit A holds f.c = "a", commit B adds "b".
    const lib = path.join(dir, 'libsrc');
    fs.mkdirSync(lib);
    sh(lib, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lib, 'f.c'), 'a\n');
    sh(lib, 'add', '.'); sh(lib, 'commit', '-q', '-m', 'A');
    const A = sh(lib, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(lib, 'f.c'), 'a\nb\n');
    if (sub.nested) sh(lib, 'update-index', '--add', '--cacheinfo', `160000,${A},inner`);
    sh(lib, 'add', 'f.c');
    sh(lib, 'commit', '-q', '-m', 'B');
    libShas = { A, B: sh(lib, 'rev-parse', 'HEAD') };
    fs.mkdirSync(path.join(dir, 'remote', 'o'), { recursive: true });
    sh(dir, 'clone', '-q', '--bare', lib, path.join(dir, 'remote', 'o', 'lib.git'));
    fs.writeFileSync(path.join(src, '.gitmodules'), `[submodule "lib"]\n\tpath = lib\n\turl = ${sub.url || 'https://github.com/o/lib'}\n`);
    sh(src, 'add', '.gitmodules');
    sh(src, 'update-index', '--add', '--cacheinfo', `160000,${libShas.A},lib`);
  }
  sh(src, 'add', 'a.js'); sh(src, 'commit', '-q', '-m', 'c0');
  const c0 = sh(src, 'rev-parse', 'HEAD');
  sh(src, 'checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(src, 'a.js'), 'one\nbad\nthree\nfour\n');
  if (sub) sh(src, 'update-index', '--cacheinfo', `160000,${libShas.B},lib`);
  sh(src, 'add', 'a.js'); sh(src, 'commit', '-q', '-m', 'c1');
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
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), `#!${process.execPath}
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
else if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+$/.test(a[1])) {
  const known = fs.existsSync(dir + '/repos.json') ? JSON.parse(fs.readFileSync(dir + '/repos.json', 'utf8')) : {};
  const info = known[a[1].slice(6)];
  if (!info) { console.error('HTTP 404'); process.exit(1); }
  j(info);
}
else if (a[0] === 'api' && a.includes('-X')) {
  const posts = fs.existsSync(dir + '/posts.jsonl') ? fs.readFileSync(dir + '/posts.jsonl', 'utf8').split('\\n').filter(Boolean) : [];
  const body = fs.readFileSync(0, 'utf8');
  if (fs.existsSync(dir + '/fail-posts')) { console.error('GitHub unreachable'); process.exit(1); }
  fs.appendFileSync(dir + '/posts.jsonl', body + '\\n');
  const posted = JSON.parse(body);
  const reviews = fs.existsSync(dir + '/reviews.json') ? JSON.parse(fs.readFileSync(dir + '/reviews.json', 'utf8')) : [];
  reviews.push({ id: 100 + posts.length, user: { login: 'bot' }, commit_id: posted.commit_id, state: posted.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', submitted_at: new Date().toISOString() });
  fs.writeFileSync(dir + '/reviews.json', JSON.stringify(reviews));
  if (fs.existsSync(dir + '/crash-after-post')) { console.error('timeout after GitHub accepted the review'); process.exit(1); }
  j({ id: 100 + posts.length, submitted_at: new Date().toISOString() });
} else if (a[0] === 'api' && /\\/reviews$/.test(a[a.length - 1])) j([fs.existsSync(dir + '/reviews.json') ? JSON.parse(fs.readFileSync(dir + '/reviews.json', 'utf8')) : []]);
else if (a[0] === 'api' && fs.existsSync(dir + '/fail-comments')) { console.error('boom'); process.exit(1); }
else if (a[0] === 'api') j([[{ id: 7 }]]);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'runner.js'), `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runner-calls.jsonl'))}, JSON.stringify({ ...JSON.parse(process.argv[2]), diff: require('node:child_process').spawnSync('git', ['diff', JSON.parse(process.argv[2]).base, 'HEAD'], { encoding: 'utf8' }).stdout, subGit: fs.existsSync('lib/.git'), envKeys: Object.keys(process.env), home: process.env.HOME, homeEntries: fs.readdirSync(process.env.HOME), codexHome: process.env.CODEX_HOME, claudeConfig: process.env.CLAUDE_CONFIG_DIR, claudeConfigEntries: fs.existsSync(process.env.CLAUDE_CONFIG_DIR) ? fs.readdirSync(process.env.CLAUDE_CONFIG_DIR) : null, claudeCredentials: fs.existsSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json') ? fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json', 'utf8') : null, claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }) + '\\n');
const findings = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'findings.json'))}, 'utf8'));
const edit = ${JSON.stringify(path.join(dir, 'edit.json'))};
if (fs.existsSync(${JSON.stringify(path.join(dir, 'replace'))})) {
  const { execFileSync } = require('node:child_process');
  const git = (args, input) => execFileSync('git', args, { encoding: 'utf8', input, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const blob = git(['hash-object', '-w', '--stdin'], 'nothing\\n');
  const tree = git(['mktree'], '100644 blob ' + blob + '\\ta.js\\n');
  git(['replace', '-f', git(['rev-parse', 'HEAD']), git(['commit-tree', tree, '-m', 'fake'])]);
}
if (fs.existsSync(edit)) for (const [file, text] of Object.entries(JSON.parse(fs.readFileSync(edit, 'utf8')))) fs.writeFileSync(file, text);
console.log(JSON.stringify({ decision: 'review-only', round: 1, findings }));
`);
  // Both reviewers are installed and Codex is logged in; the Claude token is absent unless a test sets it. PATH names only system directories, so a codex or claude of the machine running the tests is never found.
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(dir, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'node'));
  const realClaude = path.join(dir, 'real-claude');
  fs.mkdirSync(realClaude);
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const env = { ...process.env, CLAUDECODE: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CONFIG_DIR: realClaude, CODEX_HOME: codexHome, PATH: ['/usr/bin', '/bin'].reduce((p, d) => `${p}${path.delimiter}${d}`, path.join(dir, 'bin')), REVIEW_APPROVE_STATE_DIR: path.join(dir, 'ledgers'), REVIEW_APPROVE_REMOTE: path.join(dir, 'remote'), REVIEW_APPROVE_RUNNER: path.join(dir, 'runner.js') };
  const approve = (...args) => spawnSync(process.execPath, [APPROVE, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
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

test('a waived finding lets the unchanged head be approved; the waiver is recorded and approval follows', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('approve', 'o/r', '5').stdout).reason, 'open-findings');
  assert.equal(JSON.parse(w.approve('waive', 'o/r', '5', 'correctness:bad').stdout).event, 'approved');
  assert.equal(w.posts()[1].event, 'APPROVE');
});

test('two findings with the same key in one round are recorded and posted once', () => {
  const w = world();
  w.write('findings.json', [finding, { ...finding, id: 'style:bad', category: 'style' }]);
  w.approve('start', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('round', 'o/r', '5').stdout).new, 1);
  assert.equal(w.ledger().findings.length, 1);
  assert.equal(w.posts()[0].comments.length, 1);
});

test('a review containing a credential is never posted', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, summary: 'leaked ghp_secret here' }]);
  w.approve('start', 'o/r', '5');
  const r = w.approve('round', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.equal(w.posts().length, 0);
});

test('the review process gets an allowlisted environment: no GitHub or unrelated credential reaches the untrusted checkout', () => {
  const w = world({ GH_TOKEN: 'x', GITHUB_TOKEN: 'x', NPM_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', GH_CONFIG_DIR: '/x' });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const keys = w.calls()[0].envKeys;
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GH_CONFIG_DIR']) assert.ok(!keys.includes(name), name);
  assert.ok(keys.includes('PATH') && keys.includes('CLAUDE_CONFIG_DIR'));
});

test('the ledger is saved even when the comment-id fetch after a successful post fails', () => {
  const w = world();
  w.write('findings.json', [finding]);
  fs.writeFileSync(path.join(w.dir, 'fail-comments'), '');
  w.approve('start', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('round', 'o/r', '5').stdout).event, 'published');
  assert.equal(w.posts().length, 1);
  assert.equal(w.ledger().rounds.length, 1);
  assert.equal(w.ledger().findings.length, 1);
});

test('a refused post leaves no temporary clone behind', () => {
  const tmp = tempDir('rua-tmp-');
  const w = world({ TMPDIR: tmp });
  w.write('findings.json', [{ ...finding, summary: 'leaked ghp_secret here' }]);
  w.approve('start', 'o/r', '5');
  assert.notEqual(w.approve('round', 'o/r', '5').status, 0);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('review-until-approve-')), []);
});

const UNRESTRICTED = '--allow-unrestricted-home';

test('start refuses a claude reviewer that was asked for without the opt-in flag, and names the flag', () => {
  const asked = world({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  const r = asked.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--allow-unrestricted-home/);
  assert.equal(fs.existsSync(path.join(asked.dir, 'ledgers', 'o__r__5__bot.json')), false);
  const inCodex = world({ CLAUDECODE: '' });
  inCodex.approve('start', 'o/r', '5');
  assert.equal(inCodex.ledger().provider, 'codex');
});

test('with the opt-in flag the claude reviewer runs, and start and every round print the warning that it can read the real home', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdef' });
  w.write('findings.json', []);
  const started = w.approve('start', 'o/r', '5', '--reviewer', 'claude', UNRESTRICTED, '--model', 'm');
  assert.deepEqual([w.ledger().provider, w.ledger().model], ['claude', 'm']);
  assert.match(JSON.parse(started.stdout).warning, /real home/);
  assert.match(started.stderr, /real home/);
  const round = w.approve('round', 'o/r', '5');
  assert.match(JSON.parse(round.stdout).warning, /real home/);
  assert.match(round.stderr, /real home/);
  // A later start without the flag is refused again.
  assert.notEqual(w.approve('start', 'o/r', '5').status, 0);
});

test('two open findings sharing an id are closed by their own key: the unfixed one keeps blocking approval', () => {
  const w = world();
  const a = { ...finding, id: 'correctness:x', span: 'bad', line: 2 };
  const b = { ...finding, id: 'correctness:x', span: 'three', line: 3 };
  w.write('findings.json', [a, b]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\ngood\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', [b]);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.fixed, r.stillOpen], ['COMMENT', 1, 1]);
  assert.deepEqual(w.ledger().findings.map((f) => f.status), ['fixed', 'open']);
});

test('a push that only renames the file keeps the finding open at the new path and the round is a COMMENT', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  sh(w.src, 'mv', 'a.js', 'b.js');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.fixed, r.stillOpen], ['COMMENT', 0, 1]);
  assert.deepEqual([w.ledger().findings[0].status, w.ledger().findings[0].file], ['open', 'b.js']);
});

// A push that only renames the file (and edits it when `edit` is set).
function renamePush(span, edit) {
  const w = world();
  w.write('findings.json', [{ ...finding, span }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  sh(w.src, 'mv', 'a.js', 'b.js');
  if (edit) fs.writeFileSync(path.join(w.src, 'b.js'), 'one\ngood\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  return { w, r: JSON.parse(w.approve('round', 'o/r', '5').stdout) };
}

test('a pure rename (R100) with the span still present keeps the finding open at the new path and is not approved', () => {
  const { w, r } = renamePush('bad', false);
  assert.deepEqual([r.review, r.fixed, r.stillOpen], ['COMMENT', 0, 1]);
  assert.deepEqual([w.ledger().findings[0].status, w.ledger().findings[0].file, w.ledger().findings[0].openReason], ['open', 'b.js', 'span-present']);
});

test('a pure rename (R100) does not fix a finding whose span is not verbatim: it stays open, unverified, and the round names it', () => {
  const { w, r } = renamePush('not verbatim in the file', false);
  assert.deepEqual([r.review, r.fixed, r.stillOpen], ['COMMENT', 0, 1]);
  assert.deepEqual(r.held, [{ id: 'correctness:bad', key: w.ledger().findings[0].key, file: 'a.js', reason: 'unverified' }]);
  assert.match(r.hint, /waive/);
  assert.equal(w.ledger().findings[0].status, 'open');
});

test('a rename with edits that removes the verified span fixes the finding; an unverified span does not', () => {
  const fixed = renamePush('bad', true);
  assert.deepEqual([fixed.r.fixed, fixed.r.stillOpen, fixed.r.review], [1, 0, 'APPROVE']);
  assert.equal(fixed.w.ledger().findings[0].status, 'fixed');
  const unverified = renamePush('not verbatim in the file', true);
  assert.deepEqual([unverified.r.fixed, unverified.r.stillOpen], [0, 1]);
});

test('round refuses a claude ledger that never took the opt-in', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5', '--reviewer', 'claude', UNRESTRICTED);
  const file = path.join(w.dir, 'ledgers', 'o__r__5__bot.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete ledger.unrestrictedHome;
  fs.writeFileSync(file, JSON.stringify(ledger));
  const r = w.approve('round', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--allow-unrestricted-home/);
  assert.equal(w.calls().length, 0);
});

test('a file with a special character in its name is matched by its real name', () => {
  const w = world();
  const f = { ...finding, file: 'é.js' };
  fs.writeFileSync(path.join(w.src, 'é.js'), 'one\nbad\n');
  sh(w.src, 'add', '.'); sh(w.src, 'commit', '-q', '-m', 'c1b');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', [f]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  fs.writeFileSync(path.join(w.src, 'é.js'), 'one\ngood\n');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('round', 'o/r', '5').stdout).fixed, 1);
});

test('the review process gets an empty HOME, and the real Codex home for its auth', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const call = w.calls()[0];
  assert.notEqual(call.home, process.env.HOME);
  assert.deepEqual(call.homeEntries, []);
  assert.equal(call.codexHome, path.join(w.dir, 'codex-home'));
});

test('a claude reviewer does not get the Codex home', () => {
  const w = world({ CODEX_HOME: '/real/codex', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5', '--reviewer', 'claude', UNRESTRICTED); w.approve('round', 'o/r', '5');
  assert.equal(w.calls()[0].codexHome, undefined);
});

test('the engine is told the real home and the real Claude configuration directory, whatever HOME the reviewer gets', () => {
  const w = world({ CLAUDE_CONFIG_DIR: '/real/claude' });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.deepEqual([w.calls()[0].reviewDenyRead, w.calls()[0].reviewRealHome], [['/real/claude'], require('node:os').homedir()]);
  assert.notEqual(w.calls()[0].home, w.calls()[0].reviewRealHome);
});
test('nudged records the nudge so a restarted watch does not repeat it', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const event = { event: 'nudge', kind: 'push-only', head: 'h2', replyAt: null };
  assert.equal(JSON.parse(w.approve('nudged', 'o/r', '5', JSON.stringify(event)).stdout).event, 'nudge-recorded');
  assert.deepEqual(w.ledger().nudged, { kind: 'push-only', head: 'h2', replyAt: null });
});

test('a file with a special character in its name gets its finding posted inline', () => {
  const w = world();
  fs.writeFileSync(path.join(w.src, 'é.js'), 'one\nbad\n');
  sh(w.src, 'add', '.'); sh(w.src, 'commit', '-q', '-m', 'c1b');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', [{ ...finding, file: 'é.js' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.equal(w.posts()[0].comments[0].path, 'é.js');
});

test('a file added and renamed inside the PR keeps its finding open when the range falls back to the merge base', () => {
  const w = world();
  fs.writeFileSync(path.join(w.src, 'n.js'), 'one\nbad\n');
  sh(w.src, 'add', '.'); sh(w.src, 'commit', '-q', '-m', 'c1b');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', [{ ...finding, file: 'n.js' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  sh(w.src, 'mv', 'n.js', 'm.js');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD'), title: 'T2' });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.mode, r.fixed, r.stillOpen], ['broad', 0, 1]);
  assert.deepEqual([w.ledger().findings[0].status, w.ledger().findings[0].file], ['open', 'm.js']);
});

// A push by the author: write files, commit, publish as the new PR head.
function push(w, files, message) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(w.src, name), text);
  sh(w.src, 'add', '.'); sh(w.src, 'commit', '-q', '-m', message);
  const head = sh(w.src, 'rev-parse', 'HEAD');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head });
  return head;
}

test('a push to another file does not fix a finding whose span the file does not contain verbatim, and the PR is not approved', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, span: 'text the engine paraphrased' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'b.js': 'unrelated\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.review, r2.fixed, r2.stillOpen, r2.notApproved], ['COMMENT', 0, 1, 'open-findings']);
  assert.equal(w.ledger().findings[0].status, 'open');
  assert.deepEqual(w.posts().map((p) => p.event), ['COMMENT', 'COMMENT']);
});

test('every verified finding is judged, however many there are: twenty-one fixed by one push are all fixed', () => {
  const w = world();
  push(w, { 'a.js': Array.from({ length: 21 }, (_, i) => `bad${i}`).join('\n') + '\n' }, 'c1b');
  w.write('findings.json', Array.from({ length: 21 }, (_, i) => ({ ...finding, id: `c:${i}`, span: `bad${i}` })));
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'rewritten\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.fixed, r2.stillOpen, r2.review], [21, 0, 'APPROVE']);
});

test('a finding raised again with a different span is neither listed fixed nor posted as new', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'one\nbad2\nthree\nfour\n' }, 'c2');
  w.write('findings.json', [{ ...finding, span: 'bad2' }]);
  w.approve('start', 'o/r', '5');
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.new, r2.fixed, r2.stillOpen], [0, 0, 1]);
  assert.equal(w.ledger().findings.length, 1);
});

test('a finding whose file path leaves the checkout, or runs through a symlink, is never verified, so it stays open', () => {
  const w = world();
  // The runner writes intent.md next to the clone; the span below occurs there, not in the checkout.
  w.write('findings.json', [{ ...finding, id: 'x:out', file: '../intent.md', span: '# T' }, { ...finding, id: 'x:link', file: 'link.txt', span: 'bad' }]);
  fs.symlinkSync('a.js', path.join(w.src, 'link.txt'));
  push(w, { 'a.js': 'one\nbad\nthree\nfour\n' }, 'c1b');
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  // A rewrite of the history, so the next round reviews the whole PR diff and the files count as untouched.
  sh(w.src, 'commit', '-q', '--amend', '-m', 'rewritten');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.fixed, r2.stillOpen], [0, 2]);
});

test('a mode-only push (chmod +x) fixes nothing: the span is still at the new head, verified or not, and the PR is not approved', () => {
  for (const span of ['bad', 'not verbatim in the file']) {
    const w = world();
    w.write('findings.json', [{ ...finding, span }]);
    w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
    sh(w.src, 'update-index', '--chmod=+x', 'a.js');
    sh(w.src, 'commit', '-q', '-m', 'chmod');
    sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
    w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
    w.write('findings.json', []);
    w.approve('start', 'o/r', '5');
    const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
    assert.deepEqual([r.review, r.fixed, r.stillOpen, r.notApproved], ['COMMENT', 0, 1, 'open-findings']);
    assert.equal(w.ledger().findings[0].status, 'open');
  }
});

test('a reviewer that edits the checkout during the review cannot fix a finding: the span is read from git objects', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'one\nbad\nthree\nfour\nfive\n' }, 'c2');
  w.write('findings.json', []);
  w.write('edit.json', { 'a.js': 'one\nthree\n' });
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.fixed, r.stillOpen], ['COMMENT', 0, 1]);
  assert.equal(w.ledger().findings[0].status, 'open');
});

test('a replace ref planted in the review clone does not change what the head contains', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'one\nbad\nthree\nfour\nfive\n' }, 'c2');
  w.write('findings.json', []);
  fs.writeFileSync(path.join(w.dir, 'replace'), '');
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.fixed, r.stillOpen], ['COMMENT', 0, 1]);
});

test('a finding whose engine line is missing is still posted inline, at the span in the diff', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, line: null }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.deepEqual(w.posts()[0].comments.map((c) => [c.path, c.line]), [['a.js', 2]]);
  assert.match(w.posts()[0].body.split('\n\n')[1], /^reviewed by concord \(codex\)$/);
});

test('a finding whose engine line is outside the diff stays in the body even when its span occurs inside it', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, line: 99 }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.deepEqual(w.posts()[0].comments, []);
  assert.match(w.posts()[0].body, /`a\.js:99`/);
});

test('waive refuses an id shared by two open findings, names their keys, and waives exactly the one whose key is given', () => {
  const w = world();
  fs.writeFileSync(path.join(w.src, 'b.js'), 'bad\n');
  push(w, {}, 'c1b');
  w.write('findings.json', [finding, { ...finding, file: 'b.js', line: 1 }]);
  w.approve('start', 'o/r', '5');
  const round = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.equal(round.open.length, 2);
  const refused = w.approve('waive', 'o/r', '5', 'correctness:bad');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /more than one/);
  assert.deepEqual(w.ledger().findings.map((f) => f.status), ['open', 'open']);
  const [a, b] = w.ledger().findings;
  assert.equal(JSON.parse(w.approve('waive', 'o/r', '5', a.key).stdout).event, 'not-approved');
  assert.deepEqual(w.ledger().findings.map((f) => f.status), ['waived', 'open']);
  assert.equal(JSON.parse(w.approve('waive', 'o/r', '5', b.key).stdout).event, 'approved');
});

test('a ledger finding recorded without spanVerified is unverified: it stays open until waived, and the round says how to clear it', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const file = path.join(w.dir, 'ledgers', 'o__r__5__bot.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete ledger.findings[0].spanVerified;
  fs.writeFileSync(file, JSON.stringify(ledger));
  push(w, { 'a.js': 'one\ngood\nthree\nfour\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.fixed, r.stillOpen, r.held[0].reason], [0, 1, 'unverified']);
  assert.equal(JSON.parse(w.approve('waive', 'o/r', '5', 'correctness:bad').stdout).event, 'approved');
});

test('a pure rename to a name git would read as pathspec magic (":a.js") keeps the finding open, not fixed', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  sh(w.src, 'mv', 'a.js', ':a.js');
  sh(w.src, 'commit', '-q', '-am', 'rename');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.fixed, r.stillOpen], [0, 1]);
  assert.deepEqual([w.ledger().findings[0].status, w.ledger().findings[0].file], ['open', ':a.js']);
});

test('a span that moved to another file keeps the finding open at the new path', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'one\nthree\nfour\n', 'moved.js': 'x\nbad\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.fixed, r.stillOpen], [0, 1]);
  assert.deepEqual([w.ledger().findings[0].file, w.ledger().findings[0].openReason], ['moved.js', 'span-present']);
});

test('deleting the file fixes a verified finding and leaves an unverified one open', () => {
  const w = world();
  w.write('findings.json', [finding, { ...finding, id: 'correctness:other', span: 'not verbatim in the file' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  sh(w.src, 'rm', '-q', 'a.js');
  sh(w.src, 'commit', '-q', '-m', 'delete');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.fixed, r.stillOpen], [1, 1]);
  assert.deepEqual(w.ledger().findings.map((f) => f.status), ['fixed', 'open']);
});

test('a fixed finding that the reviewer raises again with the span present reopens under the same entry', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'one\ngood\nthree\nfour\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.equal(w.ledger().findings[0].status, 'fixed');
  push(w, { 'a.js': 'one\nbad\nthree\nfour\n' }, 'c3');
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.new], ['COMMENT', 1]);
  assert.deepEqual([w.ledger().findings.length, w.ledger().findings[0].status], [1, 'open']);
});

test('a verbatim re-raise verifies an unverified finding', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, span: 'bad\n' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.equal(w.ledger().findings[0].spanVerified, w.c1);
  const file = path.join(w.dir, 'ledgers', 'o__r__5__bot.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete ledger.findings[0].spanVerified;
  fs.writeFileSync(file, JSON.stringify(ledger));
  push(w, { 'a.js': 'one\nbad\nthree\nfour\nfive\n' }, 'c2');
  w.write('findings.json', [{ ...finding, span: 'bad\n' }]);
  w.approve('start', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('round', 'o/r', '5').stdout).held, undefined);
  assert.equal(w.ledger().findings[0].spanVerified, sh(w.src, 'rev-parse', 'HEAD'));
});

test('an approval GitHub accepted but the call reported as failed is not posted a second time', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  fs.writeFileSync(path.join(w.dir, 'crash-after-post'), '');
  const r1 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.equal(r1.review, 'APPROVE');
  assert.equal(w.posts().length, 1);
  assert.equal(w.ledger().approval.head, w.c1);
  assert.equal(w.ledger().rounds.length, 1);
});

test('start after a crash between the approval post and the ledger save finds the posted review and does not review again', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  // The pending marker the round saved before posting, and the review GitHub holds for that head.
  const file = path.join(w.dir, 'ledgers', 'o__r__5__bot.json');
  const ledger = w.ledger();
  ledger.pending = { head: w.c1, after: 50, round: { n: 1, head: w.c1, base: w.state.mergeBase, mergeBase: w.state.mergeBase, intent: 'x', mode: 'broad', commentIds: [], event: 'APPROVE' } };
  fs.writeFileSync(file, JSON.stringify(ledger));
  w.write('reviews.json', [{ id: 77, user: { login: 'bot' }, commit_id: w.c1, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(JSON.parse(w.approve('start', 'o/r', '5').stdout).action, 'watch');
  assert.deepEqual([w.ledger().approval.reviewId, w.ledger().rounds.length, w.ledger().pending], [77, 1, undefined]);
  assert.equal(w.posts().length, 0);
});

test('start after a crash before GitHub accepted the approval drops the marker and reviews again', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const file = path.join(w.dir, 'ledgers', 'o__r__5__bot.json');
  const ledger = w.ledger();
  ledger.pending = { head: w.c1, after: 50, round: { n: 1 } };
  fs.writeFileSync(file, JSON.stringify(ledger));
  w.write('reviews.json', [{ id: 40, user: { login: 'bot' }, commit_id: w.c1, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(JSON.parse(w.approve('start', 'o/r', '5').stdout).action, 'round');
  assert.equal(w.ledger().pending, undefined);
});

test('an APPROVE whose post fails outright leaves the findings as they were, not marked fixed', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'a.js': 'one\ngood\nthree\nfour\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  fs.writeFileSync(path.join(w.dir, 'fail-posts'), '');
  assert.notEqual(w.approve('round', 'o/r', '5').status, 0);
  assert.deepEqual([w.ledger().findings[0].status, w.ledger().rounds.length], ['open', 1]);
  fs.rmSync(path.join(w.dir, 'fail-posts'));
  // The next start drops the marker; the round runs again and approves.
  assert.equal(JSON.parse(w.approve('start', 'o/r', '5').stdout).action, 'round');
  assert.equal(JSON.parse(w.approve('round', 'o/r', '5').stdout).review, 'APPROVE');
});

test('a comment review on the pending head is not taken for the approval', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const ledger = w.ledger();
  ledger.pending = { head: w.c1, after: 50, round: { n: 1 } };
  fs.writeFileSync(path.join(w.dir, 'ledgers', 'o__r__5__bot.json'), JSON.stringify(ledger));
  w.write('reviews.json', [{ id: 77, user: { login: 'bot' }, commit_id: w.c1, state: 'COMMENTED', submitted_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(JSON.parse(w.approve('start', 'o/r', '5').stdout).action, 'round');
  assert.equal(w.ledger().approval, null);
});

// A harness whose own reviewer is unusable still starts in one call, on the other reviewer, and says so in one line.
const startOut = (r) => JSON.parse(r.stdout);

test('under Claude Code with a login but without the opt-in, start runs on codex in one call and names the flag, not a token', () => {
  const w = world({ CLAUDECODE: '1' });
  fs.writeFileSync(path.join(w.dir, 'real-claude', '.credentials.json'), '{}');
  const r = w.approve('start', 'o/r', '5');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.ledger().provider, 'codex');
  const o = startOut(r);
  assert.equal(o.reviewer, 'codex');
  assert.match(o.note, /^reviewer: codex \(claude: pass --allow-unrestricted-home/);
  assert.equal(o.note.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(o.note.includes('\n'), false);
});

test('under Claude Code with a token but no opt-in, start still runs on codex and names the flag', () => {
  const w = world({ CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  const r = w.approve('start', 'o/r', '5');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.ledger().provider, 'codex');
  assert.equal(w.ledger().unrestrictedHome, false);
  assert.match(startOut(r).note, /--allow-unrestricted-home/);
});

test('under Claude Code with the opt-in, the harness reviewer is chosen with a token or with a login file, and no note is printed', () => {
  for (const login of ['token', 'file']) {
    const w = world({ CLAUDECODE: '1', ...(login === 'token' ? { CLAUDE_CODE_OAUTH_TOKEN: 't' } : {}) });
    if (login === 'file') fs.writeFileSync(path.join(w.dir, 'real-claude', '.credentials.json'), '{}');
    const o = startOut(w.approve('start', 'o/r', '5', UNRESTRICTED));
    assert.equal(o.reviewer, 'claude');
    assert.equal(o.note, undefined);
  }
});

test('under Claude Code with the opt-in but no Claude login, start runs on codex and names how to log in', () => {
  const w = world({ CLAUDECODE: '1' });
  const o = startOut(w.approve('start', 'o/r', '5', UNRESTRICTED));
  assert.equal(o.reviewer, 'codex');
  assert.match(o.note, /^reviewer: codex \(claude: log in with claude .*setup-token/);
  const explicit = w.approve('start', 'o/r', '5', '--reviewer', 'claude', UNRESTRICTED);
  assert.notEqual(explicit.status, 0);
  assert.match(explicit.stderr, /log in with claude/);
});

test('under Codex with codex logged out, start runs on claude only with the opt-in', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  fs.rmSync(path.join(w.dir, 'codex-home', 'auth.json'));
  const refused = w.approve('start', 'o/r', '5');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /codex: .*codex login/);
  assert.match(refused.stderr, /claude: .*--allow-unrestricted-home/);
  assert.equal(refused.stderr.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  const ok = w.approve('start', 'o/r', '5', UNRESTRICTED);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(startOut(ok).note, /^reviewer: claude \(codex: .*codex login/);
});

test('when no reviewer is usable, start exits non-zero with one line per reviewer naming what is missing, and creates no ledger', () => {
  const w = world({ CLAUDECODE: '1' });
  fs.rmSync(path.join(w.dir, 'bin', 'codex'));
  fs.rmSync(path.join(w.dir, 'bin', 'claude'));
  const r = w.approve('start', 'o/r', '5');
  assert.notEqual(r.status, 0);
  const lines = r.stderr.trim().split('\n').filter((l) => /^\s*(codex|claude):/.test(l));
  assert.equal(lines.length, 2, r.stderr);
  assert.match(lines.find((l) => /codex:/.test(l)), /install codex/);
  assert.match(lines.find((l) => /claude:/.test(l)), /install claude.*--allow-unrestricted-home/);
  assert.equal(fs.existsSync(path.join(w.dir, 'ledgers', 'o__r__5__bot.json')), false);
});

test('an explicit reviewer is never replaced: --reviewer codex with codex missing exits non-zero, and --reviewer claude without the opt-in is refused', () => {
  const w = world({ CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  fs.rmSync(path.join(w.dir, 'bin', 'codex'));
  const noCodex = w.approve('start', 'o/r', '5', '--reviewer', 'codex');
  assert.notEqual(noCodex.status, 0);
  assert.match(noCodex.stderr, /install codex/);
  const claude = w.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(claude.status, 0);
  assert.match(claude.stderr, /--allow-unrestricted-home/);
});

// The opted-in Claude reviewer authenticates as the user: the token when set, else the real credentials file copied into the reviewer's own config directory, else the real configuration.
const loginWorld = (extra, files) => {
  const real = tempDir('rua-real-claude-');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(real, name), text);
  const w = world({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: real, ...extra });
  w.write('findings.json', []);
  const started = w.approve('start', 'o/r', '5', UNRESTRICTED);
  assert.equal(started.status, 0, started.stderr);
  const round = w.approve('round', 'o/r', '5');
  assert.equal(round.status, 0, round.stderr);
  return { real, call: w.calls()[0] };
};

test('with the opt-in and no token, the Claude reviewer gets only the credentials file of the real configuration, in its own config directory', () => {
  const { real, call } = loginWorld({}, { '.credentials.json': '{"login":"user"}', 'settings.json': '{"hooks":{}}' });
  assert.notEqual(call.claudeConfig, real);
  assert.deepEqual(call.claudeConfigEntries, ['.credentials.json']);
  assert.equal(call.claudeCredentials, '{"login":"user"}');
  assert.equal(call.claudeToken, undefined);
});

test('with the opt-in and a token, the Claude reviewer gets the token and no copied credentials file', () => {
  const { call } = loginWorld({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { '.credentials.json': '{"login":"user"}' });
  assert.equal(call.claudeToken, 'tok');
  assert.deepEqual(call.claudeConfigEntries, []);
});

test('round refuses a claude ledger whose login has gone, naming how to log in, and starts no reviewer', () => {
  const env = { CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't' };
  const w = world(env);
  w.write('findings.json', []);
  assert.equal(w.approve('start', 'o/r', '5', UNRESTRICTED).status, 0);
  env.CLAUDE_CODE_OAUTH_TOKEN = '';
  const again = w.approve('round', 'o/r', '5');
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /log in with claude/);
  assert.equal(w.calls().length, 0);
});

test('a review that quotes the access or refresh token from the credentials file is never posted', () => {
  const access = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa';
  const refresh = 'sk-ant-ort01-bbbbbbbbbbbbbbbbbbbbbbbb';
  for (const leaked of [access, refresh]) {
    const real = tempDir('rua-real-claude-');
    fs.writeFileSync(path.join(real, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 1 } }));
    const w = world({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: real });
    w.write('findings.json', [{ ...finding, summary: `quoted ${leaked} here` }]);
    assert.equal(w.approve('start', 'o/r', '5', UNRESTRICTED).status, 0);
    const r = w.approve('round', 'o/r', '5');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /holds a credential/);
    assert.equal(w.posts().length, 0);
  }
});

test('a repaired multiline span crossing into a diff hunk is published at the first overlapping line', () => {
  const { prepareAnchors, applyAnchors } = require('../../../core/review-anchors');
  const w = world();
  const rows = Array.from({ length: 30 }, (_, index) => `context ${index + 1}`);
  const base = push(w, { 'a.js': rows.join('\n') + '\n' }, 'long base');
  w.state.baseTip = base;
  w.state.mergeBase = base;
  rows[19] = 'changed line';
  const text = rows.join('\n') + '\n';
  push(w, { 'a.js': text }, 'change');
  const original = { ...finding, span: 'context 10 ... changed line', line: null };
  const request = prepareAnchors([original], () => text);
  const corrected = applyAnchors([original], request, { anchors: [{ index: 0, span: rows.slice(9, 21).join('\n') }] });
  w.write('findings.json', corrected);
  assert.equal(w.approve('start', 'o/r', '5').status, 0);
  const round = w.approve('round', 'o/r', '5');
  assert.equal(round.status, 0, round.stderr);
  assert.deepEqual(w.posts()[0].comments.map((comment) => comment.line), [17]);
  assert.equal(w.ledger().findings[0].spanVerified, sh(w.src, 'rev-parse', 'HEAD'));
});
// A pull request that bumps a submodule is reviewed on the submodule's own diff.
const libInfo = (w, lib) => w.write('repos.json', { 'o/r': { private: false }, 'o/lib': lib });

test('a submodule bump is reviewed on the submodule diff: the reviewer sees lib/f.c, not a pointer line', () => {
  const w = world({}, { sub: {} });
  libInfo(w, { private: false });
  w.write('findings.json', []);
  JSON.parse(w.approve('start', 'o/r', '5').stdout);
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.match(w.calls()[0].diff, /\+\+\+ b\/lib\/f\.c/);
  assert.match(w.calls()[0].diff, /\+b\n/);
  assert.deepEqual([r.review, r.notApproved], ['APPROVE', undefined]);
});

const startRound = (w) => { w.approve('start', 'o/r', '5'); return JSON.parse(w.approve('round', 'o/r', '5').stdout); };

test('a repaired root finding is inline while a submodule finding stays in the body', () => {
  const { prepareAnchors, applyAnchors, readCommittedSource } = require('../../../core/review-anchors');
  const w = world({}, { sub: {} });
  libInfo(w, { private: false });
  const head = sh(w.src, 'rev-parse', 'HEAD');
  const findings = [
    { id: 'correctness:root', category: 'correctness', file: 'a.js', line: null, span: 'one ... bad', summary: 'bad root line', requirement: '' },
    { id: 'correctness:b', category: 'correctness', file: 'lib/f.c', line: 2, span: 'b', summary: 'bad submodule line', requirement: '' },
  ];
  const request = prepareAnchors(findings, file => readCommittedSource(w.src, head, file));
  assert.deepEqual(request.candidates.map(({ index }) => index), [0]);
  w.write('findings.json', applyAnchors(findings, request, { anchors: [{ index: 0, span: 'bad' }] }));

  const result = startRound(w);
  assert.equal(result.review, 'COMMENT');
  assert.deepEqual(w.posts()[0].comments.map(({ path, line }) => [path, line]), [['a.js', 2]]);
  assert.match(w.posts()[0].body, /`lib\/f\.c:2`/);
  assert.deepEqual(w.ledger().findings.map(({ spanVerified }) => spanVerified), [head, head]);
});

test('a finding inside the submodule lands in the review body, is verified, and is fixed by a bump that drops the span', () => {
  const w = world({}, { sub: {} });
  libInfo(w, { private: false });
  w.write('findings.json', [{ id: 'correctness:b', category: 'correctness', file: 'lib/f.c', line: 2, span: 'b', summary: 'bad b', requirement: '' }]);
  const r1 = startRound(w);
  assert.equal(r1.review, 'COMMENT');
  assert.deepEqual(w.posts()[0].comments, []);
  assert.match(w.posts()[0].body, /`lib\/f\.c:2`/);
  assert.equal(w.ledger().findings[0].status, 'open');
  assert.equal(w.ledger().findings[0].openReason, undefined);

  // The submodule moves to a commit without the span.
  const lib = path.join(w.dir, 'libsrc');
  fs.writeFileSync(path.join(lib, 'f.c'), 'a\n');
  sh(lib, 'commit', '-q', '-am', 'C');
  sh(lib, 'push', '-q', path.join(w.dir, 'remote', 'o', 'lib.git'), 'HEAD:refs/heads/main');
  sh(w.src, 'update-index', '--cacheinfo', `160000,${sh(lib, 'rev-parse', 'HEAD')},lib`);
  sh(w.src, 'commit', '-q', '-m', 'c2');
  const c2 = sh(w.src, 'rev-parse', 'HEAD');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: c2 });
  w.write('findings.json', []);
  const r2 = startRound(w);
  assert.deepEqual([r2.review, r2.fixed], ['APPROVE', 1]);
});

test('a submodule the account cannot read is reported as not reviewed, and the round does not approve, now or on a later push', () => {
  const w = world({}, { sub: {} });
  w.write('repos.json', { 'o/r': { private: false } });
  w.write('findings.json', []);
  const r1 = startRound(w);
  assert.equal(r1.review, 'COMMENT');
  assert.equal(r1.notApproved, 'unreviewed-submodule');
  assert.equal(r1.unreviewed[0].path, 'lib');
  assert.equal(r1.unreviewed[0].reason, 'unreadable');
  assert.match(w.posts()[0].body, /Not reviewed, so this review does not approve: submodule `lib` [0-9a-f]{7}\.\.[0-9a-f]{7} \(unreadable\)/);
  assert.deepEqual(JSON.parse(w.approve('approve', 'o/r', '5').stdout), { event: 'not-approved', reason: 'unreviewed-submodule' });

  // A push that leaves the submodule alone reviews the whole pull request again and still does not approve.
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\nbad\nthree\nfour\nfive\n');
  sh(w.src, 'add', 'a.js'); sh(w.src, 'commit', '-q', '-m', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  const r2 = startRound(w);
  assert.equal(w.calls()[1].base, w.state.mergeBase);
  assert.deepEqual([r2.review, r2.notApproved], ['COMMENT', 'unreviewed-submodule']);
});

test('a .gitmodules url that is not a GitHub repository is never fetched: the range is unreviewed with reason url', () => {
  for (const url of ['file://__DIR__/remote/o/lib.git', 'ext::sh -c touch% __DIR__/pwned', '../../../../etc', 'https://github.com.evil.com/o/lib', 'https://github.com/o/../lib', '--upload-pack=touch __DIR__/pwned', '__DIR__/remote/o/lib.git']) {
    const w = world({}, { sub: { url: 'placeholder' } });
    const real = url.replaceAll('__DIR__', w.dir);
    fs.writeFileSync(path.join(w.src, '.gitmodules'), `[submodule "lib"]\n\tpath = lib\n\turl = ${real}\n`);
    sh(w.src, 'add', '.gitmodules'); sh(w.src, 'commit', '-q', '-m', 'urls');
    sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
    w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
    libInfo(w, { private: false });
    w.write('findings.json', []);
    const r = startRound(w);
    assert.equal(r.unreviewed?.[0]?.reason, 'url', url);
    assert.equal(w.calls()[0].subGit, false, url);
    assert.equal(fs.existsSync(path.join(w.dir, 'pwned')), false, url);
  }
});

test('a private submodule is reviewed only when it is the pull request repository itself: same owner, even a private pull request, is not the same readers', () => {
  for (const repos of [{ 'o/r': { private: false }, 'o/lib': { private: true, full_name: 'o/lib' } }, { 'o/r': { private: true }, 'o/lib': { private: true, full_name: 'o/lib' } }, { 'o/r': { private: true }, 'o/lib': { private: true, full_name: 'o/renamed' } }]) {
    const w = world({}, { sub: {} });
    w.write('repos.json', repos);
    w.write('findings.json', []);
    assert.equal(startRound(w).unreviewed[0].reason, 'audience');
    assert.equal(w.calls()[0].subGit, false);
  }
  const same = world({}, { sub: { url: 'https://github.com/o/r' } });
  same.write('repos.json', { 'o/r': { private: true, full_name: 'o/r' } });
  same.write('findings.json', []);
  // The submodule is the pull request repository: it is fetched (here the fixture remote lacks the commit), not refused as audience.
  assert.equal(startRound(same).unreviewed[0].reason, 'fetch');
});

test('a submodule the pull request adds is checked for nested submodules too', () => {
  const w = world({}, { sub: { nested: true } });
  libInfo(w, { private: false });
  fs.appendFileSync(path.join(w.src, '.gitmodules'), '[submodule "lib2"]\n\tpath = lib2\n\turl = https://github.com/o/lib\n');
  sh(w.src, 'add', '.gitmodules');
  sh(w.src, 'update-index', '--add', '--cacheinfo', `160000,${sh(path.join(w.dir, 'libsrc'), 'rev-parse', 'HEAD')},lib2`);
  sh(w.src, 'commit', '-q', '-m', 'add lib2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  const r = startRound(w);
  assert.deepEqual(r.unreviewed.filter((u) => u.path === 'lib2').map((u) => u.reason), ['nested']);
  assert.equal(r.notApproved, 'unreviewed-submodule');
});

test('a removed submodule needs nothing fetched and does not block approval', () => {
  const w = world({}, { sub: {} });
  sh(w.src, 'rm', '-q', '--cached', 'lib');
  sh(w.src, 'commit', '-q', '-m', 'drop lib');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  const r = startRound(w);
  assert.deepEqual([r.review, r.unreviewed], ['APPROVE', undefined]);
});
