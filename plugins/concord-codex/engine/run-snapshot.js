'use strict';
// A review run executes one code version end to end. The Codex updater removes the
// installed version directory, so the driver copies its engine and CLI shim into a
// per-run temp directory and loads and spawns only that copy (#309).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pidRunning } = require('./run-lock');

const PREFIX = 'concord-run-';
const NAME = /^concord-run-(\d+)-[A-Za-z0-9]{6}$/;
const STALE_MS = 24 * 60 * 60 * 1000;

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function tempParent(repoRoot) {
  const repo = fs.realpathSync(repoRoot);
  for (const candidate of [os.tmpdir(), '/tmp']) {
    try { const parent = fs.realpathSync(candidate); if (!inside(parent, repo)) return parent; } catch (_) { /* try the next candidate */ }
  }
  throw new Error('harness-failure: no temporary directory exists outside the reviewed repository');
}

// Removes snapshots left by runs that were killed. Only direct children of `parent` that match
// the name, are real directories owned by this user, belong to a dead pid and are old are removed.
function reapStale(parent) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const name of fs.readdirSync(parent)) {
    const match = NAME.exec(name);
    if (!match) continue;
    const dir = path.join(parent, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || (uid !== null && stat.uid !== uid) || pidRunning(Number(match[1])) || Date.now() - stat.mtimeMs <= STALE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* another process may have reaped it */ }
  }
}

function copyFile(from, to) {
  fs.writeFileSync(to, fs.readFileSync(from), { flag: 'wx', mode: 0o400 });
}

// pluginRoot is the driver's own plugin directory (never derived from the repository or state).
// Returns { root, cliPath, remove }; cliPath is the one path the run invokes for CLI verbs.
function snapshotRunEngine(pluginRoot, repoRoot) {
  const parent = tempParent(repoRoot);
  reapStale(parent);
  const root = fs.mkdtempSync(path.join(parent, `${PREFIX}${process.pid}-`));
  const remove = () => { fs.rmSync(root, { recursive: true, force: true }); };
  try {
    fs.mkdirSync(path.join(root, 'engine')); fs.mkdirSync(path.join(root, 'bin'));
    // The whole engine directory, so a module loaded lazily is present by construction.
    for (const entry of fs.readdirSync(path.join(pluginRoot, 'engine'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) copyFile(path.join(pluginRoot, 'engine', entry.name), path.join(root, 'engine', entry.name));
    }
    copyFile(path.join(pluginRoot, 'bin', 'review-cli.js'), path.join(root, 'bin', 'review-cli.js'));
    // A package.json in a parent of the temp directory must not change how the copy loads.
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}\n', { flag: 'wx', mode: 0o400 });
  } catch (error) { remove(); throw error; }
  return { root, cliPath: path.join(root, 'bin', 'review-cli.js'), remove };
}

module.exports = { snapshotRunEngine, reapStale };
