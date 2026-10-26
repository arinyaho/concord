'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { tempDir } = require('./temp-dir');
const { readCommittedIntent, INTENT_MAX_BYTES } = require('../../core/intent');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function repo(t) {
  const dir = tempDir('committed-intent-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}
function commitFile(dir, filename, data, message = 'commit') {
  const abs = path.join(dir, filename);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  git(dir, 'add', '--', filename);
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}

test('returns exact committed bytes and stable source identity despite dirty worktree', (t) => {
  const dir = repo(t);
  const head = commitFile(dir, 'spec/要求書.md', Buffer.from('Committed requirement\n'));
  fs.writeFileSync(path.join(dir, 'spec/要求書.md'), 'uncommitted replacement');
  const result = readCommittedIntent({ repoRoot: dir, path: 'spec/要求書.md', head });
  assert.equal(result.text, 'Committed requirement\n');
  assert.equal(result.bytes, Buffer.byteLength(result.text));
  assert.equal(result.sha, require('node:crypto').createHash('sha256').update(result.text).digest('hex'));
  assert.deepEqual(result.source, {
    kind: 'committed-file', path: 'spec/要求書.md', commit: head,
    blob: git(dir, 'rev-parse', `${head}:spec/要求書.md`),
  });
});

test('committed reader resolves Git through the trusted cross-platform spawn seam', (t) => {
  const dir = repo(t); const head = commitFile(dir, 'intent.md', 'through trusted git seam');
  const intentModulePath = require.resolve('../../core/intent');
  const spawnModulePath = require.resolve('../../core/spawn-cross-platform');
  const originalIntentModule = require.cache[intentModulePath];
  const actualSpawn = require(spawnModulePath);
  const calls = [];
  const seam = {
    crossPlatformCommand(bin, excludeDir) { calls.push(['command', bin, excludeDir]); return actualSpawn.crossPlatformCommand(bin, excludeDir); },
    needsDoubleEscape(bin, excludeDir) { calls.push(['doubleEscape', bin, excludeDir]); return actualSpawn.needsDoubleEscape(bin, excludeDir); },
    crossPlatformArgs(args, doubleEscape) { calls.push(['args', doubleEscape]); return actualSpawn.crossPlatformArgs(args, doubleEscape); },
    crossPlatformOpts(options) { calls.push(['options', options.cwd, options.timeout, options.maxBuffer]); return actualSpawn.crossPlatformOpts(options); },
  };
  const originalLoad = Module._load;
  delete require.cache[intentModulePath];
  Module._load = function(request, parent, isMain) {
    if (request === './spawn-cross-platform' && parent.filename === intentModulePath) return seam;
    return originalLoad.apply(this, arguments);
  };
  let isolatedIntent;
  try { isolatedIntent = require(intentModulePath); }
  finally {
    Module._load = originalLoad;
    delete require.cache[intentModulePath];
    require.cache[intentModulePath] = originalIntentModule;
  }
  assert.equal(isolatedIntent.readCommittedIntent({ repoRoot: dir, path: 'intent.md', head }).text, 'through trusted git seam');
  assert.ok(calls.some(([kind, bin, excluded]) => kind === 'command' && bin === 'git' && excluded === dir));
  assert.ok(calls.some(([kind, bin, excluded]) => kind === 'doubleEscape' && bin === 'git' && excluded === dir));
  assert.ok(calls.some(([kind, cwd, timeout, maxBuffer]) => kind === 'options' && cwd === dir && timeout > 0 && maxBuffer <= INTENT_MAX_BYTES + 1));
});

test('reads the requested historical commit and changes digest/source commit when content changes', (t) => {
  const dir = repo(t);
  const first = commitFile(dir, 'intent.md', 'first');
  const second = commitFile(dir, 'intent.md', 'second');
  const a = readCommittedIntent({ repoRoot: dir, path: 'intent.md', head: first });
  const b = readCommittedIntent({ repoRoot: dir, path: 'intent.md', head: second });
  assert.equal(a.text, 'first');
  assert.equal(b.text, 'second');
  assert.notEqual(a.sha, b.sha);
  assert.equal(a.source.commit, first);
  assert.equal(b.source.commit, second);
});

test('rejects untracked files', (t) => {
  const dir = repo(t); fs.writeFileSync(path.join(dir, 'untracked.md'), 'intent');
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'untracked.md', head: 'HEAD' }), /harness-failure/);
});

test('reads a committed blob when the worktree file is absent', (t) => {
  const dir = repo(t); const head = commitFile(dir, 'intent.md', 'committed while absent');
  fs.unlinkSync(path.join(dir, 'intent.md'));
  assert.equal(readCommittedIntent({ repoRoot: dir, path: 'intent.md', head }).text, 'committed while absent');
});

test('rejects symlinks', (t) => {
  const dir = repo(t); fs.writeFileSync(path.join(dir, 'target'), 'intent');
  fs.symlinkSync('target', path.join(dir, 'intent.md'));
  git(dir, 'add', 'intent.md'); git(dir, 'commit', '-qm', 'symlink');
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'intent.md', head: 'HEAD' }), /harness-failure/);
});

test('rejects unsafe and nonportable relative paths', (t) => {
  const dir = repo(t); const head = commitFile(dir, 'intent.md', 'ok');
  for (const p of ['', '../intent.md', 'a/../../intent.md', '.git/config', 'a/.git/config', '/intent.md', 'C:\\intent.md', 'a\\intent.md', 'bad\0name']) {
    assert.throws(() => readCommittedIntent({ repoRoot: dir, path: p, head }), /harness-failure/, JSON.stringify(p));
  }
});

test('rejects empty, whitespace-only, and oversized committed blobs', (t) => {
  const dir = repo(t); const head1 = commitFile(dir, 'empty', '');
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'empty', head: head1 }), /harness-failure/);
  const head2 = commitFile(dir, 'space', ' \n\t');
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'space', head: head2 }), /harness-failure/);
  const head3 = commitFile(dir, 'large', Buffer.alloc(INTENT_MAX_BYTES + 1, 97));
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'large', head: head3 }), /harness-failure/);
});

test('rejects committed blobs that are not valid UTF-8 text', (t) => {
  const dir = repo(t); const head = commitFile(dir, 'binary-intent', Buffer.from([0xff, 0xfe, 0x61]));
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'binary-intent', head }), /harness-failure:.*UTF-8/);
});

test('rejects missing or non-commit revisions and directories', (t) => {
  const dir = repo(t); const head = commitFile(dir, 'dir/file', 'x');
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'dir', head }), /harness-failure/);
  assert.throws(() => readCommittedIntent({ repoRoot: dir, path: 'dir/file', head: 'not-a-revision' }), /harness-failure/);
});
