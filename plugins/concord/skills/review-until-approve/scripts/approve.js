#!/usr/bin/env node
'use strict';
// Round runner of review-until-approve. Every verb prints one JSON line.
//   start <owner/repo> <pr> [--reviewer codex|claude] [--model <m>] [--language <tag>] [--effort <level>]   check identity, open or resume the ledger, say what to do next
//   trust <owner/repo> <pr> [--declaration '<words>' --confirmation '<reply>' | --revoke]   print the question, record the user's trust declaration for this pull request, or withdraw it
//   round <owner/repo> <pr>                                           review, publish, approve when clean
//   approve <owner/repo> <pr>                                         approve the reviewed head if the approval condition holds
//   waive <owner/repo> <pr> <finding-id|key>                          the user dismisses a finding, then approve if possible
//   reclass <owner/repo> <pr> <finding-id|key> <blocker|minor> --reason '<line>'   the user changes the class of an open finding, then approve if it became minor
//   stop <owner/repo> <pr>                                            record a user stop
//   nudged <owner/repo> <pr> '<nudge event json>'                     record that the user was told, so the watch stays silent until a new head or reply
// Run under `mien exec <profile> --` when the reviewing account is not the ambient gh account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');
const publish = require('./publish');
const { core } = require('./locate');
const { writeFileAtomic } = require(path.join(core, 'atomic-write'));
const { reclaimStaleLock } = require(path.join(core, 'run-lock'));
const { allowedFindingPrefixes } = require(path.join(core, 'artifact-contract'));
const broker = require('./broker');

// The review clone's .git is writable for an unconfined reviewer, which could plant refs/replace/* to make a head read differently; evidence is read as stored.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

const MAX_ROUNDS = 10;
const MAX_DISCARDS = 3;
// The Claude reviewer is unconfined (#366), so it runs only on a pull request the user declared trusted: `trust` records the user's own confirming words in that pull request's ledger.
// Under Claude Code the Claude reviewer runs as subagents of the session that drives the skill, with the session's own login, so it needs no `claude` binary and no credentials of its own.
const subagents = () => !!process.env.CLAUDECODE;
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku'];
// The reasoning effort each reviewer takes: the Codex runner passes it as model_reasoning_effort, which has no `max`; Claude takes it as `--effort` (`claude -p`) or the Agent tool's `effort` (subagents).
const EFFORTS = { codex: ['low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'] };
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const warningFor = (ledger) => `the claude reviewer runs unconfined on your trust declaration${ledger.trust ? ` (recorded ${ledger.trust.recordedAt})` : ''}: it can read your real home directory (gh, ssh and cloud credentials); a malicious pull request could make it publish their contents, and it is not trusted to leave the review clone intact. To withdraw the declaration, run trust --revoke for this pull request (the codex reviewer stays confined).`;
const die = (message, code = 1) => { process.stderr.write(`review-until-approve: ${message}\n`); process.exit(code); };
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// A Claude run says so in every result, and on stderr where the user sees it.
const outFor = (ledger, value) => {
  if (ledger.provider !== 'claude') return out(value);
  const warning = warningFor(ledger);
  process.stderr.write(`review-until-approve: WARNING: ${warning}\n`);
  out({ ...value, warning: [value.warning, warning].filter(Boolean).join(' ') });
};

function run(command, args, { input, cwd, env } = {}) {
  const r = spawnSync(command, args, { input, cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${command} ${args[0]} failed: ${(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}
const gh = (args, input) => run('gh', args, { input });
const ghJson = (args, input) => JSON.parse(gh(args, input));
const git = (cwd, args, env) => run('git', args, { cwd, env: env ? { ...process.env, ...env } : undefined });
// The credential helper is given to the clone and fetches only, never written to configuration.
const GIT_AUTH = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential' };

const stateDir = () => process.env.REVIEW_APPROVE_STATE_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'concord', 'review-until-approve');
const ledgerFile = (repo, pr, login) => path.join(stateDir(), `${repo.replace('/', '__')}__${pr}__${login}.json`);
const load = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const save = (file, ledger) => { fs.mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`); };

const held = new Set();
function lock(file) {
  if (held.has(file)) return;
  const dir = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), String(process.pid));
      process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
      held.add(file);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!reclaimStaleLock(dir)) die('another session is already reviewing this pull request');
    }
  }
  die('could not take the ledger lock');
}

// The reviewer reads attacker-controlled files, so it gets an allowlist, not the whole environment.
const ENV_ALLOWED = /^(PATH|USER|LOGNAME|LANG|LC_\w+|TERM|TMPDIR|TZ|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS)$/;
// HOME is an empty directory; the engine keeps the reviewer from the real home (`reviewRealHome`) with a Codex
// file-system profile (Codex only). The Codex engine copies auth.json from CODEX_HOME into a home of its own.
function reviewerEnv(provider, claudeConfig, home, realClaudeConfig) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ENV_ALLOWED.test(name)));
  env.HOME = home;
  env.CLAUDE_CONFIG_DIR = claudeConfig;
  if (provider === 'codex') env.CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (provider === 'claude' && !subagents()) {
    // The opted-in Claude reviewer can already read the whole home, so it authenticates as the user: the token when set, else the
    // real credentials file copied into its own config directory. The user's settings, hooks, plugins and MCP servers never load
    // into the review: its allow rules and a logged-in gh would go beyond what the opt-in accepts.
    const credentials = path.join(realClaudeConfig, '.credentials.json');
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else if (fs.existsSync(credentials)) {
      const copy = path.join(claudeConfig, '.credentials.json');
      fs.copyFileSync(credentials, copy);
      credentialCopies.push(copy);
    }
  }
  return env;
}

function snapshot(repo, pr) {
  const v = ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,baseRefOid,title,body,state,isDraft,author']);
  const mergeBase = gh(['api', `repos/${repo}/compare/${v.baseRefOid}...${v.headRefOid}`, '--jq', '.merge_base_commit.sha']).trim();
  return { head: v.headRefOid, baseTip: v.baseRefOid, mergeBase, intent: lib.sha(`${v.title}\n\n${v.body}`), title: v.title, body: v.body, state: v.state, isDraft: v.isDraft, author: v.author.login };
}

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// Every long string of a credentials file (access and refresh tokens): a copy of it sits where the opted-in Claude reviewer can read it.
const credentialCopies = [];
function credentialStrings(file) {
  const found = [];
  const walk = (value) => { if (typeof value === 'string') { if (value.length >= 20) found.push(value); } else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  try { walk(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) { /* absent or not JSON: nothing to check */ }
  return found;
}
const secrets = () => [process.env.GH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.OPENAI_API_KEY, (() => { try { return gh(['auth', 'token']).trim(); } catch (_) { return ''; } })(),
  ...credentialStrings(path.join(claudeConfigDir(), '.credentials.json')), ...credentialCopies.flatMap(credentialStrings)];

function guard(text) {
  if (publish.containsSecret(text, secrets())) throw new Error('the review text holds a credential; nothing was posted');
  return text;
}
function post(repo, pr, { threads, ...payload }) {
  return ghJson(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], guard(JSON.stringify(payload)));
}

// A review is built as a pending one (invisible until submitted): GitHub refuses a whole review for one bad comment and the
// review API has no file-level comment, but a GraphQL thread can be added, and can fail, one at a time.
const THREAD = 'mutation($r:ID!,$p:String!,$b:String!,$l:Int,$t:PullRequestReviewThreadSubjectType!){addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$p,body:$b,line:$l,side:RIGHT,subjectType:$t}){thread{id}}}';
function postThread(nodeId, t) {
  guard(t.body);
  try {
    const args = ['api', 'graphql', '-f', `query=${THREAD}`, '-f', `r=${nodeId}`, '-f', `p=${t.path}`, '-f', `b=${t.body}`, '-f', `t=${t.subject}`, ...(t.subject === 'LINE' ? ['-F', `l=${t.line}`] : [])];
    return ghJson(args).data?.addPullRequestReviewThread?.thread?.id || null;
  } catch (_) { return null; }
}
// Returns the submitted review, or null when the head moved before the submission (the pending review is deleted).
// A comment GitHub refuses moves only its finding to the body. A pending review left by a crash carries the marker and is deleted first; one without it is the user's own draft and is never touched.
function publishReview({ repo, pr, reviewer, head, after, state, input, render, headMoved, onThread }) {
  const drop = (id) => gh(['api', '-X', 'DELETE', `repos/${repo}/pulls/${pr}/reviews/${id}`]);
  for (const r of reviewsOf(repo, pr)) {
    if (r.user?.login !== reviewer || r.state !== 'PENDING') continue;
    if (!(r.body || '').startsWith('<!-- concord-approve:')) throw new Error(`finish or discard your pending review on ${repo}#${pr} first`);
    drop(r.id);
  }
  const first = render(input, 'inline');
  const pending = post(repo, pr, { commit_id: head, body: first.body.split('\n')[0] });
  const rejected = first.threads.filter((t) => {
    const id = postThread(pending.node_id, t);
    if (id) onThread(t.finding, id);
    return !id;
  }).map((t) => t.finding);
  if (headMoved()) { drop(pending.id); return null; }
  const final = render({ ...input, rejected }, 'inline');
  const submit = () => ghJson(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews/${pending.id}/events`, '--input', '-'], guard(JSON.stringify({ event: final.event, body: final.body })));
  try { return submit(); } catch (error) {
    // Accepted although the call failed: take that review; otherwise the pending review still exists, so submit once more.
    return landed(reviewsOf(repo, pr), reviewer, head, after, state) || submit();
  }
}

// A finding that is fixed has its own thread answered and resolved; one reopened has it unresolved. Each thread is checked when acted on:
// still on this pull request, started by this account, not resolved by anyone else. A failure that may pass (network) records nothing, so the next round retries.
const THREAD_STATE = 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved resolvedBy{login} pullRequest{number repository{nameWithOwner}} root:comments(first:1){nodes{author{login}}} comments(last:100){nodes{author{login} body createdAt}}}}}';
// ponytail: the thread's starter is read apart from the newest 100 comments, which are what the author-reply and last-comment checks need.
// settleThreads needs only the starter and isResolved, so it does not download comment bodies.
const SETTLE_STATE = 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved pullRequest{number repository{nameWithOwner}} root:comments(first:1){nodes{author{login}}}}}}';
const threadMutation = (name, field) => `mutation($id:ID!${field === 'reply' ? ',$b:String!' : ''}){${name}(input:{${field === 'reply' ? 'pullRequestReviewThreadId:$id,body:$b' : 'threadId:$id'}}){clientMutationId}}`;
const threadCall = (name, field, id, body) => ghJson(['api', 'graphql', '-f', `query=${threadMutation(name, field)}`, '-f', `id=${id}`, ...(body ? ['-f', `b=${body}`] : [])]);
function settleThreads(repo, pr, ledger, file) {
  const head = (ledger.rounds[ledger.rounds.length - 1] || {}).head;
  if (!head) return;
  const short = (sha) => sha.slice(0, 7);
  for (const f of ledger.findings) {
    if (!f.threadId) continue;
    const fixing = (f.status === 'fixed' || f.status === 'addressed') && !f.threadSkipped && !f.threadResolved;
    const reopened = f.status === 'open' && (f.threadResolved || f.threadReplied || f.threadSkipped || f.threadReopened);
    if (!fixing && !reopened) continue;
    try {
      const t = ghJson(['api', 'graphql', '-f', `query=${SETTLE_STATE}`, '-f', `id=${f.threadId}`]).data?.node;
      const mine = t && t.pullRequest?.number === Number(pr) && t.pullRequest?.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase() && t.root?.nodes?.[0]?.author?.login === ledger.reviewer;
      if (!t) f.threadSkipped = 'gone';
      else if (!mine) f.threadSkipped = 'not-ours';
      else if (fixing && t.isResolved) f.threadSkipped = 'resolved';
      else if (fixing) {
        if (!f.threadReplied) { threadCall('addPullRequestReviewThreadReply', 'reply', f.threadId, guard(f.status === 'addressed' ? `Addressed at \`${short(f.addressedHead)}\`: ${f.addressedEvidence.reason} (\`${f.addressedEvidence.file}\`).` : `Fixed in \`${short(ledger.rounds[f.fixedRound - 1].head)}\`.`)); f.threadReplied = true; save(file, ledger); }
        threadCall('resolveReviewThread', 'id', f.threadId);
        f.threadResolved = true;
      } else {
        if (f.threadResolved && t.isResolved) { threadCall('unresolveReviewThread', 'id', f.threadId); f.threadReopened = short(head); }
        delete f.threadResolved; delete f.threadReplied; delete f.threadSkipped;
        save(file, ledger);
        if (f.threadReopened) { threadCall('addPullRequestReviewThreadReply', 'reply', f.threadId, `Reopened at \`${f.threadReopened}\`.`); delete f.threadReopened; }
      }
    } catch (_) { /* ponytail: nothing is recorded, so the next round retries */ }
    save(file, ledger);
  }
}

// GitHub may accept a review and still fail the call (a timeout, a crash before the ledger is saved). A review
// by this account on this head with an id above `after` (the newest id before the post) is that review.
const reviewsOf = (repo, pr) => ghJson(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews`]).flat();
const newestId = (reviews) => reviews.reduce((m, r) => Math.max(m, r.id), 0);
const landed = (reviews, login, head, after, state) => reviews.find((r) => r.user?.login === login && r.commit_id === head && r.id > after && r.state === state);

// A pending marker is written before an APPROVE is posted. Settle it before anything else posts: when the
// review reached GitHub, record the round and the approval it stands for; otherwise drop the marker.
function settlePending(repo, pr, ledger, file, reviewer) {
  if (!ledger?.pending) return;
  const { head, after, round, findings } = ledger.pending;
  const review = landed(reviewsOf(repo, pr), reviewer, head, after, 'APPROVED');
  if (review) {
    const at = review.submitted_at || new Date().toISOString();
    if (round && round.n === ledger.rounds.length + 1) ledger.rounds.push({ ...round, reviewId: review.id, submittedAt: at });
    if (findings) ledger.findings = findings;
    ledger.approval = { head, reviewId: review.id, at };
    delete ledger.attempt;
  }
  delete ledger.pending;
  save(file, ledger);
}

// The ledger is read under the lock, so a session that waited for it sees the other session's saved state.
// The file name carries the login: another account reviewing the same pull request has its own ledger.
function identify(repo, pr, args) {
  const reviewer = gh(['api', 'user', '--jq', '.login']).trim();
  const file = ledgerFile(repo, pr, reviewer);
  lock(file);
  const ledger = load(file);
  settlePending(repo, pr, ledger, file, reviewer);
  return { reviewer, file, ledger, args };
}

const onPath = (name) => (process.env.PATH || '').split(path.delimiter).some((dir) => (process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD').split(';') : ['']).some((ext) => { try { fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK); return true; } catch (_) { return false; } }));
// What a reviewer still needs from the user, in the words that fix it. An empty list means it is ready.
function missing(provider, repo, pr, trust) {
  if (provider === 'codex') return [!onPath('codex') ? 'install codex' : !fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json')) && 'run `codex login`'].filter(Boolean);
  // The Claude reviewer cannot yet be kept from the account's home directory (#366), so it runs only on a pull request the user declared trusted.
  const untrusted = !trust && `it cannot be confined yet (#366), so ${repo}#${pr} is reviewed by it only after you declare that you trust its author${process.env.CLAUDECODE ? '; or ask explicitly for the confined Codex reviewer (--reviewer codex)' : ''}`;
  if (subagents()) return [untrusted].filter(Boolean);
  return [!onPath('claude') && 'install claude', !process.env.CLAUDE_CODE_OAUTH_TOKEN && !fs.existsSync(path.join(claudeConfigDir(), '.credentials.json')) && `log in with claude (no \`.credentials.json\` in ${claudeConfigDir()}) or export CLAUDE_CODE_OAUTH_TOKEN (create one with \`claude setup-token\`)`, untrusted].filter(Boolean);
}
// The reviewer is the one asked for, the resumed ledger's, or the harness's own; the other vendor is never substituted.
function chooseReviewer(asked, repo, pr, trust) {
  if (asked && !['codex', 'claude'].includes(asked)) die('--reviewer must be codex or claude');
  const provider = asked || (process.env.CLAUDECODE ? 'claude' : 'codex');
  const need = missing(provider, repo, pr, trust);
  if (need.length) die(`the ${provider} reviewer is not ready: ${need.join('; ')}${asked ? '' : `. No other reviewer is substituted${provider === 'codex' ? '; ask explicitly for --reviewer claude if you want it' : ''}`}`);
  return { provider };
}

// The Agent tool takes only these model names.
function checkModel(ledger) {
  if (ledger.provider === 'claude' && subagents() && ledger.model && !MODEL_ALIASES.includes(ledger.model)) die(`under Claude Code the Claude reviewer runs as subagents, which take only the model names ${MODEL_ALIASES.slice(0, 2).join(', ')} or ${MODEL_ALIASES[2]}; --model ${ledger.model} cannot be used (run start with --model sonnet, opus or haiku)`);
}

function checkLanguageAndEffort(ledger) {
  if (ledger.language && !LANGUAGE_TAG.test(ledger.language)) die(`--language must be a BCP 47 tag such as ko, en or zh-TW, not "${ledger.language}"`);
  if (ledger.effort && !EFFORTS[ledger.provider].includes(ledger.effort)) die(`--effort ${ledger.effort} cannot be used with the ${ledger.provider} reviewer, which takes ${EFFORTS[ledger.provider].join(', ')}`);
}

// When the Claude reviewer ran unconfined on the user's declaration; a published review states it.
const unconfinedAt = (ledger) => ledger.provider === 'claude' && ledger.trust ? ledger.trust.recordedAt : undefined;
const newLedger = (repo, pr, reviewer, author) => ({ version: 1, repo, pr, reviewer, provider: null, model: null, language: null, effort: null, author, startedAt: new Date().toISOString(), rounds: [], findings: [], nudged: null, approval: null, stopped: null });
const opt = (args, name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const lastRound = (ledger) => ledger.rounds[ledger.rounds.length - 1];

function start(repo, pr, args) {
  const { reviewer, file, ledger: found } = identify(repo, pr, args);
  const snap = snapshot(repo, pr);
  if (snap.state !== 'OPEN') die(`the pull request is ${snap.state}`);
  if (snap.author === reviewer) die(`${reviewer} is the author; GitHub rejects self-approval`);
  const { provider } = chooseReviewer(opt(args, '--reviewer') || found?.provider, repo, pr, found?.trust);
  const ledger = found || newLedger(repo, pr, reviewer, snap.author);
  ledger.provider = provider;
  if (opt(args, '--model')) ledger.model = opt(args, '--model');
  if (opt(args, '--language')) ledger.language = opt(args, '--language');
  if (opt(args, '--effort')) ledger.effort = opt(args, '--effort');
  checkModel(ledger);
  checkLanguageAndEffort(ledger);
  ledger.stopped = null;
  save(file, ledger);
  const viewer = gh(['repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission']).trim();
  const warning = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(viewer) ? undefined : `permission ${viewer}: an approval will not satisfy branch protection`;
  let action = 'watch';
  if (ledger.rounds.length === 0 || snap.head !== lastRound(ledger).head) action = 'round';
  else if (lib.evaluateApproval(ledger, snap, lastRound(ledger).head).approve) action = 'approve';
  outFor(ledger, { ledger: file, action, round: ledger.rounds.length + 1, reviewer: provider, ...(ledger.model && { model: ledger.model }), ...(ledger.language && { language: ledger.language }), ...(ledger.effort && { effort: ledger.effort }), ...(warning && { warning }) });
}

// The findings the reviewer is told about. Telling it decides nothing: a finding is fixed by the code, never by the reviewer's silence. The runner gives each role only the ids of its own artifact.
const priorFindings = (open) => open.map((f) => ({ id: f.id, file: f.file, summary: f.summary }));

// What the verify pass is shown about a finding whose quoted code is still present: the span, and the PR author's own replies in its thread
// (after our last comment there) and whether someone else resolved it. All of it is the author's claim; the reviewer must check it against the code.
const cut = (text, max) => text.length > max ? `${text.slice(0, max)} [truncated]` : text;
function addressable(repo, pr, ledger, shown) {
  const rank = (f) => lib.isBlocker(f) ? 0 : 1;
  // Only ids the verify artifact can list: a verdict for any other prefix would fail normalizeAddressed and the whole artifact.
  const listable = allowedFindingPrefixes('verify');
  return shown.filter((f) => typeof f.spanVerified === 'string' && f.span && listable.some((p) => f.id.startsWith(p))).sort((a, b) => rank(a) - rank(b)).slice(0, 20).map((f) => {
    const entry = { id: f.id, file: f.file, class: f.class || 'blocker', summary: f.summary, requirement: f.requirement || '', span: cut(f.span, 2048) };
    if (!f.threadId) return entry;
    try {
      const t = ghJson(['api', 'graphql', '-f', `query=${THREAD_STATE}`, '-f', `id=${f.threadId}`]).data?.node;
      const comments = t?.comments?.nodes || [];
      if (!t || t.pullRequest?.number !== Number(pr) || t.pullRequest?.repository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase() || t.root?.nodes?.[0]?.author?.login !== ledger.reviewer) return entry;
      const lastMine = comments.map((c) => c.author?.login).lastIndexOf(ledger.reviewer);
      let budget = 4000;
      const replies = comments.slice(lastMine + 1).filter((c) => c.author?.login === ledger.author).slice(-3).reverse().map((c) => cut(String(c.body || ''), 1500)).map((text) => { text = text.slice(0, Math.max(0, budget)); budget -= text.length; return text; }).reverse().filter(Boolean);
      return { ...entry, ...(replies.length && { authorReply: replies.join('\n\n') }), ...(t.isResolved && t.resolvedBy?.login && t.resolvedBy.login !== ledger.reviewer && { threadResolved: { resolved: true, by: t.resolvedBy.login } }) };
    } catch (_) { return entry; /* the thread is only an input: without it the reviewer judges the code alone */ }
  });
}

// The class a published finding is labeled with.
const pick = ({ class: cls, reason, releaseBlocking }) => ({ class: cls || 'blocker', ...(reason && { reason }), ...(releaseBlocking && { releaseBlocking }) });
const openMinors = (findings) => findings.filter((f) => f.status === 'open' && !lib.isBlocker(f));

const MAX_SPAN_FILE_BYTES = 20 * 1024 * 1024;
// A file as stored in the git object of `rev`, never from the working tree: a Buffer, null when the path is
// absent, 'other' when it is not a regular file (symlink, submodule, directory, or a path git rejects), 'big' when too large or the name does not survive decoding as UTF-8.
function gitBlob(cwd, rev, file) {
  if (file.includes('\uFFFD')) return 'big';
  const ls = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', rev, '--', file], { cwd, encoding: 'utf8' });
  if (ls.status !== 0) return 'other';
  const entry = ls.stdout.split('\0').find((e) => e.slice(e.indexOf('\t') + 1) === file && e.includes('\t'));
  if (!entry) return inGitlink(cwd, rev, file);
  const [mode, , oid] = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (mode !== '100644' && mode !== '100755') return 'other';
  const size = spawnSync('git', ['cat-file', '-s', oid], { cwd, encoding: 'utf8' });
  if (size.status !== 0 || Number(size.stdout) > MAX_SPAN_FILE_BYTES) return 'big';
  const blob = spawnSync('git', ['cat-file', 'blob', oid], { cwd, maxBuffer: MAX_SPAN_FILE_BYTES + 1024 });
  return blob.status === 0 ? blob.stdout : 'big';
}
// A path below a gitlink at `rev` is read from the submodule checkout prepared for the round, at the commit the gitlink names; null when no gitlink is a prefix of it.
function inGitlink(cwd, rev, file) {
  const parts = file.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/');
    const ls = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', rev, '--', prefix], { cwd, encoding: 'utf8' });
    const entry = ls.status === 0 ? ls.stdout.split('\0').find((e) => e.slice(e.indexOf('\t') + 1) === prefix && e.includes('\t')) : null;
    if (!entry) continue;
    const [mode, , oid] = entry.slice(0, entry.indexOf('\t')).split(' ');
    if (mode !== '160000') return null;
    const sub = path.join(cwd, prefix);
    return underClone(cwd, prefix) && fs.existsSync(path.join(sub, '.git')) ? gitBlob(sub, oid, parts.slice(i).join('/')) : 'other';
  }
  return null;
}
// A finding is verified when its span occurs byte for byte in the file at the head it was recorded against.
const verifiedAt = (cwd, head, f) => {
  const blob = f.span ? gitBlob(cwd, head, f.file) : null;
  return Buffer.isBuffer(blob) && blob.includes(Buffer.from(f.span, 'utf8'));
};

// A submodule change is reviewed on the submodule's own diff. Each gitlink the pull request changes is checked out at its own path in the
// review clone, in a fresh .git with no hooks or configuration from the pull request, from a url built here out of the `owner/repo` that
// `.gitmodules` names (never the .gitmodules string); `git submodule` is never run. A range that cannot be read is returned as `unreviewed`.
const underClone = (work, rel) => { try { return fs.realpathSync(path.join(work, rel)) === path.join(fs.realpathSync(work), rel); } catch (_) { return false; } };
// The gitlinks that differ between `from` and HEAD: { path, oldSha, newSha }, a side null when it is not a gitlink there.
function gitlinkChanges(cwd, from) {
  const raw = git(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, 'HEAD']).split('\0');
  const found = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha] = raw[i].slice(1).split(' ');
    if (oldMode === '160000' || newMode === '160000') found.push({ path: raw[i + 1], oldSha: oldMode === '160000' ? oldSha : null, newSha: newMode === '160000' ? newSha : null });
  }
  return found;
}
const submoduleUrls = (work) => {
  const urls = new Map(), paths = new Map();
  const r = spawnSync('git', ['config', '--blob', 'HEAD:.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { cwd: work, encoding: 'utf8' });
  for (const entry of r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []) {
    const nl = entry.indexOf('\n'), key = entry.slice(0, nl), dot = key.lastIndexOf('.');
    (key.slice(dot + 1) === 'path' ? paths : urls).set(key.slice(10, dot), entry.slice(nl + 1));
  }
  return new Map([...paths].filter(([name]) => urls.has(name)).map(([name, p]) => [p, urls.get(name)]));
};
const submoduleRemote = (sr) => `${process.env.REVIEW_APPROVE_REMOTE || 'https://github.com'}/${sr}.git`;
const fetchSubmodule = (dir, remote, shas) => git(dir, ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', remote, ...[...new Set(shas)].map((sha) => `${sha}:refs/concord/${sha}`)], GIT_AUTH);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function prepareSubmodules(work, repo, snap, range, subs) {
  const urls = submoduleUrls(work);
  const info = new Map();
  const visibility = (sr) => { if (!info.has(sr)) { try { info.set(sr, ghJson(['api', `repos/${sr}`])); } catch (_) { info.set(sr, null); } } return info.get(sr); };
  const inRange = gitlinkChanges(work, range.base);
  const seen = new Set(inRange.map((c) => c.path));
  const unreviewed = [];
  for (const change of [...inRange.map((c) => ({ ...c, inRange: true })), ...gitlinkChanges(work, snap.mergeBase).filter((c) => !seen.has(c.path))]) {
    if (!change.newSha) continue;
    const fail = (reason) => { if (change.inRange) unreviewed.push({ path: change.path, from: change.oldSha && change.oldSha.slice(0, 7), to: change.newSha.slice(0, 7), reason }); };
    const sr = urls.has(change.path) ? lib.submoduleRepo(urls.get(change.path), repo) : null;
    if (!sr) { fail('url'); continue; }
    if (!underClone(work, change.path) || !fs.lstatSync(path.join(work, change.path)).isDirectory() || fs.readdirSync(path.join(work, change.path)).length) { fail('path'); continue; }
    const target = visibility(sr);
    if (!target) { fail('unreadable'); continue; }
    // A private repository has its own readers (collaborators are per repository), so only the pull request's own repository, by the name GitHub resolves, may be quoted into its review.
    if (target.private && String(target.full_name).toLowerCase() !== repo.toLowerCase()) { fail('audience'); continue; }
    const dir = path.join(work, change.path);
    try {
      git(work, ['init', '--quiet', '--template=', dir]);
      fetchSubmodule(dir, submoduleRemote(sr), [change.newSha, change.oldSha].filter(Boolean));
      git(dir, ['checkout', '--quiet', '--detach', change.newSha]);
    } catch (_) { fail('fetch'); fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); continue; }
    if (gitlinkChanges(dir, change.oldSha || EMPTY_TREE).length) { fail('nested'); continue; }
    subs.set(change.path, { dir, remote: submoduleRemote(sr) });
  }
  return unreviewed;
}

// The name-status delta below one gitlink between two heads, for a finding in the submodule; null when it cannot be computed.
function submoduleDelta(work, from, subs, file) {
  const change = gitlinkChanges(work, from).find((c) => c.oldSha && c.newSha && file.startsWith(`${c.path}/`));
  if (!change) return undefined;
  const sub = subs.get(change.path);
  if (!sub) return null;
  try {
    if (spawnSync('git', ['cat-file', '-e', `${change.oldSha}^{commit}`], { cwd: sub.dir }).status !== 0) fetchSubmodule(sub.dir, sub.remote, [change.oldSha]);
    const d = lib.parseNameStatus(git(sub.dir, ['diff', '-z', '--name-status', '-M', change.oldSha, change.newSha]));
    const at = (f) => `${change.path}/${f}`;
    return { renames: new Map([...d.renames].map(([a, b]) => [at(a), at(b)])), live: new Set([...d.live].map(at)) };
  } catch (_) { return null; }
}

function reviewRound(repo, pr, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger?.provider) die('no ledger; run start first');
  if (ledger.rounds.length >= MAX_ROUNDS) return outFor(ledger, { event: 'round-limit', rounds: ledger.rounds.length });
  for (let discards = 0; discards < MAX_DISCARDS; discards++) {
    // Read again before every launch: a discarded attempt takes minutes, and the user may have revoked the declaration meanwhile.
    if (ledger.provider === 'claude') { const need = missing('claude', repo, pr, ledger.trust); if (need.length) die(`the claude reviewer is not ready: ${need.join('; ')}`); }
    checkModel(ledger);
    const result = attempt(repo, pr, ledger, file);
    if (result) return outFor(ledger, result);
  }
  outFor(ledger, { event: 'head-keeps-moving' });
}

// One round against the live head. Returns the summary, or null when the head moved and the result is discarded.
function attempt(repo, pr, ledger, file) {
  const snap = snapshot(repo, pr);
  if (snap.state !== 'OPEN') return { event: snap.state.toLowerCase() };
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-until-approve-'));
    const work = path.join(dir, 'work');
    const remote = `${process.env.REVIEW_APPROVE_REMOTE || 'https://github.com'}/${repo}.git`;
    // Written before anything slow, so `next` never finds no round while this one is still setting up; it is removed when the process ends, and a pid that is gone is not a running round.
    const brokerDir = ledger.provider === 'claude' && subagents() ? path.join(dir, 'broker') : null;
    if (brokerDir) {
      fs.mkdirSync(brokerDir);
      fs.writeFileSync(`${runFile(file)}.tmp`, JSON.stringify({ pid: process.pid, dir: brokerDir }));
      fs.renameSync(`${runFile(file)}.tmp`, runFile(file));
      process.once('exit', () => fs.rmSync(runFile(file), { force: true }));
    }
    git(dir, ['clone', '--quiet', remote, work], GIT_AUTH);
    git(work, ['fetch', '--quiet', '--no-recurse-submodules', 'origin', `pull/${pr}/head`], GIT_AUTH);
    git(work, ['checkout', '-q', '-B', `concord-pr-${pr}`, snap.head], GIT_AUTH);
    git(work, ['fetch', '--quiet', '--no-recurse-submodules', 'origin', snap.baseTip], GIT_AUTH);
    if (git(work, ['merge-base', snap.baseTip, 'HEAD']).trim() !== snap.mergeBase) throw new Error('the local merge base differs from the snapshot');
    const prior = ledger.rounds.length ? lastRound(ledger) : null;
    const isAncestor = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: work }).status === 0;
    const range = prior ? lib.chooseRange(prior, snap, isAncestor) : { base: snap.mergeBase, broad: true };
    const subs = new Map();
    const unreviewed = prepareSubmodules(work, repo, snap, range, subs);
    // The engine's diff of a gitlink then holds the submodule's own hunks.
    git(work, ['config', 'diff.submodule', 'diff']);

    // The delta from the head where each open finding's span was last verified to this head; a head that is gone is fetched, else the finding stays open.
    const deltas = new Map();
    const resolve = (p) => {
      if (!deltas.has(p.spanVerified)) {
        let delta = null;
        try {
          if (spawnSync('git', ['cat-file', '-e', `${p.spanVerified}^{commit}`], { cwd: work }).status !== 0) git(work, ['fetch', '--quiet', '--no-recurse-submodules', 'origin', p.spanVerified], GIT_AUTH);
          delta = lib.parseNameStatus(git(work, ['diff', '-z', '--name-status', '-M', p.spanVerified, snap.head]));
        } catch (_) { /* unreachable head: its findings stay open */ }
        deltas.set(p.spanVerified, delta);
      }
      const delta = deltas.get(p.spanVerified);
      if (!delta) return delta;
      // A finding below a gitlink follows the submodule's own renames; when they cannot be read, the finding stays open.
      const inSub = submoduleDelta(work, p.spanVerified, subs, p.file);
      return inSub === undefined ? delta : inSub && { renames: new Map([...delta.renames, ...inSub.renames]), live: new Set([...delta.live, ...inSub.live]) };
    };
    const open = ledger.findings.filter((f) => f.status === 'open');
    const shown = open.map((p) => { const d = typeof p.spanVerified === 'string' && p.span ? resolve(p) : null; return { ...p, file: d?.renames.get(p.file) || p.file }; });

    // A finding whose span is gone at this head is about to be fixed: it is not offered, and does not take a slot of the cap.
    const gone = new Set(lib.classifyPrior(open, [], resolve, (file) => gitBlob(work, snap.head, file), snap.head).filter((r) => r.status === 'fixed').map((r) => r.key));
    const addressableNow = addressable(repo, pr, ledger, shown.filter((f) => !gone.has(f.key)));
    const intentFile = path.join(dir, 'intent.md');
    fs.writeFileSync(intentFile, `# ${snap.title}\n\n${snap.body}`);
    const realClaudeConfig = claudeConfigDir();
    const claudeConfig = fs.mkdtempSync(path.join(dir, 'claude-'));
    const reviewerHome = fs.mkdtempSync(path.join(dir, 'home-'));
    const runnerOptions = { ref: `concord-pr-${pr}`, base: range.base, broad: range.broad, noBroad: !range.broad, reviewer: ledger.provider, reviewerModel: ledger.model || undefined, reasoningEffort: ledger.effort || undefined, reviewLanguage: ledger.language || undefined, reviewDenyRead: [realClaudeConfig], reviewRealHome: os.homedir(), priorFindings: priorFindings(shown), ...(addressableNow.length && { addressable: addressableNow }), intentFile: range.broad ? intentFile : undefined };
    const env = reviewerEnv(ledger.provider, claudeConfig, reviewerHome, realClaudeConfig);
    const runner = process.env.REVIEW_APPROVE_RUNNER || path.join(__dirname, 'run-review.js');
    // The runner waits in `dir/broker` for the session to answer each request; `next` finds that directory through the run file.
    if (brokerDir) {
      runnerOptions.broker = brokerDir;
      if (process.env.REVIEW_APPROVE_BROKER_TIMEOUT_MS) runnerOptions.brokerTimeoutMs = Number(process.env.REVIEW_APPROVE_BROKER_TIMEOUT_MS);
    }
    const reviewed = JSON.parse(run('node', [runner, JSON.stringify(runnerOptions)], { cwd: work, env }).trim().split('\n').pop());
    if (reviewed.decision !== 'review-only' || !Array.isArray(reviewed.findings)) throw new Error(`the review did not complete: ${JSON.stringify(reviewed).slice(0, 200)}`);

    const n = ledger.rounds.length + 1;
    // An addressed finding is judged again every round with the open ones.
    const tracked = ledger.findings.filter((f) => f.status === 'open' || f.status === 'addressed');
    // Only a finding offered this round can be closed by a verdict; any other verdict is reported as not-offered below.
    const offered = new Set(addressableNow.map((f) => f.id));
    const verdicts = (Array.isArray(reviewed.addressed) ? reviewed.addressed : []).filter((a) => offered.has(a?.id));
    const verdict = lib.classifyPrior(tracked, reviewed.findings, resolve, (file) => gitBlob(work, snap.head, file), snap.head, verdicts);
    const addressedRejected = [...verdict.filter((r) => r.why).map((r) => ({ id: r.id, why: r.why })), ...(Array.isArray(reviewed.addressed) ? reviewed.addressed : []).filter((a) => !offered.has(a?.id)).map((a) => ({ id: String(a?.id), why: 'not-offered' }))];
    const next = JSON.parse(JSON.stringify(ledger));
    const stillOpenFindings = [];
    const inNext = (key) => next.findings.find((f) => f.key === key && (f.status === 'open' || f.status === 'addressed'));
    for (const r of verdict) {
      const f = inNext(r.key);
      if (r.status === 'fixed') Object.assign(f, { status: 'fixed', fixedRound: n });
      else if (r.status === 'addressed') {
        if (r.evidenceFile && f.addressedEvidence && r.evidenceFile !== f.addressedEvidence.file) f.addressedEvidence = { ...f.addressedEvidence, file: r.evidenceFile };
        if (r.evidence) { Object.assign(f, { status: 'addressed', addressedRound: n, addressedHead: snap.head, addressedEvidence: r.evidence }); delete f.openReason; }
        if (r.file && (r.file !== f.file || r.spanVerified !== f.spanVerified)) Object.assign(f, { file: r.file, spanVerified: r.spanVerified, key: lib.findingKey({ ...f, file: r.file }) });
      } else {
        if (f.status === 'addressed') { f.status = 'open'; delete f.addressedRound; delete f.addressedHead; delete f.addressedEvidence; }
        stillOpenFindings.push(f);
        Object.assign(f, { openReason: r.reason });
        if (r.file && (r.file !== f.file || r.spanVerified !== f.spanVerified)) Object.assign(f, { file: r.file, spanVerified: r.spanVerified, key: lib.findingKey({ ...f, file: r.file }) });
      }
    }
    // A raised finding is posted when new; one whose span is verbatim at this head also verifies an unverified finding of the same file and span, and reopens a fixed one (same file and span only).
    const fresh = reviewed.findings.filter((f, i, all) => !lib.isPublished(next, f) && all.findIndex((g) => lib.findingKey(g) === lib.findingKey(f)) === i);
    const verified = (f) => typeof f.spanVerified === 'string' && f.span;
    const reopened = new Set();
    for (const f of reviewed.findings.filter((g) => verifiedAt(work, snap.head, g))) {
      const unverified = next.findings.find((g) => g.status === 'open' && !verified(g) && lib.findingKey(g) === lib.findingKey(f));
      const fixed = unverified || next.findings.some((g) => g.status === 'open' && lib.findingKey(g) === lib.findingKey(f)) ? null : next.findings.find((g) => g.status === 'fixed' && lib.findingKey(g) === lib.findingKey(f));
      const known = unverified || fixed;
      if (!known) continue;
      Object.assign(known, { status: 'open', span: f.span, file: f.file, spanVerified: snap.head });
      delete known.fixedRound;
      delete known.openReason;
      delete known.addressedRound; delete known.addressedHead; delete known.addressedEvidence;
      known.key = lib.findingKey(known);
      reopened.add(lib.findingKey(f));
    }
    for (const f of fresh.filter((g) => !reopened.has(lib.findingKey(g)))) {
      next.findings.push({ key: lib.findingKey(f), id: f.id, category: f.category, file: f.file, line: f.line, span: f.span, summary: f.summary, requirement: f.requirement || '', ...lib.strictest(reviewed.findings.filter((g) => lib.findingKey(g) === lib.findingKey(f))), status: 'open', firstRound: n, ...(verifiedAt(work, snap.head, f) && { spanVerified: snap.head }) });
    }
    for (const f of next.findings) if (f.status === 'open' && !verified(f)) f.openReason = 'unverified';
    for (const f of next.findings) if (f.status === 'open' && verified(f) && f.openReason === 'unverified') delete f.openReason;
    const fixedIds = verdict.filter((r) => r.status === 'fixed').map((r) => r.id);
    const addressedIds = verdict.filter((r) => r.evidence).map((r) => r.id);
    const openIds = verdict.filter((r) => r.status === 'open').map((r) => r.id);
    const held = next.findings.filter((f) => f.status === 'open' && lib.isBlocker(f) && ['unverified', 'path-unresolved'].includes(f.openReason)).map((f) => ({ id: f.id, key: f.key, file: f.file, reason: f.openReason }));
    const openNow = next.findings.filter((f) => f.status === 'open').map((f) => ({ id: f.id, key: f.key, file: f.file, class: f.class || 'blocker' }));

    const diff = git(work, ['diff', '-U3', '--submodule=short', range.base, 'HEAD']);
    const verdictNow = lib.evaluateApproval({ ...next, rounds: [...next.rounds, { head: snap.head, unreviewed }] }, snapshot(repo, pr), snap.head);
    const hunks = publish.hunksOf(diff);
    // The engine's line is kept whether or not it is in the diff; only a finding without one is looked up by span in the file at the head.
    const entryOf = (f) => next.findings.find((g) => g.status === 'open' && lib.findingKey(g) === lib.findingKey(f)) || f;
    const placed = (f0) => {
      const f = { ...f0, ...pick(entryOf(f0)) };
      if (f.line != null) return f;
      const blob = f.span ? gitBlob(work, snap.head, f.file) : null;
      const line = Buffer.isBuffer(blob) ? publish.placeLine(blob.toString('utf8'), f.span, f.file, hunks) : null;
      return line == null ? f : { ...f, line };
    };
    const input = { unconfined: unconfinedAt(ledger), head: snap.head, round: n, rangeBase: range.base, reviewer: ledger.provider, hunks, files: publish.filesOf(diff), findings: fresh.map(placed), fixed: fixedIds, addressed: addressedIds, stillOpen: stillOpenFindings, followUps: openMinors(next.findings), previousHead: prior ? prior.head : snap.head, approve: verdictNow.approve };
    if (verdictNow.reason === 'head-moved') return null;
    // A submodule range that could not be read is said in the review, which then does not approve.
    const render = (i, how) => {
      const r = publish.renderReview(i, how);
      return unreviewed.length ? { ...r, body: `${r.body}\n\nNot reviewed, so this review does not approve: ${unreviewed.map((u) => `submodule \`${u.path}\` ${u.from ? `${u.from}..` : ''}${u.to} (${u.reason})`).join('; ')}` } : r;
    };
    const known = newestId(reviewsOf(repo, pr));
    const entry = (review) => ({ n, head: snap.head, ...(unreviewed.length && { unreviewed }), base: range.base, mergeBase: snap.mergeBase, intent: snap.intent, mode: range.broad ? 'broad' : 'diff', reviewId: review.id, submittedAt: review.submitted_at || new Date().toISOString(), commentIds: [], event: input.approve ? 'APPROVE' : 'COMMENT' });
    // Saved before an APPROVE is posted, so a crash after GitHub accepts it is recovered by the next start.
    // Only the marker is saved: the verdict's findings travel inside it and apply when the review is found.
    const marker = { head: snap.head, after: known, round: entry({}), findings: next.findings };
    if (input.approve) save(file, { ...ledger, pending: marker });
    let review;
    try {
      review = publishReview({ repo, pr, reviewer: ledger.reviewer, head: snap.head, after: known, state: input.approve ? 'APPROVED' : 'COMMENTED', input, render, headMoved: () => snapshot(repo, pr).head !== snap.head, onThread: (f, id) => { const g = next.findings.find((h) => h.status === 'open' && h.key === lib.findingKey(f)); if (g) g.threadId = id; if (input.approve) save(file, { ...ledger, pending: marker }); } });
    } catch (error) {
      if (snapshot(repo, pr).head !== snap.head) return null;
      throw error;
    }
    if (!review) return null;
    // Saved before anything else can fail, so a posted review (an APPROVE above all) is never forgotten.
    next.rounds.push(entry(review));
    delete next.pending;
    delete next.attempt;
    if (input.approve) next.approval = { head: snap.head, reviewId: review.id, at: next.rounds[next.rounds.length - 1].submittedAt };
    save(file, next);
    // Best effort: replies to a thread are recognized by these ids; without them only conversation replies count.
    try {
      next.rounds[next.rounds.length - 1].commentIds = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews/${review.id}/comments`]).flat().map((c) => c.id);
      save(file, next);
    } catch (_) { /* ponytail: ids stay empty; thread replies are then missed until the next round */ }
    settleThreads(repo, pr, next, file);
    return { event: 'published', round: n, mode: range.broad ? 'broad' : 'diff', review: input.approve ? 'APPROVE' : 'COMMENT', new: fresh.length, fixed: fixedIds.length, ...(addressedIds.length && { addressed: addressedIds.length }), ...(addressedRejected.length && { addressedRejected }), stillOpen: openIds.length, open: openNow, ...(unreviewed.length && { unreviewed }), ...(verdictNow.approve ? {} : { notApproved: verdictNow.reason }), ...(held.length && { held, hint: 'These findings cannot be settled from the code; run waive <key> (or waive <id> when the id is unique) to dismiss one you accept, or reclass <key> minor --reason <line> if it should not block.' }) };
  } catch (error) {
    // Any failure after the head snapshot is recorded with the head it tried, so the watch waits for a newer head or reply; the ledger is read again because a pending approval marker may have been saved meanwhile.
    save(file, { ...load(file), attempt: { head: snap.head, at: new Date().toISOString() } });
    throw error;
  } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}

const runFile = (file) => `${file}.run.json`;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The session's side of a round that runs as subagents: prints the open request, or `waiting` after a bounded wait, or `finished`
// when no round is running (the round's own result is the output of the process the session started). Takes no lock.
function next(repo, pr, args) {
  const file = ledgerFile(repo, pr, gh(['api', 'user', '--jq', '.login']).trim());
  const running = () => { const run = load(runFile(file)); return run && pidAlive(run.pid) ? run : null; };
  const done = opt(args, '--done');
  if (args.includes('--done') && !done) die('--done needs the id of the request');
  if (done !== undefined) {
    const run = running();
    if (!run) die('no round is running');
    try { broker.markDone(run.dir, done); } catch (error) { die(error.message); }
  }
  const deadline = Date.now() + Number(process.env.REVIEW_APPROVE_NEXT_WAIT_MS || 540000);
  for (;;) {
    const run = running();
    if (!run) return out({ event: 'finished' });
    const request = broker.openRequest(run.dir);
    if (request) return out({ event: 'subagent-request', id: request.id, role: request.role, promptFile: request.promptFile, ...(request.model && { model: request.model }), ...(request.effort && { effort: request.effort }) });
    if (Date.now() > deadline) return out({ event: 'waiting' });
    sleep(250);
  }
}

function approve(repo, pr, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger || !ledger.rounds.length) die('no reviewed round to approve');
  const reviewed = lastRound(ledger);
  const verdict = lib.evaluateApproval(ledger, snapshot(repo, pr), reviewed.head);
  if (!verdict.approve) return out({ event: 'not-approved', reason: verdict.reason });
  const after = newestId(reviewsOf(repo, pr));
  const followUps = openMinors(ledger.findings);
  ledger.pending = { head: reviewed.head, after, round: null };
  save(file, ledger);
  let review;
  try {
    review = post(repo, pr, publish.renderReview({ unconfined: unconfinedAt(ledger), head: reviewed.head, round: reviewed.n, rangeBase: reviewed.base, reviewer: ledger.provider, hunks: [], findings: [], fixed: [], stillOpen: followUps, followUps, previousHead: reviewed.head, approve: true }, 'body'));
  } catch (error) {
    review = landed(reviewsOf(repo, pr), ledger.reviewer, reviewed.head, after, 'APPROVED');
    if (!review) { delete ledger.pending; save(file, ledger); throw error; }
  }
  delete ledger.pending;
  ledger.approval = { head: reviewed.head, reviewId: review.id, at: new Date().toISOString() };
  save(file, ledger);
  out({ event: 'approved', head: reviewed.head });
}

// The one open finding an id or key names; dies when there is none or the id is ambiguous.
function openFinding(ledger, id) {
  const matching = (ledger?.findings || []).filter((f) => (f.id === id || f.key === id) && f.status === 'open');
  if (!matching.length) die(`no open finding ${id}`);
  if (matching.length > 1) die(`${id} matches more than one open finding; pass the key of one: ${matching.map((f) => `${f.key} (${f.file})`).join(', ')}`);
  return matching[0];
}

function waive(repo, pr, id, args) {
  const { file, ledger } = identify(repo, pr, args);
  const finding = openFinding(ledger, id);
  Object.assign(finding, { status: 'waived', waivedAt: new Date().toISOString() });
  save(file, ledger);
  approve(repo, pr, args);
}

// The user changes the class of an open finding. The script cannot know who typed it (see trust); the record keeps the account, the time and the class it replaced.
function reclass(repo, pr, id, to, args) {
  const reason = (opt(args, '--reason') || '').trim();
  if (!['blocker', 'minor'].includes(to)) die('usage: reclass <owner/repo> <pr> <finding-id|key> <blocker|minor> --reason <one line>: the class must be blocker or minor', 2);
  if (!reason) die('reclass needs --reason with the user\'s one-line reason', 2);
  const { reviewer, file, ledger } = identify(repo, pr, args);
  const finding = openFinding(ledger, id);
  const from = finding.class || 'blocker';
  finding.reclassed = [...(finding.reclassed || []), { from, to, reason, at: new Date().toISOString(), account: reviewer }];
  Object.assign(finding, { class: to, reason });
  if (to === 'minor') Object.assign(finding, { releaseBlocking: [] });
  save(file, ledger);
  out({ event: 'reclassed', id: finding.id, key: finding.key, from, to, ...(to === 'blocker' && ledger.approval && { note: 'an approval already posted for this head stays on GitHub' }) });
  if (to === 'minor') approve(repo, pr, args);
}

// The user's own confirming words for this pull request, kept in its ledger. The script cannot know who typed them; they stay in the ledger and the local output, and a published review states only that the declaration exists.
function trust(repo, pr, args) {
  const question = `Record that you trust the author of ${repo}#${pr} for this review? The Claude reviewer then runs without isolation: it can read your home directory, and this pull request could make it publish what it reads.`;
  const declaration = (opt(args, '--declaration') || '').trim();
  const confirmation = (opt(args, '--confirmation') || '').trim();
  if (!args.includes('--revoke') && !declaration && !confirmation) return out({ event: 'trust-question', question });
  const { reviewer, file, ledger: found } = identify(repo, pr, args);
  if (args.includes('--revoke')) {
    if (found?.trust) { delete found.trust; save(file, found); }
    return out({ event: 'trust-revoked' });
  }
  if (!declaration || !confirmation) die('trust needs --declaration (the user\'s words) and --confirmation (the user\'s reply to the question), both non-empty; run trust with no options to get the question', 2);
  const snap = snapshot(repo, pr);
  if (snap.state !== 'OPEN') die(`the pull request is ${snap.state}`);
  if (snap.author === reviewer) die(`${reviewer} is the author; the author cannot declare trust in their own pull request`);
  if (`${snap.title}\n${snap.body}`.includes(declaration)) die('the declaration occurs in the pull request text; text from the pull request is never the user\'s declaration');
  const ledger = found || newLedger(repo, pr, reviewer, snap.author);
  ledger.trust = { declaration, confirmation, question, recordedAt: new Date().toISOString(), account: reviewer };
  save(file, ledger);
  out({ event: 'trust-recorded', trust: ledger.trust });
}

function stop(repo, pr, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger) die('no ledger');
  ledger.stopped = { reason: 'user', at: new Date().toISOString() };
  save(file, ledger);
  out({ event: 'stopped' });
}

function nudged(repo, pr, event, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger) die('no ledger');
  const { kind, head, replyAt } = JSON.parse(event || '{}');
  if (!kind || !head) die('usage: nudged <owner/repo> <pr> <nudge event json>', 2);
  ledger.nudged = { kind, head, replyAt: replyAt ?? null };
  save(file, ledger);
  out({ event: 'nudge-recorded' });
}

const [verb, repo, pr, ...rest] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(pr || '')) die('usage: approve.js <start|trust|round|next|approve|waive|reclass|stop|nudged> <owner/repo> <pr> [...]', 2);
const verbs = { start, trust, round: reviewRound, next, approve, stop, waive: (r, p, a) => waive(r, p, a[0], a), reclass: (r, p, a) => reclass(r, p, a[0], a[1], a), nudged: (r, p, a) => nudged(r, p, a[0], a) };
if (!verbs[verb]) die(`unknown verb ${verb}`, 2);
try { verbs[verb](repo, pr, rest); } catch (error) { die(error.message); }
