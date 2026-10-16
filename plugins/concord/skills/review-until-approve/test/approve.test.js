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
function world(extraEnv = {}) {
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
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runner-calls.jsonl'))}, JSON.stringify({ ...JSON.parse(process.argv[2]), envKeys: Object.keys(process.env), home: process.env.HOME, homeEntries: fs.readdirSync(process.env.HOME), codexHome: process.env.CODEX_HOME }) + '\\n');
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
  const env = { ...process.env, CLAUDECODE: '', PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, REVIEW_APPROVE_STATE_DIR: path.join(dir, 'ledgers'), REVIEW_APPROVE_REMOTE: path.join(dir, 'remote'), REVIEW_APPROVE_RUNNER: path.join(dir, 'runner.js') };
  const approve = (...args) => spawnSync('node', [APPROVE, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
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

test('start refuses the claude reviewer without the opt-in flag, whether asked for or chosen as the harness default, and names the flag', () => {
  const asked = world({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  const r = asked.approve('start', 'o/r', '5', '--reviewer', 'claude');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--allow-unrestricted-home/);
  assert.equal(fs.existsSync(path.join(asked.dir, 'ledgers', 'o__r__5__bot.json')), false);
  const inClaude = world({ CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDECODE: '1' });
  const d = inClaude.approve('start', 'o/r', '5');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /--allow-unrestricted-home/);
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
  const w = world({ CODEX_HOME: '/real/codex' });
  w.write('findings.json', []);
  w.approve('start', 'o/r', '5'); w.approve('round', 'o/r', '5');
  const call = w.calls()[0];
  assert.notEqual(call.home, process.env.HOME);
  assert.deepEqual(call.homeEntries, []);
  assert.equal(call.codexHome, '/real/codex');
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
