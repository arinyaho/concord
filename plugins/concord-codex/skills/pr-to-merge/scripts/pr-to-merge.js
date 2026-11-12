#!/usr/bin/env node
'use strict';
// pr-to-merge: watch the open pull requests of the given repositories without a model, merge every approved pull
// request GitHub allows to merge, and print one line per event for what it did or could not decide. It reads the
// live state from GitHub (`gh`) and the local clones (`git`) on every scan; the --state file only records the
// notices already printed, so deleting it repeats notices and changes nothing else. Every text another person
// controls (names, branch names, messages) is sanitized before it is printed; event lines never carry free text.
// usage: pr-to-merge.js --self <login> --state <file> [--mine <login>] [--automated <account>]... [--automated-path <glob>]...
//          [--checkout OWNER/REPO=<path>]... [--blocked-label <name>] [--no-merge]
//          [--interval <seconds>] [--deadline <seconds>] OWNER/REPO|OWNER/REPO#N ...
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = 'usage: pr-to-merge.js --self <login> --state <file> [--mine <login>] [--automated <account>]... [--automated-path <glob>]... [--checkout OWNER/REPO=<path>]... [--blocked-label <name>] [--no-merge] [--interval <seconds>] [--deadline <seconds>] OWNER/REPO|OWNER/REPO#N ...';
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
  if (!o.state) usage('--state is required');
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

const PR_FIELDS = `number state isDraft author{login __typename} labels(first:100){nodes{name}}
  headRefName headRefOid isCrossRepository baseRefName mergeable mergeStateStatus isInMergeQueue changedFiles
  approvals: reviews(states:APPROVED){totalCount}`;
const shapePr = (repo, p) => ({
  repo, number: p.number, state: p.state, draft: p.isDraft, author: lower(p.author?.login), authorBot: p.author?.__typename === 'Bot',
  labels: (p.labels?.nodes || []).map((l) => lower(l.name)), headRef: p.headRefName, head: p.headRefOid, cross: p.isCrossRepository,
  baseRef: p.baseRefName, mergeable: p.mergeable, mergeState: p.mergeStateStatus, queued: p.isInMergeQueue, changedFiles: p.changedFiles,
  anyApproval: (p.approvals?.totalCount || 0) > 0,
});

function listOpen(repo) {
  const [owner, name] = repo.split('/');
  const pages = graphql(`query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){defaultBranchRef{name}
    pullRequests(states:OPEN,first:50,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{${PR_FIELDS}}}}}`, { owner, name }, true);
  return { defaultBranch: pages[0].data.repository.defaultBranchRef?.name, open: pages.flatMap((p) => p.data.repository.pullRequests.nodes).map((p) => shapePr(repo, p)) };
}

function onePr(repo, number) {
  const [owner, name] = repo.split('/');
  const [r] = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${PR_FIELDS}}}}`, { owner, name, number });
  return shapePr(repo, r.data.repository.pullRequest);
}

// How many review threads are unresolved, for the `merged` line.
function unresolvedThreads(pr) {
  const [owner, name] = pr.repo.split('/');
  return graphql(`query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes).filter((t) => !t.isResolved).length;
}

// When each review body was last edited; GraphQL has the edit time that REST lacks.
function reviewEdits(pr) {
  const [owner, name] = pr.repo.split('/');
  return new Map(graphql(`query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviews(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId lastEditedAt}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.reviews.nodes).map((r) => [String(r.fullDatabaseId), r.lastEditedAt]));
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
    if (runs.some((r) => !r.done)) return { required, state: 'pending' };
    const real = runs.filter((r) => r.result !== 'CANCELLED');
    const last = (real.length ? real : runs).reduce((a, b) => (b.at > a.at ? b : a));
    return { required, state: PASS.has(last.result) ? 'pass' : 'fail', runId: last.runId };
  });
}

// ---- notices ------------------------------------------------------------------------------------------------------

const seen = (() => {
  try { return new Set(JSON.parse(fs.readFileSync(opts.state, 'utf8')).notices); } catch (_) { return new Set(); }
})();
function saveState() {
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
  try { fs.appendFileSync(`${opts.state}.log`, `${new Date().toISOString()} ${what}: ${String(e?.detail || e?.message || e)}\n`); } catch (_) { /* a log only */ }
  process.stderr.write(`pr-to-merge: ${what}: failed${httpStatus(e) ? ` (HTTP ${httpStatus(e)})` : ''}\n`);
}

// Text another person controls: control characters dropped, anything else unexpected replaced, at most 80 characters.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/[^A-Za-z0-9 ._/:()[\]#@,+=-]/g, '?').slice(0, 80);
const safeUrl = (u) => (/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(u || '') ? u : '');
const tag = (pr) => `${pr.repo}#${pr.number}`;
const short = (sha) => clean(sha).slice(0, 8);
const time = (s) => Date.parse(s || '') || 0;
// The later of the publish and edit times. A review comment's `created_at` is when it was drafted; `updated_at` is when
// it was published or last edited.
const timeOf = (c) => Math.max(time(c.created_at), time(c.updated_at));
const self = (user) => lower(user?.login) === opts.self;
const isBot = (user) => user?.type === 'Bot';
const hasBody = (r) => Boolean(String(r.body || '').trim());

// ---- counting accounts and approvals --------------------------------------------------------------------------------

// Write access, read once per login per scan. A lookup that fails is unknown, is not cached, and makes the pull request
// it was needed for wait for a later scan: an unknown account must neither count nor be ignored. GitHub answers 404
// for a login that is no account, which is a plain no.
class UnknownStanding extends Error {}
let permissions = new Map();
function canWrite(pr, login) {
  const key = `${pr.repo.toLowerCase()}:${login}`;
  if (!permissions.has(key)) {
    try {
      const p = gh(['api', `repos/${pr.repo}/collaborators/${login}/permission`]);
      permissions.set(key, ['admin', 'maintain', 'write'].includes(p?.role_name) || ['admin', 'write'].includes(p?.permission));
    } catch (e) {
      if (httpStatus(e) === '404') permissions.set(key, false);
      else { warn(`${tag(pr)} permission of ${clean(login)}`, e); throw new UnknownStanding(login); }
    }
  }
  return permissions.get(key);
}
// A counting account has write, maintain or admin permission. Automation accounts and items with no author never count.
const counts = (pr, item) => Boolean(item.user?.login) && !isBot(item.user) && canWrite(pr, lower(item.user.login));
// A user account that is the pull request's author (an app's login is in another namespace).
const isAuthor = (pr, login) => !pr.authorBot && login === pr.author;

// An agent's approval: review-until-approve begins its review bodies with this line, whichever account posts them.
const agentApproval = (r) => String(r.body || '').split('\n')[0].trimStart().startsWith('<!-- concord-approve: ');
// Approvals by a counting account that is neither the author nor --self nor an agent's, and whether a counting
// account's latest review requests changes (a comment-only review does not withdraw it, as on GitHub).
// Only the accounts whose standing decides something are looked up.
function approvalOf(pr, reviews) {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.submitted_at).sort((a, b) => time(a.submitted_at) - time(b.submitted_at));
  const byLogin = new Map();
  for (const r of submitted) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) byLogin.set(lower(r.user?.login), r);
  const candidate = (r) => r.state === 'APPROVED' && !self(r.user) && !isAuthor(pr, lower(r.user?.login)) && !agentApproval(r);
  return {
    approvals: submitted.filter(candidate).filter((r) => counts(pr, r)),
    changesRequested: [...byLogin.values()].filter((r) => r.state === 'CHANGES_REQUESTED' && !self(r.user)).some((r) => counts(pr, r)),
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
    issueComments: restPages(`repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`),
  };
}
const who = (item) => clean(item.user?.login);

// The user's own pull request: each review, review-thread comment and conversation comment from a counting account or
// an automation account, other than --self, as [notice key, line].
function activity(pr, reviews, d) {
  const reported = (item) => Boolean(item.user?.login) && !self(item.user) && (isBot(item.user) || counts(pr, item));
  const line = (id, text) => [`review:${tag(pr)}:${id}`, `review ${tag(pr)} head ${short(pr.head)}: ${text}`.trim()];
  const lines = [];
  for (const r of reviews) {
    if (r.state === 'PENDING' || (r.state === 'COMMENTED' && !hasBody(r)) || !reported(r)) continue;
    lines.push(line(`review:${r.id}`, `review ${clean(r.state).toLowerCase().replace(/_/g, ' ')} by ${who(r)} ${safeUrl(r.html_url)}`));
  }
  for (const c of d.comments) if (reported(c)) lines.push(line(`thread:${c.id}`, `thread comment by ${who(c)} ${safeUrl(c.html_url)}`));
  for (const c of d.issueComments) if (reported(c)) lines.push(line(`comment:${c.id}`, `comment by ${who(c)} ${safeUrl(c.html_url)}`));
  return lines;
}

// What holds a pull request besides a request for changes: `thread` (a thread comment) and `comment` (a conversation
// comment or a non-approving review body) from a counting account other than --self, newer than `cutoff`, the newest
// approval that covers the head; and `label`. Only a counting approval given after such an item releases it: resolving
// its thread does not. Earlier threads and comments do not hold, resolved or not.
function holdsOf(pr, reviews, d, cutoff) {
  const holds = [];
  const later = (item, at) => at > cutoff && !self(item.user) && counts(pr, item);
  if (d.comments.some((c) => later(c, timeOf(c)))) holds.push('thread');
  const edits = reviews.some(hasBody) ? reviewEdits(pr) : new Map();
  const bodyHolds = (r) => r.state !== 'PENDING' && r.state !== 'APPROVED' && hasBody(r) && later(r, Math.max(time(r.submitted_at), time(edits.get(String(r.id)))));
  if (reviews.some(bodyHolds) || d.issueComments.some((c) => later(c, timeOf(c)))) holds.push('comment');
  if (pr.labels.includes(lower(opts.blockedLabel))) holds.push('label');
  return holds;
}

// ---- evaluating one pull request ----------------------------------------------------------------------------------

// An automated pull request: from a branch of the repository, opened by a named account of the named kind (app or user),
// changing only files (including a renamed file's old path) that match an --automated-path pattern. The answer is tied
// to the head whose files were read: the head is read again afterwards and must be unchanged.
const automatedAccount = (pr) => opts.automated.some((a) => a.login === pr.author && a.bot === pr.authorBot);
// 'yes', 'no', or 'moved' when the head changed while its files were read.
function automatedAtHead(pr) {
  if (pr.cross || !automatedAccount(pr)) return 'no';
  const files = restPages(`repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`);
  if (files.length < pr.changedFiles) return 'no'; // GitHub lists at most 3000 files
  const within = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)).every((name) => opts.automatedPaths.some((re) => re.test(name)));
  if (!within) return 'no';
  return onePr(pr.repo, pr.number).head === pr.head ? 'yes' : 'moved';
}

// What GitHub's mergeability allows: 'ok', 'approve' (an automated head --self has not approved), 'behind', or null.
// A failed required check is run again here; with --no-merge the write is reported instead.
function mergeStatus(pr, checks, needsApproval, say) {
  const failed = checks.filter((c) => c.required && c.state === 'fail');
  const pending = checks.filter((c) => c.required && c.state === 'pending');
  if (pr.mergeState === 'BEHIND') {
    if (opts.noMerge) say('behind', 'behind its base');
    return opts.noMerge ? null : 'behind';
  }
  if (failed.length) {
    if (opts.noMerge) say('failed', 'required check failed');
    else rerun(pr, failed, say);
    return null;
  }
  if (pending.length) return null; // wait for the required checks
  if (needsApproval && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED'].includes(pr.mergeState)) return 'approve';
  if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeState)) return 'ok';
  if (pr.mergeState === 'BLOCKED') say('rule', 'a branch rule blocks the merge');
  return null;
}

// Returns the pull request with `status` from mergeStatus, null when it does not qualify. Every account is looked up
// before anything is printed or written, so an unknown standing leaves the pull request untouched this scan.
function evaluate(pr) {
  const e = { pr, status: null };
  if (pr.queued) return e; // left alone while it waits in a merge queue
  const own = Boolean(opts.mine) && !pr.authorBot && pr.author === opts.mine;
  // Neither approved, from an automation account, nor the user's own: left alone, its reviews not read.
  if (!pr.anyApproval && !own && !automatedAccount(pr)) return e;
  const say = (kind, text) => notice(`${kind}:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${short(pr.head)}: ${text}`);
  const reviews = restPages(`repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`);
  const { approvals, changesRequested } = approvalOf(pr, reviews);
  const covered = coverage(pr);
  const covering = approvals.filter((a) => covered(a.commit_id));
  // The automated route applies whenever no counting approval covers the head; --self's approvals never count.
  // The script's own approvals (it posts no body) on a pull request from an automation account.
  const ownApprovals = automatedAccount(pr) ? reviews.filter((r) => r.state === 'APPROVED' && self(r.user) && !hasBody(r)) : [];
  const atHead = !covering.length || ownApprovals.length ? automatedAtHead(pr) : 'no';
  const automated = !covering.length && atHead === 'yes';
  // An approval the script gave that the current head does not earn is withdrawn.
  const withdraw = !opts.noMerge && ownApprovals.length > 0 && atHead === 'no';
  const d = own || covering.length || automated ? details(pr) : null;
  const reviewLines = own ? activity(pr, reviews, d) : [];
  // A comment holds until an approval that counts is given after it; an automated pull request has no approval to count from.
  const holds = covering.length || automated ? holdsOf(pr, reviews, d, Math.max(0, ...covering.map((a) => time(a.submitted_at)))) : [];

  for (const [key, line] of reviewLines) notice(key, line);
  if (withdraw) {
    try {
      for (const r of ownApprovals) gh(['api', '-X', 'PUT', `repos/${pr.repo}/pulls/${pr.number}/reviews/${r.id}/dismissals`, '-f', 'message=This head is not an automated change.', '-f', 'event=DISMISS']);
      say('withdrawn', 'automated approval withdrawn');
    } catch (err) {
      // Tried again on every scan; reported once per head.
      warn(`${tag(pr)} dismissal`, err);
      say('unwithdrawn', `automated approval could not be withdrawn: ${refusal(err)}`);
    }
  }
  if (!covering.length && !automated) {
    if (approvals.length) say('stale', 'approved on an older head only');
    return e;
  }
  if (changesRequested) say('changes', 'changes requested');
  if (holds.length) say('held', `held by ${holds.join(', ')}`);
  if (pr.mergeable === 'CONFLICTING') say('conflict', 'conflict');
  if (changesRequested || holds.length || pr.mergeable !== 'MERGEABLE') return e;
  const checks = checksOf(pr);
  e.notPassed = checks.filter((c) => c.state !== 'pass').length;
  e.unresolved = unresolvedThreads(pr);
  const needsApproval = automated && !reviews.some((r) => r.state === 'APPROVED' && self(r.user) && r.commit_id === pr.head);
  e.status = mergeStatus(pr, checks, needsApproval, say);
  return e;
}

// Runs the failed jobs of each failed required check again, once per head: a workflow run already on its second
// attempt is not run again, and is reported instead. GitHub's run attempt is the record, not the notice record.
function rerun(pr, failed, say) {
  const started = [], red = [];
  for (const id of new Set(failed.map((c) => c.runId).filter(Boolean))) {
    const r = gh(['api', `repos/${pr.repo}/actions/runs/${id}`]);
    if (r.status !== 'completed') continue;
    if ((r.run_attempt || 1) >= 2) { red.push(id); continue; }
    gh(['api', '-X', 'POST', `repos/${pr.repo}/actions/runs/${id}/rerun-failed-jobs`]);
    started.push(Number(id));
  }
  if (started.length) emit(`rerun ${tag(pr)} head ${short(pr.head)}: run ${started.join(', ')}`);
  if (red.length) say('red', 'required check still red after one re-run');
  if (failed.some((c) => !c.runId)) say('external', 'required check failed and cannot be re-run');
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

const METHODS = { squash: ['--squash', 'squash', 'allow_squash_merge'], merge: ['--merge', 'merge commit', 'allow_merge_commit'], rebase: ['--rebase', 'rebase', 'allow_rebase_merge'] };
// A squash into a branch of its own, a merge commit into another pull request's branch; when the repository does not
// allow that method, the next one it allows.
function mergeMethod(repo, intoPullRequest) {
  const settings = gh(['api', `repos/${repo}`]);
  const order = intoPullRequest ? ['merge', 'squash', 'rebase'] : ['squash', 'merge', 'rebase'];
  return METHODS[order.find((m) => settings?.[METHODS[m][2]] !== false)] || METHODS[order[0]];
}

// Merges one pull request into its base, naming the head it expects. `merged` is printed only when GitHub reports the
// pull request merged; otherwise (a merge queue, or a state that could not be read) `queued`, once per head.
function merge(e, intoPullRequest) {
  const { pr } = e;
  const [flag, word] = mergeMethod(pr.repo, intoPullRequest);
  try {
    run('gh', ['pr', 'merge', String(pr.number), '--repo', pr.repo, flag, '--match-head-commit', pr.head]);
  } catch (err) {
    if (BEHIND.test(err.detail || err.message)) return sync(pr);
    warn(`${tag(pr)} merge`, err);
    return notice(`mergefail:${tag(pr)}@${pr.head}:${refusal(err)}`, `merge failed ${tag(pr)} head ${short(pr.head)}: ${refusal(err)}`);
  }
  let state;
  try { state = onePr(pr.repo, pr.number).state; } catch (err) { warn(`${tag(pr)} state after the merge`, err); }
  if (state !== 'MERGED') return notice(`queued:${tag(pr)}@${pr.head}`, `queued ${tag(pr)} head ${short(pr.head)}`);
  emit(`merged ${tag(pr)} into ${clean(pr.baseRef)} (${word}) head ${short(pr.head)}; not passed: ${e.notPassed}; unresolved threads: ${e.unresolved}`);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- one scan -------------------------------------------------------------------------------------------------------

function scanRepo(target) {
  const { repo } = target;
  // Every open pull request is listed, also for OWNER/REPO#N arguments: what is based on a branch decides whether it merges.
  const { defaultBranch, open } = listOpen(repo);
  for (const n of target.numbers) {
    if (open.some((p) => p.number === n)) continue;
    try { if (onePr(repo, n).state === 'CLOSED') notice(`closed:${repo}#${n}`, `closed ${repo}#${n}`); } catch (e) { warn(`${repo}#${n}`, e); }
  }
  // The default branch is never a stack parent, whatever pull request has it as its head.
  const sameRepo = open.filter((p) => !p.cross && p.headRef !== defaultBranch);
  for (const pr of open.filter((p) => !p.draft && (target.whole || target.numbers.has(p.number)))) {
    try {
      const e = evaluate(pr);
      if (!e.status) continue;
      if (e.status === 'behind') { sync(pr); continue; }
      // An automated head is approved in one scan and merged in a later one, once GitHub counts the approval.
      if (e.status === 'approve' && !opts.noMerge) { approve(pr); continue; }
      // A pull request waits while an open pull request from this repository, a draft included, is based on its branch.
      const child = !pr.cross && pr.headRef !== defaultBranch && sameRepo.find((p) => p.baseRef === pr.headRef && p.number !== pr.number);
      if (child) notice(`stack:${tag(pr)}@${pr.head}`, `stack ${tag(pr)}: waits for #${child.number}`);
      else if (opts.noMerge) notice(`ready:${tag(pr)}@${pr.head}`, `ready ${tag(pr)} head ${short(pr.head)}`);
      else merge(e, sameRepo.some((p) => p.headRef === pr.baseRef));
    } catch (e) {
      if (e instanceof UnknownStanding) process.stderr.write(`pr-to-merge: ${tag(pr)}: left for the next scan, an account's access is unknown\n`);
      else warn(tag(pr), e);
    }
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
    // `approved`, `rerun` and `synced` are informational; any other line ends the run so that it is acted on.
    if (printed.some((l) => !/^(approved|rerun|synced) /.test(l))) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleepMs(Math.min(opts.interval * 1000, remaining));
  }
})();
