#!/usr/bin/env node
'use strict';
// pr-to-merge: watch the open pull requests of the given repositories without a model, merge every approved pull
// request GitHub allows to merge, and print one line per event for what it did or could not decide. It reads the
// live state from GitHub (`gh`) and the local clones (`git`) on every scan; the --state file only records the
// notices already printed, so deleting it repeats notices and changes nothing else. Every text another person
// controls (names, branch names, messages) is sanitized before it is printed; event lines never carry free text.
// usage: pr-to-merge.js --self <login> [--mine <login>] [--automated <account>]... [--automated-path <glob>]...
//          [--checkout OWNER/REPO=<path>]... [--blocked-label <name>] [--no-merge] [--state <file>]
//          [--interval <seconds>] [--deadline <seconds>] OWNER/REPO|OWNER/REPO#N ...
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = 'usage: pr-to-merge.js --self <login> [--mine <login>] [--automated <account>]... [--automated-path <glob>]... [--checkout OWNER/REPO=<path>]... [--blocked-label <name>] [--no-merge] [--state <file>] [--interval <seconds>] [--deadline <seconds>] OWNER/REPO|OWNER/REPO#N ...';
const usage = (why) => { process.stderr.write(`${why ? `pr-to-merge: ${why}\n` : ''}${USAGE}\n`); process.exit(2); };

// GitHub logins are case-insensitive.
const lower = (login) => String(login || '').toLowerCase();

// A path pattern: `*` and `?` stay within one path segment, `**` crosses segments (`**/` also matches no directory).
function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; }
    else if (glob.startsWith('**', i)) { re += '.*'; i += 1; }
    else if (glob[i] === '*') re += '[^/]*';
    else if (glob[i] === '?') re += '[^/]';
    else re += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function parseArgs(argv) {
  const o = { automated: [], automatedPaths: [], checkout: new Map(), blockedLabel: 'blocked', noMerge: false, interval: 300, deadline: 3300, targets: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    const seconds = (zero) => { const v = Number(value()); return Number.isFinite(v) && (v > 0 || (zero && v === 0)) ? v : usage(`${a} needs a number of seconds`); };
    if (a === '--self') o.self = lower(value());
    else if (a === '--mine') o.mine = lower(value());
    else if (a === '--automated') {
      // `x[bot]` and `app/x` name the app account x, which GraphQL reports as a Bot with login x; a plain `x` names a user.
      const account = value();
      if (!/^[\w./[\]-]+$/.test(account)) usage(`--automated takes an account, not ${account}`);
      const app = /^app\/(.+)$/i.exec(account) || /^(.+)\[bot\]$/i.exec(account);
      o.automated.push({ login: lower(app ? app[1] : account), bot: Boolean(app) });
    } else if (a === '--automated-path') o.automatedPaths.push(globRegex(value()));
    else if (a === '--checkout') { const v = value(), at = v.indexOf('='); if (at < 1) usage('--checkout needs OWNER/REPO=<path>'); o.checkout.set(v.slice(0, at).toLowerCase(), path.resolve(v.slice(at + 1))); }
    else if (a === '--blocked-label') o.blockedLabel = value();
    else if (a === '--no-merge') o.noMerge = true;
    else if (a === '--state') o.state = value();
    else if (a === '--interval') o.interval = seconds(false);
    else if (a === '--deadline') o.deadline = seconds(true);
    else if (/^[\w.-]+\/[\w.-]+(#\d+)?$/.test(a)) {
      const [repo, n] = a.split('#');
      const t = o.targets.get(repo.toLowerCase()) || { repo, whole: false, numbers: new Set() };
      if (n) t.numbers.add(Number(n)); else t.whole = true;
      o.targets.set(repo.toLowerCase(), t);
    } else usage(`unknown argument ${a}`);
  }
  if (!o.self) usage('--self is required');
  if (lower(o.blockedLabel) === 'review-blocked') usage('--blocked-label cannot be review-blocked, which belongs to review-until-approve');
  if (o.automated.length && !o.automatedPaths.length) usage('--automated needs at least one --automated-path');
  if (!o.targets.size) usage('name at least one OWNER/REPO or OWNER/REPO#N');
  return o;
}

const opts = parseArgs(process.argv.slice(2));

// ---- external commands ------------------------------------------------------------------------------------------

// Commands run with argument arrays, never through a shell, from a neutral directory so `gh` never acts on a local clone.
function run(cmd, args, { cwd = os.tmpdir(), ok = [0] } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
  if (r.error) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')}: ${r.error.message}`);
  if (!ok.includes(r.status)) {
    const err = new Error(`${cmd} ${args.slice(0, 2).join(' ')}: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ').slice(0, 300) || `exit ${r.status}`}`);
    err.detail = String(r.stderr || r.stdout || '').trim();
    throw err;
  }
  return { out: r.stdout, status: r.status };
}
const gh = (args) => JSON.parse(run('gh', args).out || 'null');
// --paginate prints every page; --slurp wraps them in one array.
const restPages = (url) => gh(['api', '--paginate', '--slurp', url]).flat();
function graphql(query, vars, paged) {
  const args = ['api', 'graphql', ...(paged ? ['--paginate', '--slurp'] : []), '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  const result = gh(args);
  return paged ? result : [result];
}
const git = (dir, args, ok) => run('git', ['-C', dir, ...args], { ok });
const httpStatus = (e) => /HTTP (\d{3})/.exec(String(e?.detail || e?.message || ''))?.[1];

// ---- start-up checks ----------------------------------------------------------------------------------------------

try {
  const login = lower(gh(['api', 'user'])?.login);
  if (login !== opts.self) usage(`--self ${opts.self} is not the account gh is logged in as (${login.replace(/[^a-z0-9-]/g, '?')})`);
} catch (e) { usage(`cannot read the account gh is logged in as${httpStatus(e) ? ` (HTTP ${httpStatus(e)})` : ''}`); }
for (const [repo, dir] of opts.checkout) {
  try { git(dir, ['merge-tree', '--write-tree', 'HEAD', 'HEAD']); } catch (_) { usage(`--checkout ${repo}: ${dir} is not a clone, or git lacks merge-tree --write-tree (git 2.38 or later)`); }
}

// ---- reading GitHub ---------------------------------------------------------------------------------------------

const PR_FIELDS = `number state isDraft title url createdAt author{login __typename} assignees(first:100){nodes{login}} labels(first:100){nodes{name}}
  headRefName headRefOid isCrossRepository baseRefName mergeable mergeStateStatus isInMergeQueue changedFiles
  approvals: reviews(states:APPROVED){totalCount} dismissed: reviews(states:DISMISSED){totalCount}`;
const shapePr = (repo, p) => {
  const bot = p.author?.__typename === 'Bot';
  return {
    repo, number: p.number, state: p.state, draft: p.isDraft, title: p.title || '', author: lower(p.author?.login), authorBot: bot,
    // The author's login as REST reports it on reviews and comments.
    authorRest: bot ? `${lower(p.author?.login)}[bot]` : lower(p.author?.login),
    assignees: (p.assignees?.nodes || []).map((a) => lower(a.login)), labels: (p.labels?.nodes || []).map((l) => lower(l.name)),
    headRef: p.headRefName, head: p.headRefOid, cross: p.isCrossRepository, baseRef: p.baseRefName, mergeable: p.mergeable,
    mergeState: p.mergeStateStatus, queued: p.isInMergeQueue, changedFiles: p.changedFiles,
    anyApproval: (p.approvals?.totalCount || 0) > 0, anyDismissed: (p.dismissed?.totalCount || 0) > 0,
  };
};

function listOpen(repo) {
  const [owner, name] = repo.split('/');
  const pages = graphql(`query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){defaultBranchRef{name}
    pullRequests(states:OPEN,first:50,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{${PR_FIELDS}}}}}`, { owner, name }, true);
  return { defaultBranch: pages[0].data.repository.defaultBranchRef.name, prs: pages.flatMap((p) => p.data.repository.pullRequests.nodes).map((p) => shapePr(repo, p)) };
}

function onePr(repo, number) {
  const [owner, name] = repo.split('/');
  const [r] = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name} pullRequest(number:$number){${PR_FIELDS}}}}`, { owner, name, number });
  return { defaultBranch: r.data.repository.defaultBranchRef.name, pr: shapePr(repo, r.data.repository.pullRequest) };
}

function threadsOf(pr) {
  const [owner, name] = pr.repo.split('/');
  return graphql(`query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{isResolved resolvedBy{login __typename} comments(first:1){nodes{databaseId}}}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes)
    .map((t) => ({ resolved: t.isResolved, resolver: t.resolvedBy && { login: lower(t.resolvedBy.login), bot: t.resolvedBy.__typename === 'Bot' }, root: t.comments.nodes[0]?.databaseId }));
}

// When each review body was last edited; GraphQL has the edit time that REST lacks.
function reviewEdits(pr) {
  const [owner, name] = pr.repo.split('/');
  return new Map(graphql(`query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviews(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{databaseId lastEditedAt}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.reviews.nodes).map((r) => [r.databaseId, r.lastEditedAt]));
}

const PASS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
// One result per check name: pending while any run of it is unfinished, otherwise the latest finished run, where a
// cancelled run counts only when no other run of the check finished (a newer push or a concurrency group cancels duplicates).
function checksOf(pr) {
  const [owner, name] = pr.repo.split('/');
  const contexts = graphql(`query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
    commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{__typename
      ... on CheckRun{name status conclusion completedAt isRequired(pullRequestNumber:$number) checkSuite{workflowRun{databaseId}}}
      ... on StatusContext{context state createdAt isRequired(pullRequestNumber:$number)}}}}}}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes || []);
  const groups = new Map();
  for (const c of contexts) {
    const run = c.__typename === 'StatusContext'
      ? { name: c.context, required: c.isRequired, done: !['PENDING', 'EXPECTED'].includes(c.state), result: c.state, at: c.createdAt || '' }
      : { name: c.name, required: c.isRequired, done: c.status === 'COMPLETED', result: c.conclusion, at: c.completedAt || '', runId: c.checkSuite?.workflowRun?.databaseId };
    if (!groups.has(run.name)) groups.set(run.name, []);
    groups.get(run.name).push(run);
  }
  return [...groups.values()].map((runs) => {
    const required = runs.some((r) => r.required);
    if (runs.some((r) => !r.done)) return { name: runs[0].name, required, state: 'pending' };
    const real = runs.filter((r) => r.result !== 'CANCELLED');
    const last = (real.length ? real : runs).reduce((a, b) => (b.at > a.at ? b : a));
    return { name: last.name, required, state: PASS.has(last.result) ? 'pass' : 'fail', result: String(last.result).toLowerCase(), runId: last.runId };
  });
}

// ---- notices ------------------------------------------------------------------------------------------------------

const record = (() => { try { return JSON.parse(fs.readFileSync(opts.state, 'utf8')); } catch (_) { return {}; } })();
const seen = new Set(Array.isArray(record.notices) ? record.notices : []);
// Merges GitHub accepted but did not yet report merged (a merge queue, or a read that failed): reported when it does.
let awaiting = Array.isArray(record.awaiting) ? record.awaiting : [];
function saveState() {
  if (!opts.state) return;
  const tmp = path.join(path.dirname(opts.state), `.${path.basename(opts.state)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ notices: [...seen], awaiting }), { flag: 'wx' });
    fs.renameSync(tmp, opts.state);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    process.stderr.write(`pr-to-merge: cannot write ${opts.state}: ${e.message}\n`);
  }
}
let printed = [];
const emit = (line) => { process.stdout.write(`${line}\n`); printed.push(line); };
const notice = (key, line) => { if (!seen.has(key)) { seen.add(key); emit(line); } };
// Standard error carries a fixed description and the HTTP status only; the raw message goes to `<state>.log` for the user.
function warn(what, e) {
  if (opts.state) { try { fs.appendFileSync(`${opts.state}.log`, `${new Date().toISOString()} ${what}: ${String(e?.detail || e?.message || e)}\n`); } catch (_) { /* a log only */ } }
  process.stderr.write(`pr-to-merge: ${what}: failed${httpStatus(e) ? ` (HTTP ${httpStatus(e)})` : ''}\n`);
}

// Text another person controls: control characters dropped, anything else unexpected replaced, at most 80 characters.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/[^A-Za-z0-9 ._/:()[\]#@,+=-]/g, '?').slice(0, 80);
const safeUrl = (u) => (/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(u || '') ? u : '');
const tag = (pr) => `${pr.repo}#${pr.number}`;
const short = (sha) => clean(sha).slice(0, 8);
const time = (s) => Date.parse(s || '') || 0;
const timeOf = (c) => Math.max(time(c.created_at), time(c.updated_at)); // an edit to an older comment is new
const self = (user) => lower(user?.login) === opts.self;
const isBot = (user) => user?.type === 'Bot';
const hasBody = (r) => Boolean(String(r.body || '').trim());

// ---- the approval rule ----------------------------------------------------------------------------------------------


// Write access, read once per login per scan. A lookup that fails is unknown, is not cached, and holds the pull request
// it was needed for until a later scan reads it: an unknown account must neither count nor be ignored.
class UnknownStanding extends Error {}
let permissions = new Map();
function canWrite(pr, login) {
  const key = `${pr.repo.toLowerCase()}:${login}`;
  if (!permissions.has(key)) {
    try {
      const p = gh(['api', `repos/${pr.repo}/collaborators/${login}/permission`]);
      permissions.set(key, ['admin', 'maintain', 'write'].includes(p?.role_name) || ['admin', 'write'].includes(p?.permission));
    } catch (e) {
      warn(`${tag(pr)} permission of ${clean(login)}`, e);
      throw new UnknownStanding(login);
    }
  }
  return permissions.get(key);
}
// A counting account: write access, the pull request's author, or an automation (Bot) account.
const counts = (pr, item) => isBot(item.user) || lower(item.user?.login) === pr.authorRest || canWrite(pr, lower(item.user?.login));

// An agent's approval: one by review-until-approve, which ends its review bodies with its state marker.
const agentApproval = (r) => String(r.body || '').includes('<!-- review-until-approve:state ');
// Approvals by an account with write access that is neither the author nor --self nor an agent's, whether a counting
// reviewer's latest review requests changes (a comment-only review does not withdraw it, as on GitHub), and each
// reviewer's latest review. Only the accounts whose standing decides something are looked up.
function approvalOf(pr, reviews) {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.submitted_at).sort((a, b) => time(a.submitted_at) - time(b.submitted_at));
  const byLogin = new Map();
  for (const r of submitted) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) byLogin.set(lower(r.user?.login), r);
  const latest = [...byLogin.values()];
  const candidate = (r) => r.state === 'APPROVED' && lower(r.user?.login) !== pr.authorRest && !self(r.user) && !agentApproval(r);
  return {
    approvals: submitted.filter(candidate).filter((r) => canWrite(pr, lower(r.user?.login))),
    changesRequested: latest.filter((r) => r.state === 'CHANGES_REQUESTED').some((r) => counts(pr, r)),
    latest,
  };
}

// The markers on the last lines of a --self conversation comment, as [kind, value]: `<!-- pr-to-merge:<kind> <value> -->`.
function markers(c) {
  const found = [];
  for (const line of String(c.body || '').split('\n').map((l) => l.trim()).reverse()) {
    const m = /^<!-- pr-to-merge:(answered|merge) (\S+) -->$/.exec(line);
    if (m) found.push([m[1], m[2]]);
    else if (line) break;
  }
  return found;
}
// The full SHAs that --self's own conversation comments name as merges it made.
const mergeMarkers = (d) => new Set(d.issueComments.filter((c) => self(c.user)).flatMap(markers).filter(([k, v]) => k === 'merge' && /^[0-9a-f]{40}$/.test(v)).map(([, v]) => v));

// Whether an approval given on `sha` covers the head: the head itself, or commits after it on the head's first-parent
// line that are all merge commits, each either a clean merge of the pull request's own base (second parent on that
// branch, tree equal to the one git produces merging the two parents) or made by --self, whatever it merged. A merge is
// --self's when GitHub made it for --self (verified, committed by web-flow, authored by --self) or when a --self
// conversation comment names it. Needs the local clone; without one only the head counts. `keeps(sha)` says whether one
// commit is such a merge (without the clone, only by --self's marker or GitHub's record).
function coverage(pr, named) {
  const dir = opts.checkout.get(pr.repo.toLowerCase());
  const memo = new Map();
  let fetched = false;
  const exists = (rev) => git(dir, ['cat-file', '-e', `${rev}^{commit}`], [0, 1, 128]).status === 0;
  const isAncestor = (a, b) => git(dir, ['merge-base', '--is-ancestor', a, b], [0, 1]).status === 0;
  const onBase = (c) => isAncestor(c, `refs/remotes/origin/${pr.baseRef}`);
  const tree = (rev) => git(dir, ['rev-parse', `${rev}^{tree}`]).out.trim();
  const cleanMerge = (c, p1, p2) => {
    const r = git(dir, ['merge-tree', '--write-tree', p1, p2], [0, 1]);
    return r.status === 0 && r.out.split('\n')[0].trim() === tree(c);
  };
  const cleanBaseMerge = (c, p1, p2) => Boolean(dir) && onBase(p2) && cleanMerge(c, p1, p2);
  const madeByGitHubForSelf = (c) => {
    const commit = gh(['api', `repos/${pr.repo}/commits/${c}`]);
    return commit?.commit?.verification?.verified === true && lower(commit?.committer?.login) === 'web-flow' && lower(commit?.author?.login) === opts.self;
  };
  // The commits after `sha` as [commit, ...parents], newest first; null when the head's first-parent line does not reach `sha`.
  const commitsAfter = (sha) => {
    if (!exists(sha) || !exists(pr.head) || !isAncestor(sha, pr.head)) return null;
    const lines = git(dir, ['rev-list', '--first-parent', '--parents', `${sha}..${pr.head}`]).out.split('\n').filter(Boolean).map((l) => l.split(' '));
    return lines.length && lines[lines.length - 1][1] === sha ? lines : null;
  };
  const allowed = ([c, p1, p2, ...more]) => {
    const isMerge = Boolean(p2) && !more.length;
    // The local checks first, the API only when they fail.
    return isMerge && (cleanBaseMerge(c, p1, p2) || named.has(c) || madeByGitHubForSelf(c));
  };
  const fetch = () => {
    if (!fetched) git(dir, ['fetch', '-q', 'origin', `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`, `refs/pull/${pr.number}/head`]);
    fetched = true;
  };
  const covers = (sha) => {
    if (sha === pr.head) return true;
    if (!dir || !sha) return false;
    if (!memo.has(sha)) {
      fetch();
      const after = commitsAfter(sha);
      memo.set(sha, Boolean(after) && after.every(allowed));
    }
    return memo.get(sha);
  };
  const keeps = (sha) => {
    if (!/^[0-9a-f]{40}$/.test(sha || '')) return false;
    if (dir) fetch();
    const parents = dir && exists(sha) ? git(dir, ['rev-list', '--parents', '-n', '1', sha]).out.trim().split(' ').slice(1)
      : (gh(['api', `repos/${pr.repo}/commits/${sha}`])?.parents || []).map((p) => p.sha);
    return allowed([sha, ...parents]);
  };
  return { covers, keeps };
}

// ---- review activity and open points --------------------------------------------------------------------------------

function details(pr) {
  return {
    comments: restPages(`repos/${pr.repo}/pulls/${pr.number}/comments?per_page=100`),
    threads: threadsOf(pr),
    issueComments: restPages(`repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`),
  };
}
const rootOf = (c) => c.in_reply_to_id || c.id;
// A point a person raised in a review body or a conversation comment: not a bot's, and not an approving review's body.
const raisedByPerson = (item, kind) => !isBot(item.user) && (kind === 'comment' || item.state !== 'APPROVED');
const who = (item) => clean(item.user?.login);

// Every review, review-thread comment and conversation comment that counts and is not written by --self (or by
// `ignore`). `point` marks the items that re-report a held pull request: a person's review or comment, any thread comment.
function activity(pr, reviews, d, ignore) {
  const other = (item) => !self(item.user) && lower(item.user?.login) !== ignore && counts(pr, item); // the API last
  const threadOf = new Map(d.threads.map((t) => [t.root, t]));
  const items = [];
  for (const r of reviews) {
    if (r.state === 'PENDING' || !other(r) || (r.state === 'COMMENTED' && !hasBody(r))) continue;
    items.push({ id: `review:${r.id}`, point: raisedByPerson(r, 'review'), text: `review ${clean(r.state).toLowerCase().replace(/_/g, ' ')} by ${who(r)} ${safeUrl(r.html_url)}`.trim() });
  }
  for (const c of d.comments) {
    if (!other(c)) continue;
    const resolved = threadOf.get(rootOf(c))?.resolved ? 'resolved' : 'unresolved';
    items.push({ id: `thread:${c.id}`, point: true, text: `thread comment by ${who(c)} (${resolved}) ${safeUrl(c.html_url)}`.trim() });
  }
  for (const c of d.issueComments) {
    if (other(c)) items.push({ id: `comment:${c.id}`, point: raisedByPerson(c, 'comment'), text: `comment by ${who(c)} ${safeUrl(c.html_url)}`.trim() });
  }
  return items;
}

// Open points: each unresolved thread opened by a counting account, bots included (keyed by its latest comment, so
// a new reply is a new point), and each point a person raised in a review body or conversation comment after `cutoff`
// that no later --self conversation comment marks answered with `<!-- pr-to-merge:answered <id> -->`.
// A thread is closed only when resolved by --self or by a counting account other than the pull request's author.
function closedThread(pr, t) {
  if (!t.resolved || !t.resolver) return false;
  if (t.resolver.login === opts.self) return true;
  if (t.resolver.login === pr.author && t.resolver.bot === pr.authorBot) return false;
  return t.resolver.bot || canWrite(pr, t.resolver.login);
}

function openPoints(pr, reviews, d, cutoff, ignore) {
  const points = [];
  const byId = new Map(d.comments.map((c) => [c.id, c]));
  for (const t of d.threads) {
    const root = byId.get(t.root);
    // A thread --self opened holds the merge like any counting account's.
    if (closedThread(pr, t) || (root && !self(root.user) && !counts(pr, root))) continue;
    const ids = d.comments.filter((c) => rootOf(c) === t.root).map((c) => c.id);
    points.push(`thread:${t.root}:${ids.length ? Math.max(...ids) : ''}`);
  }
  const answeredAt = new Map();
  for (const c of d.issueComments.filter((x) => self(x.user))) {
    for (const [kind, id] of markers(c)) if (kind === 'answered') answeredAt.set(id, Math.max(answeredAt.get(id) || 0, timeOf(c)));
  }
  const edits = reviews.some((r) => hasBody(r)) ? reviewEdits(pr) : new Map();
  const reviewTime = (r) => Math.max(time(r.submitted_at), time(edits.get(r.id)));
  const open = (id, item, at) => !self(item.user) && lower(item.user?.login) !== ignore && at > cutoff && !((answeredAt.get(id) || 0) > at) && counts(pr, item);
  for (const r of reviews) {
    const id = `review:${r.id}`;
    if (r.state !== 'PENDING' && hasBody(r) && raisedByPerson(r, 'review') && open(id, r, reviewTime(r))) points.push(id);
  }
  for (const c of d.issueComments) {
    const id = `comment:${c.id}`;
    if (raisedByPerson(c, 'comment') && open(id, c, timeOf(c))) points.push(id);
  }
  return points;
}

// ---- evaluating one pull request ----------------------------------------------------------------------------------

// An automated pull request: from a branch of the repository, opened by a named account of the named kind (app or user),
// changing only files (including a renamed file's old path) that match an --automated-path pattern.
const automatedAccount = (pr) => !pr.cross && opts.automated.some((a) => a.login === pr.author && a.bot === pr.authorBot);
function changesOnlyAllowedPaths(pr) {
  const files = restPages(`repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`);
  if (files.length < pr.changedFiles) return false; // GitHub lists at most 3000 files
  return files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)).every((name) => opts.automatedPaths.some((re) => re.test(name)));
}
const isOwn = (pr, listed) => listed || (opts.mine && pr.author === opts.mine && !pr.authorBot);

// The approvals that cover the head, and the time open points are counted from: the earliest covering approval (the
// earliest approval when none covers, for the triage report only).
function coveringApproval(pr, approvals, named) {
  const { covers } = coverage(pr, named);
  const covering = approvals.filter((a) => covers(a.commit_id));
  const from = covering.length ? covering : approvals;
  return { covering, cutoff: Math.min(...from.map((a) => time(a.submitted_at))) };
}

function reportApproved(pr, { covering, open, held, items, ids }) {
  const h = short(pr.head);
  if (!covering.length) notice(`stale:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved on an older head only`);
  if (pr.mergeable === 'CONFLICTING') notice(`conflict:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved, conflict`);
  // On a held pull request a new point or a new approval of the head is reported, so that the skill can read it again.
  // Whatever the skill read for one report (the open points, the approvals and all activity so far) does not cause the next.
  const approvals = covering.map((a) => `approval:${a.id}`);
  const watched = held ? [...items.filter((i) => i.point).map((i) => i.id), ...approvals] : open;
  if (!watched.some((i) => !seen.has(`open:${tag(pr)}:${i}`))) return;
  for (const i of [...open, ...approvals, ...ids]) seen.add(`open:${tag(pr)}:${i}`);
  emit(`triage ${tag(pr)} head ${h}: approved, open points`);
}

// Whether GitHub allows the merge: 'ok', 'approve' (an automated pull request --self has not approved at this head),
// 'behind', or null. A failed required check is run again here; a branch rule that still blocks is reported.
function mergeStatus(pr, checks, approved, needsApproval) {
  const failed = checks.filter((c) => c.required && c.state === 'fail');
  const pending = checks.filter((c) => c.required && c.state === 'pending');
  if (pr.mergeState === 'BEHIND') return 'behind';
  if (failed.length) {
    if (approved && !opts.noMerge) rerun(pr, failed);
    return null;
  }
  if (pending.length) return null; // wait for the required checks
  if (needsApproval && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED'].includes(pr.mergeState)) return 'approve';
  if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeState)) return 'ok';
  if (pr.mergeState === 'BLOCKED') notice(`rule:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${short(pr.head)}: approved, a branch rule blocks the merge`);
  return null;
}

// A pull request with no counting approval left whose counting reviewer's latest review is a dismissed approval, where
// the dismissal names a commit of a kind that keeps coverage: the repository dismissed it on a push of the skill's own.
// Read from the dismissal events, which keep the review's earlier state and the commit that caused it.
function reportDismissed(pr, latest, d) {
  if (seen.has(`dismissed:${tag(pr)}@${pr.head}`)) return;
  const dismissed = new Set(latest.filter((r) => r.state === 'DISMISSED' && !self(r.user) && lower(r.user?.login) !== pr.authorRest && !agentApproval(r) && canWrite(pr, lower(r.user?.login))).map((r) => r.id));
  if (!dismissed.size) return;
  const [owner, name] = pr.repo.split('/');
  const commits = graphql(`query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
    timelineItems(itemTypes:[REVIEW_DISMISSED_EVENT],first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{... on ReviewDismissedEvent{previousReviewState review{databaseId} pullRequestCommit{commit{oid}}}}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.timelineItems.nodes)
    .filter((n) => n.previousReviewState === 'APPROVED' && dismissed.has(n.review?.databaseId)).map((n) => n.pullRequestCommit?.commit?.oid);
  const { keeps } = coverage(pr, mergeMarkers(d));
  if (commits.some(keeps)) notice(`dismissed:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${short(pr.head)}: approval dismissed`);
}

const HOLD = 'review-blocked';

// Returns the pull request with `status` from mergeStatus, null when it does not qualify.
function evaluate(pr, listed) {
  const e = { pr, status: null };
  if (pr.queued) return e; // left alone while it waits in a merge queue
  const own = isOwn(pr, listed);
  const automatedCandidate = automatedAccount(pr);
  // Neither approved (now or before a dismissal), automated nor the user's own: left alone, its reviews not read.
  if (!pr.anyApproval && !pr.anyDismissed && !own && !automatedCandidate) return e;
  const reviews = restPages(`repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`);
  // --self's approvals never count, so each new head of an automated pull request is approved again.
  const { approvals, changesRequested, latest } = approvalOf(pr, reviews);
  const approved = approvals.length > 0 && !changesRequested;
  let d = null;
  if (!approvals.length && pr.anyDismissed) reportDismissed(pr, latest, d = details(pr));
  const automated = !approved && !changesRequested && automatedCandidate && changesOnlyAllowedPaths(pr);
  if (!approved && !automated && !own) return e;
  d = d || details(pr);
  const ignore = automated ? pr.authorRest : null;

  if (!approved && !automated) {
    for (const item of activity(pr, reviews, d, ignore)) notice(`review:${tag(pr)}:${item.id}`, `review ${tag(pr)} head ${short(pr.head)}: ${item.text}`);
    return e;
  }

  const held = pr.labels.includes(lower(opts.blockedLabel)) || pr.labels.includes(HOLD);
  const { covering, cutoff } = approved ? coveringApproval(pr, approvals, mergeMarkers(d)) : { covering: [true], cutoff: 0 };
  // Every account lookup happens before any notice, so an unknown standing leaves the pull request untouched this scan.
  const open = openPoints(pr, reviews, d, cutoff, ignore);
  const items = held ? activity(pr, reviews, d, ignore) : [];
  const ids = [...reviews.map((r) => `review:${r.id}`), ...d.comments.map((c) => `thread:${c.id}`), ...d.issueComments.map((c) => `comment:${c.id}`)];
  if (approved) reportApproved(pr, { covering, open, held, items, ids });
  // Qualification: the approval covers the head, no open point, no hold label; then GitHub's mergeability.
  if (!covering.length || open.length || held || pr.mergeable !== 'MERGEABLE') return e;
  const checks = checksOf(pr);
  e.notPassed = checks.filter((c) => c.state !== 'pass');
  const needsApproval = automated && !reviews.some((r) => r.state === 'APPROVED' && self(r.user) && r.commit_id === pr.head);
  e.status = mergeStatus(pr, checks, approved, needsApproval);
  return e;
}

// Runs the failed jobs of each failed required check again, once per head: a workflow run already on its second
// attempt is not run again, and is reported instead. GitHub's run attempt is the record, not the state file.
function rerun(pr, failed) {
  const h = short(pr.head), started = [];
  let red = [];
  for (const id of new Set(failed.map((c) => c.runId).filter(Boolean))) {
    const r = gh(['api', `repos/${pr.repo}/actions/runs/${id}`]);
    if (r.status !== 'completed') continue;
    if ((r.run_attempt || 1) >= 2) { red.push(id); continue; }
    gh(['api', '-X', 'POST', `repos/${pr.repo}/actions/runs/${id}/rerun-failed-jobs`]);
    started.push(id);
  }
  if (started.length) emit(`rerun ${tag(pr)} head ${h}: run ${started.join(', ')}`);
  const external = failed.filter((c) => !c.runId).map((c) => clean(c.name));
  if (red.length) notice(`red:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: required check still red after one re-run`);
  if (external.length) notice(`external:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: required check failed and cannot be re-run: ${external.join(', ')}`);
}

// ---- merging --------------------------------------------------------------------------------------------------------

const BEHIND = /not up to date|out of date|behind/i;
function sync(pr) {
  try {
    gh(['api', '-X', 'PUT', `repos/${pr.repo}/pulls/${pr.number}/update-branch`, '-f', `expected_head_sha=${pr.head}`]);
    emit(`synced ${tag(pr)} head ${short(pr.head)}`);
  } catch (e) {
    warn(`${tag(pr)} update-branch`, e);
    const msg = clean(e.detail || e.message);
    notice(`syncfail:${tag(pr)}@${pr.head}:${msg}`, `sync failed ${tag(pr)} head ${short(pr.head)}: ${msg}`);
  }
}

function approve(pr) {
  gh(['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${pr.head}`]);
  emit(`approved ${tag(pr)} (automated)`);
}

const mergedLine = (a) => `merged ${a.repo}#${a.number} into ${clean(a.base)} (${a.squash ? 'squash' : 'merge commit'}) head ${short(a.head)}${a.late.length ? `; not passed: ${a.late.join(', ')}` : ''}`;

// Merges one pull request into its base, naming the head it expects. `merged` is printed only when GitHub reports the
// pull request merged. One that stays open is in a merge queue; it, and one whose state could not be read, is kept in
// the notice record and reported by a later scan when GitHub reports it merged or closed.
function merge(e, squash) {
  const { pr } = e;
  try {
    run('gh', ['pr', 'merge', String(pr.number), '--repo', pr.repo, squash ? '--squash' : '--merge', '--match-head-commit', pr.head]);
  } catch (err) {
    if (BEHIND.test(err.detail || err.message)) return sync(pr);
    warn(`${tag(pr)} merge`, err);
    const msg = clean(err.detail || err.message);
    return notice(`mergefail:${tag(pr)}@${pr.head}:${msg}`, `merge failed ${tag(pr)} head ${short(pr.head)}: ${msg}`);
  }
  const accepted = { repo: pr.repo, number: pr.number, head: pr.head, base: pr.baseRef, squash, late: (e.notPassed || []).map((c) => `${clean(c.name)} (${c.state === 'pending' ? 'pending' : clean(c.result)})`) };
  let state;
  try { state = onePr(pr.repo, pr.number).pr.state; } catch (err) { warn(`${tag(pr)} state after the merge`, err); }
  if (state === 'MERGED') return emit(mergedLine(accepted));
  awaiting.push(accepted);
  if (state) notice(`queued:${tag(pr)}@${pr.head}`, `queued ${tag(pr)} head ${short(pr.head)}`);
}

// Reports each merge the record awaits once GitHub reports the pull request merged or closed.
function settleAwaiting() {
  awaiting = awaiting.filter((a) => {
    let state;
    try { state = onePr(a.repo, a.number).pr.state; } catch (err) { warn(`${a.repo}#${a.number} state of an accepted merge`, err); return true; }
    if (state === 'MERGED') emit(mergedLine(a));
    else if (state === 'CLOSED') notice(`closed:${a.repo}#${a.number}`, `closed ${a.repo}#${a.number}`);
    return state === 'OPEN';
  });
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- one scan -------------------------------------------------------------------------------------------------------

// The open pull request of this repository whose head branch is `branch`, when it is not one of the covered ones.
const uncoveredParent = (repo, branch) => restPages(`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&per_page=100`)[0];

function scanRepo(target) {
  const { repo } = target;
  let defaultBranch, prs = [];
  if (target.whole) ({ defaultBranch, prs } = listOpen(repo));
  for (const n of target.numbers) {
    if (prs.some((p) => p.number === n)) continue;
    try {
      const one = onePr(repo, n);
      defaultBranch = defaultBranch || one.defaultBranch;
      if (one.pr.state === 'CLOSED') notice(`closed:${repo}#${n}`, `closed ${repo}#${n}`);
      else if (one.pr.state === 'OPEN') prs.push(one.pr);
    } catch (e) { warn(`${repo}#${n}`, e); }
  }

  // Drafts are never evaluated, but stay in the stack map so a child of a draft does not merge.
  const evals = [];
  for (const pr of prs.filter((p) => p.state === 'OPEN')) {
    if (pr.draft) { evals.push({ pr, status: null }); continue; }
    try { evals.push(evaluate(pr, target.numbers.has(pr.number))); } catch (e) {
      if (e instanceof UnknownStanding) process.stderr.write(`pr-to-merge: ${tag(pr)}: left for the next scan, an account's access is unknown\n`);
      else warn(tag(pr), e);
      evals.push({ pr, status: null });
    }
  }

  // A stack parent is a pull request from a branch of this repository; a fork's branch is never another pull request's base.
  const byHead = new Map(evals.filter((e) => !e.pr.cross).map((e) => [e.pr.headRef, e]));
  const bases = new Set(evals.map((e) => e.pr.baseRef));
  for (const top of evals.filter((e) => e.pr.cross || !bases.has(e.pr.headRef))) {
    const chain = [top];
    let cur = top;
    while (cur.pr.baseRef !== defaultBranch && byHead.has(cur.pr.baseRef) && !chain.includes(byHead.get(cur.pr.baseRef))) chain.push(cur = byHead.get(cur.pr.baseRef));
    if (chain.some((e) => !e.status)) continue;
    try {
      // Any other base is a branch of its own (a release branch), unless an open pull request outside the arguments has it as its head.
      if (cur.pr.baseRef !== defaultBranch && !target.whole) {
        const parent = uncoveredParent(repo, cur.pr.baseRef);
        if (parent) { notice(`parent:${tag(cur.pr)}@${parent.number}`, `stack ${tag(cur.pr)}: its parent #${Number(parent.number)} is not covered`); continue; }
      }
      if (chain.some((e) => e.status === 'behind')) { if (!opts.noMerge) chain.filter((e) => e.status === 'behind').forEach((e) => sync(e.pr)); continue; }
      const contained = chain.slice(0, -1).every((e, i) => ['ahead', 'identical'].includes(gh(['api', `repos/${repo}/compare/${chain[i + 1].pr.head}...${e.pr.head}`])?.status));
      if (!contained) {
        notice(`stack:${tag(top.pr)}@${chain.map((e) => e.pr.head).join(',')}`, `stack ${tag(top.pr)}: a child does not contain its parent's head`);
        continue;
      }
      if (opts.noMerge) chain.forEach((e) => notice(`ready:${tag(e.pr)}@${e.pr.head}`, `ready ${tag(e.pr)} head ${short(e.pr.head)}`));
      // An automated pull request is approved in one scan and merged in a later one, once GitHub counts the approval.
      else if (chain.some((e) => e.status === 'approve')) chain.filter((e) => e.status === 'approve').forEach((e) => approve(e.pr));
      // One level per scan: the top merges into its parent, which a later scan evaluates as an ordinary pull request.
      else merge(top, chain.length === 1);
    } catch (e) { warn(`${tag(top.pr)} stack`, e); }
  }
}

(async () => {
  const deadline = Date.now() + opts.deadline * 1000;
  for (;;) {
    printed = [];
    permissions = new Map();
    settleAwaiting();
    for (const target of opts.targets.values()) {
      try { scanRepo(target); } catch (e) { warn(target.repo, e); }
    }
    saveState();
    if (printed.some((l) => !/^(rerun|synced) /.test(l))) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleepMs(Math.min(opts.interval * 1000, remaining));
  }
})();
