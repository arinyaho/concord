'use strict';
// The watch list, the detached watcher, the locator, and what the user sees: the SessionStart hooks of both
// harnesses and `watch status`.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { world, pr, approve, SCRIPT } = require('./world');
const { tempDir } = require('../../../hooks/test/temp-dir');
const runtime = require('../scripts/watcher');
const { entryFromArgs, addEntry } = require(SCRIPT);

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..');
const day = (offset) => new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const TODAY = day(0);
const watchList = (w) => JSON.parse(fs.readFileSync(path.join(w.skillDir, 'watch.json'), 'utf8'));
const writeList = (w, list) => { fs.mkdirSync(w.skillDir, { recursive: true }); fs.writeFileSync(path.join(w.skillDir, 'watch.json'), JSON.stringify(list)); };
// A watch list holding `e`, as `watch add` writes it.
const listOf = (e) => { const list = { entries: {} }; addEntry(list, e); return list; };
const entry = (...args) => entryFromArgs(['acme/app', '--harness', 'claude', '--self', 'octocat', ...args]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
// Waits, without a model and up to `ms`, until `ok` holds.
function until(ok, ms = 15000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return true;
}

test('an entry expires seven days after the date of the authorizing words: it is removed with `unwatched`, and nothing acts on it', () => {
  const w = world({ 'acme/app': { prs: [pr(1, { reviews: [approve('monalisa', 'head1')] })] } });
  writeList(w, { entries: { 'acme/app': { ...entry('--authorized', TODAY), authorized: day(-8) } } });
  const r = w.script(['check', '--harness', 'claude']);
  assert.equal(r.stdout, `unwatched acme/app: the authorization of ${day(-8)} expired\n`);
  assert.deepEqual(watchList(w).entries, {});
  assert.ok(!w.calls().some((c) => c[0] === 'pr' || /pulls|graphql/.test(c.join(' '))), 'nothing read or written for it');
  assert.equal(w.script(['check', '--harness', 'claude']).stdout, '');
  // Seven days old is still in force.
  writeList(w, { entries: { 'acme/app': { ...entry('--authorized', TODAY), authorized: day(-7) } } });
  assert.match(w.script(['check', '--harness', 'claude']).stdout, /^merged acme\/app#1/m);
});

test('watch add with the same or an earlier date does not extend an entry; a later date does', () => {
  const list = { entries: {} };
  addEntry(list, { ...entry('--authorized', TODAY), authorized: day(-3) });
  addEntry(list, { ...entry('--authorized', TODAY), authorized: day(-3) });
  assert.equal(list.entries['acme/app'].authorized, day(-3));
  addEntry(list, { ...entry('--authorized', TODAY), authorized: day(-5) });
  assert.equal(list.entries['acme/app'].authorized, day(-3), 'an earlier date');
  addEntry(list, entry('--authorized', TODAY));
  assert.equal(list.entries['acme/app'].authorized, TODAY, 'a later date');
  // --confirm stays; older words cannot widen the entry to merging.
  const c = { entries: {} };
  addEntry(c, entry('--authorized', TODAY, '--confirm', '--no-merge'));
  addEntry(c, { ...entry('--authorized', TODAY), authorized: day(-6) });
  assert.deepEqual([c.entries['acme/app'].confirm, c.entries['acme/app'].noMerge, c.entries['acme/app'].authorized], [true, true, TODAY]);
  addEntry(c, entry('--authorized', TODAY));
  assert.deepEqual([c.entries['acme/app'].confirm, c.entries['acme/app'].noMerge], [true, false], 'words of the same date can authorize merging');
  assert.throws(() => entry('--authorized', day(-8)), /more than seven days old/);
  assert.throws(() => entry('--authorized', day(3)), /future/);
  assert.throws(() => entry(), /--authorized/);
  // Numbers add to an entry of numbers; a whole repository replaces them; confirmations stay.
  const n = { entries: {} };
  addEntry(n, entryFromArgs(['acme/app#1', '--harness', 'claude', '--self', 'octocat', '--authorized', TODAY]));
  n.entries['acme/app'].confirmations = { 1: [{ sha: 'a'.repeat(40), at: 'x' }] };
  addEntry(n, entryFromArgs(['acme/app#2', '--harness', 'claude', '--self', 'octocat', '--authorized', TODAY]));
  assert.deepEqual(n.entries['acme/app'].numbers, [1, 2]);
  assert.deepEqual(Object.keys(n.entries['acme/app'].confirmations), ['1']);
  addEntry(n, entry('--authorized', TODAY));
  assert.deepEqual([n.entries['acme/app'].whole, n.entries['acme/app'].numbers], [true, []]);
});

// A world with nothing to merge, a watcher interval of a fifth of a second, and HOME without plugin caches.
function quietWorld(extra) {
  const w = world({ 'acme/app': { prs: [] } }, extra);
  w.env.CONCORD_WATCH_INTERVAL = '0.2';
  return w;
}
const add = (w, ...args) => w.script(['watch', 'add', 'acme/app', '--harness', 'claude', '--self', 'octocat', '--authorized', TODAY, ...args]);
const lock = (w) => runtime.readJson(path.join(w.skillDir, 'watcher.lock'), null);

test('watch add starts one detached watcher that outlives it, a second add starts none, and the watcher exits when the list is empty', { skip: process.platform === 'win32' }, () => {
  const w = quietWorld();
  const first = add(w);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^watching acme\/app as octocat until \d{4}-\d{2}-\d{2}\nwatcher started\n$/);
  assert.ok(until(() => lock(w) && alive(lock(w).pid)), 'the watcher took its lock');
  const { pid } = lock(w);
  assert.ok(until(() => fs.existsSync(path.join(w.skillDir, 'record.json'))), 'the watcher ran a check after its starter exited');
  const second = add(w, '--no-merge');
  assert.match(second.stdout, /watcher running\n$/);
  assert.equal(lock(w).pid, pid);
  // Owner-only state.
  for (const dir of [w.base, w.skillDir, path.join(w.base, 'notices')].filter(fs.existsSync)) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  const removed = w.script(['watch', 'remove', 'acme/app', '--harness', 'claude']);
  assert.equal(removed.stdout, 'unwatched acme/app: removed\n');
  for (const file of ['watch.json', 'record.json'].map((f) => path.join(w.skillDir, f))) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
  for (const n of runtime.pendingNotices(w.base)) assert.equal(fs.statSync(n.file).mode & 0o777, 0o600, n.file);
  assert.equal(fs.statSync(path.join(w.base, 'notices')).mode & 0o777, 0o700);
  assert.ok(until(() => !alive(pid)), 'the watcher exited');
  assert.equal(lock(w), null, 'and released its lock');
});

test('a lock taken under another locale still reads as held', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir('ptm-lock-');
  const file = path.join(dir, 'lock');
  const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../scripts/watcher'))}).takeLock(${JSON.stringify(file)}); setTimeout(() => {}, 20000)`], { env: { ...process.env, LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' }, stdio: 'ignore' });
  try {
    assert.ok(until(() => fs.existsSync(file)));
    assert.equal(runtime.running(runtime.readJson(file, null)), true);
    assert.equal(runtime.takeLock(file), false);
  } finally {
    holder.kill();
  }
});

test('a failed probe starts nothing and prints the command for the user to run', () => {
  const w = quietWorld({ fail: ['^api user$'] });
  const r = add(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^watcher not started: .* Run this in a terminal:\n.*pr-to-merge\.js watch add acme\/app --harness claude --self octocat --authorized \d{4}-\d{2}-\d{2}\n$/);
  assert.ok(!fs.existsSync(path.join(w.skillDir, 'watch.json')));
  assert.equal(lock(w), null);
});

test('the watcher notifies once after ten failed checks in a row', { skip: process.platform === 'win32' }, () => {
  const w = quietWorld({ fail: ['^api user$'] });
  w.env.CONCORD_WATCH_INTERVAL = '0.05';
  writeList(w, listOf(entry('--authorized', TODAY)));
  const child = spawn(process.execPath, [SCRIPT, 'watcher', '--harness', 'claude'], { env: w.env, stdio: 'ignore' });
  const userReads = () => w.calls().filter((c) => c.join(' ') === 'api user').length;
  assert.ok(until(() => userReads() >= 12, 60000), `checks ran: ${userReads()}`);
  writeList(w, { entries: {} });
  assert.ok(until(() => !alive(child.pid) || lock(w) === null), 'the watcher exits');
  assert.deepEqual(w.notifications().length, 1);
  assert.match(w.notifications()[0].join(' '), /pr-to-merge: ten checks in a row failed/);
});

// A fixture plugin cache entry: the manifest, and a pr-to-merge.js whose check records its version and empties the watch list.
function installed(home, root, manifestDir, name, version) {
  const dir = path.join(home, root, 'plugins', 'cache', 'mp', name, version);
  fs.mkdirSync(path.join(dir, manifestDir), { recursive: true });
  fs.writeFileSync(path.join(dir, manifestDir, 'plugin.json'), JSON.stringify({ name, version }));
  const scripts = path.join(dir, 'skills', 'pr-to-merge', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'pr-to-merge.js'), `const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.env.HOME, 'ran'), ${JSON.stringify(version)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'concord', 'pr-to-merge', 'watch.json'), JSON.stringify({ entries: {} }));\n`);
  return path.join(scripts, 'pr-to-merge.js');
}

test('the watcher runs the check from the newest installed copy across both harnesses\' plugin caches', { skip: process.platform === 'win32' }, () => {
  const w = quietWorld();
  const home = w.env.HOME;
  installed(home, '.claude', '.claude-plugin', 'concord', '99.0.0');
  const newest = installed(home, '.codex', '.codex-plugin', 'concord', '100.0.0-beta.10');
  installed(home, '.codex', '.codex-plugin', 'concord', '100.0.0-beta.9');
  installed(home, '.claude', '.claude-plugin', 'other', '200.0.0');
  const bare = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(require.resolve('../scripts/watcher'))}).locate('pr-to-merge', 'pr-to-merge.js', 'own'))`], { env: { ...w.env, HOME: tempDir('ptm-empty-') }, encoding: 'utf8' });
  assert.equal(bare.stdout.trim(), 'own', 'no installed copy: the running one');
  const located = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(require.resolve('../scripts/watcher'))}).locate('pr-to-merge', 'pr-to-merge.js', ${JSON.stringify(SCRIPT)}))`], { env: w.env, encoding: 'utf8' });
  assert.equal(located.stdout.trim(), newest);
  writeList(w, listOf(entry('--authorized', TODAY)));
  const r = spawnSync(process.execPath, [SCRIPT, 'watcher', '--harness', 'claude'], { env: w.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(home, 'ran'), 'utf8'), '100.0.0-beta.10 check --harness claude\n');
  assert.ok(runtime.compareVersions('1.0.0', '1.0.0-beta.10') > 0 && runtime.compareVersions('1.0.0-beta.10', '1.0.0-beta.9') > 0 && runtime.compareVersions('1.0.0-beta', '1.0.0-beta.1') < 0);
});

// What each harness's SessionStart hook prints, and what the user sees of it: `systemMessage`.
const HOOKS = {
  claude: { hook: path.join(ROOT, 'plugins', 'concord', 'hooks', 'session-state-injector.js'), envKey: 'CLAUDE_CONFIG_DIR' },
  codex: { hook: path.join(ROOT, 'plugins', 'concord-codex', 'hooks', 'session-state-injector.js'), envKey: 'CODEX_HOME' },
};
function sessionStart(harness, home) {
  const { hook, envKey } = HOOKS[harness];
  const proj = tempDir('ptm-proj-');
  const env = { ...process.env, HOME: path.join(home, 'home'), [envKey]: home };
  delete env[envKey === 'CODEX_HOME' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
  const r = spawnSync(process.execPath, [hook], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', transcript_path: path.join(proj, 's1.jsonl'), cwd: proj, source: 'startup', hook_event_name: 'SessionStart' }) });
  return r.stdout;
}

for (const harness of ['claude', 'codex']) {
  test(`${harness}: the SessionStart hook shows the user the pending lines and that the watcher is not running; a line stops showing once watch status showed it`, () => {
    const home = tempDir(`ptm-${harness}-`);
    const base = path.join(home, 'concord');
    assert.doesNotMatch(sessionStart(harness, home), /^\{/, 'nothing pending: the hook prints its context as before');
    runtime.addNotice(base, 'pr-to-merge', 'merged acme/app#1 into main (squash) head head1; not passed: 0; unresolved threads: 0');
    const dir = runtime.ownerDir(path.join(base, 'pr-to-merge'));
    fs.writeFileSync(path.join(dir, 'watch.json'), JSON.stringify(listOf(entryFromArgs(['acme/app', '--harness', harness, '--self', 'octocat', '--authorized', TODAY]))));
    fs.writeFileSync(path.join(dir, 'watcher.lock'), JSON.stringify({ pid: 2 ** 22 + 7, start: 'gone' }));
    const out = JSON.parse(sessionStart(harness, home));
    assert.match(out.systemMessage, /pr-to-merge: merged acme\/app#1 into main/);
    assert.match(out.systemMessage, /pr-to-merge: the watcher is not running; invoke pr-to-merge to start it again/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /DECISION:/);
    assert.match(out.hookSpecificOutput.additionalContext, /merged acme\/app#1/);
    const envKey = HOOKS[harness].envKey;
    const status = spawnSync(process.execPath, [SCRIPT, 'watch', 'status', '--harness', harness], { env: { ...process.env, [envKey]: home }, encoding: 'utf8' });
    assert.equal(status.stdout, `watcher not running; last check none\nwatching acme/app as octocat until ${day(7)}\nmerged acme/app#1 into main (squash) head head1; not passed: 0; unresolved threads: 0\n`);
    const after = JSON.parse(sessionStart(harness, home));
    assert.doesNotMatch(after.systemMessage, /merged/);
    assert.match(after.systemMessage, /the watcher is not running/);
    fs.writeFileSync(path.join(dir, 'watch.json'), JSON.stringify({ entries: {} }));
    assert.doesNotMatch(sessionStart(harness, home), /^\{/, 'an empty watch list needs no watcher');
  });
}
