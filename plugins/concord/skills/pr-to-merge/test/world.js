'use strict';
// A fake `gh` on PATH that serves pull requests from world.json, pages every list two items at a time, records each
// call in calls.jsonl, and applies merges to the world. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../../../hooks/test/temp-dir');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pr-to-merge.js');

const FAKE_GH = (dir) => `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
const file = dir + '/world.json';
const w = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(a) + '\\n');
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const save = () => fs.writeFileSync(file, JSON.stringify(w));
// A failure is a pattern that always fails, or { match, times } that fails that many calls.
for (const f of w.fail || []) {
  if (!new RegExp(typeof f === 'string' ? f : f.match).test(a.join(' ')) || f.times === 0) continue;
  if (f.times) { f.times -= 1; save(); }
  fail('HTTP 502: Bad Gateway');
}
const pages = (list) => { const p = []; for (let i = 0; i < list.length; i += 2) p.push(list.slice(i, i + 2)); return p.length ? p : [[]]; };
const field = (k) => { const i = a.findIndex((x, j) => ['-f', '-F'].includes(a[j - 1]) && x.startsWith(k + '=')); return i < 0 ? undefined : a[i].slice(k.length + 1); };
const url = a.slice(1).find((x, i, arr) => !x.startsWith('-') && !['-X', '-f', '-F'].includes(arr[i - 1]));
const repoAt = (name) => w.repos[name];
const prOf = (repo, n) => repo.prs.find((p) => p.number === Number(n));
const gqlPr = (p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, title: p.title, url: p.url, createdAt: p.createdAt, author: { login: p.author },
  assignees: { nodes: p.assignees.map((login) => ({ login })) }, labels: { nodes: p.labels.map((name) => ({ name })) }, headRefName: p.headRefName,
  headRefOid: p.headRefOid, isCrossRepository: p.isCrossRepository, baseRefName: p.baseRefName, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus,
  approvals: { totalCount: p.reviews.filter((r) => r.state === 'APPROVED').length } });
if (a[0] === 'api' && url === 'graphql') {
  const q = field('query'), name = field('owner') + '/' + field('name'), repo = repoAt(name);
  if (!repo) fail('Could not resolve to a Repository');
  const p = field('number') && prOf(repo, field('number'));
  const wrap = (pr) => ({ data: { repository: { defaultBranchRef: { name: repo.defaultBranch || 'main' }, ...pr } } });
  if (/pullRequests\\(/.test(q)) out(pages(repo.prs.filter((x) => x.state === 'OPEN')).map((nodes) => wrap({ pullRequests: { nodes: nodes.map(gqlPr) } })));
  else if (/reviewThreads/.test(q)) out(pages(p.threads).map((nodes) => wrap({ pullRequest: { reviewThreads: { nodes: nodes.map((t) => ({ isResolved: t.resolved, path: t.path, line: t.line, comments: { nodes: [{ databaseId: t.root }] } })) } } })));
  else if (/statusCheckRollup/.test(q)) out(pages(p.checks).map((nodes) => wrap({ pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: nodes.map((c) => c.context
    ? { __typename: 'StatusContext', context: c.context, state: c.state, isRequired: !!c.required, createdAt: c.at || '2026-01-01T00:00:00Z' }
    : { __typename: 'CheckRun', name: c.name, status: c.status || 'COMPLETED', conclusion: c.conclusion ?? 'SUCCESS', completedAt: c.at || '2026-01-01T00:00:00Z', isRequired: !!c.required, checkSuite: { workflowRun: c.runId ? { databaseId: c.runId } : null } }) } } } }] } } })));
  else out(wrap({ pullRequest: p ? gqlPr(p) : null }));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  const repo = repoAt(a[a.indexOf('--repo') + 1]), p = prOf(repo, a[2]), head = a[a.indexOf('--match-head-commit') + 1];
  if ((w.mergeError || {})[a[2]]) fail(w.mergeError[a[2]]);
  if (p.headRefOid !== head) fail('Head branch was modified. Review and try the merge again.');
  p.state = 'MERGED';
  const parent = a.includes('--merge') && repo.prs.find((x) => x.headRefName === p.baseRefName && x.state === 'OPEN');
  if (parent) {
    const merge = 'merge' + p.number;
    repo.commits = { ...repo.commits, [merge]: { author: 'octocat', parents: [parent.headRefOid, p.headRefOid] } };
    parent.headRefOid = merge;
  }
  save();
} else if (a[0] === 'api' && a.includes('-X')) {
  if (w.writeError && new RegExp(w.writeError.match).test(url)) fail(w.writeError.message);
  out({});
} else if (a[0] === 'api') {
  const [, name, rest] = /^repos\\/([^/]+\\/[^/]+)\\/(.*)$/.exec(url) || [];
  const repo = name && repoAt(name);
  let m;
  if ((m = /^pulls\\/(\\d+)\\/reviews/.exec(rest))) out(pages(prOf(repo, m[1]).reviews));
  else if ((m = /^pulls\\/(\\d+)\\/comments/.exec(rest))) out(pages(prOf(repo, m[1]).comments));
  else if ((m = /^issues\\/(\\d+)\\/comments/.exec(rest))) out(pages(prOf(repo, m[1]).issueComments));
  else if ((m = /^commits\\/(\\w+)$/.exec(rest))) { const c = (repo.commits || {})[m[1]] || {}; out({ sha: m[1], author: c.author ? { login: c.author } : null, parents: (c.parents || []).map((sha) => ({ sha })) }); }
  else if ((m = /^compare\\/(.+)\\.\\.\\.(.+)$/.exec(rest))) out({ status: (repo.compare || {})[m[1] + '...' + m[2]] || 'ahead' });
  else if ((m = /^actions\\/runs\\/(\\d+)$/.exec(rest))) out((repo.runs || {})[m[1]] || { status: 'completed', conclusion: 'failure', run_attempt: 1 });
  else fail('HTTP 404: Not Found (' + url + ')');
} else fail('unexpected gh call: ' + a.join(' '));
`;

const T = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
let ids = 1000;
const nextId = () => ++ids;

function pr(number, over = {}) {
  return {
    number, state: 'OPEN', isDraft: false, title: 'Change', url: `https://github.com/acme/app/pull/${number}`, createdAt: T(0), author: 'hubot',
    assignees: [], labels: [], headRefName: `feat-${number}`, headRefOid: `head${number}`, isCrossRepository: false, baseRefName: 'main',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviews: [], comments: [], threads: [], issueComments: [],
    checks: [{ name: 'build', required: true, runId: 900 + number }], ...over,
  };
}
const review = (login, state, commit, minute = 10, over = {}) => ({ id: nextId(), user: { login }, state, commit_id: commit, submitted_at: T(minute), body: '', author_association: 'MEMBER', html_url: `https://github.com/acme/app/pull/1#pullrequestreview-${ids}`, ...over });
const approve = (login, commit, minute, over) => review(login, 'APPROVED', commit, minute, over);
const comment = (login, minute, over = {}) => ({ id: nextId(), user: { login }, created_at: T(minute), body: 'a point', html_url: `https://github.com/acme/app/pull/1#issuecomment-${ids}`, ...over });

function world(repos, extra = {}) {
  const dir = tempDir('ptm-world-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH(dir), { mode: 0o755 });
  const file = path.join(dir, 'world.json');
  fs.writeFileSync(file, JSON.stringify({ repos, ...extra }));
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = path.join(dir, 'state.json');
  return {
    dir, state,
    get: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    update(fn) { const w = this.get(); fn(w); fs.writeFileSync(file, JSON.stringify(w)); },
    run(args, { self = 'octocat', deadline = '0', timeout = 30000 } = {}) {
      const before = calls().length;
      const r = spawnSync(process.execPath, [SCRIPT, '--self', self, '--state', state, '--deadline', deadline, ...args], {
        encoding: 'utf8', timeout, env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` },
      });
      const made = calls().slice(before);
      return {
        lines: r.stdout.split('\n').filter(Boolean), stderr: r.stderr, code: r.status, calls: made,
        writes: made.filter((c) => c.includes('-X') || (c[0] === 'pr' && c[1] === 'merge')),
      };
    },
  };
}

// A local origin with a pull request whose history `build` writes in `work`; returns a clone for --checkout.
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function gitPr(number, build) {
  const dir = tempDir('ptm-git-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  sh(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\nthree\n');
  sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', 'c0');
  const edit = (content, message) => { fs.writeFileSync(path.join(work, 'a.txt'), content); sh(work, 'commit', '-q', '-am', message); return sh(work, 'rev-parse', 'HEAD'); };
  const { approved } = build({ work, edit, sh: (...args) => sh(work, ...args) });
  const head = sh(work, 'rev-parse', 'pr');
  const bare = path.join(dir, 'origin.git');
  sh(dir, 'clone', '-q', '--bare', work, bare);
  sh(bare, 'update-ref', `refs/pull/${number}/head`, head);
  const checkout = path.join(dir, 'checkout');
  sh(dir, 'clone', '-q', bare, checkout);
  return { checkout, approved, head };
}

module.exports = { world, pr, review, approve, comment, T, gitPr, SCRIPT };
