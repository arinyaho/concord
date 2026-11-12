'use strict';
// A fake `gh` on PATH that serves pull requests from world.json and records each call in calls.jsonl. Lists come in
// pages of two: with --paginate every page is served (wrapped in an array with --slurp), without it only the page the
// `endCursor` variable names, so a call that forgets to page sees only the first page. Merges and approvals change the
// world as GitHub would. Nothing touches the network.
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
  fail(w.failMessage || 'HTTP 502: Bad Gateway');
}
const field = (k) => { const i = a.findIndex((x, j) => ['-f', '-F'].includes(a[j - 1]) && x.startsWith(k + '=')); return i < 0 ? undefined : a[i].slice(k.length + 1); };
const url = a.slice(1).find((x, i, arr) => !x.startsWith('-') && !['-X', '-f', '-F'].includes(arr[i - 1]));
const paginate = a.includes('--paginate'), slurp = a.includes('--slurp');
const chunks = (list) => { const p = []; for (let i = 0; i < list.length; i += 2) p.push(list.slice(i, i + 2)); return p.length ? p : [[]]; };
// GraphQL: build(nodes, pageInfo) makes one response; the cursor of page i is 'c' + i.
const gqlPages = (list, build) => {
  const pages = chunks(list).map((nodes, i, all) => build(nodes, { hasNextPage: i < all.length - 1, endCursor: i < all.length - 1 ? 'c' + (i + 1) : null }));
  if (paginate) return out(slurp ? pages : pages[0]);
  const at = field('endCursor') ? Number(field('endCursor').slice(1)) : 0;
  out(pages[at]);
};
const restPages = (list) => { const pages = chunks(list); out(paginate && slurp ? pages : pages[0]); };
const repoAt = (name) => w.repos[name];
const prOf = (repo, n) => repo.prs.find((p) => p.number === Number(n));
const gqlPr = (p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, title: p.title, url: p.url, createdAt: p.createdAt,
  author: { login: p.author, __typename: p.authorType }, assignees: { nodes: p.assignees.map((login) => ({ login })) },
  labels: { nodes: p.labels.map((name) => ({ name })) }, headRefName: p.headRefName, headRefOid: p.headRefOid, isCrossRepository: p.isCrossRepository,
  baseRefName: p.baseRefName, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, isInMergeQueue: Boolean(p.queued),
  changedFiles: p.changedFiles ?? (p.files || []).length,
  approvals: { totalCount: p.reviews.filter((r) => r.state === 'APPROVED').length }, dismissed: { totalCount: p.reviews.filter((r) => r.state === 'DISMISSED').length } });
if (a[0] === 'api' && url === 'user') out({ login: w.self || 'octocat' });
else if (a[0] === 'api' && url === 'graphql') {
  const q = field('query'), name = field('owner') + '/' + field('name'), repo = repoAt(name);
  if (!repo) fail('Could not resolve to a Repository');
  const p = field('number') && prOf(repo, field('number'));
  const wrap = (pr) => ({ data: { repository: { defaultBranchRef: { name: repo.defaultBranch || 'main' }, ...pr } } });
  if (/pullRequests\\(/.test(q)) gqlPages(repo.prs.filter((x) => x.state === 'OPEN'), (nodes, pageInfo) => wrap({ pullRequests: { pageInfo, nodes: nodes.map(gqlPr) } }));
  else if (/timelineItems/.test(q)) gqlPages(p.reviews.filter((r) => r.state === 'DISMISSED'), (nodes, pageInfo) => wrap({ pullRequest: { timelineItems: { pageInfo, nodes: nodes.map((r) => ({ previousReviewState: r.previous || 'APPROVED', review: { databaseId: r.id } })) } } }));
  else if (/reviewThreads/.test(q)) gqlPages(p.threads, (nodes, pageInfo) => wrap({ pullRequest: { reviewThreads: { pageInfo, nodes: nodes.map((t) => ({ isResolved: t.resolved, comments: { nodes: [{ databaseId: t.root }] } })) } } }));
  else if (/statusCheckRollup/.test(q)) gqlPages(p.checks, (nodes, pageInfo) => wrap({ pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo, nodes: nodes.map((c) => c.context
    ? { __typename: 'StatusContext', context: c.context, state: c.state, isRequired: !!c.required, createdAt: c.at || '2026-01-01T00:00:00Z' }
    : { __typename: 'CheckRun', name: c.name, status: c.status || 'COMPLETED', conclusion: c.conclusion ?? 'SUCCESS', completedAt: c.at || '2026-01-01T00:00:00Z', isRequired: !!c.required, checkSuite: { workflowRun: c.runId ? { databaseId: c.runId } : null } }) } } } }] } } }));
  else out(wrap({ pullRequest: p ? gqlPr(p) : null }));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  const repo = repoAt(a[a.indexOf('--repo') + 1]), p = prOf(repo, a[2]), head = a[a.indexOf('--match-head-commit') + 1];
  if ((w.mergeError || {})[a[2]]) fail(w.mergeError[a[2]]);
  if (p.headRefOid !== head) fail('Head branch was modified. Review and try the merge again.');
  if (w.queue) p.queued = true;
  else {
    p.state = 'MERGED';
    const parent = a.includes('--merge') && repo.prs.find((x) => x.headRefName === p.baseRefName && x.state === 'OPEN');
    if (parent) {
      const merge = 'merge' + p.number;
      repo.commits = { ...repo.commits, [merge]: { author: w.self || 'octocat', committer: 'web-flow', verified: true, parents: [parent.headRefOid, p.headRefOid] } };
      parent.headRefOid = merge;
    }
  }
  save();
} else if (a[0] === 'api' && a.includes('-X')) {
  if (w.writeError && new RegExp(w.writeError.match).test(url)) fail(w.writeError.message);
  const approve = /^repos\\/([^/]+\\/[^/]+)\\/pulls\\/(\\d+)\\/reviews$/.exec(url);
  if (approve) {
    prOf(repoAt(approve[1]), approve[2]).reviews.push({ id: 5000 + a.length, user: { login: w.self || 'octocat', type: 'User' }, state: 'APPROVED', commit_id: field('commit_id'), submitted_at: new Date().toISOString(), body: '', author_association: 'MEMBER' });
    save();
  }
  out({});
} else if (a[0] === 'api') {
  const [, name, rest] = /^repos\\/([^/]+\\/[^/]+)\\/(.*)$/.exec(url) || [];
  const repo = name && repoAt(name);
  let m;
  if ((m = /^pulls\\/(\\d+)\\/reviews/.exec(rest))) restPages(prOf(repo, m[1]).reviews);
  else if ((m = /^pulls\\/(\\d+)\\/comments/.exec(rest))) restPages(prOf(repo, m[1]).comments);
  else if ((m = /^issues\\/(\\d+)\\/comments/.exec(rest))) restPages(prOf(repo, m[1]).issueComments);
  else if ((m = /^pulls\\/(\\d+)\\/files/.exec(rest))) restPages(prOf(repo, m[1]).files || []);
  else if ((m = /^pulls\\?state=open&head=([^&]+)/.exec(rest))) {
    const head = decodeURIComponent(m[1]).split(':')[1];
    restPages(repo.prs.filter((x) => x.state === 'OPEN' && x.headRefName === head).map((x) => ({ number: x.number })));
  } else if ((m = /^collaborators\\/([^/]+)\\/permission$/.exec(rest))) {
    const role = (w.permissions || {})[m[1]] || 'write';
    if (role === 'error') fail('HTTP 403: Must have push access to view collaborator permission.');
    out({ permission: role === 'maintain' ? 'write' : role === 'triage' ? 'read' : role, role_name: role });
  } else if ((m = /^commits\\/(\\w+)$/.exec(rest))) {
    const c = (repo.commits || {})[m[1]] || {};
    out({ sha: m[1], author: c.author ? { login: c.author } : null, committer: c.committer ? { login: c.committer } : null,
      commit: { verification: { verified: Boolean(c.verified) } }, parents: (c.parents || []).map((sha) => ({ sha })) });
  }
  else if ((m = /^compare\\/(.+)\\.\\.\\.(.+)$/.exec(rest))) out({ status: (repo.compare || {})[m[1] + '...' + m[2]] || 'ahead' });
  else if ((m = /^actions\\/runs\\/(\\d+)$/.exec(rest))) out((repo.runs || {})[m[1]] || { status: 'completed', conclusion: 'failure', run_attempt: 1 });
  else fail('HTTP 404: Not Found (' + url + ')');
} else fail('unexpected gh call: ' + a.join(' '));
`;

const T = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
let ids = 1000;
const nextId = () => ++ids;
const user = (login) => ({ login, type: login.endsWith('[bot]') ? 'Bot' : 'User' });

function pr(number, over = {}) {
  return {
    number, state: 'OPEN', isDraft: false, title: 'Change', url: `https://github.com/acme/app/pull/${number}`, createdAt: T(0), author: 'hubot', authorType: 'User',
    assignees: [], labels: [], headRefName: `feat-${number}`, headRefOid: `head${number}`, isCrossRepository: false, baseRefName: 'main',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviews: [], comments: [], threads: [], issueComments: [],
    checks: [{ name: 'build', required: true, runId: 900 + number }], ...over,
  };
}
const review = (login, state, commit, minute = 10, over = {}) => ({ id: nextId(), user: user(login), state, commit_id: commit, submitted_at: T(minute), body: '', author_association: 'MEMBER', html_url: `https://github.com/acme/app/pull/1#pullrequestreview-${ids}`, ...over });
const approve = (login, commit, minute, over) => review(login, 'APPROVED', commit, minute, over);
const comment = (login, minute, over = {}) => ({ id: nextId(), user: user(login), created_at: T(minute), updated_at: T(minute), body: 'a point', author_association: 'MEMBER', html_url: `https://github.com/acme/app/pull/1#issuecomment-${ids}`, ...over });
// A review-thread comment; a reply passes `in_reply_to_id`.
const threadComment = (login, over = {}) => ({ id: nextId(), user: user(login), path: 'src/a.js', line: 3, author_association: 'MEMBER', html_url: `https://github.com/acme/app/pull/1#discussion_r${ids}`, created_at: T(20), ...over });

function world(repos, extra = {}) {
  const dir = tempDir('ptm-world-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH(dir), { mode: 0o755 });
  const file = path.join(dir, 'world.json');
  fs.writeFileSync(file, JSON.stringify({ repos, ...extra }));
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  const state = path.join(stateDir, 'state.json');
  return {
    dir, state, stateDir,
    get: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    update(fn) { const w = this.get(); fn(w); fs.writeFileSync(file, JSON.stringify(w)); },
    run(args, { self = 'octocat', deadline = '0', timeout = 30000 } = {}) {
      const before = calls().length;
      const r = spawnSync(process.execPath, [SCRIPT, '--self', self, '--state', state, '--deadline', deadline, ...args], {
        encoding: 'utf8', timeout, env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` },
      });
      const made = calls().slice(before);
      return {
        lines: r.stdout.split('\n').filter(Boolean), stdout: r.stdout, stderr: r.stderr, code: r.status, calls: made,
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
  const built = build({ work, edit, sh: (...args) => sh(work, ...args) });
  const head = sh(work, 'rev-parse', 'pr');
  const bare = path.join(dir, 'origin.git');
  sh(dir, 'clone', '-q', '--bare', work, bare);
  sh(bare, 'update-ref', `refs/pull/${number}/head`, head);
  const checkout = path.join(dir, 'checkout');
  sh(dir, 'clone', '-q', bare, checkout);
  return { ...built, checkout, head, work, bare };
}

module.exports = { world, pr, review, approve, comment, threadComment, user, T, gitPr, sh, SCRIPT };
