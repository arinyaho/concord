'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { repositoryIdentity } = require('../../core/initiative-review-run');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function tempRepo(t) {
  const root = tempDir('repository-identity-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'file'), 'content'); git(root, 'add', 'file'); git(root, 'commit', '-qm', 'initial');
  return root;
}

function withSpawnMocks(t, { command, failResolution = false } = {}) {
  const modulePath = require.resolve('../../core/initiative-review-run');
  const originalModule = require.cache[modulePath];
  const oldLoad = Module._load;
  const calls = [];
  const seam = {
    crossPlatformCommand(bin, excludeDir) {
      calls.push(['command', bin, excludeDir]);
      if (failResolution) throw new Error('no trusted git on PATH');
      return command;
    },
    needsDoubleEscape(bin, excludeDir) { calls.push(['doubleEscape', bin, excludeDir]); return true; },
    crossPlatformArgs(args, doubleEscape) { calls.push(['args', doubleEscape, args]); return args; },
    crossPlatformOpts(opts) { calls.push(['opts', opts]); return { ...opts, shell: true }; },
  };
  const childProcess = { execFileSync(bin, args, opts) { calls.push(['exec', bin, args, opts]); return '.git\n'; } };
  delete require.cache[modulePath];
  Module._load = function(request, parent, isMain) {
    if (parent.filename?.endsWith(`${path.sep}initiative-review-run.js`) && request === './spawn-cross-platform') return seam;
    if (parent.filename?.endsWith(`${path.sep}initiative-review-run.js`) && request === 'node:child_process') return childProcess;
    return oldLoad.apply(this, arguments);
  };
  let fresh;
  try { fresh = require(modulePath); }
  finally {
    Module._load = oldLoad;
    delete require.cache[modulePath];
    if (originalModule) require.cache[modulePath] = originalModule;
  }
  t.after(() => {});
  return { identity: fresh.repositoryIdentity, calls };
}

test('repositoryIdentity uses trusted Windows Git resolution and .cmd shim options', (t) => {
  const root = tempRepo(t);
  const trustedGitCmd = 'C:\\trusted\\Git\\cmd\\git.CMD';
  const { identity, calls } = withSpawnMocks(t, { command: trustedGitCmd });
  assert.equal(identity(root), fs.realpathSync(path.join(root, '.git')));
  assert.ok(calls.some(([kind, bin, excluded]) => kind === 'command' && bin === 'git' && excluded === fs.realpathSync(root)));
  assert.ok(calls.some(([kind, bin, excluded]) => kind === 'doubleEscape' && bin === 'git' && excluded === fs.realpathSync(root)));
  assert.ok(calls.some(([kind, doubleEscape]) => kind === 'args' && doubleEscape === true));
  const invocation = calls.find(([kind]) => kind === 'exec');
  assert.equal(invocation[1], trustedGitCmd);
  assert.deepEqual(invocation[2], ['rev-parse', '--git-common-dir']);
  assert.equal(invocation[3].cwd, fs.realpathSync(root));
  assert.equal(invocation[3].shell, true);
});

test('repositoryIdentity does not fall back to raw git when trusted resolution fails', (t) => {
  const root = tempRepo(t);
  const { identity, calls } = withSpawnMocks(t, { failResolution: true });
  assert.equal(identity(root), fs.realpathSync(root));
  assert.ok(calls.some(([kind, bin, excluded]) => kind === 'command' && bin === 'git' && excluded === fs.realpathSync(root)));
  assert.equal(calls.some(([kind]) => kind === 'exec'), false);
});

test('repositoryIdentity matches the common Git directory across linked worktrees', (t) => {
  const root = tempRepo(t);
  const linked = tempDir(`linked-${path.basename(root)}-`);
  fs.rmdirSync(linked);
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  git(root, 'worktree', 'add', '-qb', 'linked', linked);
  assert.equal(repositoryIdentity(root), repositoryIdentity(linked));
});
