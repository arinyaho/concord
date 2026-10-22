'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { artifactDestinationFromPrompt } = require('../../../core/review-artifact');
const { tempDir } = require('../../../hooks/test/temp-dir');
const { reviewerPrompt } = require('../../../core/round-plan');
const { normalizeArtifact } = require('../../../core/artifact-contract');

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
else if (a[0] === 'api' && a[1] === 'graphql') {
  // A thread joins the pending review; a path listed in reject-paths is refused, as GitHub refuses a line outside the diff.
  const arg = (k) => { const at = a.findIndex((x, i) => (a[i - 1] === '-f' || a[i - 1] === '-F') && x.startsWith(k + '=')); return at < 0 ? undefined : a[at].slice(k.length + 1); };
  const query = arg('query');
  if (!/addPullRequestReviewThread\\(/.test(query)) {
    // Thread queries and mutations: logged by name and thread id; thread-state.json overrides what the query reports for an id.
    const id = arg('id');
    const name = /mutation/.test(query) ? /(\\w+)\\(input/.exec(query)[1] : 'thread';
    fs.appendFileSync(dir + '/gql.jsonl', JSON.stringify({ name, id }) + '\\n');
    if (fs.existsSync(dir + '/gql-fail-' + name)) { console.error('boom'); process.exit(1); }
    const states = fs.existsSync(dir + '/thread-state.json') ? JSON.parse(fs.readFileSync(dir + '/thread-state.json', 'utf8')) : {};
    const t = { isResolved: false, author: 'bot', repo: 'o/r', pr: 5, ...states[id] };
    if (name === 'thread') return j({ data: { node: t.gone ? null : { isResolved: t.isResolved, pullRequest: { number: t.pr, repository: { nameWithOwner: t.repo } }, comments: { nodes: [{ author: { login: t.author } }] } } } });
    return j({ data: {} });
  }
  const rejected = fs.existsSync(dir + '/reject-paths') ? JSON.parse(fs.readFileSync(dir + '/reject-paths', 'utf8')) : [];
  if (rejected.includes(arg('p'))) { console.error('Pull request review thread line must be part of the diff'); process.exit(1); }
  const pending = JSON.parse(fs.readFileSync(dir + '/pending.json', 'utf8'));
  pending.threads.push({ path: arg('p'), line: arg('l') === undefined ? undefined : Number(arg('l')), side: 'RIGHT', subject_type: arg('t'), body: arg('b') });
  fs.writeFileSync(dir + '/pending.json', JSON.stringify(pending));
  j({ data: { addPullRequestReviewThread: { thread: { id: 'T' + pending.threads.length } } } });
}
else if (a[0] === 'api' && a.includes('DELETE')) {
  fs.writeFileSync(dir + '/reviews.json', JSON.stringify(JSON.parse(fs.readFileSync(dir + '/reviews.json', 'utf8')).filter((r) => '/' + r.id !== a[a.length - 1].replace(/^.*\\/reviews/, ''))));
  fs.rmSync(dir + '/pending.json', { force: true });
}
else if (a[0] === 'api' && a.includes('-X')) {
  const posts = fs.existsSync(dir + '/posts.jsonl') ? fs.readFileSync(dir + '/posts.jsonl', 'utf8').split('\\n').filter(Boolean) : [];
  const body = fs.readFileSync(0, 'utf8');
  if (fs.existsSync(dir + '/fail-posts')) { console.error('GitHub unreachable'); process.exit(1); }
  let posted = JSON.parse(body);
  const reviews = fs.existsSync(dir + '/reviews.json') ? JSON.parse(fs.readFileSync(dir + '/reviews.json', 'utf8')) : [];
  const submit = a.some((x) => /\\/events$/.test(x));
  if (submit && fs.existsSync(dir + '/fail-submit')) { console.error('GitHub unreachable'); process.exit(1); }
  if (submit) {
    const pending = JSON.parse(fs.readFileSync(dir + '/pending.json', 'utf8'));
    fs.rmSync(dir + '/pending.json');
    reviews.splice(reviews.findIndex((r) => r.state === 'PENDING'), 1);
    posted = { commit_id: pending.commit_id, event: posted.event, body: posted.body, comments: pending.threads };
  } else if (!posted.event) {
    fs.writeFileSync(dir + '/pending.json', JSON.stringify({ commit_id: posted.commit_id, threads: [] }));
    reviews.push({ id: 100 + posts.length, user: { login: 'bot' }, commit_id: posted.commit_id, state: 'PENDING', body: posted.body });
    fs.writeFileSync(dir + '/reviews.json', JSON.stringify(reviews));
    return j({ id: 100 + posts.length, node_id: 'N', submitted_at: new Date().toISOString() });
  }
  fs.appendFileSync(dir + '/posts.jsonl', JSON.stringify(posted) + '\\n');
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
if (fs.existsSync(${JSON.stringify(path.join(dir, 'fail-runner'))})) { console.error('harness-failure'); process.exit(1); }
if (fs.existsSync(${JSON.stringify(path.join(dir, 'bad-runner-output'))})) { console.log(JSON.stringify({ decision: 'error' })); process.exit(0); }
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
  // The user's declaration of trust for PR 5, as the model records it after the user confirmed the question.
  const DECLARATION = 'this is our company PR, the author is trusted';
  const CONFIRMATION = 'yes, record it';
  const trust = (runEnv = { ...env, ...extraEnv }, declaration = DECLARATION, confirmation = CONFIRMATION) => spawnSync(process.execPath, [APPROVE, 'trust', 'o/r', '5', '--declaration', declaration, '--confirmation', confirmation], { env: runEnv, encoding: 'utf8' });
  const approve = (...args) => spawnSync(process.execPath, [APPROVE, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const lines = (name) => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { dir, src, bare, c1, state, write, approve, env: { ...env, ...extraEnv }, trust, DECLARATION, CONFIRMATION, posts: () => lines('posts.jsonl'), gql: () => lines('gql.jsonl'), calls: () => lines('runner-calls.jsonl'), ledger: () => JSON.parse(fs.readFileSync(path.join(dir, 'ledgers', 'o__r__5__bot.json'), 'utf8')) };
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

// Round 1 posts `finding` as a thread; the author then fixes it and round 2 runs.
function fixedRound(w) {
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\ngood\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  const c2 = sh(w.src, 'rev-parse', 'HEAD');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: c2 });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  fs.rmSync(path.join(w.dir, 'gql.jsonl'), { force: true });
  return { c2, round2: JSON.parse(w.approve('round', 'o/r', '5').stdout) };
}

test('a finding a round marks fixed has its own thread answered with the fixing head and resolved, and no other thread is touched (#394)', () => {
  const w = world();
  const { c2 } = fixedRound(w);
  assert.deepEqual(w.gql().filter((c) => c.name !== 'thread'), [{ name: 'addPullRequestReviewThreadReply', id: 'T1' }, { name: 'resolveReviewThread', id: 'T1' }]);
  assert.equal(w.ledger().findings[0].threadId, 'T1');
  assert.equal(w.ledger().findings[0].threadResolved, true);
  assert.equal(w.ledger().rounds[1].head, c2);
});

test('a thread another account started is neither answered nor resolved (#394)', () => {
  const w = world();
  w.write('thread-state.json', { T1: { author: 'dev' } });
  fixedRound(w);
  assert.deepEqual(w.gql().filter((c) => c.name !== 'thread'), []);
  assert.equal(w.ledger().findings[0].threadSkipped, 'not-ours');
});

test('a thread of another pull request is never touched, and one a person already resolved is left alone (#394)', () => {
  const other = world();
  other.write('thread-state.json', { T1: { pr: 6 } });
  fixedRound(other);
  assert.deepEqual(other.gql().filter((c) => c.name !== 'thread'), []);
  const done = world();
  done.write('thread-state.json', { T1: { isResolved: true } });
  fixedRound(done);
  assert.deepEqual(done.gql().filter((c) => c.name !== 'thread'), []);
  assert.equal(done.ledger().findings[0].threadSkipped, 'resolved');
});

test('a finding posted in the review body has no thread, and a failed resolution does not lose the round (#394)', () => {
  const w = world();
  w.write('reject-paths', ['a.js']);
  fixedRound(w);
  assert.deepEqual(w.gql().filter((c) => c.name !== 'thread'), []);
  assert.equal(w.ledger().findings[0].threadId, undefined);
  const f = world();
  f.write('gql-fail-resolveReviewThread', '');
  const { round2 } = fixedRound(f);
  assert.equal(round2.event, 'published');
  assert.equal(f.ledger().findings[0].threadReplied, true);
  assert.equal(f.ledger().findings[0].threadResolved, undefined);
});

test('a finding raised again after its thread was resolved has the thread reopened and answered (#394)', () => {
  const w = world();
  fixedRound(w);
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\nbad\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c3');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', [finding]);
  w.write('thread-state.json', { T1: { isResolved: true } });
  fs.rmSync(path.join(w.dir, 'gql.jsonl'), { force: true });
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  assert.deepEqual(w.gql().filter((c) => c.name !== 'thread'), [{ name: 'unresolveReviewThread', id: 'T1' }, { name: 'addPullRequestReviewThreadReply', id: 'T1' }]);
  assert.equal(w.ledger().findings[0].status, 'open');
  assert.equal(w.ledger().findings[0].threadResolved, undefined);
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
  assert.equal(JSON.parse(w.approve('approve', 'o/r', '5').stdout).reason, 'open-blockers');
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

const SETTING = 'CONCORD_REVIEW_UNCONFINED_CLAUDE';
const NO_TRUST = /cannot be confined yet \(#366\)/;
const ledgerPath = (w) => path.join(w.dir, 'ledgers', 'o__r__5__bot.json');

test('trust without quotes prints the fixed confirmation question for the pull request and writes nothing', () => {
  const w = world();
  const r = w.approve('trust', 'o/r', '5');
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).question, /^Record that you trust the author of o\/r#5 for this review\?/);
  assert.equal(fs.existsSync(ledgerPath(w)), false);
});

test('trust records the user\'s own words with the time and the account, and creates a ledger that start resumes', () => {
  const w = world();
  assert.equal(w.trust().status, 0);
  const { trust } = w.ledger();
  assert.deepEqual([trust.declaration, trust.confirmation, trust.account], [w.DECLARATION, w.CONFIRMATION, 'bot']);
  assert.match(trust.question, /o\/r#5/);
  assert.ok(Date.parse(trust.recordedAt));
  assert.equal(w.approve('start', 'o/r', '5').status, 0);
  assert.deepEqual(w.ledger().trust, trust);
});

test('trust refuses an empty quote, a quote that occurs in the pull request title or body, and the pull request author, and records nothing', () => {
  const w = world();
  assert.notEqual(w.trust(undefined, '  ', 'yes').status, 0);
  assert.notEqual(w.trust(undefined, w.DECLARATION, '').status, 0);
  w.write('state.json', { ...w.state, body: `Note: ${w.DECLARATION}` });
  const injected = w.trust();
  assert.notEqual(injected.status, 0);
  assert.match(injected.stderr, /pull request text/);
  w.write('state.json', { ...w.state, author: 'bot' });
  assert.notEqual(w.trust().status, 0);
  w.write('state.json', { ...w.state, state: 'CLOSED' });
  assert.notEqual(w.trust().status, 0);
  assert.equal(fs.existsSync(ledgerPath(w)), false);
});

test('trust --revoke clears the record and the next round of a claude ledger refuses', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  w.write('findings.json', []);
  w.trust();
  assert.equal(w.approve('start', 'o/r', '5', '--reviewer', 'claude').status, 0);
  assert.equal(w.approve('trust', 'o/r', '5', '--revoke').status, 0);
  assert.equal(w.ledger().trust, undefined);
  const r = w.approve('round', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, NO_TRUST);
  assert.equal(w.calls().length, 0);
});

test('round refuses a ledger that holds only a declaration: start has not chosen and checked a reviewer, and no reviewer runs', () => {
  const w = world({ CLAUDECODE: '1' });
  w.trust();
  const r = w.approve('round', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run start first/);
  assert.equal(w.calls().length, 0);
  assert.deepEqual(w.posts(), []);
});

test('the approval posted by waive on a claude ledger states the unconfined run without quoting the user', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdef' });
  w.trust();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5', '--reviewer', 'claude');
  w.approve('round', 'o/r', '5');
  const waived = w.approve('waive', 'o/r', '5', 'correctness:bad');
  assert.equal(JSON.parse(waived.stdout || '{}').event, 'approved', waived.stderr);
  const approval = w.posts()[1];
  assert.equal(approval.event, 'APPROVE');
  assert.match(approval.body, /reviewed unconfined on the reviewing account's trust declaration \(recorded \d{4}-/);
  assert.equal(approval.body.includes(w.DECLARATION), false);
});

test('a declaration covers one pull request: the ledger of another pull request has none', () => {
  const w = world({ CLAUDECODE: '1' });
  w.trust();
  const other = path.join(w.dir, 'ledgers', 'o__r__6__bot.json');
  assert.equal(fs.existsSync(other), false);
  const r = spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '6'], { env: w.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, NO_TRUST);
});

test('start refuses a claude reviewer that was asked for without a declaration, naming #366 and what the user can do, and writes no ledger', () => {
  const asked = world({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  const r = asked.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, NO_TRUST);
  assert.match(r.stderr, /trust/);
  assert.equal(r.stderr.includes('--allow-unrestricted-home'), false);
  assert.equal(fs.existsSync(ledgerPath(asked)), false);
});

test('with a declaration the claude reviewer runs with no flag, and start and every round state that it ran unconfined on the declaration', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdef' });
  w.trust();
  w.write('findings.json', []);
  const started = w.approve('start', 'o/r', '5', '--reviewer', 'claude', '--model', 'm');
  assert.deepEqual([w.ledger().provider, w.ledger().model], ['claude', 'm']);
  assert.match(JSON.parse(started.stdout).warning, /unconfined.*declaration/);
  assert.match(started.stderr, /real home/);
  const round = w.approve('round', 'o/r', '5');
  assert.match(JSON.parse(round.stdout).warning, /unconfined.*declaration/);
  // The published review says so too, without the user's words.
  const body = w.posts()[0].body;
  assert.match(body, /reviewed unconfined on the reviewing account's trust declaration \(recorded \d{4}-\d\d-\d\dT/);
  assert.equal(body.includes(w.DECLARATION) || body.includes(w.CONFIRMATION), false);
});

test('the former user setting, as an environment variable or in the user settings file, enables nothing', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 't', [SETTING]: '1' });
  fs.mkdirSync(path.join(w.dir, 'home', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'home', '.claude', 'settings.json'), JSON.stringify({ env: { [SETTING]: '1' } }));
  const r = spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5', '--reviewer', 'claude'], { env: { ...w.env, HOME: path.join(w.dir, 'home') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, NO_TRUST);
  assert.equal(fs.readFileSync(APPROVE, 'utf8').includes(SETTING), false);
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
  assert.match(r.hint, /reclass/);
  assert.equal(w.ledger().findings[0].status, 'open');
});

test('a rename with edits that removes the verified span fixes the finding; an unverified span does not', () => {
  const fixed = renamePush('bad', true);
  assert.deepEqual([fixed.r.fixed, fixed.r.stillOpen, fixed.r.review], [1, 0, 'APPROVE']);
  assert.equal(fixed.w.ledger().findings[0].status, 'fixed');
  const unverified = renamePush('not verbatim in the file', true);
  assert.deepEqual([unverified.r.fixed, unverified.r.stillOpen], [0, 1]);
});

test('round re-reads the declaration: once it is revoked, no later round runs the claude reviewer, and recording it again resumes the same run', () => {
  const w = world({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdef' });
  w.trust();
  w.write('findings.json', []);
  assert.equal(w.approve('start', 'o/r', '5', '--reviewer', 'claude').status, 0);
  assert.equal(w.approve('trust', 'o/r', '5', '--revoke').status, 0);
  assert.notEqual(w.approve('start', 'o/r', '5').status, 0);
  const r = w.approve('round', 'o/r', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, NO_TRUST);
  assert.equal(w.calls().length, 0);
  w.trust();
  const again = w.approve('round', 'o/r', '5');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(w.calls().length, 1);
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
  w.trust(); w.approve('start', 'o/r', '5', '--reviewer', 'claude'); w.approve('round', 'o/r', '5');
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


test('start --language ko --effort high is stored in the ledger and reaches the runner in round 1 and in a resumed round 2', () => {
  const w = world();
  w.write('findings.json', [finding]);
  const started = JSON.parse(w.approve('start', 'o/r', '5', '--language', 'ko', '--effort', 'high').stdout);
  assert.deepEqual([started.language, started.effort], ['ko', 'high']);
  assert.deepEqual([w.ledger().language, w.ledger().effort], ['ko', 'high']);
  w.approve('round', 'o/r', '5');
  push(w, { 'b.js': 'unrelated\n' }, 'c2');
  // A resumed start without the flags keeps them.
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  assert.equal(w.calls().length, 2);
  for (const call of w.calls()) assert.deepEqual([call.reviewLanguage, call.reasoningEffort], ['ko', 'high']);
});

test('start without --language and --effort passes neither to the runner', () => {
  const w = world();
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.deepEqual([w.calls()[0].reviewLanguage, w.calls()[0].reasoningEffort], [undefined, undefined]);
});

test('start refuses a language that is not a BCP 47 tag and an effort the reviewer does not take, and writes no ledger', () => {
  const w = world();
  const name = w.approve('start', 'o/r', '5', '--language', 'Korean');
  assert.notEqual(name.status, 0);
  assert.match(name.stderr, /--language/);
  const max = w.approve('start', 'o/r', '5', '--reviewer', 'codex', '--effort', 'max');
  assert.notEqual(max.status, 0);
  assert.match(max.stderr, /--effort max.*codex/);
  const odd = w.approve('start', 'o/r', '5', '--reviewer', 'codex', '--effort', 'extreme');
  assert.notEqual(odd.status, 0);
  assert.equal(fs.existsSync(ledgerPath(w)), false);
});

test('a push to another file does not fix a finding whose span the file does not contain verbatim, and the PR is not approved', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, span: 'text the engine paraphrased' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  push(w, { 'b.js': 'unrelated\n' }, 'c2');
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5');
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.review, r2.fixed, r2.stillOpen, r2.notApproved], ['COMMENT', 0, 1, 'open-blockers']);
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
    assert.deepEqual([r.review, r.fixed, r.stillOpen, r.notApproved], ['COMMENT', 0, 1, 'open-blockers']);
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

test('a finding whose engine line is outside the diff is a file comment even when its span occurs inside it', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, line: 99 }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.deepEqual(w.posts()[0].comments.map((c) => [c.path, c.subject_type, c.line]), [['a.js', 'FILE', undefined]]);
  assert.match(w.posts()[0].comments[0].body, /^Line 99: /);
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

// The reviewer is the harness's own; the other vendor is used only when the user asks for it, and start never falls back to it.
const startOut = (r) => JSON.parse(r.stdout);

test('under Claude Code with no declaration and no --reviewer, start exits non-zero naming #366 and --reviewer codex, writes no ledger and never selects codex', () => {
  for (const login of [{}, { CLAUDE_CODE_OAUTH_TOKEN: 't' }]) {
    const w = world({ CLAUDECODE: '1', ...login });
    fs.writeFileSync(path.join(w.dir, 'real-claude', '.credentials.json'), '{}');
    const r = w.approve('start', 'o/r', '5');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, NO_TRUST);
    assert.match(r.stderr, /--reviewer codex/);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(ledgerPath(w)), false);
  }
});

test('under Claude Code, --reviewer codex runs the confined Codex reviewer when the user asked for it, with no note', () => {
  const w = world({ CLAUDECODE: '1' });
  const o = startOut(w.approve('start', 'o/r', '5', '--reviewer', 'codex'));
  assert.equal(o.reviewer, 'codex');
  assert.equal(o.note, undefined);
  assert.equal(w.ledger().provider, 'codex');
});

test('under Claude Code with a declaration, the harness reviewer is chosen without a token, a login file or the claude binary, and no note is printed', () => {
  const w = world({ CLAUDECODE: '1' });
  fs.rmSync(path.join(w.dir, 'bin', 'claude'));
  fs.rmSync(path.join(w.dir, 'bin', 'codex'));
  assert.equal(w.trust().status, 0);
  const o = startOut(w.approve('start', 'o/r', '5'));
  assert.equal(o.reviewer, 'claude');
  assert.equal(o.note, undefined);
});

test('under Codex a declaration changes nothing: the confined Codex reviewer runs with or without it', () => {
  const w = world({ CLAUDECODE: '' });
  assert.equal(startOut(w.approve('start', 'o/r', '5')).reviewer, 'codex');
  w.trust();
  const again = startOut(w.approve('start', 'o/r', '5'));
  assert.equal(again.reviewer, 'codex');
  assert.equal(again.warning, undefined);
});

test('under Codex with codex logged out, start refuses and offers --reviewer claude, even with a declaration, and never falls back', () => {
  const w = world({ CLAUDECODE: '', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  fs.rmSync(path.join(w.dir, 'codex-home', 'auth.json'));
  w.trust();
  const refused = w.approve('start', 'o/r', '5');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /codex login/);
  assert.match(refused.stderr, /--reviewer claude/);
  assert.equal(refused.stdout, '');
  assert.equal(w.ledger().provider, null);
});

test('under Codex, --reviewer claude needs a declaration and a Claude login', () => {
  const w = world({ CLAUDECODE: '' });
  const noTrust = w.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(noTrust.status, 0);
  assert.match(noTrust.stderr, NO_TRUST);
  assert.doesNotMatch(noTrust.stderr, /--reviewer codex/);
  w.trust();
  const noLogin = w.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(noLogin.status, 0);
  assert.match(noLogin.stderr, /log in with claude.*setup-token/);
});

test('an explicit reviewer is never replaced: --reviewer codex with codex missing exits non-zero, and --reviewer claude without a declaration is refused', () => {
  const w = world({ CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  fs.rmSync(path.join(w.dir, 'bin', 'codex'));
  const noCodex = w.approve('start', 'o/r', '5', '--reviewer', 'codex');
  assert.notEqual(noCodex.status, 0);
  assert.match(noCodex.stderr, /install codex/);
  const claude = w.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(claude.status, 0);
  assert.match(claude.stderr, NO_TRUST);
});

// The opted-in Claude reviewer authenticates as the user: the token when set, else the real credentials file copied into the reviewer's own config directory, else the real configuration.
const loginWorld = (extra, files) => {
  const real = tempDir('rua-real-claude-');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(real, name), text);
  const w = world({ CLAUDECODE: '', CLAUDE_CONFIG_DIR: real, ...extra });
  w.write('findings.json', []);
  w.trust();
  const started = w.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.equal(started.status, 0, started.stderr);
  const round = w.approve('round', 'o/r', '5');
  assert.equal(round.status, 0, round.stderr);
  return { real, call: w.calls()[0] };
};

test('with a declaration and no token, the Claude reviewer gets only the credentials file of the real configuration, in its own config directory', () => {
  const { real, call } = loginWorld({}, { '.credentials.json': '{"login":"user"}', 'settings.json': '{"hooks":{}}' });
  assert.notEqual(call.claudeConfig, real);
  assert.deepEqual(call.claudeConfigEntries, ['.credentials.json']);
  assert.equal(call.claudeCredentials, '{"login":"user"}');
  assert.equal(call.claudeToken, undefined);
});

test('with a declaration and a token, the Claude reviewer gets the token and no copied credentials file', () => {
  const { call } = loginWorld({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { '.credentials.json': '{"login":"user"}' });
  assert.equal(call.claudeToken, 'tok');
  assert.deepEqual(call.claudeConfigEntries, []);
});

test('round refuses a claude ledger whose login has gone, naming how to log in, and starts no reviewer', () => {
  const env = { CLAUDECODE: '', CLAUDE_CODE_OAUTH_TOKEN: 't' };
  const w = world(env);
  w.write('findings.json', []);
  w.trust();
  assert.equal(w.approve('start', 'o/r', '5', '--reviewer', 'claude').status, 0);
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
    w.trust();
    assert.equal(w.approve('start', 'o/r', '5').status, 0);
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

// Under Claude Code the reviewer roles run as the session's own subagents: `round` keeps running and waits, a session loop asks `next`
// for the open request, a subagent writes the one artifact the prompt names, and `next --done` hands control back.
const roleArtifact = (role, found) => ({
  correctness: { status: 'ok', examined: ['a.js'], findings: found.map((f) => ({ id: f.id, gate: 'correctness', file: f.file, span: f.span, summary: f.summary })) },
  verify: { status: 'ok', rejected: [], findings: [] },
  gate: { status: 'ok', findings: [] },
  'gate-verify': { status: 'ok', rejected: [], findings: [], blocking: [] },
  intent: { status: 'ok', findings: [] },
}[role]);

// Plays the session: starts `round` in the background, answers every request the way a subagent would, and returns the round's own output.
async function session(w, { found = [], answer } = {}) {
  const child = spawn(process.execPath, [APPROVE, 'round', 'o/r', '5'], { env: w.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  let closed = false;
  const exited = new Promise((resolve) => child.on('close', (code) => { closed = true; resolve(code); }));
  const requests = [];
  let answered = null;
  for (let i = 0; i < 400 && !closed; i++) {
    const next = spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5', ...(answered ? ['--done', answered] : [])], { env: w.env, encoding: 'utf8' });
    answered = null;
    const line = next.stdout.trim().split('\n').pop();
    const event = line ? JSON.parse(line) : { event: 'none', stderr: next.stderr };
    // `finished` before the round has written its run file is not the end: only the round process closing is.
    if (event.event !== 'subagent-request') { await new Promise((r) => setTimeout(r, 200)); continue; }
    requests.push(event);
    const prompt = fs.readFileSync(event.promptFile, 'utf8');
    // The artifact is the one the prompt tells the role to write, as the runner reads it; the other paths in the prompt are its inputs.
    const artifact = artifactDestinationFromPrompt(prompt, path.dirname(prompt.match(/(\S*round-\d+-[A-Za-z0-9:._-]+\.json)/)[1]));
    const body = answer ? answer(event, artifact) : roleArtifact(event.role, found);
    if (body !== null) fs.writeFileSync(artifact, JSON.stringify(body));
    answered = event.id;
  }
  const code = await exited;
  return { code, stdout, stderr, requests };
}

const inClaudeCode = { CLAUDECODE: '1', PATH: '/usr/bin:/bin' };
function claudeCodeWorld(extra = {}) {
  const w = world(extra);
  // No claude binary and no login: the session's own login is used.
  fs.rmSync(path.join(w.dir, 'bin', 'claude'));
  fs.rmSync(path.join(w.dir, 'bin', 'codex'));
  w.env.CLAUDECODE = '1';
  delete w.env.REVIEW_APPROVE_RUNNER;
  w.env.REVIEW_APPROVE_NEXT_WAIT_MS = '2000';
  w.env.REVIEW_APPROVE_BROKER_TIMEOUT_MS = '20000';
  w.trust(w.env);
  return w;
}

test('subagent transport: with a declaration, under Claude Code, a round with no claude binary and no login is ready and publishes what the claude -p path publishes for the same findings', async () => {
  const w = claudeCodeWorld();
  const started = JSON.parse(spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env, encoding: 'utf8' }).stdout);
  assert.deepEqual([started.reviewer, started.action], ['claude', 'round']);
  const r = await session(w, { found: [finding] });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual([out.event, out.review, out.new], ['published', 'COMMENT', 1]);
  assert.ok(r.requests.map((q) => q.role).includes('correctness'));
  assert.equal(w.posts()[0].comments[0].path, 'a.js');

  const reference = world({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdef' });
  reference.trust();
  reference.write('findings.json', [finding]);
  reference.approve('start', 'o/r', '5', '--reviewer', 'claude');
  reference.approve('round', 'o/r', '5');
  // Each world has its own repository, so its head differs; the finding is verified at that world's head.
  const shape = (x) => x.ledger().findings.map(({ key, id, file, span, status, spanVerified }) => ({ key, id, file, span, status, verified: spanVerified === x.c1 }));
  assert.deepEqual(shape(w), shape(reference));
  const posted = (x) => [x.posts()[0].event, x.posts()[0].commit_id === x.c1, x.posts()[0].body.replace(/recorded [^)]*/, 'recorded T').replaceAll(x.c1, 'HEAD').replaceAll(x.state.mergeBase, 'BASE'), x.posts()[0].comments.map((c) => [c.path, c.line, c.body.replaceAll(x.c1, 'HEAD')])];
  assert.deepEqual(posted(w), posted(reference));
});

test('subagent transport: under Claude Code without a declaration nothing changes: start refuses, and round on a claude ledger issues no request', async () => {
  const w = claudeCodeWorld();
  const started = spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  spawnSync(process.execPath, [APPROVE, 'trust', 'o/r', '5', '--revoke'], { env: w.env });
  const refused = spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, NO_TRUST);
  const r = await session(w, { found: [finding] });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, NO_TRUST);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(w.posts(), []);
});

test('subagent transport: a subagent that wrote no artifact fails the round: nothing is posted and no run state is left', async () => {
  const w = claudeCodeWorld();
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  const r = await session(w, { answer: () => null });
  assert.notEqual(r.code, 0);
  assert.deepEqual(w.posts(), []);
  assert.equal(fs.existsSync(path.join(w.dir, 'ledgers', 'o__r__5__bot.json.run.json')), false);
  assert.equal(w.ledger().rounds.length, 0);
});

test('subagent transport: next with no round running says finished and refuses --done; with a round waiting, --done for another id or with no id is refused and the request stays open', async () => {
  const w = claudeCodeWorld();
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  assert.equal(JSON.parse(spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5'], { env: w.env, encoding: 'utf8' }).stdout).event, 'finished');
  assert.notEqual(spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5', '--done', '1'], { env: w.env, encoding: 'utf8' }).status, 0);
  const round = spawn(process.execPath, [APPROVE, 'round', 'o/r', '5'], { env: w.env });
  let request;
  for (let i = 0; i < 100 && !request; i++) {
    const out = spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5'], { env: w.env, encoding: 'utf8' }).stdout.trim().split('\n').pop();
    if (out && JSON.parse(out).event === 'subagent-request') request = JSON.parse(out);
  }
  assert.ok(request, 'no request');
  const wrong = spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5', '--done', String(request.id + 7)], { env: w.env, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /not open/);
  const bare = spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5', '--done'], { env: w.env, encoding: 'utf8' });
  assert.notEqual(bare.status, 0);
  assert.equal(JSON.parse(spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5'], { env: w.env, encoding: 'utf8' }).stdout).id, request.id);
  round.kill('SIGKILL');
});

test('subagent transport: start refuses a --model that the Agent tool cannot take', () => {
  const w = claudeCodeWorld();
  const bad = spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5', '--reviewer', 'claude', '--model', 'claude-opus-5-5'], { env: w.env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /sonnet, opus or haiku/);
  const good = spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5', '--reviewer', 'claude', '--model', 'opus'], { env: w.env, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
});

test('subagent transport: the stored effort is in every subagent request, and none is set when --effort is absent', async () => {
  const w = claudeCodeWorld();
  assert.equal(spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5', '--effort', 'max'], { env: w.env, encoding: 'utf8' }).status, 0);
  const r = await session(w, { found: [] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.requests.length > 0);
  for (const q of r.requests) assert.equal(q.effort, 'max');
  const plain = claudeCodeWorld();
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: plain.env });
  const p = await session(plain, { found: [] });
  for (const q of p.requests) assert.equal('effort' in q, false);
});

test('subagent transport: a subagent that edits a tracked file of the checkout fails the round and nothing is posted', async () => {
  const w = claudeCodeWorld();
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  const r = await session(w, { found: [finding], answer: (event) => {
    if (event.role === 'correctness') fs.writeFileSync(path.join(path.dirname(path.dirname(event.promptFile)), 'work', 'a.js'), 'tampered\n');
    return roleArtifact(event.role, [finding]);
  } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /modified|moved/);
  assert.deepEqual(w.posts(), []);
});

test('subagent transport: every role prompt tells a subagent without a shell to judge by reading, so "cannot run it" is never a reason to write blocked', async () => {
  const w = claudeCodeWorld();
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  const seen = [];
  await session(w, { found: [finding], answer: (event) => {
    seen.push([event.role, fs.readFileSync(event.promptFile, 'utf8'), path.join(path.dirname(path.dirname(event.promptFile)), 'work')]);
    return roleArtifact(event.role, [finding]);
  } });
  assert.ok(['correctness', 'verify'].every((role) => seen.some(([r]) => r === role)), JSON.stringify(seen.map(([r]) => r)));
  for (const [role, prompt, checkout] of seen) {
    assert.match(prompt, /cannot run any command/, role);
    assert.match(prompt, /judge by reading/, role);
    assert.match(prompt, /write "blocked" only for a file you must read and cannot/, role);
    // The subagent runs in the session's own directory, so the prompt must say where the pull request is checked out.
    assert.ok(prompt.includes(`checked out at ${checkout}`), `${role}: prompt does not name ${checkout}`);
  }
});

test('the pr-reviewer agent has no shell: Read, Grep, Glob and Write only', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'agents', 'pr-reviewer.md'), 'utf8');
  assert.match(agent, /^---\nname: pr-reviewer\n/);
  assert.match(agent, /\ntools: Read, Grep, Glob, Write\n/);
});

test('subagent transport: a session that never answers ends the round at the deadline: nothing is posted and no run state is left', async () => {
  const w = claudeCodeWorld();
  w.env.REVIEW_APPROVE_BROKER_TIMEOUT_MS = '1500';
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  const child = spawnSync(process.execPath, [APPROVE, 'round', 'o/r', '5'], { env: w.env, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /no subagent answered/);
  assert.deepEqual(w.posts(), []);
  assert.equal(fs.existsSync(path.join(w.dir, 'ledgers', 'o__r__5__bot.json.run.json')), false);
});

test('subagent transport: a review that quotes the login credentials a subagent could read is never posted', async () => {
  const w = claudeCodeWorld();
  const token = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa';
  fs.writeFileSync(path.join(w.dir, 'real-claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  const r = await session(w, { found: [{ ...finding, summary: `leaks ${token}` }] });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /holds a credential/);
  assert.deepEqual(w.posts(), []);
});

test('subagent transport: the run file exists before the clone starts, so `next` never says finished while a round is still setting up', async () => {
  const w = claudeCodeWorld();
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const seen = path.join(w.dir, 'run-file-at-clone');
  fs.writeFileSync(path.join(w.dir, 'bin', 'git'), `#!/bin/sh\nif [ "$1" = clone ]; then ls ${JSON.stringify(path.join(w.dir, 'ledgers'))}/*.run.json >> ${JSON.stringify(seen)} 2>/dev/null; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  await session(w, { found: [] });
  assert.match(fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '', /o__r__5__bot\.json\.run\.json/);
});

test('subagent transport: when the round is killed, the runner it started ends too and removes the clone', async () => {
  const w = claudeCodeWorld();
  spawnSync(process.execPath, [APPROVE, 'start', 'o/r', '5'], { env: w.env });
  const round = spawn(process.execPath, [APPROVE, 'round', 'o/r', '5'], { env: w.env });
  let request;
  for (let i = 0; i < 100 && !request; i++) {
    const out = spawnSync(process.execPath, [APPROVE, 'next', 'o/r', '5'], { env: w.env, encoding: 'utf8' }).stdout.trim().split('\n').pop();
    if (out && JSON.parse(out).event === 'subagent-request') request = JSON.parse(out);
  }
  assert.ok(request, 'no request');
  const attemptDir = path.dirname(path.dirname(request.promptFile));
  const runner = Number(execFileSync('pgrep', ['-P', String(round.pid)], { encoding: 'utf8' }).trim().split('\n')[0]);
  process.kill(round.pid, 'SIGKILL');
  // A PID 1 that does not reap children leaves the ended runner as a zombie, which `kill -0` still finds; a zombie is not running.
  const running = () => { try { process.kill(runner, 0); return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${runner}/stat`, 'utf8')); } catch (_) { return false; } };
  for (let i = 0; i < 60 && (fs.existsSync(attemptDir) || running()); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.existsSync(attemptDir), false);
  assert.equal(running(), false);
});

const gateFinding = { id: 'gate:design-conformance:pg-readme-disabled-release-path', category: 'design', file: 'a.js', line: 4, span: 'four', summary: 'release path disabled', requirement: '' };

test('a follow-up round gives each reviewer role only the prior findings of its own artifact namespace (#386)', () => {
  const w = world();
  w.write('findings.json', [finding, gateFinding]);
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  push(w, { 'b.js': 'unrelated\n' }, 'c2');
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  const options = w.calls()[1];
  const context = { stateDir: '/s', round: 2, targetType: 'git', slug: 'concord-pr-5', gateMode: 'design-conformance', reviewerGuidance: options.reviewerGuidance ?? null, priorFindings: options.priorFindings ?? [] };
  const correctness = reviewerPrompt('correctness', context);
  const gate = reviewerPrompt('gate', context);
  // A reviewer that follows the prompt raises again every prior id it is told about.
  const raised = (prompt, ids) => ids.filter((id) => prompt.includes(id)).map((id) => ({ ...finding, id }));
  const ids = [finding.id, gateFinding.id];
  assert.doesNotThrow(() => normalizeArtifact('correctness', JSON.stringify({ status: 'ok', examined: ['a.js'], findings: raised(correctness, ids) })));
  assert.ok(correctness.includes(finding.id));
  assert.ok(!correctness.includes(gateFinding.id));
  assert.ok(gate.includes(gateFinding.id));
  assert.ok(!gate.includes(finding.id));
});

test('a round whose runner fails records the head it attempted and leaves the rounds alone; a published round clears it (#391)', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  const head2 = push(w, { 'b.js': 'unrelated\n' }, 'c2');
  w.approve('start', 'o/r', '5');
  fs.writeFileSync(path.join(w.dir, 'fail-runner'), '');
  assert.notEqual(w.approve('round', 'o/r', '5').status, 0);
  const failed = w.ledger();
  assert.equal(failed.rounds.length, 1);
  assert.equal(failed.attempt.head, head2);
  assert.ok(Date.parse(failed.attempt.at) > 0);
  fs.rmSync(path.join(w.dir, 'fail-runner'));
  w.approve('round', 'o/r', '5');
  assert.equal(w.ledger().attempt, undefined);
  assert.equal(w.ledger().rounds.length, 2);
});

test('a runner result that is not a review still records the head it attempted', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5');
  fs.writeFileSync(path.join(w.dir, 'bad-runner-output'), '');
  assert.notEqual(w.approve('round', 'o/r', '5').status, 0);
  const failed = w.ledger();
  assert.equal(failed.rounds.length, 0);
  assert.equal(failed.attempt.head, w.c1);
});

const minor = { ...finding, id: 'correctness:wording', class: 'minor', releaseBlocking: [], rationale: 'wording only, no behavior changes' };

test('a round whose only open finding is minor posts APPROVE that lists it as a follow-up', () => {
  const w = world();
  w.write('findings.json', [minor]);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.event, r.review, r.new, r.stillOpen], ['published', 'APPROVE', 1, 0]);
  const post = w.posts()[0];
  assert.equal(post.event, 'APPROVE');
  const body = `${post.body}\n${post.comments.map((c) => c.body).join('\n')}`;
  assert.match(post.body, /Follow-ups \(not blocking\)/);
  assert.match(post.body, /correctness:wording/);
  assert.match(body, /\(minor\)/);
  assert.match(body, /wording only, no behavior changes/);
  const f = w.ledger().findings[0];
  assert.deepEqual([f.status, f.class, f.reason], ['open', 'minor', 'wording only, no behavior changes']);
  assert.equal(w.ledger().approval.head, w.c1);
});

test('a round with an unclassified finding does not approve, and labels it a blocker', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.notApproved], ['COMMENT', 'open-blockers']);
  assert.match(`${w.posts()[0].body}${w.posts()[0].comments.map((c) => c.body).join('')}`, /\(blocker/);
  assert.deepEqual([w.ledger().findings[0].class, w.ledger().findings[0].reason], ['blocker', 'unclassified']);
});

test('a minor and a blocker in one round: COMMENT, and the minor is not lost when the blocker is fixed', () => {
  const w = world();
  w.write('findings.json', [finding, { ...minor, span: 'three', line: 3 }]);
  w.approve('start', 'o/r', '5');
  const r1 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r1.review, r1.notApproved, r1.new], ['COMMENT', 'open-blockers', 2]);
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\ngood\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c2');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', []);
  const r2 = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r2.review, r2.fixed, r2.stillOpen], ['APPROVE', 1, 1]);
  assert.match(w.posts()[1].body, /Follow-ups \(not blocking\)[\s\S]*correctness:wording/);
});

test('an unverified minor does not need a waiver and is not held', () => {
  const w = world();
  w.write('findings.json', [{ ...minor, span: 'text that is not in the file' }]);
  w.approve('start', 'o/r', '5');
  const r = JSON.parse(w.approve('round', 'o/r', '5').stdout);
  assert.deepEqual([r.review, r.held], ['APPROVE', undefined]);
});

test('reclass: the user turns a blocker into a minor with a reason, which approves; the record keeps the old class', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const r = w.approve('reclass', 'o/r', '5', 'correctness:bad', 'minor', '--reason', 'unusual input only');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n')[0]).event, 'reclassed');
  const f = w.ledger().findings[0];
  assert.deepEqual([f.class, f.reason], ['minor', 'unusual input only']);
  assert.deepEqual(f.reclassed.map(({ from, to, reason, account }) => ({ from, to, reason, account })), [{ from: 'blocker', to: 'minor', reason: 'unusual input only', account: 'bot' }]);
  assert.ok(f.reclassed[0].at);
  assert.equal(w.posts()[1].event, 'APPROVE');
  assert.match(w.posts()[1].body, /Follow-ups \(not blocking\)[\s\S]*unusual input only[\s\S]*correctness:bad/);
});

test('reclass: a minor can be raised to a blocker, which posts nothing and blocks the next approval', () => {
  const w = world();
  w.write('findings.json', [minor]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const before = w.posts().length;
  const r = w.approve('reclass', 'o/r', '5', 'correctness:wording', 'blocker', '--reason', 'it breaks callers');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.posts().length, before);
  assert.equal(w.ledger().findings[0].class, 'blocker');
  w.write('state.json', { ...w.state });
  assert.equal(JSON.parse(w.approve('approve', 'o/r', '5').stdout).reason, 'already-approved');
});

test('reclass refuses a missing reason, a class that is neither, and a finding that is not open', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.match(w.approve('reclass', 'o/r', '5', 'correctness:bad', 'minor').stderr, /--reason/);
  assert.match(w.approve('reclass', 'o/r', '5', 'correctness:bad', 'minor', '--reason', '  ').stderr, /--reason/);
  assert.match(w.approve('reclass', 'o/r', '5', 'correctness:bad', 'major', '--reason', 'x').stderr, /blocker or minor/);
  assert.match(w.approve('reclass', 'o/r', '5', 'nope', 'minor', '--reason', 'x').stderr, /no open finding/);
  assert.equal(w.ledger().findings[0].class, 'blocker');
});

test('waive still dismisses a minor, and it leaves the follow-up list', () => {
  const w = world();
  w.write('findings.json', [minor, { ...finding, id: 'correctness:other', span: 'three', line: 3 }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  assert.equal(JSON.parse(w.approve('waive', 'o/r', '5', 'correctness:other').stdout).event, 'approved');
  assert.doesNotMatch(w.posts()[1].body, /Follow-ups[\s\S]*correctness:other/);
  assert.match(w.posts()[1].body, /Follow-ups[\s\S]*correctness:wording/);
});

test('a finding outside every hunk of a changed file is posted as a file comment, one in an unchanged file in the body', () => {
  const w = world();
  w.write('findings.json', [{ ...finding, line: 99 }, { ...finding, id: 'correctness:other', file: 'zz.js', line: 1, span: 'nope' }]);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const post = w.posts()[0];
  assert.deepEqual(post.comments.map((c) => [c.path, c.subject_type]), [['a.js', 'FILE']]);
  assert.match(post.body, /`zz\.js:1`/);
  assert.doesNotMatch(post.body, /`a\.js:99`/);
});

test('a comment GitHub refuses moves only its finding to the body', () => {
  const w = world();
  w.write('reject-paths', ['a.js']);
  w.write('findings.json', [finding, { ...finding, id: 'correctness:other', file: 'b.js', line: 1, span: 'bad2' }]);
  fs.writeFileSync(path.join(w.src, 'b.js'), 'bad2\n');
  sh(w.src, 'add', '.'); sh(w.src, 'commit', '-q', '-m', 'c1b');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const post = w.posts()[0];
  assert.deepEqual(post.comments.map((c) => c.path), ['b.js']);
  assert.match(post.body, /`a\.js:2`/);
});

test('a pending review left by a crash is deleted before the next round posts; the reviewer\'s own draft blocks the round and is kept', () => {
  const w = world();
  w.write('findings.json', [finding]);
  w.write('reviews.json', [{ id: 50, user: { login: 'bot' }, commit_id: 'x', state: 'PENDING', body: '<!-- concord-approve: x round:1 base:y -->' }]);
  w.approve('start', 'o/r', '5');
  assert.equal(w.approve('round', 'o/r', '5').status, 0);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(w.dir, 'reviews.json'), 'utf8')).some((r) => r.id === 50));
  const draft = world();
  draft.write('findings.json', [finding]);
  draft.write('reviews.json', [{ id: 51, user: { login: 'bot' }, commit_id: 'x', state: 'PENDING', body: 'my notes' }]);
  draft.approve('start', 'o/r', '5');
  assert.notEqual(draft.approve('round', 'o/r', '5').status, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(draft.dir, 'reviews.json'), 'utf8')).some((r) => r.id === 51));
  assert.deepEqual(draft.posts(), []);
});

test('the thread id of a finding posted in an approving round is in the pending marker, so a recovered approval keeps it (#394)', () => {
  const w = world();
  w.write('findings.json', [minor]);
  w.write('fail-submit', '');
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  assert.equal(w.ledger().pending.findings[0].threadId, 'T1');
});

test('a reopened thread whose reply failed is answered on the next round (#394)', () => {
  const w = world();
  fixedRound(w);
  fs.writeFileSync(path.join(w.src, 'a.js'), 'one\nbad\nthree\nfour\n');
  sh(w.src, 'commit', '-q', '-am', 'c3');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.write('findings.json', [finding]);
  w.write('thread-state.json', { T1: { isResolved: true } });
  w.write('gql-fail-addPullRequestReviewThreadReply', '');
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  fs.rmSync(path.join(w.dir, 'gql-fail-addPullRequestReviewThreadReply'));
  w.write('thread-state.json', { T1: { isResolved: false } });
  fs.rmSync(path.join(w.dir, 'gql.jsonl'), { force: true });
  fs.writeFileSync(path.join(w.src, 'b.js'), 'x\n');
  sh(w.src, 'add', 'b.js');
  sh(w.src, 'commit', '-q', '-m', 'c4');
  sh(w.src, 'push', '-q', w.bare, 'HEAD:refs/pull/5/head', '-f');
  w.write('state.json', { ...w.state, head: sh(w.src, 'rev-parse', 'HEAD') });
  w.approve('start', 'o/r', '5');
  w.approve('round', 'o/r', '5');
  assert.deepEqual(w.gql().filter((c) => c.name !== 'thread'), [{ name: 'addPullRequestReviewThreadReply', id: 'T1' }]);
});
