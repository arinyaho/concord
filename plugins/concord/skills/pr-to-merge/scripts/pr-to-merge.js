#!/usr/bin/env node
'use strict';
// pr-to-merge: carry the user's own pull requests and the named automated ones to their merge, without a model. The
// skill adds repositories to a watch list; a detached watcher runs `check` every five minutes, which reads the live
// state from GitHub (`gh`) and the local clones (`git`), requests reviews, re-runs failed jobs, updates branches,
// merges what qualifies, and records one line per event in Concord's notice list. The notice record only says which
// notices and requests were already made; deleting it repeats them and changes nothing else. Every text another person
// controls (names, branch names, messages) is sanitized before it is recorded; lines never carry free text.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runtime = require('./watcher');

const SKILL = 'pr-to-merge';
const USAGE = `usage:
  pr-to-merge.js watch add OWNER/REPO[#N]... --harness claude|codex --self <login> --authorized <YYYY-MM-DD>
      [--automated <account> --automated-path <glob>]... [--reviewer <login|org/team>]... [--reviewer-bot <account>]...
      [--checkout <path>] [--blocked-label <name>] [--confirm] [--no-merge] [--model <name>]
  pr-to-merge.js watch remove OWNER/REPO[#N]... --harness claude|codex
  pr-to-merge.js watch status --harness claude|codex
  pr-to-merge.js confirm OWNER/REPO#N <sha> --harness claude|codex
  pr-to-merge.js check --harness claude|codex      (one check; the watcher runs it)
  pr-to-merge.js watcher --harness claude|codex    (the watcher loop; watch add starts it)`;
class Usage extends Error {}
const usage = (why) => { throw new Usage(why); };

// GitHub logins are case-insensitive.
const lower = (login) => String(login || '').toLowerCase();
const DAY = 24 * 3600 * 1000;

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

// ---- arguments ------------------------------------------------------------------------------------------------------

// Options and targets of any verb. Targets are OWNER/REPO or OWNER/REPO#N.
function parseArgs(argv) {
  const o = { automated: [], automatedPaths: [], reviewers: [], reviewerBots: [], targets: [], rest: [] };
  if (argv.some((a) => /[\x00-\x1f\x7f]/.test(a))) usage('an argument holds a control character');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    if (a === '--harness') { o.harness = value(); if (!['claude', 'codex'].includes(o.harness)) usage('--harness is claude or codex'); }
    else if (a === '--self') o.self = lower(value());
    else if (a === '--authorized') o.authorized = value();
    else if (a === '--automated') {
      // `x[bot]` and `app/x` name the app account x, which GraphQL reports as a Bot with login x; a plain `x` names a user.
      const account = value();
      if (!/^[\w./[\]-]+$/.test(account)) usage(`--automated takes an account, not ${account}`);
      const app = /^app\/(.+)$/i.exec(account) || /^(.+)\[bot\]$/i.exec(account);
      o.automated.push({ login: lower(app ? app[1] : account), bot: Boolean(app) });
    } else if (a === '--automated-path') o.automatedPaths.push(value());
    else if (a === '--reviewer') { const r = value(); if (!/^[\w.-]+(\/[\w.-]+)?$/.test(r)) usage(`--reviewer takes a login or org/team, not ${r}`); o.reviewers.push(r); }
    else if (a === '--reviewer-bot') o.reviewerBots.push(lower(value()));
    else if (a === '--checkout') o.checkout = path.resolve(value());
    else if (a === '--blocked-label') o.blockedLabel = value();
    else if (a === '--model') o.model = value();
    else if (a === '--confirm') o.confirm = true;
    else if (a === '--no-merge') o.noMerge = true;
    else if (/^[\w.-]+\/[\w.-]+(#\d+)?$/.test(a)) { const [repo, n] = a.split('#'); o.targets.push({ repo, number: n ? Number(n) : null }); }
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else o.rest.push(a);
  }
  if (!o.harness) usage('--harness is required');
  return o;
}

// The date of the user's authorizing words (UTC): an entry is in force through the seventh day after it, and expires
// once the date is more than seven days old.
const authorizedAt = (date) => Date.parse(`${date}T00:00:00Z`);
const expired = (entry, now = Date.now()) => now - authorizedAt(entry.authorized) >= 8 * DAY;
const until = (entry) => new Date(authorizedAt(entry.authorized) + 7 * DAY).toISOString().slice(0, 10);

// The watch entry `watch add` writes, from its arguments.
function entryFromArgs(argv) {
  const o = parseArgs(argv);
  if (!o.targets.length) usage('name OWNER/REPO or OWNER/REPO#N');
  const repos = new Set(o.targets.map((t) => t.repo.toLowerCase()));
  if (repos.size > 1) usage('one repository per watch add');
  if (o.rest.length) usage(`unexpected ${o.rest[0]}`);
  if (!o.self) usage('--self is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.authorized || '') || Number.isNaN(authorizedAt(o.authorized))) usage('--authorized needs the date of the user\'s words, YYYY-MM-DD');
  if (authorizedAt(o.authorized) > Date.now() + DAY) usage('--authorized is a date in the future');
  if (o.automated.length && !o.automatedPaths.length) usage('--automated needs at least one --automated-path');
  const entry = {
    repo: o.targets[0].repo, whole: o.targets.some((t) => t.number === null), numbers: [...new Set(o.targets.filter((t) => t.number !== null).map((t) => t.number))],
    self: o.self, authorized: o.authorized, automated: o.automated, automatedPaths: o.automatedPaths, reviewers: o.reviewers, reviewerBots: o.reviewerBots,
    checkout: o.checkout || null, blockedLabel: o.blockedLabel || 'blocked', confirm: Boolean(o.confirm), noMerge: Boolean(o.noMerge), harness: o.harness, model: o.model || null,
    confirmations: {},
  };
  if (entry.whole) entry.numbers = [];
  if (expired(entry)) usage('--authorized is more than seven days old; only the user\'s new words authorize a watch');
  return entry;
}

// Adds `entry` to the watch list. Numbers add to an entry of numbers; a whole repository replaces them. The date only
// moves forward, so a `watch add` with the same or an earlier date does not extend an entry. Confirmations stay.
function addEntry(list, entry) {
  const key = entry.repo.toLowerCase();
  const old = list.entries[key];
  const merged = { ...entry, confirmations: old?.confirmations || {} };
  if (old) {
    merged.whole = old.whole || entry.whole;
    merged.numbers = merged.whole ? [] : [...new Set([...old.numbers, ...entry.numbers])].sort((a, b) => a - b);
    if (authorizedAt(old.authorized) > authorizedAt(entry.authorized)) merged.authorized = old.authorized;
  }
  list.entries[key] = merged;
  return merged;
}

// ---- external commands ------------------------------------------------------------------------------------------

class RateLimited extends Error {}
// Commands run with argument arrays, never through a shell, from a neutral directory so `gh` never acts on a local clone.
function run(cmd, args, { cwd = os.tmpdir(), ok = [0] } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
  if (r.error) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')}: ${r.error.message}`);
  if (!ok.includes(r.status)) {
    const detail = String(r.stderr || r.stdout || '').trim();
    if (cmd === 'gh' && /rate limit|HTTP 429/i.test(detail)) throw new RateLimited(detail);
    const err = new Error(`${cmd} ${args.slice(0, 2).join(' ')}: ${detail.split('\n').slice(0, 3).join(' ').slice(0, 300) || `exit ${r.status}`}`);
    err.detail = detail;
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

// ---- state of one check -----------------------------------------------------------------------------------------

// The options of the entry being checked, the notice record, and the lines this check added.
let opts;
let dirs;
let record;
let added = [];
let permissions = new Map();

// The notice record: which notices and requests were already made (key -> time), the merges being followed, and when
// the last check ran. Deleting it repeats notices and requests and changes nothing else.
const recordFile = () => path.join(dirs.skill, 'record.json');
const readRecord = () => ({ seen: {}, following: [], ...runtime.readJson(recordFile(), {}) });
function saveRecord() {
  const keep = Date.now() - 30 * DAY;
  for (const [k, at] of Object.entries(record.seen)) if (at < keep) delete record.seen[k];
  runtime.writeAtomic(recordFile(), JSON.stringify(record));
}

const emit = (line) => { runtime.addNotice(dirs.base, SKILL, line); process.stdout.write(`${line}\n`); added.push(line); };
const notice = (key, line) => { if (!(key in record.seen)) { record.seen[key] = Date.now(); emit(line); } };
// Standard error carries a fixed description and the HTTP status only; the raw message goes to the log for the user.
function warn(what, e) {
  try { fs.appendFileSync(path.join(dirs.skill, 'log'), `${new Date().toISOString()} ${what}: ${String(e?.detail || e?.message || e)}\n`, { mode: 0o600 }); } catch (_) { /* a log only */ }
  process.stderr.write(`pr-to-merge: ${what}: failed${httpStatus(e) ? ` (HTTP ${httpStatus(e)})` : ''}\n`);
}

// Text another person controls: control characters dropped, anything else unexpected replaced, at most 80 characters.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/[^A-Za-z0-9 ._/:()[\]#@,+=-]/g, '?').slice(0, 80);
const safeUrl = (u) => (/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(u || '') ? u : '');
const tag = (pr) => `${pr.repo}#${pr.number}`;
const short = (sha) => clean(sha).slice(0, 8);
const full = (sha) => clean(sha).slice(0, 64);
const time = (s) => Date.parse(s || '') || 0;
// The later of the publish and edit times. A review comment's `created_at` is when it was drafted; `updated_at` is when
// it was published or last edited.
const timeOf = (c) => Math.max(time(c.created_at), time(c.updated_at));
const self = (user) => lower(user?.login) === opts.self;
const isBot = (user) => user?.type === 'Bot';
const hasBody = (r) => Boolean(String(r.body || '').trim());

// ---- reading GitHub ---------------------------------------------------------------------------------------------

const PR_FIELDS = `number state isDraft author{login __typename} labels(first:100){nodes{name}}
  headRefName headRefOid isCrossRepository baseRefName mergeable mergeStateStatus isInMergeQueue changedFiles reviewDecision mergeCommit{oid}`;
const shapePr = (repo, p) => ({
  repo, number: p.number, state: p.state, draft: p.isDraft, author: lower(p.author?.login), authorBot: p.author?.__typename === 'Bot',
  labels: (p.labels?.nodes || []).map((l) => lower(l.name)), headRef: p.headRefName, head: p.headRefOid, cross: p.isCrossRepository,
  baseRef: p.baseRefName, mergeable: p.mergeable, mergeState: p.mergeStateStatus, queued: p.isInMergeQueue, changedFiles: p.changedFiles,
  reviewDecision: p.reviewDecision || null, mergeCommit: p.mergeCommit?.oid || null,
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
    const one = c.__typename === 'StatusContext'
      ? { name: c.context, required: c.isRequired, done: !['PENDING', 'EXPECTED'].includes(c.state), result: c.state, at: c.createdAt || '' }
      : { name: c.name, required: c.isRequired, done: c.status === 'COMPLETED', result: c.conclusion, at: c.completedAt || '', runId: c.checkSuite?.workflowRun?.databaseId };
    if (!groups.has(one.name)) groups.set(one.name, []);
    groups.get(one.name).push(one);
  }
  return [...groups.values()].map((runs) => {
    const required = runs.some((r) => r.required);
    if (runs.some((r) => !r.done)) return { required, state: 'pending' };
    const real = runs.filter((r) => r.result !== 'CANCELLED');
    const last = (real.length ? real : runs).reduce((a, b) => (b.at > a.at ? b : a));
    return { required, state: PASS.has(last.result) ? 'pass' : 'fail', runId: last.runId };
  });
}

// ---- counting accounts and approvals --------------------------------------------------------------------------------

// Write access, read once per login per check. A lookup that fails is unknown, is not cached, and makes the pull
// request it was needed for wait for a later check: an unknown account must neither count nor be ignored. GitHub
// answers 404 for a login that is no account, which is a plain no.
class UnknownStanding extends Error {}
function canWrite(pr, login) {
  const key = `${pr.repo.toLowerCase()}:${login}`;
  if (!permissions.has(key)) {
    try {
      const p = gh(['api', `repos/${pr.repo}/collaborators/${login}/permission`]);
      permissions.set(key, ['admin', 'maintain', 'write'].includes(p?.role_name) || ['admin', 'write'].includes(p?.permission));
    } catch (e) {
      if (e instanceof RateLimited) throw e;
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

// An approval review-until-approve posted, whichever account posted it, never counts: a first line starting
// `<!-- concord-approve: ` (its earlier form) or a last line that is its `<!-- review-until-approve:state … -->` marker.
function agentApproval(r) {
  const lines = String(r.body || '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines[0].trimStart().startsWith('<!-- concord-approve: ') || /^\s*<!-- review-until-approve:state\b.*-->\s*$/.test(lines[lines.length - 1]);
}
// Approvals by a counting account that is neither the author nor --self nor an agent's, the newest of them and of
// dismissed approvals (for asking the approver again), and whether a counting account's latest review requests changes
// (a comment-only review does not withdraw it, as on GitHub). Only the accounts whose standing decides something are looked up.
function approvalOf(pr, reviews) {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.submitted_at).sort((a, b) => time(a.submitted_at) - time(b.submitted_at));
  const byLogin = new Map();
  for (const r of submitted) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) byLogin.set(lower(r.user?.login), r);
  const candidate = (r) => !self(r.user) && !isAuthor(pr, lower(r.user?.login)) && !agentApproval(r);
  const approvals = submitted.filter((r) => r.state === 'APPROVED' && candidate(r)).filter((r) => counts(pr, r));
  return {
    approvals,
    newestApprover: () => submitted.filter((r) => ['APPROVED', 'DISMISSED'].includes(r.state) && candidate(r)).filter((r) => counts(pr, r)).pop(),
    changesRequested: [...byLogin.values()].filter((r) => r.state === 'CHANGES_REQUESTED' && !self(r.user)).some((r) => counts(pr, r)),
  };
}

// Whether an approval given on `sha` covers the head: the head itself, or commits after it on the head's first-parent
// line that are all merge commits, each either a clean merge of the pull request's own base (second parent on that
// branch, tree equal to the one git produces merging the two parents) or one GitHub made for --self (verified,
// committed by web-flow, authored by --self). Needs the local clone; without one only the head counts.
function coverage(pr) {
  const dir = opts.checkout;
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
  // For the stale line: how many commits after `sha` do not keep coverage; null when the head's first-parent line
  // does not reach `sha`. Needs the local clone.
  const uncovered = (sha) => {
    if (!sha) return null;
    fetch();
    const after = commitsAfter(sha);
    return after && after.filter((c) => !allowed(c)).length;
  };
  return { covers, uncovered };
}

// What the stale line says about the commits after the approval.
function afterApproval(approval, uncovered) {
  if (!opts.checkout) return 'commits after it not read';
  const n = uncovered(approval.commit_id);
  return n === null ? 'not on the head\'s first-parent line' : `${n} commit${n === 1 ? '' : 's'} after it not covered`;
}

// ---- review activity, requests, and holds ---------------------------------------------------------------------------

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

// The reviewers requested now, whether GitHub's timeline shows any request ever, and when the newest request was made.
function reviewRequests(pr) {
  const now = gh(['api', `repos/${pr.repo}/pulls/${pr.number}/requested_reviewers`]) || {};
  const events = restPages(`repos/${pr.repo}/issues/${pr.number}/timeline?per_page=100`).filter((e) => e.event === 'review_requested');
  const users = (now.users || []).map((u) => lower(u.login));
  const teams = (now.teams || []).map((t) => lower(t.slug));
  return { users, outstanding: users.length + teams.length > 0, ever: events.length > 0, at: Math.max(0, ...events.map((e) => time(e.created_at))) };
}
function requestReview(pr, reviewers) {
  const args = ['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/requested_reviewers`];
  for (const r of reviewers) args.push('-f', r.includes('/') ? `team_reviewers[]=${r.split('/')[1]}` : `reviewers[]=${r}`);
  gh(args);
}
const refusal = (e) => (httpStatus(e) ? `HTTP ${httpStatus(e)}` : 'refused');
function tryRequest(pr, reviewers) {
  try { requestReview(pr, reviewers); return true; } catch (e) {
    if (e instanceof RateLimited) throw e;
    warn(`${tag(pr)} review request`, e);
    notice(`requestfail:${tag(pr)}@${pr.head}:${refusal(e)}`, `request failed ${tag(pr)} head ${short(pr.head)}: ${refusal(e)}`);
    return false;
  }
}

// What holds a pull request besides a request for changes: `thread` (a thread comment) and `comment` (a conversation
// comment or a non-approving review body) from a counting account other than --self, newer than `cutoff`, the newest
// covering approval or confirmation; and `label`. Only a counting approval or, on a base that requires no review, the
// user's confirmation given after such an item releases it: resolving its thread does not, nor does a push.
function holdsOf(pr, reviews, d, cutoff, covering) {
  const holds = [];
  const later = (item, at) => at > cutoff && !self(item.user) && counts(pr, item);
  // The inline comments of an approving review that covers the head are part of that approval.
  const approvals = new Set(covering.map((a) => a.id));
  if (d.comments.some((c) => !approvals.has(c.pull_request_review_id) && later(c, timeOf(c)))) holds.push('thread');
  const edits = reviews.some(hasBody) ? reviewEdits(pr) : new Map();
  const bodyHolds = (r) => r.state !== 'PENDING' && r.state !== 'APPROVED' && hasBody(r) && later(r, Math.max(time(r.submitted_at), time(edits.get(String(r.id)))));
  if (reviews.some(bodyHolds) || d.issueComments.some((c) => later(c, timeOf(c)))) holds.push('comment');
  if (pr.labels.includes(lower(opts.blockedLabel)) || pr.labels.includes('review-blocked')) holds.push('label');
  return holds;
}

// ---- evaluating one pull request ----------------------------------------------------------------------------------

// An automated pull request: from a branch of the repository, opened by a named account of the named kind (app or user),
// changing only files (including a renamed file's old path) that match an --automated-path pattern. The answer is tied
// to the head whose files were read: the head is read again afterwards and must be unchanged.
const automatedAccount = (pr) => opts.automated.some((a) => a.login === pr.author && a.bot === pr.authorBot);
const isOwn = (pr) => !pr.authorBot && pr.author === opts.self;
// 'yes', 'no', or 'moved' when the head changed while its files were read.
function automatedAtHead(pr) {
  if (pr.cross || !automatedAccount(pr)) return 'no';
  const files = restPages(`repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`);
  if (files.length < pr.changedFiles) return 'no'; // GitHub lists at most 3000 files
  const within = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)).every((name) => opts.automatedPaths.some((re) => re.test(name)));
  if (!within) return 'no';
  return onePr(pr.repo, pr.number).head === pr.head ? 'yes' : 'moved';
}

// The user's confirmations of this pull request's heads, from the watch entry.
const confirmationsOf = (pr) => opts.confirmations[String(pr.number)] || [];

// What GitHub's mergeability allows: 'ok', 'approve' (an automated head --self has not approved), 'behind', or null.
// A failed required check is run again here.
function mergeStatus(pr, checks, needsApproval, say) {
  const failed = checks.filter((c) => c.required && c.state === 'fail');
  const pending = checks.filter((c) => c.required && c.state === 'pending');
  if (pr.mergeState === 'BEHIND') return 'behind';
  if (failed.length) { rerun(pr, failed, say); return null; }
  if (pending.length) return null; // wait for the required checks
  if (needsApproval && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED'].includes(pr.mergeState)) return 'approve';
  if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeState)) return 'ok';
  if (pr.mergeState === 'BLOCKED') say('rule', 'a branch rule blocks the merge');
  return null;
}

// Returns the pull request with `status` from mergeStatus, null when it does not qualify. Every account is looked up
// before anything is recorded or written, so an unknown standing leaves the pull request untouched this check.
function evaluate(pr) {
  const e = { pr, status: null };
  if (pr.queued) return e; // left alone while it waits in a merge queue
  const own = isOwn(pr);
  // Another person's pull request is read only for the merge order.
  if (!own && !automatedAccount(pr)) return e;
  const noReview = !pr.reviewDecision; // GitHub reports no review decision where the base requires no review
  const say = (kind, text) => notice(`${kind}:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${full(pr.head)}: ${text}`);
  const reviews = restPages(`repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`);
  const { approvals, newestApprover, changesRequested } = approvalOf(pr, reviews);
  const { covers, uncovered } = coverage(pr);
  const covering = approvals.filter((a) => covers(a.commit_id));
  // The automated route applies whenever no counting approval covers the head; --self's approvals never count.
  // The script's own approvals (it posts no body) on a pull request from an automation account.
  const ownApprovals = automatedAccount(pr) ? reviews.filter((r) => r.state === 'APPROVED' && self(r.user) && !hasBody(r)) : [];
  const atHead = !covering.length || ownApprovals.length ? automatedAtHead(pr) : 'no';
  const automated = !covering.length && atHead === 'yes';
  // An approval the script gave that the current head does not earn is withdrawn.
  const withdraw = !opts.noMerge && ownApprovals.length > 0 && atHead === 'no';
  const confirmations = confirmationsOf(pr);
  e.confirmed = confirmations.some((c) => c.sha === pr.head);
  const confirmedAt = Math.max(0, ...confirmations.map((c) => time(c.at)));
  // The user's own pull request on a base that requires no review merges without an approval.
  const unapproved = own && noReview && !covering.length;
  const d = own || covering.length || automated ? details(pr) : null;
  const reviewLines = own ? activity(pr, reviews, d) : [];
  const requests = own ? reviewRequests(pr) : null;
  const reviewed = own && reviews.some((r) => r.state !== 'PENDING' && !self(r.user) && counts(pr, r));
  const stale = own && !noReview && !covering.length ? newestApprover() : null;
  // A hold is measured from the newest covering approval or, on a base that requires no review, the user's newest
  // confirmation; with neither, everything a counting account added holds.
  const cutoff = Math.max(0, ...covering.map((a) => time(a.submitted_at)), noReview ? confirmedAt : 0);
  const holds = covering.length || automated || unapproved ? holdsOf(pr, reviews, d, cutoff, covering) : [];
  // An outstanding review request holds the user's own pull request on such a base for 24 hours, unless confirmed after it.
  if (own && noReview && requests.outstanding && requests.at > confirmedAt && Date.now() - requests.at < DAY) holds.push('review request');

  for (const [key, line] of reviewLines) notice(key, line);
  if (own && !requests.outstanding && !requests.ever && !reviewed) {
    const reviewers = opts.reviewers.filter((r) => lower(r) !== opts.self);
    if (!reviewers.length) notice(`noreviewer:${tag(pr)}`, `no reviewer ${tag(pr)} head ${short(pr.head)}`);
    else if (tryRequest(pr, reviewers)) emit(`requested ${tag(pr)} head ${short(pr.head)}: ${reviewers.map(clean).join(', ')}`);
  }
  if (stale && !(`stale:${tag(pr)}@${pr.head}` in record.seen)) {
    const login = lower(stale.user.login);
    const already = requests.users.includes(login);
    if (already || tryRequest(pr, [login])) {
      notice(`stale:${tag(pr)}@${pr.head}`, `stale approval ${tag(pr)} head ${full(pr.head)}: by ${who(stale)} at ${short(stale.commit_id) || 'no commit'}, ${already ? 'already requested' : 'asked again'}, ${afterApproval(stale, uncovered)}`);
    }
  }
  if (withdraw) {
    try {
      for (const r of ownApprovals) gh(['api', '-X', 'PUT', `repos/${pr.repo}/pulls/${pr.number}/reviews/${r.id}/dismissals`, '-f', 'message=This head is not an automated change.', '-f', 'event=DISMISS']);
      say('withdrawn', 'automated approval withdrawn');
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      // Tried again on every check; reported once per head.
      warn(`${tag(pr)} dismissal`, err);
      say('unwithdrawn', `automated approval could not be withdrawn: ${refusal(err)}`);
    }
  }
  if (!covering.length && !automated && !unapproved) return e;
  if (changesRequested) say('changes', 'changes requested');
  if (holds.length) say('held', `held by ${holds.join(', ')}`);
  if (pr.mergeable === 'CONFLICTING') say('conflict', 'conflict');
  if (changesRequested || holds.length || pr.mergeable !== 'MERGEABLE') return e;
  const checks = checksOf(pr);
  e.notPassed = checks.filter((c) => c.state !== 'pass').length;
  e.unresolved = unresolvedThreads(pr);
  // With --confirm, every head of the user's own pull request on such a base waits for the user's confirmation.
  e.needsConfirm = own && noReview && opts.confirm && !e.confirmed;
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
function sync(pr) {
  try {
    gh(['api', '-X', 'PUT', `repos/${pr.repo}/pulls/${pr.number}/update-branch`, '-f', `expected_head_sha=${pr.head}`]);
    emit(`synced ${tag(pr)} head ${short(pr.head)}`);
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    warn(`${tag(pr)} update-branch`, e);
    notice(`syncfail:${tag(pr)}@${pr.head}:${refusal(e)}`, `sync failed ${tag(pr)} head ${short(pr.head)}: ${refusal(e)}`);
  }
}

function approve(pr) {
  gh(['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${pr.head}`]);
  emit(`approved ${tag(pr)} (automated)`);
}

const METHODS = { squash: ['--squash', 'squash', 'allow_squash_merge'], merge: ['--merge', 'merge commit', 'allow_merge_commit'], rebase: ['--rebase', 'rebase', 'allow_rebase_merge'] };
// A squash into a branch of its own, a merge commit into another pull request's branch or from the default branch; when the repository does not
// allow that method, the next one it allows.
function mergeMethod(repo, mergeCommit) {
  const settings = gh(['api', `repos/${repo}`]);
  const order = mergeCommit ? ['merge', 'squash', 'rebase'] : ['squash', 'merge', 'rebase'];
  return METHODS[order.find((m) => settings?.[METHODS[m][2]] !== false)] || METHODS[order[0]];
}

// Merges one pull request into its base, naming the head it expects. `merged` is recorded only when GitHub reports the
// pull request merged; otherwise (a merge queue, or a state that could not be read) `queued`, once per head. A merged
// pull request's runs are followed by later checks.
function merge(e, mergeCommit) {
  const { pr } = e;
  const [flag, word] = mergeMethod(pr.repo, mergeCommit);
  try {
    run('gh', ['pr', 'merge', String(pr.number), '--repo', pr.repo, flag, '--match-head-commit', pr.head]);
  } catch (err) {
    if (err instanceof RateLimited) throw err;
    if (BEHIND.test(err.detail || err.message)) return sync(pr);
    warn(`${tag(pr)} merge`, err);
    return notice(`mergefail:${tag(pr)}@${pr.head}:${refusal(err)}`, `merge failed ${tag(pr)} head ${short(pr.head)}: ${refusal(err)}`);
  }
  let after;
  try { after = onePr(pr.repo, pr.number); } catch (err) { warn(`${tag(pr)} state after the merge`, err); }
  if (after?.state !== 'MERGED') return notice(`queued:${tag(pr)}@${pr.head}`, `queued ${tag(pr)} head ${short(pr.head)}`);
  emit(`merged ${tag(pr)} into ${clean(pr.baseRef)} (${word}) head ${short(pr.head)}; not passed: ${e.notPassed}; unresolved threads: ${e.unresolved}`);
  record.following.push({ repo: pr.repo, number: pr.number, head: pr.head, merge: after.mergeCommit, at: Date.now() });
}

// For a day after a merge: the runs still going on the merged head and those the merge starts on its base. A failed
// run is run again once; a second failure is recorded as `post-merge failed`.
function followMerges() {
  record.following = record.following.filter((m) => Date.now() - m.at < DAY);
  for (const m of record.following) {
    if (lower(m.repo) !== lower(opts.repo)) continue;
    const pr = { repo: m.repo, number: m.number, head: m.head };
    const runs = [m.head, m.merge].filter(Boolean)
      .flatMap((sha) => gh(['api', '--paginate', '--slurp', `repos/${m.repo}/actions/runs?head_sha=${sha}&per_page=100`]).flatMap((p) => p.workflow_runs || []))
      .filter((r) => r.head_sha === m.merge || r.status !== 'completed' || time(r.updated_at) > m.at);
    let open = false;
    for (const r of runs) {
      if (r.status !== 'completed') { open = true; continue; }
      if (PASS.has(String(r.conclusion).toUpperCase()) || r.conclusion === 'cancelled') continue;
      if ((r.run_attempt || 1) < 2) {
        gh(['api', '-X', 'POST', `repos/${m.repo}/actions/runs/${r.id}/rerun-failed-jobs`]);
        emit(`rerun ${tag(pr)} head ${short(m.head)}: run ${Number(r.id)}`);
        open = true;
      } else notice(`postmerge:${m.repo}:${r.id}`, `post-merge failed ${tag(pr)} run ${Number(r.id)} ${safeUrl(r.html_url)}`.trim());
    }
    if (!open) m.done = true;
  }
  record.following = record.following.filter((m) => !m.done);
}

// ---- one check ------------------------------------------------------------------------------------------------------

function scanRepo(entry) {
  const { repo } = entry;
  // Every open pull request is listed, also for OWNER/REPO#N entries: what is based on a branch decides whether it merges.
  const { defaultBranch, open } = listOpen(repo);
  for (const n of entry.numbers) {
    if (open.some((p) => p.number === n)) continue;
    try { if (onePr(repo, n).state === 'CLOSED') notice(`closed:${repo}#${n}`, `closed ${repo}#${n}`); } catch (e) { if (e instanceof RateLimited) throw e; warn(`${repo}#${n}`, e); }
  }
  const sameRepo = open.filter((p) => !p.cross);
  // The default branch is never a stack parent: a pull request from it does not wait for the pull requests into it,
  // and those are not merges into another pull request's branch.
  const fromDefault = (p) => !p.cross && p.headRef === defaultBranch;
  const intoPullRequest = (p) => p.baseRef !== defaultBranch && sameRepo.some((q) => q.headRef === p.baseRef);
  for (const pr of open.filter((p) => !p.draft && (entry.whole || entry.numbers.includes(p.number)))) {
    try {
      const e = evaluate(pr);
      if (!e.status) continue;
      // The merge authorization: the entry's, or the user's confirmation of this head.
      const may = !opts.noMerge || e.confirmed;
      if (e.status === 'behind') {
        if (may) sync(pr);
        else if (e.needsConfirm) notice(`confirm:${tag(pr)}@${pr.head}`, `confirm ${tag(pr)} head ${full(pr.head)}`);
        else notice(`behind:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${full(pr.head)}: behind its base`);
        continue;
      }
      // An automated head is approved in one check and merged in a later one, once GitHub counts the approval.
      if (e.status === 'approve') {
        if (!opts.noMerge) approve(pr);
        else notice(`ready:${tag(pr)}@${pr.head}`, `ready ${tag(pr)} head ${short(pr.head)}`);
        continue;
      }
      // A pull request waits while an open pull request from this repository, a draft included, is based on its branch.
      const child = !pr.cross && !fromDefault(pr) && sameRepo.find((p) => p.baseRef === pr.headRef && p.number !== pr.number);
      if (child) notice(`stack:${tag(pr)}@${pr.head}`, `stack ${tag(pr)}: waits for #${child.number}`);
      else if (e.needsConfirm) notice(`confirm:${tag(pr)}@${pr.head}`, `confirm ${tag(pr)} head ${full(pr.head)}`);
      else if (!may) notice(`ready:${tag(pr)}@${pr.head}`, `ready ${tag(pr)} head ${short(pr.head)}`);
      // One long-lived branch into another also lands as a merge commit, so that later promotions do not repeat its changes.
      else merge(e, intoPullRequest(pr) || fromDefault(pr));
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      if (e instanceof UnknownStanding) process.stderr.write(`pr-to-merge: ${tag(pr)}: left for the next check, an account's access is unknown\n`);
      else warn(tag(pr), e);
    }
  }
}

const INFORMATIONAL = /^(approved|rerun|synced|requested) /;
// One check over the watch list. Exits 1 when the gh account or a repository could not be read.
function check(harness) {
  dirs = { base: runtime.ownerDir(runtime.baseDir(harness)) };
  dirs.skill = runtime.ownerDir(path.join(dirs.base, SKILL));
  record = readRecord();
  added = [];
  permissions = new Map();
  let failed = false;
  // Expired entries are removed before anything acts on them.
  const gone = runtime.updateWatch(dirs.skill, (list) => {
    const out = Object.entries(list.entries).filter(([, en]) => expired(en)).map(([k, en]) => { delete list.entries[k]; return en; });
    return out;
  });
  for (const en of gone) emit(`unwatched ${en.repo}: the authorization of ${en.authorized} expired`);
  const entries = Object.values(runtime.readWatch(dirs.skill).entries);
  try {
    if (entries.length) {
      const quota = gh(['api', 'rate_limit'])?.resources || {};
      const low = ['core', 'graphql'].map((k) => quota[k]).find((q) => q && q.remaining < 100);
      if (low) throw new RateLimited(String(low.reset));
      let login;
      try { login = lower(gh(['api', 'user'])?.login); } catch (e) { if (e instanceof RateLimited) throw e; warn('the gh account', e); failed = true; }
      for (const entry of login ? entries : []) {
        opts = { ...entry, automatedPaths: entry.automatedPaths.map(globRegex), confirmations: entry.confirmations || {} };
        if (login !== entry.self) {
          notice(`account:${entry.repo}:${login}`, `account ${entry.repo}: gh is logged in as ${clean(login)}, not ${clean(entry.self)}`);
          continue;
        }
        try { scanRepo(entry); followMerges(); } catch (e) { if (e instanceof RateLimited) throw e; warn(entry.repo, e); failed = true; }
      }
    }
  } catch (e) {
    if (!(e instanceof RateLimited)) throw e;
    const reset = Number(e.message) ? new Date(Number(e.message) * 1000).toISOString() : 'unknown';
    notice(`ratelimit:${reset}`, `rate limited: GitHub's quota is nearly used up; resets at ${reset}`);
  }
  record.lastCheck = new Date().toISOString();
  saveRecord();
  const notable = added.filter((l) => !INFORMATIONAL.test(l)).length;
  if (notable) runtime.notify(`pr-to-merge: ${notable} new notice${notable === 1 ? '' : 's'}`);
  return failed ? 1 : 0;
}

// ---- the verbs the skill runs ---------------------------------------------------------------------------------------

const quote = (a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const skillDir = (harness) => runtime.ownerDir(path.join(runtime.ownerDir(runtime.baseDir(harness)), SKILL));
const targetsOf = (entry) => (entry.whole ? entry.repo : entry.numbers.map((n) => `${entry.repo}#${n}`).join(' '));

// The watcher starts only where it can do its work: outside any harness sandbox, which a process keeps for life. The
// probe writes in the state directory and reads the GitHub API; where either fails, the user runs the command.
function watchAdd(argv) {
  const entry = entryFromArgs(argv);
  if (entry.checkout) {
    try { git(entry.checkout, ['merge-tree', '--write-tree', 'HEAD', 'HEAD']); } catch (_) { usage(`--checkout ${entry.checkout} is not a clone, or git lacks merge-tree --write-tree (git 2.38 or later)`); }
  }
  let dir, login;
  try {
    dir = skillDir(entry.harness);
    runtime.writeAtomic(path.join(dir, 'probe'), 'ok');
    fs.rmSync(path.join(dir, 'probe'));
    login = lower(gh(['api', 'user'])?.login);
  } catch (_) {
    process.stdout.write(`watcher not started: the state directory or GitHub cannot be reached from here. Run this in a terminal:\n${[process.execPath, __filename, 'watch', 'add', ...argv].map(quote).join(' ')}\n`);
    return 1;
  }
  if (login !== entry.self) usage(`--self ${entry.self} is not the account gh is logged in as (${clean(login)})`);
  const saved = runtime.updateWatch(dir, (list) => addEntry(list, entry));
  process.stdout.write(`watching ${targetsOf(saved)} as ${saved.self} until ${until(saved)}${saved.noMerge ? ', no merge' : ''}${saved.confirm ? ', confirm every head' : ''}\n`);
  if (runtime.watcherRunning(dir)) process.stdout.write('watcher running\n');
  else { runtime.startDetached(__filename, ['watcher', '--harness', entry.harness]); process.stdout.write('watcher started\n'); }
  return 0;
}

function watchRemove(argv) {
  const o = parseArgs(argv);
  if (!o.targets.length) usage('name OWNER/REPO or OWNER/REPO#N');
  const dir = skillDir(o.harness);
  const removed = runtime.updateWatch(dir, (list) => {
    const out = [];
    for (const t of o.targets) {
      const key = t.repo.toLowerCase(), en = list.entries[key];
      if (!en) continue;
      if (t.number === null || (!en.whole && en.numbers.length === 1 && en.numbers[0] === t.number)) { delete list.entries[key]; out.push(t.number === null ? en.repo : `${en.repo}#${t.number}`); }
      else if (!en.whole && en.numbers.includes(t.number)) { en.numbers = en.numbers.filter((n) => n !== t.number); out.push(`${en.repo}#${t.number}`); }
    }
    return out;
  });
  const base = runtime.baseDir(o.harness);
  for (const what of removed) { const line = `unwatched ${what}: removed`; runtime.addNotice(base, SKILL, line); process.stdout.write(`${line}\n`); }
  if (!removed.length) process.stdout.write('nothing watched there\n');
  return 0;
}

// Prints whether the watcher runs, the entries, and every pending pr-to-merge line, which this marks shown.
function watchStatus(argv) {
  const o = parseArgs(argv);
  const dir = skillDir(o.harness);
  const last = runtime.readJson(path.join(dir, 'record.json'), {}).lastCheck;
  process.stdout.write(`watcher ${runtime.watcherRunning(dir) ? 'running' : 'not running'}; last check ${last || 'none'}\n`);
  for (const en of Object.values(runtime.readWatch(dir).entries)) {
    process.stdout.write(`watching ${targetsOf(en)} as ${en.self} until ${until(en)}${en.noMerge ? ', no merge' : ''}${en.confirm ? ', confirm every head' : ''}\n`);
  }
  const pending = runtime.pendingNotices(runtime.baseDir(o.harness), SKILL);
  for (const n of pending) process.stdout.write(`${n.line}\n`);
  runtime.markShown(pending);
  return 0;
}

// Records the user's confirmation of one head in the watch entry. The skill runs it only on the user's own words.
function confirm(argv) {
  const o = parseArgs(argv);
  const [t] = o.targets;
  const sha = String(o.rest[0] || '').toLowerCase();
  if (o.targets.length !== 1 || t.number === null || o.rest.length !== 1) usage('confirm takes OWNER/REPO#N and the head SHA');
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) usage('confirm needs the full head SHA the notice printed');
  const result = runtime.updateWatch(skillDir(o.harness), (list) => {
    const en = list.entries[t.repo.toLowerCase()];
    if (!en || !(en.whole || en.numbers.includes(t.number))) return false;
    en.confirmations = en.confirmations || {};
    en.confirmations[t.number] = [...(en.confirmations[t.number] || []), { sha, at: new Date().toISOString() }].slice(-20);
    return true;
  });
  if (!result) usage(`${t.repo}#${t.number} is not watched`);
  process.stdout.write(`confirmed ${t.repo}#${t.number} head ${sha}\n`);
  return 0;
}

function main(argv) {
  const [verb, sub] = argv;
  if (verb === 'watch' && sub === 'add') return watchAdd(argv.slice(2));
  if (verb === 'watch' && sub === 'remove') return watchRemove(argv.slice(2));
  if (verb === 'watch' && sub === 'status') return watchStatus(argv.slice(2));
  if (verb === 'confirm') return confirm(argv.slice(1));
  if (verb === 'check') return check(parseArgs(argv.slice(1)).harness);
  if (verb === 'watcher') { runtime.watch({ skill: SKILL, harness: parseArgs(argv.slice(1)).harness, own: __filename }); return null; }
  return usage(verb ? `unknown verb ${verb}` : '');
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof Usage)) throw e;
    process.stderr.write(`${e.message ? `pr-to-merge: ${e.message}\n` : ''}${USAGE}\n`);
    code = 2;
  }
  if (code !== null) process.exitCode = code;
}

module.exports = { entryFromArgs, addEntry };
