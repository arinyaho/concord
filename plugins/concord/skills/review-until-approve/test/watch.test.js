'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

const WATCH = path.join(__dirname, '..', 'scripts', 'watch.js');

// A fake `gh` on PATH. Each `pr view` call is one poll and advances to the next
// step of the scenario; the last step repeats. The api calls answer for the current step.
function setup(steps, ledger) {
  const dir = tempDir('rua-watch-');
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(steps));
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const steps = JSON.parse(fs.readFileSync(dir + '/scenario.json', 'utf8'));
const cursorFile = dir + '/cursor';
const args = process.argv.slice(2);
let cursor = fs.existsSync(cursorFile) ? Number(fs.readFileSync(cursorFile, 'utf8')) : -1;
if (args[0] === 'pr') { cursor += 1; fs.writeFileSync(cursorFile, String(cursor)); }
const step = steps[Math.min(cursor, steps.length - 1)];
if (step.fail) { process.stderr.write('boom'); process.exit(1); }
if (args[0] === 'pr') console.log(JSON.stringify({ headRefOid: step.head, state: step.state || 'OPEN', isDraft: false, author: { login: 'dev' } }));
else console.log(JSON.stringify([args.some((a) => a.includes('/pulls/')) ? step.pulls || [] : step.issues || []]));
`, { mode: 0o755 });
  return dir;
}

const ledger = { reviewer: 'bot', rounds: [{ n: 1, head: 'h1', mergeBase: 'm', intent: 'i', submittedAt: new Date().toISOString(), commentIds: [11] }], findings: [{ id: 'w', key: 'w', status: 'open' }] };
const reply = () => ({ in_reply_to_id: 11, user: { login: 'dev' }, created_at: new Date(Date.now() + 1000).toISOString() });

function run(steps, extra = ledger) {
  const dir = setup(steps, extra);
  const r = spawnSync('node', [WATCH, path.join(dir, 'ledger.json'), 'o/r', '5', '--interval', '0.01'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 20000 });
  return { out: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), code: r.status };
}

test('watch: a push alone and a reply alone stay silent until the PR is merged', () => {
  const { out } = run([{ head: 'h2' }, { head: 'h2' }, { head: 'h1', pulls: [reply()] }, { head: 'h1', pulls: [reply()] }, { head: 'h1', state: 'MERGED' }]);
  assert.deepEqual(out, [{ event: 'merged' }]);
});

test('watch: a push plus a reply wakes once, after the head holds for two polls', () => {
  const { out, code } = run([{ head: 'h2', pulls: [reply()] }, { head: 'h3', pulls: [reply()] }, { head: 'h3', pulls: [reply()] }]);
  assert.deepEqual(out, [{ event: 'round', head: 'h3' }]);
  assert.equal(code, 0);
});

test('watch: a reply on the PR conversation counts, a closed PR wakes', () => {
  assert.deepEqual(run([{ head: 'h2', issues: [{ user: { login: 'dev' }, created_at: new Date(Date.now() + 1000).toISOString() }] }]).out, [{ event: 'round', head: 'h2' }]);
  assert.deepEqual(run([{ head: 'h1' }, { head: 'h1', state: 'CLOSED' }]).out, [{ event: 'closed' }]);
});

test('watch: ten failed polls end with an error event and exit status 1', () => {
  const { out, code } = run([{ fail: true }]);
  assert.equal(out[0].event, 'error');
  assert.equal(code, 1);
});

function runIn(dir, extraArgs) {
  const r = spawnSync('node', [WATCH, path.join(dir, 'ledger.json'), 'o/r', '5', '--interval', '0.01', ...extraArgs], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 20000 });
  return { out: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), code: r.status };
}

test('watch: --max-wait ends a silent wait with an idle event and exit status 0', () => {
  const dir = setup([{ head: 'h1' }], ledger);
  const { out, code } = runIn(dir, ['--max-wait', '0.2']);
  assert.deepEqual(out, [{ event: 'idle' }]);
  assert.equal(code, 0);
});

test('watch: a nudge is not repeated by the next bounded run, with or without the session recording it', () => {
  const old = { ...ledger, rounds: [{ ...ledger.rounds[0], submittedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }] };
  const dir = setup([{ head: 'h2' }], old);
  assert.deepEqual(runIn(dir, ['--max-wait', '5']).out, [{ event: 'nudge', kind: 'push-only', head: 'h2', replyAt: null }]);
  assert.deepEqual(runIn(dir, ['--max-wait', '0.2']).out, [{ event: 'idle' }]);
});

test('watch: the head seen by one bounded run counts toward the next run\'s two-poll stability', () => {
  const dir = setup([{ head: 'h2', pulls: [reply()] }], ledger);
  fs.writeFileSync(path.join(dir, 'ledger.json.watch.json'), JSON.stringify({ previousHead: 'h2' }));
  assert.deepEqual(runIn(dir, ['--max-wait', '5']).out, [{ event: 'round', head: 'h2' }]);
  const fresh = setup([{ head: 'h2', pulls: [reply()] }], ledger);
  assert.deepEqual(runIn(fresh, ['--max-wait', '0.01']).out, [{ event: 'idle' }]);
});

test('watch: a nudge in the ledger does not hide a later nudge the sidecar already showed', () => {
  const old = { ...ledger, nudged: { kind: 'push-only', head: 'h0', replyAt: null }, rounds: [{ ...ledger.rounds[0], submittedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }] };
  const dir = setup([{ head: 'h2' }], old);
  assert.equal(runIn(dir, ['--max-wait', '5']).out[0].event, 'nudge');
  assert.deepEqual(runIn(dir, ['--max-wait', '0.2']).out, [{ event: 'idle' }]);
});

test('watch: --max-wait ends at the deadline, not at the end of the next poll interval', () => {
  const dir = setup([{ head: 'h1' }], ledger);
  const started = Date.now();
  const r = spawnSync('node', [WATCH, path.join(dir, 'ledger.json'), 'o/r', '5', '--interval', '10', '--max-wait', '0.3'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 20000 });
  assert.deepEqual(JSON.parse(r.stdout), { event: 'idle' });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('watch: failed polls add up across bounded runs until the error event', () => {
  const dir = setup([{ fail: true }], ledger);
  for (let i = 1; i < 10; i++) assert.deepEqual(runIn(dir, ['--max-wait', '0.01']).out, [{ event: 'idle' }], `run ${i}`);
  const last = runIn(dir, ['--max-wait', '0.01']);
  assert.equal(last.out[0].event, 'error');
  assert.equal(last.code, 1);
});

test('watch: a run started after an error event does not error on its first failed poll', () => {
  const dir = setup([{ fail: true }], ledger);
  for (let i = 1; i < 10; i++) runIn(dir, ['--max-wait', '0.01']);
  assert.equal(runIn(dir, ['--max-wait', '0.01']).out[0].event, 'error');
  assert.deepEqual(runIn(dir, ['--max-wait', '0.01']).out, [{ event: 'idle' }]);
});

test('watch: a non-numeric or non-positive --max-wait or --interval is refused with exit status 2', () => {
  const dir = setup([{ head: 'h1' }], ledger);
  for (const args of [['--max-wait', 'soon'], ['--max-wait', '0'], ['--max-wait'], ['--interval', 'x']]) {
    const r = spawnSync('node', [WATCH, path.join(dir, 'ledger.json'), 'o/r', '5', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 5000 });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage/);
  }
});
