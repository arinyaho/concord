#!/usr/bin/env node
'use strict';
// pr-to-merge: watch the open pull requests of the given repositories without a model, merge every approved pull
// request GitHub allows to merge, and print one line per event for what it did or could not decide. It reads the
// live state from GitHub (`gh`) and the local clones (`git`) on every scan; the --state file only records the
// notices already printed, so deleting it repeats notices and changes nothing else.
// usage: pr-to-merge.js --self <login> [--mine <login>] [--automated <login>[:<title prefix>]]...
//          [--checkout OWNER/REPO=<path>]... [--blocked-label <name>] [--no-merge] [--state <file>]
//          [--interval <seconds>] [--deadline <seconds>] OWNER/REPO|OWNER/REPO#N ...
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = 'usage: pr-to-merge.js --self <login> [--mine <login>] [--automated <login>[:<title prefix>]]... [--checkout OWNER/REPO=<path>]... [--blocked-label <name>] [--no-merge] [--state <file>] [--interval <seconds>] [--deadline <seconds>] OWNER/REPO|OWNER/REPO#N ...';
const usage = (why) => { process.stderr.write(`${why ? `pr-to-merge: ${why}\n` : ''}${USAGE}\n`); process.exit(2); };

// GitHub logins are case-insensitive, and an app's login reads `app/x` in gh, `x[bot]` in REST and `x` in GraphQL.
const norm = (login) => String(login || '').toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');

function parseArgs(argv) {
  const o = { automated: [], checkout: new Map(), blockedLabel: 'blocked', noMerge: false, interval: 300, deadline: 3300, targets: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    const seconds = (zero) => { const v = Number(value()); return Number.isFinite(v) && (v > 0 || (zero && v === 0)) ? v : usage(`${a} needs a number of seconds`); };
    if (a === '--self') o.self = norm(value());
    else if (a === '--mine') o.mine = norm(value());
    else if (a === '--automated') { const [login, ...prefix] = value().split(':'); o.automated.push({ login: norm(login), prefix: prefix.length ? prefix.join(':') : null }); }
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
    err.detail = String(r.stderr || r.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 300);
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

// ---- reading GitHub ---------------------------------------------------------------------------------------------

const PR_FIELDS = `number state isDraft title url createdAt author{login} assignees(first:100){nodes{login}} labels(first:100){nodes{name}}
  headRefName headRefOid isCrossRepository baseRefName mergeable mergeStateStatus approvals: reviews(states:APPROVED){totalCount}`;
const shapePr = (repo, p) => ({
  repo, number: p.number, state: p.state, draft: p.isDraft, title: p.title || '', url: p.url, author: norm(p.author?.login),
  assignees: (p.assignees?.nodes || []).map((a) => norm(a.login)), labels: (p.labels?.nodes || []).map((l) => l.name),
  headRef: p.headRefName, head: p.headRefOid, cross: p.isCrossRepository, baseRef: p.baseRefName, mergeable: p.mergeable, mergeState: p.mergeStateStatus,
  anyApproval: (p.approvals?.totalCount || 0) > 0,
});

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
    reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{isResolved path line comments(first:1){nodes{databaseId}}}}}}}`, { owner, name, number: pr.number }, true)
    .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes)
    .map((t) => ({ resolved: t.isResolved, path: t.path, line: t.line, root: t.comments.nodes[0]?.databaseId }));
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
  try {
    const tmp = `${opts.state}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ notices: [...seen] }));
    fs.renameSync(tmp, opts.state);
  } catch (e) { process.stderr.write(`pr-to-merge: cannot write ${opts.state}: ${e.message}\n`); }
}
let printed = [];
const emit = (line) => { process.stdout.write(`${line}\n`); printed.push(line); };
const notice = (key, line) => { if (!seen.has(key)) { seen.add(key); emit(line); } };
const warn = (what, e) => process.stderr.write(`pr-to-merge: ${what}: ${e.message}\n`);

const tag = (pr) => `${pr.repo}#${pr.number}`;
const short = (sha) => String(sha || '').slice(0, 8);
const time = (s) => Date.parse(s || '') || 0;

// ---- the approval rule ----------------------------------------------------------------------------------------------

const PEOPLE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
// Approvals by an owner, member or collaborator who is not the author, and whether a reviewer's latest review
// requests changes (a comment-only review does not withdraw a request for changes, as on GitHub).
function approvalOf(pr, reviews) {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.submitted_at).sort((a, b) => time(a.submitted_at) - time(b.submitted_at));
  const latest = new Map();
  for (const r of submitted) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(norm(r.user?.login), r);
  return {
    approvals: submitted.filter((r) => r.state === 'APPROVED' && PEOPLE.has(r.author_association) && norm(r.user?.login) !== pr.author),
    changesRequested: [...latest.values()].some((r) => r.state === 'CHANGES_REQUESTED'),
  };
}

// Whether an approval given on `sha` covers the head: the head itself, or commits after it on the first-parent line that
// are all merges whose second parent is on the base branch and which are clean (the tree git produces merging the two
// parents) or were made by --self. Needs the local clone; without one only the head counts.
function coverage(pr, defaultBranch) {
  const dir = opts.checkout.get(pr.repo.toLowerCase());
  const memo = new Map();
  let bases = null;
  const isAncestor = (a, b) => git(dir, ['merge-base', '--is-ancestor', a, b], [0, 1]).status === 0;
  const tree = (rev) => git(dir, ['rev-parse', `${rev}^{tree}`]).out.trim();
  const cleanMerge = (c, p1, p2) => {
    const r = git(dir, ['merge-tree', '--write-tree', p1, p2], [0, 1]);
    return r.status === 0 && r.out.split('\n')[0].trim() === tree(c);
  };
  const bySelf = (c) => norm(gh(['api', `repos/${pr.repo}/commits/${c}`])?.author?.login) === opts.self;
  return (sha) => {
    if (sha === pr.head) return true;
    if (!dir || !sha) return false;
    if (memo.has(sha)) return memo.get(sha);
    if (!bases) {
      bases = [...new Set([pr.baseRef, defaultBranch])];
      git(dir, ['fetch', '-q', 'origin', ...bases.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`), `refs/pull/${pr.number}/head`]);
    }
    let ok = false;
    if (git(dir, ['cat-file', '-e', `${sha}^{commit}`], [0, 1, 128]).status === 0 && git(dir, ['cat-file', '-e', `${pr.head}^{commit}`], [0, 1, 128]).status === 0 && isAncestor(sha, pr.head)) {
      const lines = git(dir, ['rev-list', '--first-parent', '--parents', `${sha}..${pr.head}`]).out.split('\n').filter(Boolean).map((l) => l.split(' '));
      ok = lines.length > 0 && lines[lines.length - 1][1] === sha && lines.every(([c, p1, p2, ...more]) => p2 && !more.length
        && bases.some((b) => isAncestor(p2, `refs/remotes/origin/${b}`)) && (cleanMerge(c, p1, p2) || bySelf(c)));
    }
    memo.set(sha, ok);
    return ok;
  };
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

// Every review, review-thread comment and conversation comment not written by --self (or by `ignore`).
function activity(reviews, d, ignore) {
  const other = (login) => ![opts.self, ignore].includes(norm(login));
  const threadOf = new Map(d.threads.map((t) => [t.root, t]));
  const items = [];
  for (const r of reviews) {
    if (r.state === 'PENDING' || !other(r.user?.login) || (r.state === 'COMMENTED' && !String(r.body || '').trim())) continue;
    items.push({ id: `review:${r.id}`, text: `review ${r.state.toLowerCase().replace(/_/g, ' ')} by ${r.user?.login} ${r.html_url || ''}`.trim() });
  }
  for (const c of d.comments) {
    if (!other(c.user?.login)) continue;
    const t = threadOf.get(rootOf(c));
    items.push({ id: `thread:${c.id}`, text: `thread comment by ${c.user?.login} on ${c.path}:${c.line ?? c.original_line ?? '?'} (${t?.resolved ? 'resolved' : 'unresolved'}) ${c.html_url || ''}`.trim() });
  }
  for (const c of d.issueComments) {
    if (other(c.user?.login)) items.push({ id: `comment:${c.id}`, text: `comment by ${c.user?.login} ${c.html_url || ''}`.trim() });
  }
  return items;
}

// Open points: each unresolved thread (keyed by its latest comment, so a new reply is a new point), and each review body
// or conversation comment written after `cutoff` by someone other than --self that no later --self conversation comment
// or review answers.
function openPoints(reviews, d, cutoff, ignore) {
  const points = [];
  for (const t of d.threads) {
    if (t.resolved) continue;
    const ids = d.comments.filter((c) => rootOf(c) === t.root).map((c) => c.id);
    points.push(`thread:${t.root}:${ids.length ? Math.max(...ids) : ''}`);
  }
  const mine = (login) => norm(login) === opts.self;
  const lastSelf = Math.max(0, ...d.issueComments.filter((c) => mine(c.user?.login)).map((c) => time(c.created_at)),
    ...reviews.filter((r) => mine(r.user?.login) && r.state !== 'PENDING' && String(r.body || '').trim()).map((r) => time(r.submitted_at)));
  const counts = (login, at) => !mine(login) && norm(login) !== ignore && at > cutoff && !(lastSelf > at);
  for (const r of reviews) if (r.state !== 'PENDING' && String(r.body || '').trim() && counts(r.user?.login, time(r.submitted_at))) points.push(`review:${r.id}`);
  for (const c of d.issueComments) if (counts(c.user?.login, time(c.created_at))) points.push(`comment:${c.id}`);
  return points;
}

// ---- evaluating one pull request ----------------------------------------------------------------------------------

const automatedRule = (pr) => opts.automated.some((a) => a.login === pr.author && (a.prefix === null || pr.title.startsWith(a.prefix)));
const isOwn = (pr, listed) => listed || (opts.mine && (pr.author === opts.mine || pr.assignees.includes(opts.mine)));

// Returns the pull request with `status`: 'ok' (qualifies), 'attempt' (qualifies except that GitHub reports a branch rule
// still blocking with every required check passed: the merge is tried so GitHub states the rule), 'behind', or null.
function evaluate(pr, defaultBranch, listed) {
  const e = { pr, status: null };
  const own = isOwn(pr, listed);
  const automatedCandidate = automatedRule(pr);
  if (!pr.anyApproval && !own && !automatedCandidate) return e;
  const reviews = restPages(`repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`);
  const { approvals, changesRequested } = approvalOf(pr, reviews);
  const approved = approvals.length > 0 && !changesRequested;
  const automated = !approved && !changesRequested && automatedCandidate;
  if (!approved && !automated && !own) return e;
  const d = details(pr);
  const h = short(pr.head);

  if (!approved && !automated) {
    for (const item of activity(reviews, d)) notice(`review:${tag(pr)}:${item.id}`, `review ${tag(pr)} head ${h}: ${item.text}`);
    return e;
  }

  const blocked = pr.labels.includes(opts.blockedLabel);
  let covers = true, cutoff = 0;
  if (approved) {
    const covered = coverage(pr, defaultBranch);
    const covering = approvals.filter((a) => covered(a.commit_id));
    covers = covering.length > 0;
    cutoff = Math.min(...(covers ? covering : approvals).map((a) => time(a.submitted_at)));
  }
  const ignore = automated ? pr.author : null;
  const open = openPoints(reviews, d, cutoff, ignore);
  if (approved) {
    if (!covers) notice(`stale:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved on an older head only`);
    if (pr.mergeable === 'CONFLICTING') notice(`conflict:${tag(pr)}@${pr.head}`, `triage ${tag(pr)} head ${h}: approved, conflict`);
    // On a blocked pull request any new activity is reported, so that the skill reads it again. Whatever the skill read
    // for one report (the open points and the activity so far) does not cause the next.
    const all = activity(reviews, d).map((i) => i.id);
    if ((blocked ? all : open).some((i) => !seen.has(`open:${tag(pr)}:${i}`))) {
      for (const i of [...open, ...all]) seen.add(`open:${tag(pr)}:${i}`);
      emit(`triage ${tag(pr)} head ${h}: approved, open points`);
    }
  }
  if (!covers || open.length || blocked || pr.mergeable !== 'MERGEABLE') return e;

  const checks = checksOf(pr);
  e.notPassed = checks.filter((c) => c.state !== 'pass');
  e.automated = automated;
  const failed = checks.filter((c) => c.required && c.state === 'fail');
  const pending = checks.filter((c) => c.required && c.state === 'pending');
  if (pr.mergeState === 'BEHIND') e.status = 'behind';
  else if (failed.length) { if (approved && !opts.noMerge) rerun(pr, failed); }
  else if (pending.length) { /* wait for the required checks */ }
  else if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeState)) e.status = 'ok';
  // An automated pull request is blocked until it is approved; an approved one blocked by a rule GitHub names on refusal.
  else if (pr.mergeState === 'BLOCKED') e.status = automated ? 'ok' : 'attempt';
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
  const external = failed.filter((c) => !c.runId).map((c) => c.name);
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
    notice(`syncfail:${tag(pr)}@${pr.head}:${e.detail || e.message}`, `sync failed ${tag(pr)} head ${short(pr.head)}: ${e.detail || e.message}`);
  }
}

function mergeOne(e, squash, head) {
  const { pr } = e;
  if (e.automated) {
    gh(['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${head}`]);
    emit(`approved ${tag(pr)} (automated)`);
  }
  run('gh', ['pr', 'merge', String(pr.number), '--repo', pr.repo, squash ? '--squash' : '--merge', '--match-head-commit', head]);
  const late = (e.notPassed || []).map((c) => `${c.name} (${c.state === 'pending' ? 'pending' : c.result})`);
  emit(`merged ${tag(pr)} into ${pr.baseRef} (${squash ? 'squash' : 'merge commit'}) head ${short(head)}${late.length ? `; not passed: ${late.join(', ')}` : ''}`);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `chain` runs from the top of a stack down to the pull request based on the default branch. Each child is merged into
// its parent with a merge commit, top down; the parent's new head must be exactly that merge, and is the head the next
// merge names. Then the bottom is squash-merged.
async function mergeChain(chain) {
  let head = chain[0].pr.head;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i], squash = i === chain.length - 1;
    try {
      try { mergeOne(e, squash, head); } catch (err) {
        if ((i === 0 && !e.automated) || BEHIND.test(err.message)) throw err;
        await sleepMs(5000); // GitHub recomputes mergeability after a child's merge commit or an approval lands
        mergeOne({ ...e, automated: false }, squash, head);
      }
    } catch (err) {
      const msg = err.detail || err.message;
      if (BEHIND.test(msg)) sync({ ...e.pr, head });
      else notice(`mergefail:${tag(e.pr)}@${head}:${msg}`, `merge failed ${tag(e.pr)} head ${short(head)}: ${msg}`);
      return;
    }
    if (squash) return;
    const parent = chain[i + 1].pr;
    const next = onePr(parent.repo, parent.number).pr.head;
    const parents = (gh(['api', `repos/${parent.repo}/commits/${next}`])?.parents || []).map((p) => p.sha);
    if (parents.length !== 2 || parents[0] !== parent.head || parents[1] !== head) {
      notice(`mergefail:${tag(parent)}@${next}:unexpected`, `merge failed ${tag(parent)} head ${short(next)}: the head is not the merge of ${tag(e.pr)}; the stack stops here`);
      return;
    }
    head = next;
  }
}

// ---- one scan -------------------------------------------------------------------------------------------------------

const startedAt = Date.now();

function closedOwn(repo) {
  if (!opts.mine) return;
  // A day of lookback covers the time the skill spends acting between runs; the state file keeps each notice to one.
  const since = new Date(startedAt - 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  for (const who of ['author', 'assignee']) {
    const q = encodeURIComponent(`repo:${repo} is:pr is:closed is:unmerged ${who}:${opts.mine} closed:>=${since}`);
    for (const item of gh(['api', '--paginate', '--slurp', `search/issues?q=${q}&per_page=100`]).flatMap((p) => p.items || [])) {
      notice(`closed:${repo}#${item.number}`, `closed ${repo}#${item.number}`);
    }
  }
}

async function scanRepo(target) {
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
  prs = prs.filter((p) => p.state === 'OPEN' && !p.draft);
  if (target.whole) { try { closedOwn(repo); } catch (e) { warn(`${repo} closed pull requests`, e); } }

  const evals = [];
  for (const pr of prs) {
    try { evals.push(evaluate(pr, defaultBranch, target.numbers.has(pr.number))); } catch (e) { warn(tag(pr), e); evals.push({ pr, status: null }); }
  }

  // A stack parent is a pull request from a branch of this repository; a fork's branch is never another pull request's base.
  const byHead = new Map(evals.filter((e) => !e.pr.cross).map((e) => [e.pr.headRef, e]));
  const bases = new Set(evals.map((e) => e.pr.baseRef));
  const done = new Set();
  for (const top of evals.filter((e) => e.pr.cross || !bases.has(e.pr.headRef))) {
    const chain = [top];
    let cur = top;
    while (cur.pr.baseRef !== defaultBranch && byHead.has(cur.pr.baseRef) && !chain.includes(byHead.get(cur.pr.baseRef))) chain.push(cur = byHead.get(cur.pr.baseRef));
    if (cur.pr.baseRef !== defaultBranch || chain.some((e) => !e.status || done.has(e))) continue;
    chain.forEach((e) => done.add(e));
    try {
      if (chain.some((e) => e.status === 'behind')) { if (!opts.noMerge) chain.filter((e) => e.status === 'behind').forEach((e) => sync(e.pr)); continue; }
      if (opts.noMerge && chain.some((e) => e.status !== 'ok')) continue;
      const contained = chain.slice(0, -1).every((e, i) => ['ahead', 'identical'].includes(gh(['api', `repos/${repo}/compare/${chain[i + 1].pr.head}...${e.pr.head}`])?.status));
      if (!contained) {
        notice(`stack:${tag(top.pr)}@${chain.map((e) => e.pr.head).join(',')}`, `stack ${tag(top.pr)}: a child does not contain its parent's head`);
        continue;
      }
      if (opts.noMerge) chain.forEach((e) => notice(`ready:${tag(e.pr)}@${e.pr.head}`, `ready ${tag(e.pr)} head ${short(e.pr.head)}`));
      else await mergeChain(chain);
    } catch (e) { warn(`${tag(top.pr)} stack`, e); }
  }
}

(async () => {
  const deadline = startedAt + opts.deadline * 1000;
  for (;;) {
    printed = [];
    for (const target of opts.targets.values()) {
      try { await scanRepo(target); } catch (e) { warn(target.repo, e); }
    }
    saveState();
    if (printed.some((l) => !/^(rerun|synced) /.test(l))) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleepMs(Math.min(opts.interval * 1000, remaining));
  }
})();
