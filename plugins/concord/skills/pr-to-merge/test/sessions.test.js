'use strict';
// Headless sessions on the user's own pull requests: what starts one, what it reads, and what the script does with its
// result. The agent is a fake `claude` or `codex` (world.js) that goes through the real read-only hook; git is real,
// with a local origin as the pull request's repository.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, pr, review, approve, comment, threadComment, gitPr, sh } = require('./world');
const runtime = require('../../../runtime/watcher');

const posix = { skip: process.platform === 'win32' };
const at = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// The user's own pull request #1 from branch `pr` of a local origin, with a clone as --checkout. `conflict` makes main
// and the branch change the same line.
function setup({ over = {}, settings = { private: true }, extra = {}, conflict = false, n = 1 } = {}) {
  const g = gitPr(n, ({ sh: git, edit }) => {
    git('checkout', '-q', '-b', 'pr');
    edit('one\ntwo\nPR\n', 'on the branch');
    if (conflict) { git('checkout', '-q', 'main'); edit('one\ntwo\nMAIN\n', 'on main'); }
  });
  const w = world({ 'acme/app': { prs: [pr(n, { headRefName: 'pr', headRefOid: g.head, ...over })], ...settings && { settings } } }, extra);
  return { g, w, args: ['acme/app', '--checkout', g.checkout] };
}
const branch = (g) => at(g.bare, 'rev-parse', 'refs/heads/pr');
const posts = (w) => w.calls().filter((c) => c.includes('-X') && c.includes('POST') && /comments/.test(c.find((x) => x.startsWith('repos/'))));
const bodyOf = (call) => call[call.indexOf('-f') + 1].replace(/^body=/, '');

test('a review item starts one session in a worktree with no .git; the edit is committed with the template message and pushed as a fast-forward; the reply is posted', posix, () => {
  const c = comment('monalisa', 5, { body: 'Line three should say four.' });
  const { g, w, args } = setup({ over: { issueComments: [c] } });
  const before = ['rev-parse HEAD', 'status --porcelain', 'for-each-ref refs/heads'].map((x) => at(g.checkout, ...x.split(' ')));
  w.logGit();
  w.agent({ edits: { 'a.txt': 'one\ntwo\nfour\n' }, result: { replies: [{ item: `comment:${c.id}`, body: 'Agreed: line three now says four.' }] } });
  const r = w.run(args);
  assert.deepEqual(r.reviews, [], 'the item went to the session, not to a review line');
  const [s] = w.settle();
  assert.equal(w.sessions().length, 1);
  assert.equal(s.kind, 'review');
  // The session: its working directory is the worktree, which has no .git; it was given the item.
  const [call, seen] = w.agentCalls();
  assert.equal(call.cwd, path.join(fs.realpathSync(s.dir), 'worktree'));
  assert.equal(seen.gitInWorktree, false);
  assert.deepEqual(seen.input.items.map((i) => [i.key, i.author, i.body]), [[`comment:${c.id}`, 'monalisa', 'Line three should say four.']]);
  // The push: one commit on the old head, with the fixed message and no agent text.
  const head = branch(g);
  assert.equal(at(g.bare, 'rev-parse', `${head}^`), g.head);
  assert.equal(at(g.bare, 'log', '-1', '--format=%B', head), `Answer the review on #1\n\nBy a pr-to-merge session. Items: comment:${c.id}`);
  assert.equal(at(g.bare, 'show', `${head}:a.txt`), 'one\ntwo\nfour');
  // The reply: escaped, with the commit and the mention the script adds.
  const [reply] = posts(w);
  assert.ok(reply.includes('repos/acme/app/issues/1/comments'), JSON.stringify(reply));
  assert.match(bodyOf(reply), new RegExp(`^${c.html_url.replace(/[.?]/g, '\\$&')}\\n> Agreed: line three now says four\\.\\n\\nCommit ${head.slice(0, 12)}\\.\\n\\ncc @monalisa$`));
  assert.equal(s.status.status, 'done');
  assert.deepEqual(w.notices().filter((l) => l.startsWith('session ')), [`session acme/app#1 review done: pushed ${head.slice(0, 8)} ${path.join(s.dir, 'status.json')}`]);
  // The user's checkout is unchanged; every git call on the session's directories names them with the four options.
  assert.deepEqual(['rev-parse HEAD', 'status --porcelain', 'for-each-ref refs/heads'].map((x) => at(g.checkout, ...x.split(' '))), before);
  const own = w.gitCalls().filter((a) => a.some((x) => x.includes(path.join(s.dir, 'git')) || x.includes(path.join(s.dir, 'worktree'))));
  assert.ok(own.length >= 6, JSON.stringify(own));
  for (const a of own) {
    assert.deepEqual(a.slice(0, 6), [`--git-dir=${path.join(s.dir, 'git')}`, `--work-tree=${path.join(s.dir, 'worktree')}`, '-c', `core.hooksPath=${path.join(s.dir, 'hooks')}`, '-c', 'core.fsmonitor=false'], JSON.stringify(a));
  }
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ['record.json', 'status.json'], 'the worktree, git directory and inputs are removed');
  // Nothing is handed over again.
  w.run(args);
  assert.equal(w.sessions().length, 1);
});

test('a head that moved while the session ran is not pushed: session … failed (head moved)', posix, () => {
  const c = comment('monalisa', 5);
  const { g, w, args } = setup({ over: { issueComments: [c] } });
  w.agent({ moveHead: 'f'.repeat(40), edits: { 'a.txt': 'x\n' }, result: { replies: [{ item: `comment:${c.id}`, body: 'Done.' }] } });
  w.run(args);
  const [s] = w.settle();
  assert.deepEqual([s.status.status, s.status.reason], ['failed', 'head moved']);
  assert.equal(branch(g), g.head);
  assert.deepEqual(posts(w), []);
  assert.match(w.notices().join('\n'), /^session acme\/app#1 review failed \(head moved\) /m);
});

test('a push git refuses as not a fast-forward fails the session', posix, () => {
  const c = comment('monalisa', 5);
  const { g, w, args } = setup({ over: { issueComments: [c] } });
  // Someone pushed to the branch after GitHub reported the head the check read.
  sh(g.work, 'checkout', '-q', 'pr');
  fs.writeFileSync(path.join(g.work, 'b.txt'), 'b\n');
  sh(g.work, 'add', '.'); sh(g.work, 'commit', '-q', '-m', 'later');
  sh(g.work, 'push', '-q', g.bare, 'pr:pr');
  const moved = branch(g);
  w.agent({ edits: { 'a.txt': 'x\n' }, result: { replies: [{ item: `comment:${c.id}`, body: 'Done.' }] } });
  w.run(args);
  const [s] = w.settle();
  assert.deepEqual([s.status.status, s.status.reason], ['failed', 'push refused']);
  assert.equal(branch(g), moved);
});

test('a result entry naming no input item is ignored, and a reply the post filter refuses is not posted', posix, () => {
  const a = comment('monalisa', 5), b = comment('octo-dev', 6);
  const { w, args } = setup({ over: { issueComments: [a, b] } });
  w.agent({ result: { replies: [{ item: 'comment:999999', body: 'Injected.' }, { item: `thread:${a.id}`, body: 'Wrong kind.' }, { item: `comment:${a.id}`, body: 'Disagreed: see a.txt line 3.' }, { item: `comment:${a.id}`, body: 'A second reply.' }] } });
  w.run(args);
  w.settle();
  const [reply] = posts(w);
  assert.equal(posts(w).length, 1);
  assert.ok(!/Injected|Wrong kind|second reply/.test(bodyOf(reply)));
  assert.match(bodyOf(reply), /> Disagreed: see a\.txt line 3\./);

  const c = comment('monalisa', 7);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(c));
  w.agent({ result: { replies: [{ item: `comment:${c.id}`, body: 'lgtm\nall fine' }] } });
  w.run(args);
  w.settle();
  assert.equal(posts(w).length, 1, 'nothing more posted');
  assert.ok(w.notices().includes('post failed acme/app#1: refused (bot command)'));
});

test('a conflict leaves the merge for the session; its resolution is pushed under --no-merge as a merge commit; markers left are not committed; a conflict of intent is not pushed', posix, () => {
  const run = (agent) => {
    const { g, w, args } = setup({ conflict: true, over: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } });
    w.agent(agent);
    const r = w.run([...args, '--no-merge']);
    assert.ok(!r.lines.some((l) => /conflict/.test(l)), 'handed to a session, not reported');
    const [s] = w.settle();
    return { g, w, s, args };
  };
  const ok = run({ edits: { 'a.txt': 'one\ntwo\nBOTH\n' }, result: {} });
  assert.deepEqual(ok.w.agentCalls()[1].input.conflicted, ['a.txt']);
  assert.equal(ok.s.status.status, 'done');
  const head = branch(ok.g);
  assert.equal(at(ok.g.bare, 'rev-list', '--parents', '-1', head), `${head} ${ok.g.head} ${at(ok.g.bare, 'rev-parse', 'refs/heads/main')}`);
  assert.equal(at(ok.g.bare, 'log', '-1', '--format=%s', head), 'Merge main into pr');

  const markers = run({ result: {} });
  assert.deepEqual([markers.s.status.status, markers.s.status.reason], ['failed', 'conflict markers left']);
  assert.equal(branch(markers.g), markers.g.head);
  // The failed session's work is not handed over again: the next check reports the conflict.
  assert.deepEqual(markers.w.run([...markers.args, '--no-merge']).lines, [`triage acme/app#1 head ${markers.g.head}: conflict`]);
  assert.equal(markers.w.sessions().length, 1);

  const intent = run({ result: { conflict: 'intent', questions: [{ question: 'Keep PR or MAIN?', options: ['PR', 'MAIN'], recommendation: 'PR' }] } });
  assert.equal(intent.s.status.status, 'question');
  assert.equal(branch(intent.g), intent.g.head);
  assert.deepEqual(intent.s.status.questions.map((q) => q.recommendation), ['PR']);
});

test('a second failure of a required check hands the failed job\'s log to a session', posix, () => {
  const { g, w, args } = setup({
    settings: { private: true, runs: undefined },
    over: { checks: [{ name: 'build', required: true, conclusion: 'FAILURE', runId: 7 }] },
  });
  w.update((x) => Object.assign(x.repos['acme/app'], { runs: { 7: { status: 'completed', conclusion: 'failure', run_attempt: 2 } }, jobs: { 7: [{ id: 70, name: 'test', status: 'completed', conclusion: 'failure' }, { id: 71, name: 'lint', status: 'completed', conclusion: 'success' }] }, logs: { 70: 'expected 4, got 3\n' } }));
  w.agent({ edits: { 'a.txt': 'one\ntwo\nfour\n' }, result: {} });
  const r = w.run(args);
  assert.ok(!r.lines.some((l) => /still red/.test(l)));
  const [s] = w.settle();
  assert.equal(s.kind, 'check');
  assert.deepEqual(w.agentCalls()[1].logs, ['expected 4, got 3\n']);
  assert.equal(at(g.bare, 'log', '-1', '--format=%B', branch(g)), 'Fix the failing check on #1\n\nBy a pr-to-merge session. Runs: 7');
});

test('in a public repository a session reads only counting accounts\' and --reviewer-bot accounts\' items; the others are review lines; a repository that turns public is filtered from the next check', posix, () => {
  const ok = comment('monalisa', 5), outsider = comment('stranger', 6), bot = comment('coderabbitai[bot]', 7), otherBot = comment('helper[bot]', 8);
  const { w, args } = setup({ settings: { private: false }, over: { issueComments: [ok, outsider, bot, otherBot] }, extra: { permissions: { stranger: 'read' } } });
  w.agent({ result: {} });
  const r = w.run([...args, '--reviewer-bot', 'app/coderabbitai']);
  assert.deepEqual(r.reviews.map((l) => l.split(': ')[1].split(' https')[0]), ['comment by stranger', 'comment by helper[bot]']);
  w.settle();
  const input = w.agentCalls()[1].input;
  assert.deepEqual(input.items.map((i) => [i.author, i.automated]), [['monalisa', false], ['coderabbitai[bot]', true]]);
  assert.ok(!JSON.stringify(input).includes('stranger') && !JSON.stringify(input).includes('helper'));

  // Private at first: an outsider's comment goes to a session. Public at the next check: the next one does not.
  const p = setup({ extra: { permissions: { stranger: 'read' } }, over: { issueComments: [comment('stranger', 5)] } });
  p.w.agent({ result: {} });
  p.w.run(p.args);
  p.w.settle();
  assert.equal(p.w.sessions().length, 1);
  p.w.update((x) => { x.repos['acme/app'].settings.private = false; x.repos['acme/app'].prs[0].issueComments.push(comment('stranger', 9, { html_url: 'https://github.com/acme/app/pull/1#issuecomment-9' })); });
  assert.deepEqual(p.w.run(p.args).reviews, [`review acme/app#1 head ${p.g.head.slice(0, 8)}: comment by stranger https://github.com/acme/app/pull/1#issuecomment-9`]);
  assert.equal(p.w.sessions().length, 1);
});

test('replies: an automated reviewer\'s thread is resolved, a person\'s is not; each person with write access who reviewed is asked again once per head', posix, () => {
  const botRoot = threadComment('coderabbitai[bot]', { body: 'Off by one.' });
  const personRoot = threadComment('monalisa', { body: 'Rename this.' });
  const { w, args } = setup({ over: {
    comments: [botRoot, personRoot], threads: [{ root: botRoot.id }, { root: personRoot.id }],
    reviews: [review('monalisa', 'COMMENTED', 'x', 5, { body: 'Two points.' }), review('coderabbitai[bot]', 'COMMENTED', 'x', 6, { body: 'Summary.' }), review('stranger', 'COMMENTED', 'x', 7)],
  }, extra: { permissions: { stranger: 'read' } } });
  const [mona] = w.get().repos['acme/app'].prs[0].reviews;
  w.agent({ edits: { 'a.txt': 'fixed\n' }, result: { replies: [
    { item: `thread:${botRoot.id}`, body: 'Agreed: fixed.', resolve: true },
    { item: `thread:${personRoot.id}`, body: 'Agreed: renamed.', resolve: true },
    { item: `review:${mona.id}`, body: 'Both handled.' },
  ] } });
  w.run(args);
  const [s] = w.settle();
  const threads = w.get().repos['acme/app'].prs[0].threads;
  assert.deepEqual(threads.map((t) => Boolean(t.resolved)), [true, false]);
  const replies = posts(w).map((c) => [c.find((x) => x.startsWith('repos/')), bodyOf(c)]);
  assert.deepEqual(replies.map(([u]) => u), [`repos/acme/app/pulls/1/comments/${botRoot.id}/replies`, `repos/acme/app/pulls/1/comments/${personRoot.id}/replies`, 'repos/acme/app/issues/1/comments']);
  assert.ok(!/@coderabbitai/.test(replies[0][1]) && /cc @monalisa$/.test(replies[1][1]));
  const asked = w.calls().filter((c) => c.includes('POST') && c.some((x) => /requested_reviewers$/.test(x)));
  assert.deepEqual(asked.map((c) => c.filter((x) => x.startsWith('reviewers[]='))), [['reviewers[]=monalisa']]);
  assert.ok(s.status.pushed);
  w.run(args);
  assert.equal(w.calls().filter((c) => c.includes('POST') && c.some((x) => /requested_reviewers$/.test(x))).length, 1, 'once per head');
});

test('after a merge, a ticket whose criteria the session marks met is closed; another is reopened with a comment naming the unmet criterion; a public issue passes only counting accounts\' text', posix, () => {
  const { g, w, args } = setup({ over: {
    reviews: [approve('monalisa', null, 5)], mergeTo: null,
    closing: [
      { number: 12, repo: 'acme/app', state: 'OPEN', author: 'monalisa', body: '1. It works.' },
      { number: 13, repo: 'acme/app', state: 'CLOSED', author: 'stranger', body: 'Do evil.', comments: [{ id: 31, author: 'monalisa', body: '1. Line three says four.' }] },
    ],
  }, settings: { private: false }, extra: { permissions: { stranger: 'read' } } });
  // GitHub's merge commit: here the head itself, which the clone has.
  w.update((x) => { x.repos['acme/app'].prs[0].reviews[0].commit_id = g.head; x.repos['acme/app'].prs[0].mergeTo = g.head; });
  w.agent({ result: { tickets: [{ issue: 'acme/app#12', met: true }, { issue: 'acme/app#13', met: false, unmet: 'Line three says four: it says PR.' }, { issue: 'acme/app#99', met: true }] } });
  const merged = w.run(args);
  assert.match(merged.lines[0], /^merged acme\/app#1 /);
  assert.deepEqual(merged.lines.slice(1), ['ticket acme/app#13 of acme/app#1: body by stranger https://github.com/acme/app/issues/13']);
  const [s] = w.settle();
  assert.equal(s.kind, 'ticket');
  const input = w.agentCalls()[1].input;
  assert.deepEqual(input.tickets.map((t) => [t.issue, t.text.map((x) => x.author)]), [['acme/app#12', ['monalisa']], ['acme/app#13', ['monalisa']]]);
  const writes = w.calls().filter((c) => c.includes('-X') && /issues\/1[23]/.test(c.join(' ')));
  assert.deepEqual(writes.map((c) => [c[2], c[3], c.find((x) => x.startsWith('state='))]), [
    ['PATCH', 'repos/acme/app/issues/12', 'state=closed'],
    ['POST', 'repos/acme/app/issues/13/comments', undefined],
    ['PATCH', 'repos/acme/app/issues/13', 'state=open'],
  ]);
  assert.match(bodyOf(writes[1]), /> Line three says four: it says PR\.$/);
  assert.ok(!writes.some((c) => c.join(' ').includes('issues/99')));
  assert.equal(w.sessions().length, 1);
});

test('limits: no second session while one runs; work for it waits unreported and starts after', posix, () => {
  const g1 = gitPr(1, ({ sh: git, edit }) => { git('checkout', '-q', '-b', 'pr'); edit('a\n', 'one'); });
  // #2 is approved and mergeable; its waiting item, an automated account's comment, holds nothing by itself.
  const w = world({ 'acme/app': { prs: [pr(1, { headRefName: 'pr', headRefOid: g1.head, issueComments: [comment('monalisa', 5)] }), pr(2, { headRefName: 'pr', headRefOid: g1.head, reviews: [approve('monalisa', g1.head, 4)], issueComments: [comment('helper[bot]', 6)] })], settings: { private: true } } });
  w.agent({ sleep: 4000, result: {} });
  const args = ['acme/app', '--checkout', g1.checkout];
  for (let i = 0; i < 2; i++) {
    const r = w.run(args);
    assert.deepEqual(r.reviews.filter((l) => /comment by/.test(l)), [], 'the second pull request\'s item waits, unreported');
    assert.ok(!r.lines.some((l) => /^merged acme\/app#2/.test(l)), 'and does not merge with its item unanswered');
  }
  assert.equal(w.sessions().length, 1);
  assert.equal(w.sessions()[0].number, 1);
  w.settle();
  w.agent({ result: {} });
  w.run(args);
  w.settle();
  assert.deepEqual(w.sessions().map((x) => x.number), [1, 2]);
});

test('limits: a seventh session within 24 hours is not started (session … cap) until the skill is invoked again', posix, () => {
  const { w, args } = setup();
  w.agent({ result: {} });
  // Six sessions of this pull request ended in the last hour, after the user's invocation two hours ago.
  w.run(args);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('monalisa', 5)));
  const watch = path.join(w.skillDir, 'watch.json');
  const list = JSON.parse(fs.readFileSync(watch, 'utf8'));
  list.entries['acme/app'].invoked = new Date(Date.now() - 2 * 3600e3).toISOString();
  fs.writeFileSync(watch, JSON.stringify(list));
  const root = path.join(w.skillDir, 'sessions');
  for (let i = 0; i < 6; i++) {
    const dir = path.join(root, `${Date.now() - 3600e3 + i}-0000000${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ id: path.basename(dir), repo: 'acme/app', number: 1, kind: 'review', started: new Date(Date.now() - 3600e3).toISOString(), pid: null }));
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ status: 'done' }));
  }
  const r = w.script(['check', '--harness', 'claude']);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.includes('session acme/app#1 cap: 6 sessions in 24 hours; none starts until the skill is invoked again'), r.stdout);
  assert.ok(lines.some((l) => l.startsWith('review acme/app#1 ')), 'the item is reported for the skill instead');
  assert.equal(w.sessions().length, 6);
  // A new invocation lifts the cap.
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(comment('monalisa', 9)));
  w.run(args);
  w.settle();
  assert.equal(w.sessions().length, 7);
});

test('limits: a failed session\'s items are not handed to a new session; a later item is', posix, () => {
  const c = comment('monalisa', 5);
  const { w, args } = setup({ over: { issueComments: [c] } });
  w.agent({ resultRaw: 'not json' });
  w.run(args);
  const [s] = w.settle();
  assert.deepEqual([s.status.status, s.status.reason], ['failed', 'malformed output: not a JSON object']);
  const again = w.run(args);
  assert.deepEqual([...again.reviews, ...again.lines], []);
  assert.equal(w.sessions().length, 1);
  const later = comment('monalisa', 9);
  w.update((x) => x.repos['acme/app'].prs[0].issueComments.push(later));
  w.agent({ result: {} });
  w.run(args);
  w.settle();
  assert.equal(w.sessions().length, 2);
  assert.deepEqual(w.agentCalls().filter((x) => x.input).at(-1).input.items.map((i) => i.key), [`comment:${later.id}`]);
});

test('limits: a session recorded by a previous watcher is stopped and its directories removed; a dead session\'s are removed too', posix, () => {
  const { w, args } = setup();
  const root = path.join(w.skillDir, 'sessions');
  // A process that is not this test's child, so that once stopped it is gone rather than a zombie.
  const child = { pid: Number(execFileSync('sh', ['-c', `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 60000)" >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim()) };
  const make = (id, rec) => {
    const dir = path.join(root, id);
    for (const d of ['worktree', 'session', 'git', 'hooks']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ id, repo: 'acme/app', number: 1, kind: 'review', started: new Date().toISOString(), ...rec }));
    return dir;
  };
  const live = make('1000-aaaaaaaa', { pid: child.pid, start: runtime.startTime(child.pid), watcher: { pid: 1, start: 'an earlier watcher' } });
  const dead = make('1001-bbbbbbbb', { pid: 2 ** 22 + 7, start: 'gone', watcher: null });
  const r = w.run(args);
  for (let i = 0; i < 50 && runtime.running({ pid: child.pid, start: null }); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.equal(runtime.running({ pid: child.pid, start: null }), false, 'the process was stopped');
  for (const dir of [live, dead]) {
    assert.deepEqual(fs.readdirSync(dir).sort(), ['record.json', 'status.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).reason, 'stopped');
  }
  assert.equal(r.lines.filter((l) => /^session acme\/app#1 review failed \(stopped\) /.test(l)).length, 2);
});

test('confinement: under Claude Code the session\'s shell call and a write outside its directories are denied', posix, () => {
  const c = comment('monalisa', 5);
  const { w, args } = setup({ over: { issueComments: [c] } });
  w.agent({ result: {} });
  w.run(args);
  w.settle();
  const [call] = w.agentCalls();
  assert.deepEqual([call.harness, call.tools, call.bash, call.outside], ['claude', 'Read,Grep,Glob,Edit,Write', 'deny', 'deny']);
  assert.ok(!call.env.some((k) => /GH_TOKEN|GITHUB_TOKEN/.test(k)));
});

test('confinement: under Codex no session starts when the pre-flight finds the home readable or the network open', posix, () => {
  for (const [behavior, reason] of [[{ home: 'open' }, 'preflight failed: home readable'], [{ network: 'open' }, 'preflight failed: network reachable']]) {
    const c = comment('monalisa', 5);
    const { w, args } = setup({ over: { issueComments: [c] } });
    w.agent({ ...behavior, result: {} });
    w.run(args, { harness: 'codex' });
    const [s] = w.settle('codex');
    assert.deepEqual([s.status.status, s.status.reason], ['failed', reason]);
    assert.ok(!w.agentCalls().some((x) => x.harness), 'no agent ran');
  }
  // With both refused, the Codex session runs in its worktree under the session-worktree root.
  const c = comment('monalisa', 5);
  const { w, args } = setup({ over: { issueComments: [c] } });
  w.agent({ result: {} });
  w.run(args, { harness: 'codex' });
  const [s] = w.settle('codex');
  assert.equal(s.status.status, 'done');
  assert.equal(w.agentCalls().find((x) => x.harness).cwd, path.join(fs.realpathSync(s.dir), 'worktree'));
});

test('a refused request to review again is recorded, and the session still ends done', posix, () => {
  const c = comment('monalisa', 5);
  const { w, args } = setup({ over: { issueComments: [c], reviews: [review('monalisa', 'COMMENTED', 'x', 4, { body: 'A point.' })] }, extra: { fail: ['-X POST repos/acme/app/pulls/1/requested_reviewers'] } });
  w.agent({ edits: { 'a.txt': 'x\n' }, result: { replies: [{ item: `comment:${c.id}`, body: 'Done.' }] } });
  w.run(args);
  const [s] = w.settle();
  assert.equal(s.status.status, 'done');
  assert.ok(w.notices().includes(`request failed acme/app#1 head ${s.status.pushed.slice(0, 8)}: HTTP 502`), w.notices().join('\n'));
});

test('a .git the session made anywhere in the worktree is refused before any git call: nothing is committed or run', posix, () => {
  const c = comment('monalisa', 5);
  const { g, w, args } = setup({ over: { issueComments: [c] } });
  const marker = path.join(w.dir, 'ran');
  w.agent({ edits: { 'a.txt': 'x\n', 'sub/f.txt': 'y\n', 'sub/.git/config': `[filter "x"]\n\tclean = touch ${marker}\n` }, result: { replies: [{ item: `comment:${c.id}`, body: 'Done.' }] } });
  w.logGit();
  w.run(args);
  const [s] = w.settle();
  assert.deepEqual([s.status.status, s.status.reason], ['failed', 'nested repository']);
  assert.equal(branch(g), g.head);
  assert.ok(!fs.existsSync(marker));
  assert.ok(!w.gitCalls().some((a) => a.includes('add')), 'no git add ran');
});

test('a reply the filter refuses leaves its automated reviewer\'s thread open; a failure after the push keeps what was pushed', posix, () => {
  const root = threadComment('coderabbitai[bot]', { body: 'Off by one.' });
  const { w, args } = setup({ over: { comments: [root], threads: [{ root: root.id }] } });
  w.agent({ result: { replies: [{ item: `thread:${root.id}`, body: 'lgtm', resolve: true }] } });
  w.run(args);
  w.settle();
  assert.equal(Boolean(w.get().repos['acme/app'].prs[0].threads[0].resolved), false);
  assert.ok(w.notices().includes('post failed acme/app#1: refused (bot command)'));

  const later = threadComment('coderabbitai[bot]', { body: 'Another.' });
  w.update((x) => { const p = x.repos['acme/app'].prs[0]; p.comments.push(later); p.threads.push({ root: later.id }); x.fail = ['reviewThreads']; });
  w.agent({ edits: { 'a.txt': 'z\n' }, result: { replies: [{ item: `thread:${later.id}`, body: 'Fixed.', resolve: true }] } });
  w.run(args);
  const s = w.settle().at(-1);
  assert.deepEqual([s.status.status, s.status.reason, s.status.replies], ['done', 'incomplete: error', 1]);
  assert.ok(s.status.pushed);
  assert.ok(w.notices().includes(`session acme/app#1 review done (incomplete: error): pushed ${s.status.pushed.slice(0, 8)} ${path.join(s.dir, 'status.json')}`));
});
