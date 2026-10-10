'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { snapshotRunEngine, reapStale } = require('../../core/run-snapshot');
const { tempDir } = require('./temp-dir');

const codexRoot = path.resolve(__dirname, '../../../concord-codex');

// Installs a copy of the Codex plugin whose CLI appends `version` to `log` on every call.
function installPlugin(dir, version, log) {
  for (const sub of ['bin', 'engine']) fs.cpSync(path.join(codexRoot, sub), path.join(dir, sub), { recursive: true });
  const cli = path.join(dir, 'bin', 'review-cli.js');
  fs.appendFileSync(cli, `\nif (require.main === module) require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(version)} + '\\n');\n`);
  return cli;
}

function repo() {
  const repoRoot = tempDir('plugin-update-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  return { repoRoot, base };
}

test('a plugin update that removes the starting version directory mid-run does not break the run (#309)', async () => {
  const { repoRoot, base } = repo();
  const home = tempDir('plugin-update-home-'), log = path.join(home, 'calls.log');
  const versionA = path.join(home, 'concord-A');
  installPlugin(versionA, 'A', log);
  const snapshot = snapshotRunEngine(versionA, repoRoot);
  process.once('exit', snapshot.remove);
  const { cliPath } = snapshot;
  let updated = false;
  const result = await runReviewUntilGreen({
    ref: 'feature/test', base, repoRoot, noBroad: true, cliPath, reviewStateDir: tempDir('plugin-update-state-'),
    spawn: async ({ role, prompt }) => {
      if (!updated) { updated = true; fs.rmSync(versionA, { recursive: true, force: true }); } // the Codex updater removes the running version
      const destination = /Write ONLY .*? to ([^\n]+?\.json)/.exec(prompt)?.[1];
      fs.writeFileSync(destination, JSON.stringify(role === 'plan' ? { status: 'ok', protocolVersion: 2, groups: [] } : { status: 'ok', examined: ['a.txt'], rejected: [], findings: [] }));
      return { status: 0 };
    },
  });
  assert.ok(updated, 'the update ran mid-run');
  assert.ok(result.decision, `run reached a decision: ${JSON.stringify(result)}`);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.length > 1);
  assert.deepEqual([...new Set(calls)], ['A'], 'every CLI call of the run used the version it started with');
});

test('the driver loads every engine module from its snapshot after the plugin directory is gone (#309)', () => {
  const { repoRoot } = repo();
  const plugin = tempDir('plugin-update-plugin-'); installPlugin(plugin, 'A', path.join(plugin, 'calls.log'));
  const snapshot = snapshotRunEngine(plugin, repoRoot);
  try {
    fs.rmSync(plugin, { recursive: true, force: true });
    const modules = fs.readdirSync(path.join(snapshot.root, 'engine')).filter((name) => name.endsWith('.js'));
    assert.ok(modules.includes('initiative-report.js'));
    execFileSync('node', ['-e', `for (const m of ${JSON.stringify(modules)}) require(require('node:path').join(${JSON.stringify(snapshot.root)}, 'engine', m))`], { stdio: 'pipe' });
  } finally { snapshot.remove(); }
  assert.equal(fs.existsSync(snapshot.root), false);
});

test('a snapshot is never placed inside the repository, even when TMPDIR points there', () => {
  const { repoRoot } = repo();
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = repoRoot;
  let snapshot;
  try { snapshot = snapshotRunEngine(codexRoot, repoRoot); } finally { if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp; }
  try { assert.ok(path.relative(fs.realpathSync(repoRoot), fs.realpathSync(snapshot.root)).startsWith('..')); } finally { snapshot.remove(); }
  assert.deepEqual(fs.readdirSync(repoRoot).filter((name) => name.startsWith('concord-run-')), []);
});

test('reapStale removes only old, dead-pid, own, real snapshot directories', () => {
  const parent = tempDir('plugin-update-reap-');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  const make = (name, aged = true) => { const dir = path.join(parent, name); fs.mkdirSync(dir); if (aged) fs.utimesSync(dir, old, old); return dir; };
  const dead = make('concord-run-999999999-abcdef'), live = make(`concord-run-${process.pid}-abcdef`), fresh = make('concord-run-999999998-abcdef', false), other = make('keep-me');
  const target = tempDir('plugin-update-target-'); fs.symlinkSync(target, path.join(parent, 'concord-run-999999997-abcdef'));
  reapStale(parent);
  assert.equal(fs.existsSync(dead), false);
  for (const dir of [live, fresh, other, target, path.join(parent, 'concord-run-999999997-abcdef')]) assert.ok(fs.existsSync(dir), dir);
});
