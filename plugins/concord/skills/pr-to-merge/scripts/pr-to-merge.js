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
  approvals: reviews(states:APPROVED){totalCount}`;
const shapePr = (repo, p) => {
  const bot = p.author?.__typename === 'Bot';
  return {
    repo, number: p.number, state: p.state, draft: p.isDraft, title: p.title || '', author: lower(p.author?.login), authorBot: bot,
    // The author's login as REST reports it on reviews and comments.
    authorRest: bot ? `${lower(p.author?.login)}[bot]` : lower(p.author?.login),
    assignees: (p.assignees?.nodes || []).map((a) => lower(a.login)), labels: (p.labels?.nodes || []).map((l) => lower(l.name)),
    headRef: p.headRefName, head: p.headRefOid, cross: p.isCrossRepository, baseRef: p.baseRefName, mergeable: p.mergeable,
    mergeState: p.mergeStateStatus, queued: p.isInMergeQueue, changedFiles: p.changedFiles,
    anyApproval: (p.approvals?.totalCount || 0) > 0,
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
    reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{isResolved resolvedBy{login} comments(first:1){nodes{databaseId}}}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes)
    .map((t) => ({ resolved: t.isResolved, resolver: t.resolvedBy && lower(t.resolvedBy.login), root: t.comments.nodes[0]?.databaseId }));
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

const seen = (() => {
  try { return new Set(JSON.parse(fs.readFileSync(opts.state, 'utf8')).notices); } catch (_) { return new Set(); }
})();
function saveState() {
  if (!opts.state) return;
  const tmp = path.join(path.dirname(opts.state), `.${path.basename(opts.state)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ notices: [...seen] }), { flag: 'wx' });
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

// An agent's approval: review-until-approve begins its review bodies with this line, whichever account posts them.
const agentApproval = (r) => String(r.body || '').split('\n')[0].trimStart().startsWith('<!-- concord-approve: ');
// Approvals by an account with write access that is neither the author nor --self nor an agent's, and whether a
// counting reviewer's latest review requests changes (a comment-only review does not withdraw it, as on GitHub).
// Only the accounts whose standing decides something are looked up.
function approvalOf(pr, reviews) {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.submitted_at).sort((a, b) => time(a.submitted_at) - time(b.submitted_at));
  const byLogin = new Map();
  for (const r of submitted) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) byLogin.set(lower(r.user?.login), r);
  const candidate = (r) => r.state === 'APPROVED' && lower(r.user?.login) !== pr.authorRest && !self(r.user) && !agentApproval(r);
  return {
    approvals: submitted.filter(candidate).filter((r) => canWrite(pr, lower(r.user?.login))),
    changesRequested: [...byLogin.values()].filter((r) => r.state === 'CHANGES_REQUESTED').some((r) => counts(pr, r)),
  };
}

// Whether an approval given on `sha` covers the head: the head itself, or commits after it on the head's first-parent
// line that are all merge commits, each either a clean merge of the pull request's own base (second parent on that
// branch, tree equal to the one git produces merging the two parents) or one GitHub made for --self (verified,
// committed by web-flow, authored by --self). Needs the local clone; without one only the head counts.
function coverage(pr) {
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
  const cleanBaseMerge = (c, p1, p2) => onBase(p2) && cleanMerge(c, p1, p2);
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
    return isMerge && (cleanBaseMerge(c, p1, p2) || madeByGitHubForSelf(c)); // the local check first, the API only when it fails
  };
  return (sha) => {
    if (sha === pr.head) return true;
    if (!dir || !sha) return false;
    if (!memo.has(sha)) {
      if (!fetched) git(dir, ['fetch', '-q', 'origin', `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`, `refs/pull/${pr.number}/head`]);
      fetched = true;
      const after = commitsAfter(sha);
      memo.set(sha, Boolean(after) && after.every(allowed));
    }
    return memo.get(sha);
  };
}

// ---- review activity and holds --------------------------------------------------------------------------------------

function details(pr) {
  return {
    comments: restPages(`repos/${pr.repo}/pulls/${pr.number}/comments?per_page=100`),
    threads: threadsOf(pr),
    issueComments: restPages(`repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`),
  };
}
const rootOf = (c) => c.in_reply_to_id || c.id;
const who = (item) => clean(item.user?.login);

// The user's own pull request: each review, review-thread comment and conversation comment from a counting account
// other than --self.
function activity(pr, reviews, d) {
  const other = (item) => !self(item.user) && counts(pr, item); // the API last
  const threadOf = new Map(d.threads.map((t) => [t.root, t]));
  const items = [];
  for (const r of reviews) {
    if (r.state === 'PENDING' || !other(r) || (r.state === 'COMMENTED' && !hasBody(r))) continue;
    items.push({ id: `review:${r.id}`, text: `review ${clean(r.state).toLowerCase().replace(/_/g, ' ')} by ${who(r)} ${safeUrl(r.html_url)}`.trim() });
  }
  for (const c of d.comments) {
    if (!other(c)) continue;
    const resolved = threadOf.get(rootOf(c))?.resolved ? 'resolved' : 'unresolved';
    items.push({ id: `thread:${c.id}`, text: `thread comment by ${who(c)} (${resolved}) ${safeUrl(c.html_url)}`.trim() });
  }
  for (const c of d.issueComments) {
    if (other(c)) items.push({ id: `comment:${c.id}`, text: `comment by ${who(c)} ${safeUrl(c.html_url)}`.trim() });
  }
  return items;
}

// A thread is resolved, for a hold, only when --self resolved it, or an account with write access that is not the
// pull request's author.
function resolvedByEntitled(pr, t) {
  if (!t.resolved || !t.resolver) return false;
  if (t.resolver === opts.self) return true;
  return t.resolver !== pr.author && canWrite(pr, t.resolver);
}

// What holds an approved pull request, read from GitHub: `thread` (an unresolved thread a counting account or --self
// opened), `comment` (a non-approving review body or conversation comment from a counting person other than --self,
// and other than `ignore`, newer than `cutoff`), `label` (a hold label). Every account is looked up before anything is
// printed, so an unknown standing leaves the pull request untouched this scan.
function holdsOf(pr, reviews, d, cutoff, ignore) {
  const holds = [];
  const byId = new Map(d.comments.map((c) => [c.id, c]));
  const threadHolds = (t) => {
    const root = byId.get(t.root);
    const opener = !root || self(root.user) || counts(pr, root);
    return opener && !resolvedByEntitled(pr, t);
  };
  if (d.threads.some(threadHolds)) holds.push('thread');
  const person = (item, at) => !isBot(item.user) && !self(item.user) && lower(item.user?.login) !== ignore && at > cutoff && counts(pr, item);
  const edits = reviews.some(hasBody) ? reviewEdits(pr) : new Map();
  const reviewHolds = (r) => r.state !== 'PENDING' && r.state !== 'APPROVED' && hasBody(r) && person(r, Math.max(time(r.submitted_at), time(edits.get(r.id))));
  if (reviews.some(reviewHolds) || d.issueComments.some((c) => person(c, timeOf(c)))) holds.push('comment');
  if (pr.labels.includes(lower(opts.blockedLabel)) || pr.labels.includes(HOLD)) holds.push('label');
  return holds;
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
const HOLD = 'review-blocked';

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

// Returns the pull request with `status` from mergeStatus, null when it does not qualify.
function evaluate(pr, listed) {
  const e = { pr, status: null };
  if (pr.queued) return e; // left alone while it waits in a merge queue
  const own = isOwn(pr, listed);
  const automatedCandidate = automatedAccount(pr);
  // Neither approved, automated nor the user's own: left alone, its reviews not read.
  if (!pr.anyApproval && !own && !automatedCandidate) return e;
  const reviews = restPages(`repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`);
  // --self's approvals never count, so each new head of an automated pull request is approved again.
  const { approvals, changesRequested } = approvalOf(pr, reviews);
  const approved = approvals.length > 0 && !changesRequested;
  const automated = !approved && !changesRequested && automatedCandidate && changesOnlyAllowedPaths(pr);
  if (!approved && !automated && !own) return e;
  const d = details(pr);
  const h = short(pr.head);

  if (!approved && !automated) {
    for (const item of activity(pr, reviews, d)) notice(`review:${tag(pr)}:${item.id}`, `review ${tag(pr)} head ${h}: ${item.text}`);
    return e;
  }

  let covers = true, cutoff = 0;
  if (approved) {
    const covered = coverage(pr);
    const covering = approvals.filter((a) => covered(a.commit_id));
    covers = covering.length > 0;
    // A comment holds until an approval that counts is given after it: the newest covering approval is the cutoff.
    cutoff = Math.max(0, ...covering.map((a) => time(a.submitted_at)));
  }
  const holds = holdsOf(pr, reviews, d, cutoff, automated ? pr.authorRest : null);
  if (approved) {
    if (!covers) notice(`stale:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved on an older head only`);
    if (pr.mergeable === 'CONFLICTING') notice(`conflict:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved, conflict`);
    if (holds.length) notice(`held:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved, held by ${holds.join(', ')}`);
  }
  // Qualification: the approval covers the head and nothing holds it; then GitHub's mergeability.
  if (!covers || holds.length || pr.mergeable !== 'MERGEABLE') return e;
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
// What a refusal line says: the HTTP status, or `refused`. GitHub's message goes only to the log (warn).
const refusal = (e) => (httpStatus(e) ? `HTTP ${httpStatus(e)}` : 'refused');
function sync(pr) {
  try {
    gh(['api', '-X', 'PUT', `repos/${pr.repo}/pulls/${pr.number}/update-branch`, '-f', `expected_head_sha=${pr.head}`]);
    emit(`synced ${tag(pr)} head ${short(pr.head)}`);
  } catch (e) {
    warn(`${tag(pr)} update-branch`, e);
    notice(`syncfail:${tag(pr)}@${pr.head}:${refusal(e)}`, `sync failed ${tag(pr)} head ${short(pr.head)}: ${refusal(e)}`);
  }
}

function approve(pr) {
  gh(['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${pr.head}`]);
  emit(`approved ${tag(pr)} (automated)`);
}

// Merges one pull request into its base, naming the head it expects. `merged` is printed only when GitHub reports the
// pull request merged; otherwise (a merge queue, or a state that could not be read) `queued`, once per head.
function merge(e, squash) {
  const { pr } = e;
  try {
    run('gh', ['pr', 'merge', String(pr.number), '--repo', pr.repo, squash ? '--squash' : '--merge', '--match-head-commit', pr.head]);
  } catch (err) {
    if (BEHIND.test(err.detail || err.message)) return sync(pr);
    warn(`${tag(pr)} merge`, err);
    return notice(`mergefail:${tag(pr)}@${pr.head}:${refusal(err)}`, `merge failed ${tag(pr)} head ${short(pr.head)}: ${refusal(err)}`);
  }
  let state;
  try { state = onePr(pr.repo, pr.number).pr.state; } catch (err) { warn(`${tag(pr)} state after the merge`, err); }
  if (state !== 'MERGED') return notice(`queued:${tag(pr)}@${pr.head}`, `queued ${tag(pr)} head ${short(pr.head)}`);
  const late = (e.notPassed || []).length;
  emit(`merged ${tag(pr)} into ${clean(pr.baseRef)} (${squash ? 'squash' : 'merge commit'}) head ${short(pr.head)}${late ? `; not passed: ${late}` : ''}`);
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
