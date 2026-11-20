'use strict';
// The watch list, the detached watcher and its check, the notice list, and what the user sees, against the fake
// GitHub and fake agents of world.js. HOME is an empty directory, so the locator finds no installed copy and the
// watcher runs this checkout's script.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { world, stateReview, finding, thread, comment } = require('./world');
const { valid } = require('../scripts/review-until-approve');
const { tempDir } = require('../../../hooks/test/temp-dir');
const runtime = require('../../../runtime/watcher');

const proposal = { findings: [{ severity: 'blocker', file: 'a.js', line: 3, quote: 'bad line', reason: 'r', evidence: 'e' }] };
const kept = { class: 'blocker', file: 'a.js', line: 3, span: 'bad line', text: 'This line is bad.', reason: null };

function until(ok, ms = 30000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return true;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A world whose watcher checks every `interval` seconds, with an empty HOME.
function watched(opts = {}, interval = '0.05') {
  const w = world(opts);
  const home = tempDir('rua-home-');
  w.extra = { HOME: home, CONCORD_WATCH_INTERVAL: interval };
  w.data = path.join(w.config, 'concord', 'review-until-approve');
  w.base = path.join(w.config, 'concord');
  w.sh = (args) => {
    const r = w.run([...args], w.extra);
    for (const line of r.out) assert.ok(valid(line), JSON.stringify(line));
    return r;
  };
  w.check = () => w.run(['check', '--harness', 'claude'], w.extra);
  w.list = () => runtime.readJson(path.join(w.data, 'watch.json'), { entries: {} }).entries;
  w.lines = () => runtime.pendingNotices(w.base, 'review-until-approve').map((n) => n.line);
  // No round or decision holds a lock on the pull request.
  w.idle = () => { try { return fs.readdirSync(path.join(w.data, 'locks')).filter((n) => n.endsWith('.lock')).every((n) => !runtime.running(runtime.readJson(path.join(w.data, 'locks', n), null))); } catch { return true; } };
  w.watcher = () => runtime.readJson(path.join(w.data, 'watcher.lock'), null);
  return w;
}
// The watch entry `watch add` writes, written directly, so that no watcher starts.
function entry(w, extra = {}) {
  fs.mkdirSync(w.data, { recursive: true });
  fs.writeFileSync(path.join(w.data, 'watch.json'), JSON.stringify({ entries: { 'o/r#5': { repo: 'o/r', n: 5, login: 'rev', harness: 'claude', model: null, effort: null, ...extra } } }));
}
// Two checks an interval apart: the first sees the change, the second finds it settled.
function settle(w) {
  w.check();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return w.check();
}
const reviews = (w) => w.read().reviews.filter((r) => r.author === 'rev');
const posts = (w) => w.calls().filter((c) => c.a.includes('POST') || c.a.includes('DELETE'));
const stop = (w) => {
  const holder = w.watcher();
  fs.writeFileSync(path.join(w.data, 'watch.json'), JSON.stringify({ entries: {} }));
  // A watcher this test spawned stays a zombie until the test yields, so its released lock is what shows it exited.
  if (holder) assert.ok(until(() => !alive(holder.pid) || w.watcher() === null), 'the watcher exits');
};

test('criterion 1: a watched pull request with no activity across many checks starts no agent and posts nothing', { skip: process.platform === 'win32' }, () => {
  const w = watched();
  w.update((v) => { v.reviews.push(stateReview(w, { findings: [finding(w)] })); v.pr.labels.nodes = [{ name: 'review-blocked' }]; });
  const add = w.sh(['watch', 'add', 'o/r', '5', '--harness', 'claude']);
  assert.deepEqual(add.out, [{ event: 'watching', pr: 'o/r#5' }, { event: 'watcher', running: false, started: true }]);
  const checks = () => w.calls().filter((c) => c.a.join(' ') === 'api user').length;
  assert.ok(until(() => checks() >= 12, 60000), `checks ran: ${checks()}`);
  stop(w);
  assert.deepEqual(w.agentRuns(), []);
  assert.deepEqual(posts(w), []);
  assert.ok(!w.calls().some((c) => /compare/.test(c.a.join(' '))), 'no round prepared');
  assert.deepEqual(w.notifications(), []);
});

test('criterion 2 and 9: with no session, a push gets one round, once the head has stayed unchanged for an interval, with the entry\'s model and effort', { skip: process.platform === 'win32' }, () => {
  const w = watched({}, '0.3');
  w.agents({ reviewer: [proposal], verifier: [{ findings: [kept], verdicts: [] }] });
  w.update((v) => { v.reviews.push(stateReview(w, {})); });
  const add = w.sh(['watch', 'add', 'o/r', '5', '--harness', 'claude', '--model', 'opus', '--effort', 'high']);
  assert.equal(add.status, 0, add.stderr);
  assert.ok(until(() => w.lines().length === 0 && w.calls().filter((c) => /graphql/.test(c.a.join(' '))).length >= 3), 'the watcher read the pull request');
  w.push({ 'a.js': 'one\ntwo\nbad line\nthree\nfour\n' });
  assert.ok(until(() => reviews(w).length === 2 && w.idle(), 60000), 'a round published');
  // One more check interval: nothing is pending, so nothing more runs.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  stop(w);
  assert.equal(reviews(w).length, 2);
  const runs = w.agentRuns();
  assert.deepEqual(runs.map((r) => r.role), ['reviewer', 'verifier']);
  for (const r of runs) {
    assert.equal(r.args[r.args.indexOf('--model') + 1], 'opus');
    assert.equal(r.args[r.args.indexOf('--effort') + 1], 'high');
  }
  assert.ok(w.lines().some((l) => /^o\/r#5 question|^o\/r#5 reviewed round 2/.test(l)));
});

test('criterion 2: a pending reply and a description edit each run one round once settled; a change between checks restarts the wait', () => {
  for (const kind of ['reply', 'description']) {
    const w = watched({}, '0.05');
    w.update((v) => { v.reviews.push(stateReview(w, { findings: [finding(w)] })); v.threads.push(thread('1.1')); v.pr.labels.nodes = [{ name: 'review-blocked' }]; });
    entry(w, { model: 'sonnet' });
    w.check();
    if (kind === 'reply') w.update((v) => { v.threads[0].comments.nodes.push({ databaseId: 9e6, author: { login: 'dev' }, body: 'Done.', createdAt: new Date().toISOString(), lastEditedAt: null, url: 'https://github.com/o/r/pull/5#discussion_r9' }); });
    else w.update((v) => { v.pr.body = 'A new description.'; });
    w.check();
    assert.equal(reviews(w).length, 1, `${kind}: the first check that sees it waits`);
    // Another reply before the next check restarts the wait.
    w.update((v) => { v.comments.push(comment('dev', 'One more thing.')); });
    w.check();
    assert.ok(until(() => w.idle()));
    assert.equal(reviews(w).length, 1, `${kind}: a change since the last check waits again`);
    w.agents({ reviewer: [{ findings: [], verdicts: [{ key: '1.1', verdict: 'fixed' }] }], verifier: [{ findings: [], verdicts: [{ key: '1.1', status: 'fixed', reply: 'Gone.' }] }] });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    w.check();
    assert.ok(until(() => reviews(w).length === 2 && w.idle()), `${kind}: a round published`);
    assert.equal(w.agentRuns().length, 2);
    assert.equal(w.agentRuns()[0].args[w.agentRuns()[0].args.indexOf('--model') + 1], 'sonnet');
    assert.ok(!w.agentRuns()[0].args.includes('--effort'));
    settle(w);
    assert.ok(until(() => w.idle()));
    assert.equal(w.agentRuns().length, 2, `${kind}: no second round`);
  }
});

test('criterion 3: a clean review withheld only by draft status is published as an approval when the pull request becomes ready, with no agent, and notified', () => {
  const w = watched();
  w.update((v) => { v.pr.isDraft = true; v.reviews.push(stateReview(w, { findings: [finding(w, { class: 'minor' })] })); });
  entry(w);
  settle(w);
  assert.ok(until(() => w.idle()));
  assert.equal(reviews(w).length, 1, 'a draft is not approved');
  w.update((v) => { v.pr.isDraft = false; });
  w.check();
  assert.ok(until(() => reviews(w).length === 2 && w.idle()), 'published');
  assert.equal(reviews(w).at(-1).state, 'APPROVED');
  assert.deepEqual(w.agentRuns(), []);
  assert.ok(w.lines().some((l) => /^o\/r#5 approved round 2 at [0-9a-f]{7}: /.test(l)), w.lines().join('\n'));
  assert.equal(w.notifications().length, 1);
  assert.match(w.notifications()[0].join(' '), /review-until-approve: 1 new notice/);
  // Approved once: later checks post nothing.
  settle(w);
  assert.ok(until(() => w.idle()));
  assert.equal(reviews(w).length, 2);
});

test('criterion 4: a merged or closed pull request is notified and removed', () => {
  for (const state of ['MERGED', 'CLOSED']) {
    const w = watched();
    w.update((v) => { v.reviews.push(stateReview(w, {})); v.pr.state = state; });
    entry(w);
    const r = w.check();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(w.list(), {});
    assert.deepEqual(w.lines(), [`o/r#5 ${state.toLowerCase()}; no longer watched`]);
    assert.equal(w.notifications().length, 1);
    assert.deepEqual(posts(w), []);
  }
});

test('criterion 4: another gh account is notified once and skipped; the line goes when the account is back', () => {
  const w = watched({ login: 'other' });
  w.update((v) => { v.reviews.push(stateReview(w, {}, { login: 'rev' })); });
  entry(w);
  w.check();
  w.check();
  assert.deepEqual(w.lines(), ['o/r#5 question account rev']);
  assert.equal(w.notifications().length, 1);
  assert.ok(!w.calls().some((c) => /graphql/.test(c.a.join(' '))), 'the pull request is not read');
  w.update((v) => { v.login = 'rev'; });
  w.check();
  assert.deepEqual(w.lines(), []);
});

test('criterion 4: a seventh round within 24 hours asks the user and runs nothing', () => {
  const w = watched();
  const recent = (i) => new Date(Date.now() - (i + 1) * 600e3).toISOString();
  w.update((v) => { for (let i = 0; i < 6; i++) v.reviews.push(stateReview(w, { round: 6 - i }, { at: recent(i) })); });
  w.push({ 'a.js': 'one\ntwo\nbad line\nthree\nfour\n' });
  entry(w);
  settle(w);
  assert.ok(until(() => w.lines().some((l) => / question cap /.test(l)) && w.idle()), w.lines().join('\n'));
  assert.deepEqual(w.agentRuns(), []);
  assert.equal(reviews(w).length, 6);
  assert.match(w.lines().find((l) => / question cap /.test(l)), /^o\/r#5 question cap 6 round\(s\) in 24 hours at [0-9a-f]{7} https:\/\/github\.com\/o\/r\/pull\/5$/);
  // Held: later checks on the same state run nothing and ask nothing again.
  settle(w);
  assert.ok(until(() => w.idle()));
  assert.equal(w.lines().filter((l) => / question cap /.test(l)).length, 1);
  assert.equal(w.notifications().length, 1);
  // Once the window has passed, a new push still waits for the user's invocation, which runs at once.
  w.update((v) => { for (const r of v.reviews) r.submittedAt = new Date(Date.now() - 25 * 3600e3).toISOString(); });
  w.push({ 'a.js': 'one\ntwo\nbad line\nthree\nfive\n' });
  settle(w);
  settle(w);
  assert.ok(until(() => w.idle()));
  assert.deepEqual(w.agentRuns(), []);
  assert.equal(w.sh(['round', 'o/r', '5', '--harness', 'claude']).out[0].event, 'published');
  assert.deepEqual(w.lines().filter((l) => / question cap /.test(l)), [], 'the invocation answered it');
});

test('criterion 4: a removed review-blocked label is added back while the state requires it', () => {
  const w = watched();
  w.update((v) => { v.reviews.push(stateReview(w, { findings: [finding(w)] })); });
  entry(w);
  w.check();
  assert.deepEqual(w.read().pr.labels.nodes.map((l) => l.name), ['review-blocked']);
  assert.ok(w.lines().includes('o/r#5 review-blocked label restored'));
  // Informational: no notification.
  assert.deepEqual(w.notifications(), []);
  w.check();
  assert.equal(posts(w).length, 1);
});

test('criterion 4: ten failed checks in a row are notified once', { skip: process.platform === 'win32' }, () => {
  const w = watched({ login: null });
  entry(w);
  const child = spawn(process.execPath, [require('./world').SCRIPT, 'watcher', '--harness', 'claude'], { env: w.env(w.extra), stdio: 'ignore' });
  const reads = () => w.calls().filter((c) => c.a.join(' ') === 'api user').length;
  assert.ok(until(() => reads() >= 12, 60000), `checks ran: ${reads()}`);
  stop(w);
  child.kill();
  assert.equal(w.notifications().length, 1);
  assert.match(w.notifications()[0].join(' '), /review-until-approve: ten checks in a row failed/);
});

test('criterion 5: a failed round is not retried by the watcher on unchanged state; an invocation retries it at once', () => {
  const w = watched();
  w.agents({ reviewer: [null], verifier: [] });
  w.update((v) => { v.reviews.push(stateReview(w, {})); });
  w.push({ 'a.js': 'one\ntwo\nbad line\nthree\nfour\n' });
  entry(w);
  settle(w);
  assert.ok(until(() => w.agentRuns().length === 2 && w.idle()), 'the round ran its reviewer twice');
  assert.ok(w.lines().includes('o/r#5 round failed: reviewer-output'), w.lines().join('\n'));
  assert.equal(w.notifications().length, 1);
  settle(w);
  settle(w);
  assert.ok(until(() => w.idle()));
  assert.equal(w.agentRuns().length, 2, 'the watcher holds the failed state');
  // The user's invocation retries at once.
  w.agents({ reviewer: [proposal], verifier: [{ findings: [kept], verdicts: [] }] });
  const r = w.sh(['round', 'o/r', '5', '--harness', 'claude']);
  assert.equal(r.out[0].event, 'published');
  assert.equal(w.agentRuns().length, 4);
  // Something new after the hold runs again.
  w.agents({ reviewer: [null], verifier: [] });
  w.push({ 'a.js': 'one\ntwo\nbad line\nthree\nfive\n' });
  settle(w);
  assert.ok(until(() => w.agentRuns().length === 6 && w.idle()), `agent runs: ${w.agentRuns().length}`);
});

test('criterion 6: a question line stays pending across watch status until decide answers it; other lines are marked shown', () => {
  const w = watched();
  w.update((v) => { v.reviews.push(stateReview(w, { findings: [finding(w, { status: 'asked' })] })); });
  entry(w);
  w.check();
  const asked = 'o/r#5 question asked 1.1 https://github.com/o/r/pull/5';
  assert.deepEqual(w.lines(), ['o/r#5 review-blocked label restored', asked]);
  const status = w.sh(['watch', 'status', '--harness', 'claude']);
  assert.deepEqual(status.out.filter((l) => l.event === 'notice').map((l) => l.notice), ['o/r#5 review-blocked label restored', asked]);
  assert.deepEqual(w.lines(), [asked]);
  w.sh(['watch', 'status', '--harness', 'claude']);
  assert.deepEqual(w.lines(), [asked]);
  // A check does not add it again.
  w.check();
  assert.deepEqual(w.lines(), [asked]);
  assert.equal(w.notifications().length, 1);
  const d = w.sh(['decide', 'o/r', '5', '1.1', 'waive', '--reason', 'Fine as is.', '--harness', 'claude']);
  assert.equal(d.out[0].event, 'decided');
  assert.deepEqual(w.lines(), []);
});

test('criterion 7: the user\'s stop removes the entry, posts nothing, and leaves pr-to-merge\'s watcher running', { skip: process.platform === 'win32' }, () => {
  const w = watched({}, '0.2');
  w.update((v) => { v.reviews.push(stateReview(w, {})); });
  // pr-to-merge's watcher: its lock is held by a running process and its list is not empty.
  const ptm = path.join(w.base, 'pr-to-merge');
  fs.mkdirSync(ptm, { recursive: true });
  fs.writeFileSync(path.join(ptm, 'watch.json'), JSON.stringify({ entries: { 'o/r': { repo: 'o/r' } } }));
  const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../../../runtime/watcher'))}).takeLock(${JSON.stringify(path.join(ptm, 'watcher.lock'))}); setTimeout(() => {}, 60000)`], { stdio: 'ignore' });
  try {
    assert.ok(until(() => runtime.watcherRunning(ptm)));
    w.sh(['watch', 'add', 'o/r', '5', '--harness', 'claude']);
    assert.ok(until(() => w.watcher() && alive(w.watcher().pid)));
    const { pid } = w.watcher();
    const before = posts(w).length;
    const r = w.sh(['watch', 'remove', 'o/r', '5', '--harness', 'claude']);
    assert.deepEqual(r.out, [{ event: 'unwatched', pr: 'o/r#5' }]);
    assert.deepEqual(w.list(), {});
    assert.ok(until(() => !alive(pid)), 'review-until-approve\'s watcher exits');
    assert.equal(posts(w).length, before);
    assert.equal(runtime.watcherRunning(ptm), true, 'pr-to-merge\'s watcher still runs');
    assert.deepEqual(Object.keys(runtime.readWatch(ptm).entries), ['o/r']);
  } finally {
    holder.kill();
  }
});

test('criterion 8: watch status and the session-start channel report a stopped watcher, and invoking the skill restarts it', { skip: process.platform === 'win32' }, () => {
  const w = watched({}, '0.2');
  w.update((v) => { v.reviews.push(stateReview(w, {})); });
  entry(w);
  const status = w.sh(['watch', 'status', '--harness', 'claude']);
  assert.deepEqual(status.out.slice(0, 2), [{ event: 'watcher', running: false }, { event: 'watching', pr: 'o/r#5' }]);
  const env = { CLAUDE_CONFIG_DIR: w.config };
  assert.match(runtime.sessionStartOutput('', 'claude', env), /review-until-approve: the watcher is not running; invoke review-until-approve to start it again/);
  const add = w.sh(['watch', 'add', 'o/r', '5', '--harness', 'claude']);
  assert.deepEqual(add.out.at(-1), { event: 'watcher', running: false, started: true });
  assert.ok(until(() => w.watcher() && alive(w.watcher().pid)));
  assert.ok(until(() => w.sh(['watch', 'status', '--harness', 'claude']).out.some((l) => l.event === 'watching' && l.checked)), 'a check time is shown');
  assert.equal(runtime.sessionStartOutput('', 'claude', env), '');
  assert.deepEqual(w.sh(['watch', 'add', 'o/r', '5', '--harness', 'claude']).out.at(-1), { event: 'watcher', running: true, started: false });
  stop(w);
});

test('watch add starts nothing where the state directory or GitHub cannot be reached, and rejects an option that is not a name', () => {
  const w = watched({ login: null });
  const r = w.sh(['watch', 'add', 'o/r', '5', '--harness', 'claude']);
  assert.deepEqual(r.out, [{ event: 'watcher', running: false, started: false, reason: 'probe' }]);
  assert.deepEqual(w.list(), {});
  assert.equal(w.watcher(), null);
  const bad = w.run(['watch', 'add', 'o/r', '5', '--harness', 'claude', '--model', '--dangerous'], w.extra);
  assert.equal(bad.status, 2);
});
