#!/usr/bin/env node
'use strict';
// review-until-approve: rounds of review on someone else's pull request, driven by the state the reviewing account's
// own reviews and comments carry. Each command prints JSON lines in the fixed vocabulary below, never pull request
// text, agent text, or a local path; raw errors go to the log in the skill's data directory, which no session reads.
// usage: review-until-approve.js state <owner/repo> <n> [--harness claude|codex]
//        review-until-approve.js round <owner/repo> <n> [--harness claude|codex] [--model m] [--effort e] [--language tag]
//        review-until-approve.js decide <owner/repo> <n> <key> keep|waive|blocker|minor --reason <text>
//        review-until-approve.js decide <owner/repo> <n> submodule:<path> accept --reason <text>
//        review-until-approve.js decide <owner/repo> <n> continue|start-over --reason <text>
//        review-until-approve.js notes <owner/repo> <n> [-] [--store gist|repo:OWNER/NAME]   (- reads the complete set on stdin)
//        review-until-approve.js watch add|remove <owner/repo> <n> [--harness claude|codex] [--model m] [--effort e]
//        review-until-approve.js watch status [--harness claude|codex]
//        review-until-approve.js check|watcher --harness claude|codex   (one check; the watcher loop, which watch add starts)
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dataDir, ensureDataDir } = require('../../../runtime/data-dir');
const { runConfined } = require('../../../runtime/confined-agent');
const { escapeText, fence, fencePath, refusal, credentials } = require('../../../runtime/post-text');
const runtime = require('../../../runtime/watcher');
const { takeLock, releaseLock, readJson, writeAtomic, ownerDir, running, addNotice, pendingNotices, markShown, notify } = runtime;
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('../../../runtime/spawn-cross-platform');
const { removeSymlinks } = require('../../explain-pr/scripts/explain-pr');

const SKILL = 'review-until-approve';
const PREFIX = '<!-- review-until-approve:';
const MAX_BODY = 65536;
const DAY = 24 * 3600 * 1000;
const CAP = 6;
const HEX = /^[0-9a-f]{40}$/;
const KEY = /^\d+\.\d+$/;
const STATUSES = ['open', 'fixed', 'answered', 'asked', 'waived'];
const CLASSES = ['blocker', 'minor'];
const DECISIONS = ['keep', 'waive', 'blocker', 'minor'];
const REQUESTS = path.join(__dirname, '..', 'references');

// ---- output: the fixed vocabulary -----------------------------------------------------------------------------------

const NOTES_ASKS = ['notes-store', 'notes-unusable'];
const ASKS = ['asked', 'unreadable', 'submodule', 'agent-cannot-start', 'hook-did-not-run', 'cap', 'account', 'overflow', ...NOTES_ASKS];
// Why a notes store cannot be used: no gist scope, the repository missing or not readable, owned by another account,
// not private, shared with another collaborator, publishing a GitHub Pages site, a stored file that does not parse, or
// notes only in the cache.
const PROBLEMS = ['scope', 'missing', 'owner', 'visibility', 'collaborator', 'pages', 'format', 'unsaved'];
const REASONS = ['reviewer-output', 'verifier-list', 'prepare', 'submission', 'refused', 'author', 'github', 'reason-refused', 'internal', 'probe'];
const PENDING = ['first', 'head', 'reply', 'description', 'notes', 'start-over'];
const WHY = ['closed', 'head-moved', 'draft', 'author', 'blocker', 'unreadable', 'submodule', 'approved', 'overflow'];
const sha = (v) => typeof v === 'string' && HEX.test(v);
const count = (v) => Number.isInteger(v) && v >= 0;
const oneOf = (list) => (v) => list.includes(v);
const listOf = (ok) => (v) => Array.isArray(v) && v.every(ok);
const link = (v) => typeof v === 'string' && /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+(#[\w-]+)?$/.test(v);
const keyish = (v) => typeof v === 'string' && KEY.test(v);
const FIELDS = {
  event: oneOf(['state', 'nothing', 'published', 'superseded', 'locked', 'failed', 'question', 'decided', 'closed', 'merged', 'error', 'watching', 'unwatched', 'watcher', 'notice', 'notes']),
  ask: oneOf(ASKS), reason: oneOf(REASONS), pending: listOf(oneOf(PENDING)), why: listOf(oneOf(WHY)), problem: oneOf(PROBLEMS),
  saved: (v) => typeof v === 'boolean', empty: (v) => typeof v === 'boolean', duplicates: count,
  review: oneOf(['APPROVE', 'COMMENT']), decision: oneOf([...DECISIONS, 'accept', 'continue', 'start-over']),
  agents: (v) => typeof v === 'boolean', approvable: (v) => typeof v === 'boolean', carried: (v) => typeof v === 'boolean',
  head: sha, link, keys: listOf(keyish), key: keyish,
  round: count, new: count, fixed: count, answered: count, open: count, asked: count, blockers: count, minors: count,
  submodules: count, rounds: count, set: count,
  pr: (v) => typeof v === 'string' && /^[\w.-]+\/[\w.-]+#\d+$/.test(v), running: (v) => typeof v === 'boolean', started: (v) => typeof v === 'boolean',
  checked: (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v),
  // A notice line is composed by this script from the fields above (see noticeText).
  notice: (v) => typeof v === 'string' && v.length <= 400 && /^[\w.-]+\/[\w.-]+#\d+ [\w .,:;()/#=+-]+$/.test(v),
};
// Every printed line is checked against the vocabulary; a line that does not fit is a bug and is not printed.
function valid(line) {
  return line && typeof line === 'object' && Object.entries(line).every(([k, v]) => Object.hasOwn(FIELDS, k) && FIELDS[k](v));
}
// What this process printed, for the notice list.
const PRINTED = [];
function print(line) {
  if (!valid(line)) throw new Error(`a line outside the vocabulary: ${Object.keys(line).join(',')}`);
  PRINTED.push(line);
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// ---- processes ------------------------------------------------------------------------------------------------------

let LOG = null;
function log(what, detail) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${what}: ${String(detail || '').slice(0, 4000)}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ }
}

class GhError extends Error {
  constructor(args, stderr, quiet) {
    super('gh failed');
    const m = /HTTP (\d{3})/.exec(stderr || '');
    this.status = m ? m[1] : null;
    this.notFound = /HTTP (403|404)|Could not resolve to a (Repository|PullRequest)|NOT_FOUND|FORBIDDEN/.test(stderr || '');
    // A call to the notes store logs only its status: the call and GitHub's message can name the store.
    if (quiet) log('gh notes store', `HTTP ${this.status || 'error'}`);
    else log(`gh ${args.slice(0, 3).join(' ')}`, stderr);
  }
}
// GitHub reads and writes call gh directly from a neutral directory; the round's prepared checkout is never a cwd.
// `quiet` is for calls to the notes store.
function gh(args, input, quiet) {
  const r = spawnSync('gh', args, {
    cwd: os.tmpdir(), input, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  if (r.error || r.status !== 0) throw new GhError(args, r.stderr || String(r.error), quiet);
  return r.stdout;
}
const ghJson = (args, input, quiet) => JSON.parse(gh(args, input, quiet));
const post = (url, payload, method = 'POST') => ghJson(['api', '-X', method, url, '--input', '-'], JSON.stringify(payload));

// git runs in the script's own clone, through the spawn helper, with the round directory excluded from its lookup.
let EXCLUDE = null;
function git(dir, args, opts = {}) {
  const r = spawnSync(crossPlatformCommand('git', EXCLUDE), crossPlatformArgs(['-C', dir, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], needsDoubleEscape('git', EXCLUDE)),
    crossPlatformOpts({ cwd: os.tmpdir(), encoding: opts.encoding || 'utf8', input: opts.input, maxBuffer: 1 << 30, timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
  if (r.error || r.status !== 0) {
    log(`git ${args[0]}`, r.stderr || String(r.error));
    throw new Error('git failed');
  }
  return r.stdout;
}

// ---- markers --------------------------------------------------------------------------------------------------------

const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const lines = (body) => String(body || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
const stateLine = (state) => `${PREFIX}state ${enc(state)} -->`;

const isFinding = (f) => f && typeof f === 'object' && KEY.test(f.key) && CLASSES.includes(f.class) && STATUSES.includes(f.status)
  && (f.file === null || typeof f.file === 'string') && (f.line === null || Number.isInteger(f.line)) && sha(f.raised) && sha(f.at)
  && (f.closed === null || sha(f.closed)) && (f.closedRound === null || Number.isInteger(f.closedRound)) && typeof f.decided === 'boolean';
const isSub = (s) => s && typeof s === 'object' && typeof s.path === 'string' && sha(s.to) && (s.from === null || sha(s.from)) && typeof s.ok === 'boolean';
function validState(s) {
  return s && typeof s === 'object' && s.v === 1 && Number.isInteger(s.round) && s.round > 0 && typeof s.agents === 'boolean'
    && sha(s.head) && sha(s.base) && sha(s.mergeBase) && typeof s.desc === 'string' && typeof s.notes === 'string' && typeof s.lang === 'string'
    && s.seen && Number.isInteger(s.seen.issue) && Number.isInteger(s.seen.review)
    && Array.isArray(s.subs) && s.subs.every(isSub) && Array.isArray(s.findings) && s.findings.every(isFinding)
    && new Set(s.findings.map((f) => f.key)).size === s.findings.length;
}
// The state a review carries: undefined when its last line is not a state marker (the review does not count), null
// when it is one that does not parse.
function stateOf(body) {
  const m = /^<!-- review-until-approve:state (\S*) -->$/.exec(lines(body).at(-1));
  if (!m) return lines(body).at(-1).startsWith(`${PREFIX}state`) ? null : undefined;
  try {
    const s = dec(m[1]);
    return validState(s) ? s : null;
  } catch { return null; }
}
function decisionOf(body) {
  const first = lines(body)[0];
  if (!first.startsWith(`${PREFIX}decision`)) return undefined;
  const m = /^<!-- review-until-approve:decision (\S+) -->$/.exec(first);
  try {
    const d = m && dec(m[1]);
    if (d && (['continue', 'start-over'].includes(d.ruling) || (KEY.test(d.key) && DECISIONS.includes(d.decision))
      || (typeof d.submodule === 'string' && sha(d.to) && d.decision === 'accept'))) return d;
  } catch { /* unparsable */ }
  return null;
}
const findingOf = (body) => /^<!-- review-until-approve:finding (\d+\.\d+) -->$/.exec(lines(body)[0])?.[1];
const replyOf = (body) => {
  const m = /^<!-- review-until-approve:reply (\d+\.\d+) (open|fixed|answered|asked|waived) ([0-9a-f]{40}) -->$/.exec(lines(body)[0]);
  return m && { key: m[1], status: m[2], head: m[3] };
};

const descHash = (title, body) => crypto.createHash('sha256').update(`${title}\n\n${body || ''}`).digest('hex');

// ---- reading the pull request ---------------------------------------------------------------------------------------

const Q_PR = `query($owner:String!,$name:String!,$number:Int!,$login:String!,$endCursor:String){repository(owner:$owner,name:$name){isPrivate pullRequest(number:$number){
  number state isDraft title body url headRefOid baseRefOid author{login} labels(first:100){nodes{name}}
  reviews(first:100,after:$endCursor,author:$login){pageInfo{hasNextPage endCursor} nodes{databaseId state body submittedAt lastEditedAt url commit{oid}}}}}}`;
const Q_THREADS = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
  reviewThreads(first:50,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:100){nodes{databaseId author{login} body createdAt lastEditedAt url}}}}}}}`;
const Q_COMMENTS = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
  comments(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{databaseId author{login} body createdAt lastEditedAt url}}}}}`;

function graphql(query, vars) {
  const args = ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return ghJson(args);
}
const lower = (s) => String(s || '').toLowerCase();
const time = (s) => Date.parse(s) || 0;

// The pull request's metadata and the account's reviews (the only reviews that can count).
function readMeta(repo, n, login) {
  const [owner, name] = repo.split('/');
  const pages = graphql(Q_PR, { owner, name, number: Number(n), login });
  const pr = pages[0].data.repository.pullRequest;
  const reviews = pages.flatMap((p) => p.data.repository.pullRequest.reviews.nodes)
    .filter((r) => r.state !== 'PENDING' && r.submittedAt).sort((a, b) => time(a.submittedAt) - time(b.submittedAt));
  return {
    private: pages[0].data.repository.isPrivate === true, state: pr.state, draft: pr.isDraft, url: pr.url,
    title: pr.title, body: pr.body, head: pr.headRefOid, baseTip: pr.baseRefOid, author: lower(pr.author?.login),
    labels: (pr.labels?.nodes || []).map((l) => l.name), reviews,
  };
}

function readAll(repo, n, login) {
  const [owner, name] = repo.split('/');
  const meta = readMeta(repo, n, login);
  const threads = graphql(Q_THREADS, { owner, name, number: Number(n) }).flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes);
  const comments = graphql(Q_COMMENTS, { owner, name, number: Number(n) }).flatMap((p) => p.data.repository.pullRequest.comments.nodes)
    .sort((a, b) => time(a.createdAt) - time(b.createdAt));
  return { ...meta, threads, comments };
}

// What the account's own items say. Only items with the marker at its fixed position count; an edited one, an
// unparsable one, or a decision naming an unknown key makes the state unreadable until a later ruling.
function fold(view, login) {
  const mine = (item) => lower(item.author?.login) === login;
  const bad = [];
  const states = [];
  for (const r of view.reviews) {
    const s = stateOf(r.body);
    if (s === undefined) continue;
    if (r.lastEditedAt) bad.push(time(r.lastEditedAt));
    if (s === null) bad.push(time(r.submittedAt));
    states.push({ id: r.databaseId, at: time(r.submittedAt), url: r.url, state: s, edited: Boolean(r.lastEditedAt), commit: r.commit?.oid });
  }
  const decisions = [];
  for (const c of view.comments.filter(mine)) {
    const d = decisionOf(c.body);
    if (d === undefined) continue;
    if (c.lastEditedAt) bad.push(time(c.lastEditedAt));
    if (d === null) bad.push(time(c.createdAt));
    else if (!c.lastEditedAt) decisions.push({ at: time(c.createdAt), ...d });
  }
  const threads = new Map();
  const replies = [];
  for (const t of view.threads) {
    const [first, ...rest] = t.comments?.nodes || [];
    if (!first || !mine(first)) continue;
    const key = findingOf(first.body);
    if (!key) continue;
    if (first.lastEditedAt) bad.push(time(first.lastEditedAt));
    threads.set(key, { id: t.id, comment: first.databaseId, url: first.url, resolved: t.isResolved, text: first.body, others: rest.filter((c) => !mine(c)) });
    for (const c of rest.filter(mine)) {
      const r = replyOf(c.body);
      if (!r) continue;
      if (c.lastEditedAt) bad.push(time(c.lastEditedAt));
      replies.push(r);
    }
  }
  const rulings = decisions.filter((d) => d.ruling);
  const startOver = Math.max(0, ...rulings.filter((d) => d.ruling === 'start-over').map((d) => d.at));
  const baseItem = states.filter((s) => s.state && !s.edited && s.at > startOver).at(-1) || null;
  let state = baseItem ? structuredClone(baseItem.state) : null;
  const applied = [];
  for (const d of decisions.filter((x) => !x.ruling && x.at > (baseItem?.at || startOver))) {
    if (!applyDecision(state, d)) bad.push(d.at);
    else applied.push(d);
  }
  const ruled = Math.max(0, ...rulings.map((d) => d.at));
  // Each published review takes the next round number, so no round is above the count of state reviews: counting them
  // keeps an unparsable review's number from being reused.
  const nextRound = Math.max(states.length, ...states.filter((s) => s.state).map((s) => s.state.round)) + 1;
  // The newest state review of any kind, for the superseded check.
  const newest = states.at(-1)?.id ?? null;
  return { state, base: baseItem, unreadable: bad.some((t) => t > ruled), startedOver: startOver > 0 && !baseItem, threads, replies, states, nextRound, newest, applied };
}

// A decision folded into the state; false when it names nothing the state has.
function applyDecision(state, d) {
  if (!state) return false;
  if (d.submodule !== undefined) {
    const s = state.subs.find((x) => x.path === d.submodule && x.to === d.to);
    if (!s) return false;
    s.ok = true;
    return true;
  }
  const f = state.findings.find((x) => x.key === d.key);
  if (!f) return false;
  f.decided = true;
  if (d.decision === 'waive') f.status = 'waived';
  else if (d.decision === 'keep') { if (f.status === 'asked') f.status = 'open'; }
  else f.class = d.decision;
  return true;
}

const permissions = new Map();
function canWrite(repo, login) {
  if (!permissions.has(login)) {
    try {
      const p = ghJson(['api', `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`]);
      permissions.set(login, ['admin', 'write'].includes(p?.permission) || ['admin', 'maintain', 'write'].includes(p?.role_name));
    } catch { permissions.set(login, false); }
  }
  return permissions.get(login);
}

// Replies the state's round did not see that count: from the author or an account with write access, in a finding
// thread or the conversation. The state records the newest comment ids its round read (`seen`), so a reply posted
// while a round ran, or before a review that ran no agent, stays pending. Returns the keys replied to, and whether the
// conversation has one.
function repliesSince(repo, view, f, login) {
  const counts = (c, seen) => {
    const who = lower(c.author?.login);
    return who && who !== login && c.databaseId > seen && (who === view.author || canWrite(repo, who));
  };
  const keys = [];
  for (const k of f.state?.findings.map((x) => x.key) || []) {
    if ((f.threads.get(k)?.others || []).some((c) => counts(c, f.state.seen.review))) keys.push(k);
  }
  return { keys, conversation: view.comments.some((c) => counts(c, f.state.seen.issue)) };
}
// The newest comment ids a read saw, for `seen`.
const seenOf = (view) => ({
  issue: Math.max(0, ...view.comments.map((c) => c.databaseId || 0)),
  review: Math.max(0, ...view.threads.flatMap((t) => (t.comments?.nodes || []).map((c) => c.databaseId || 0))),
});

// `notes` is the keyed hash of the notes the round would use; changed notes are pending.
function pendingOf(repo, view, f, login, notes) {
  if (!f.state) return { pending: [f.startedOver ? 'start-over' : 'first'], keys: [] };
  const pending = [];
  if (view.head !== f.state.head) pending.push('head');
  if (descHash(view.title, view.body) !== f.state.desc) pending.push('description');
  if (notes !== f.state.notes) pending.push('notes');
  const r = repliesSince(repo, view, f, login);
  if (r.keys.length || r.conversation) pending.push('reply');
  return { pending, keys: r.conversation ? [] : r.keys };
}

// What a check compares to tell whether the head, the replies, the description, or the notes changed since the previous
// check.
const sigOf = (view, notes = '') => crypto.createHash('sha256').update(JSON.stringify([view.head, descHash(view.title, view.body), seenOf(view), notes])).digest('hex').slice(0, 16);

const blocking = (state) => state.findings.filter((x) => x.class === 'blocker' && ['open', 'asked'].includes(x.status));

// The approval condition. `approvedHeads` are the heads the account approved (a dismissed approval included).
function approval({ state, live, login, unreadable, approvedHeads = [], overflow = false }) {
  const why = [];
  if (live.state !== 'OPEN') why.push('closed');
  if (!state || live.head !== state.head) why.push('head-moved');
  if (live.draft) why.push('draft');
  if (live.author === login) why.push('author');
  if (state && blocking(state).length) why.push('blocker');
  if (unreadable) why.push('unreadable');
  if (state && state.subs.some((s) => !s.ok)) why.push('submodule');
  if (approvedHeads.includes(live.head)) why.push('approved');
  if (overflow) why.push('overflow');
  return { approve: why.length === 0, why };
}
const approvedHeads = (view) => view.reviews.filter((r) => ['APPROVED', 'DISMISSED'].includes(r.state)).map((r) => r.commit?.oid);

function questions(repo, view, f) {
  const out = [];
  if (f.unreadable) out.push({ event: 'question', ask: 'unreadable', link: view.url });
  if (!f.state) return out;
  const asked = f.state.findings.filter((x) => x.status === 'asked').map((x) => x.key);
  if (asked.length) out.push({ event: 'question', ask: 'asked', keys: asked, link: view.url });
  const subs = f.state.subs.filter((s) => !s.ok).length;
  if (subs) out.push({ event: 'question', ask: 'submodule', submodules: subs, link: view.url });
  return out;
}

// Prints every question the state raises, and notes that it did: only then does the run settle the listed ones.
function askAll(ctx, repo, view, f) {
  for (const q of questions(repo, view, f)) print(q);
  ctx.askedAll = true;
}

const tally = (state) => ({
  open: state.findings.filter((x) => x.status === 'open').length,
  asked: state.findings.filter((x) => x.status === 'asked').length,
  blockers: blocking(state).length,
});

// ---- local records --------------------------------------------------------------------------------------------------

// A pull request as the lock, the notice record, and the notice lines name it: GitHub names are case-insensitive.
const slug = (repo, n, login) => `${repo.toLowerCase().replace('/', '__')}__${Number(n)}__${login}`;
const tagOf = (repo, n) => `${repo.toLowerCase()}#${Number(n)}`;
// The notice record per pull request and account: the failed-round counter (`failed`, times of failed rounds), the
// previous check's view (`view`, its signature and since when), the last check's time (`checked`), the view at which a
// watcher round failed or stopped (`held`), whether the watcher stopped at the daily cap (`capHeld`, cleared by the
// user's next invocation), and the question lines already in the notice list (`noticed`). Deleting it at most delays
// a check, repeats a round or a notice, or resets the failed-round count; one that is not an object reads as deleted.
function readRecord(dir, id) {
  const rec = readJson(path.join(dir, 'notices', `${id}.json`), null);
  return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
}
const writeRecord = (dir, id, rec) => writeAtomic(path.join(ownerDir(path.join(dir, 'notices')), `${id}.json`), JSON.stringify(rec));
function failedRounds(dir, id) {
  const rec = readRecord(dir, id);
  return (Array.isArray(rec.failed) ? rec.failed : []).filter((t) => Number.isFinite(t) && Date.now() - t < DAY);
}
const countFailed = (dir, id) => writeRecord(dir, id, { ...readRecord(dir, id), failed: [...failedRounds(dir, id), Date.now()] });

// ---- the user's notes -----------------------------------------------------------------------------------------------

// The notes of a pull request live in the store the user chose, recorded as `notes.store` in the skill's per-user
// config.json: `gist` (a secret gist of the reviewing account per pull request, found by its description) or
// `repo:OWNER/NAME` (the file OWNER/REPO/N.md in a private repository the account owns). The key of the keyed hash is
// stored with them. The local copy is a cache, and the only copy until a store holds it (`stored: false`). Where the
// store is goes into no output, log, review, comment, or marker.
const NOTES_MAX = 65536;
const NOTES_FILE = 'notes.md';
const REPO_STORE = /^repo:[\w.-]+\/[\w.-]+$/;
const KEY_LINE = /^<!-- concord review notes key: ([0-9a-f]{64}) -->$/;
class Refused extends Error {
  constructor(problem) { super('notes store refused'); this.problem = problem; }
}
const configFile = (data) => path.join(data, 'config.json');
function notesStore(data) {
  const s = readJson(configFile(data), null)?.notes?.store;
  return s === 'gist' || REPO_STORE.test(s || '') ? s : null;
}
function recordStore(data, store) {
  const cfg = readJson(configFile(data), null);
  const base = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  writeAtomic(configFile(data), JSON.stringify({ ...base, notes: { ...base.notes, store } }));
}
const cacheFile = (ctx) => path.join(ctx.data, 'notes', `${ctx.id}.json`);
function readCache(ctx) {
  const c = readJson(cacheFile(ctx), null);
  return c && typeof c.text === 'string' && /^[0-9a-f]{64}$/.test(c.key) && typeof c.stored === 'boolean' ? c : null;
}
const writeCache = (ctx, c) => writeAtomic(path.join(ownerDir(path.join(ctx.data, 'notes')), `${ctx.id}.json`), JSON.stringify(c));
// The keyed hash the state marker holds: empty for no notes.
const notesHash = (n) => (n && n.text.trim() ? crypto.createHmac('sha256', Buffer.from(n.key, 'hex')).update(n.text).digest('hex') : '');
const serialize = (n) => `<!-- concord review notes key: ${n.key} -->\n${n.text}`;
function parseNotes(content) {
  const [first, ...rest] = String(content ?? '').split('\n');
  const m = KEY_LINE.exec(first);
  if (!m) throw new Refused('format');
  return { key: m[1], text: rest.join('\n') };
}
const gistDescription = (repo, n) => `concord review notes: ${repo.toLowerCase()}#${Number(n)}`;
const contentsUrl = (name, repo, n) => `repos/${name}/contents/${repo.toLowerCase()}/${Number(n)}.md`;
const storeJson = (args, input) => ghJson(args, input, true);
// A 404 is the store's refusal; any other failure (a 403 for a rate limit included) is GitHub's and is reported so.
const refusedOn = (problem) => (e) => { throw e instanceof GhError && e.status === '404' ? new Refused(problem) : e; };
// Whether the token may use secret gists: an OAuth token lists its scopes in a header, and without `gist` the account's
// secret gists are neither listed nor written. A token that lists no scopes is tried.
let SCOPES;
function gistScoped() {
  if (SCOPES === undefined) {
    const head = gh(['api', '-i', 'user'], undefined, true).split(/\r?\n\r?\n/)[0];
    const m = /^x-oauth-scopes:(.*)$/im.exec(head);
    SCOPES = m ? m[1].split(',').map((x) => x.trim()) : null;
  }
  return SCOPES === null || SCOPES.includes('gist');
}

// The account's secret gists described for the pull request, newest first.
function notesGists(repo, n, login) {
  if (!gistScoped()) throw new Refused('scope');
  let pages;
  try { pages = storeJson(['api', '--paginate', '--slurp', 'gists?per_page=100']); } catch (e) { refusedOn('scope')(e); }
  return pages.flat().filter((g) => g && g.public === false && lower(g.owner?.login) === login && g.description === gistDescription(repo, n))
    .sort((a, b) => time(b.created_at) - time(a.created_at));
}
// The repository store's checks, before every read and write: the reviewing account owns it, it is private (not
// internal), and nobody else collaborates on it. Nothing here creates a repository.
function checkRepo(store, login) {
  const name = store.slice('repo:'.length);
  let r;
  try { r = storeJson(['api', `repos/${name}`]); } catch (e) { refusedOn('missing')(e); }
  if (lower(r?.owner?.login) !== login) throw new Refused('owner');
  if (r.visibility !== 'private' || r.private !== true) throw new Refused('visibility');
  // A Pages site of a private repository can be public, and would serve the notes file.
  if (r.has_pages !== false) throw new Refused('pages');
  let people;
  try { people = storeJson(['api', '--paginate', '--slurp', `repos/${name}/collaborators?affiliation=all&per_page=100`]).flat(); } catch (e) { refusedOn('collaborator')(e); }
  if (people.some((p) => lower(p?.login) !== login)) throw new Refused('collaborator');
  return name;
}
// The pull request's notes in the store: { notes } (null when it holds none), with the gist's id and the count of
// duplicate gists, or the file's sha. Throws Refused when the store fails a check.
function readStore(ctx, store) {
  const { repo, n, login } = ctx;
  if (store === 'gist') {
    const [g, ...dups] = notesGists(repo, n, login);
    if (!g) return { notes: null, duplicates: 0 };
    const full = storeJson(['api', `gists/${g.id}`]);
    return { notes: parseNotes(full.files?.[NOTES_FILE]?.content), id: g.id, duplicates: dups.length };
  }
  const name = checkRepo(store, login);
  let file;
  try { file = storeJson(['api', contentsUrl(name, repo, n)]); } catch (e) {
    if (e instanceof GhError && e.status === '404') return { notes: null };
    throw e;
  }
  return { notes: parseNotes(Buffer.from(file.content || '', 'base64').toString('utf8')), sha: file.sha };
}
// Writes the complete set over what `readStore` returned (`was`).
function writeStore(ctx, store, notes, was) {
  const { repo, n, login } = ctx;
  const content = serialize(notes);
  if (store === 'gist') {
    const files = { [NOTES_FILE]: { content } };
    let res;
    try {
      res = was.id ? storeJson(['api', '-X', 'PATCH', `gists/${was.id}`, '--input', '-'], JSON.stringify({ files }))
        : storeJson(['api', '-X', 'POST', 'gists', '--input', '-'], JSON.stringify({ description: gistDescription(repo, n), public: false, files }));
    } catch (e) { refusedOn('scope')(e); }
    if (res.public !== false) throw new Refused('visibility');
    return;
  }
  const name = checkRepo(store, login);
  storeJson(['api', '-X', 'PUT', contentsUrl(name, repo, n), '--input', '-'], JSON.stringify({ message: 'concord review notes', content: Buffer.from(content).toString('base64'), ...(was.sha && { sha: was.sha }) }));
}

// The notes a round uses, given the keyed hash the state shows: { hash, text, duplicates } or { ask, problem }. No
// round runs with notes that are not in a store: notes only in the cache, notes the state shows that no store holds,
// and a store that fails a check all ask instead. With no store chosen, a machine that holds no notes but sees a hash
// looks for the notes gist by its description.
function loadNotes(ctx, stateHash) {
  const store = notesStore(ctx.data);
  const raw = () => { try { return fs.readFileSync(cacheFile(ctx), 'utf8'); } catch { return null; } };
  const before = raw();
  const cache = readCache(ctx);
  if (cache && !cache.stored) return store ? { ask: 'notes-unusable', problem: 'unsaved' } : { ask: 'notes-store' };
  if (!store && !stateHash && !cache) return { hash: '', text: '', duplicates: 0 };
  let got;
  try { got = readStore(ctx, store || 'gist'); } catch (e) {
    if (!(e instanceof Refused)) throw e;
    if (store) return { ask: 'notes-unusable', problem: e.problem };
    got = { notes: null, refused: true };
  }
  // Notes `notes` saved while the store was read stay as they are: unsaved ones keep rounds waiting, and stored ones
  // are left for the next read, which sees them as changed.
  const changed = raw() !== before;
  if (changed && readCache(ctx)?.stored === false) return store ? { ask: 'notes-unusable', problem: 'unsaved' } : { ask: 'notes-store' };
  if (!got.notes) {
    // A gist lookup this token may not make, on a machine that held notes, does not read as "no notes".
    if (got.refused && cache) return { ask: 'notes-store' };
    if (!changed) fs.rmSync(cacheFile(ctx), { force: true });
    return stateHash ? { ask: 'notes-store' } : { hash: '', text: '', duplicates: 0 };
  }
  if (!changed) writeCache(ctx, { ...got.notes, stored: true });
  return { hash: notesHash(got.notes), text: got.notes.text, duplicates: got.duplicates || 0 };
}
const notesQuestion = (l, link) => ({ event: 'question', ask: l.ask, ...(l.problem && { problem: l.problem }), ...(link && { link }) });

// ---- the notice list ------------------------------------------------------------------------------------------------

// A notice line, composed from the printed line's fields only; null for a line the user need not see.
// Questions the watcher holds a pull request on until something changes carry the head, so that the same question on a
// later head is asked again.
const HOLD = ['cap', 'agent-cannot-start', 'hook-did-not-run', 'account'];
function questionText(pr, q, head) {
  return [pr, 'question', q.ask, q.problem, q.keys?.join(','), q.submodules && `${q.submodules} submodule(s)`, q.rounds !== undefined && `${q.rounds} round(s) in 24 hours`,
    HOLD.includes(q.ask) && head && `at ${short(head)}`, q.link].filter(Boolean).join(' ');
}
function noticeText(pr, l) {
  if (l.event === 'published') return `${pr} ${l.review === 'APPROVE' ? 'approved' : 'reviewed'} round ${l.round} at ${short(l.head)}: ${l.new} new, ${l.open} open, ${l.asked} to decide, ${l.blockers} blocking${l.link ? ` ${l.link}` : ''}`;
  if (l.event === 'failed' || l.event === 'error') return `${pr} round failed: ${l.reason}`;
  return null;
}
// Lines that report an action that needs nothing from the user; every other line counts toward a notification.
const INFORMATIONAL = /^\S+ (reviewed round|review-blocked label restored)/;
// Reconciles one pull request's question lines with the questions that hold now: a pending line of the given kinds
// whose question no longer holds is marked shown, and a question not yet in the list is added, so that a question
// stays pending until it is answered. Returns how many lines it added.
function reconcile(base, rec, pr, current, kinds) {
  const stale = (t) => t.startsWith(`${pr} question `) && kinds.includes(t.split(' ')[2]) && !current.includes(t);
  markShown(pendingNotices(base, SKILL).filter((x) => stale(x.line)));
  rec.noticed = (Array.isArray(rec.noticed) ? rec.noticed : []).filter((t) => !stale(t));
  let added = 0;
  for (const t of current.filter((x) => !rec.noticed.includes(x))) {
    rec.noticed.push(t);
    addNotice(base, SKILL, t);
    added++;
  }
  return added;
}
const notifyCount = (n) => { if (n) notify(`${SKILL}: ${n} new notice${n === 1 ? '' : 's'}`); };

// Whether the pull request is still on the watch list with the account the round runs as. A round the watcher
// started checks it before it starts and before it posts, so the user's stop ends the watcher's rounds.
function watched(ctx) {
  const e = runtime.readWatch(ctx.data).entries?.[tagOf(ctx.repo, ctx.n)];
  return Boolean(e) && e.login === ctx.login;
}

// What a round or decision printed, under the pull request's lock, into the notice record and the notice list.
// From the user's session, on a watched pull request, the questions it printed are listed (the session relays them
// too, so nothing is notified), and lines its answers settled go; the invocation also lifts the watcher's holds. From the watcher, its lines are
// listed and notified, and the watcher holds the pull request at the view the round read when it failed or stopped on
// a question it cannot answer itself; an invocation by the user does not read that hold.
function recordRun(ctx, fromWatcher) {
  if (!ctx.view || PRINTED.some((l) => l.event === 'locked')) return;
  if (fromWatcher && !watched(ctx)) return;
  const base = runtime.baseDir(ctx.harness);
  const pr = tagOf(ctx.repo, ctx.n);
  const rec = readRecord(ctx.data, ctx.id);
  const asked = PRINTED.filter((l) => l.event === 'question').map((q) => questionText(pr, q, ctx.view.head));
  if (!fromWatcher) {
    // The user's invocation retries what the watcher held, so it lifts both holds.
    delete rec.capHeld;
    delete rec.held;
    // A run that stopped before printing what the state asks settles only the questions an invocation answers.
    if (!PRINTED.some((l) => l.event === 'error') && !process.exitCode && watched(ctx)) reconcile(base, rec, pr, asked, ctx.askedAll ? ASKS : [...HOLD, 'overflow']);
  } else {
    let notable = 0;
    for (const t of PRINTED.map((l) => noticeText(pr, l)).filter(Boolean)) {
      addNotice(base, SKILL, t);
      if (!INFORMATIONAL.test(t)) notable++;
    }
    notable += reconcile(base, rec, pr, asked, [...HOLD, 'overflow']);
    if (PRINTED.some((l) => ['failed', 'error'].includes(l.event) || (l.event === 'question' && HOLD.includes(l.ask)))) rec.held = sigOf(ctx.view, ctx.notes?.hash);
    if (PRINTED.some((l) => l.event === 'question' && l.ask === 'cap')) rec.capHeld = true;
    notifyCount(notable);
  }
  writeRecord(ctx.data, ctx.id, rec);
}

// ---- publishing -----------------------------------------------------------------------------------------------------

// The path of a `+++ ` header: git quotes one with special characters as "b/..." with C escapes.
function headerPath(raw) {
  const m = /^"b\/((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (!m) return raw.startsWith('b/') ? raw.slice(2) : '';
  const bytes = [];
  const esc = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c !== '\\') bytes.push(...Buffer.from(c));
    else if (/[0-7]/.test(m[1][i + 1])) { bytes.push(parseInt(m[1].slice(i + 1, i + 4), 8)); i += 3; }
    else { i++; bytes.push(m[1][i] in esc ? esc[m[1][i]] : m[1].charCodeAt(i)); }
  }
  return Buffer.from(bytes).toString('utf8');
}
function hunksOf(diff) {
  const hunks = [];
  let file = '';
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = ''; }
    else if (line.startsWith('@@')) header = false;
    if (header && line.startsWith('+++ ')) file = headerPath(line.slice(4).replace(/\t$/, ''));
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file && (m[2] === undefined || Number(m[2]) > 0)) hunks.push({ file, from: Number(m[1]), to: Number(m[1]) + (m[2] === undefined ? 1 : Number(m[2])) - 1 });
  }
  return hunks;
}
// The line where the span starts, for its first occurrence that lies inside a hunk of its file; null when none does.
function placeLine(content, span, file, hunks) {
  const mine = hunks.filter((h) => h.file === file);
  if (!span || !mine.length) return null;
  const rows = span.split('\n').length;
  let line = 1;
  let seen = 0;
  for (let at = content.indexOf(span); at !== -1; at = content.indexOf(span, at + 1)) {
    for (; seen < at; seen++) if (content.charCodeAt(seen) === 10) line++;
    for (let l = line; l < line + rows; l++) if (mine.some((h) => l >= h.from && l <= h.to)) return l;
  }
  return null;
}

const short = (h) => h.slice(0, 7);
const quote = (t) => (t ? `\n\n${escapeText(t)}` : '');
const span = (s) => (s ? `\n\n${fence(s)}` : '');
const where = (f) => (f.file ? `\n\n${fencePath(f.file)}${f.line ? `\nline ${f.line}` : ''}` : '');

// The review for a round: { event, body, comments, overflow }. `texts` maps a key to the verifier's words for it
// ({ text, span, reason } for a new finding, { reply, span } for a verdict); `place` maps a new finding's key to its
// line in the diff. Everything outside the markers is composed from keys, classes, counts, and links, with agent text
// escaped and paths and spans fenced.
// `setAside` are findings the notes outweigh, by a span quoted from the head; `notFlagged` counts the minor findings a
// note says not to flag.
function compose({ state, prev, texts = {}, place = {}, threads = new Map(), unverified = [], approve, carried = false, newKeys = [], setAside = [], notFlagged = 0 }) {
  const head = state.head;
  const comments = [];
  const findingText = (f, full) => `**${f.class}** \`${f.key}\`${full ? `${quote(texts[f.key]?.text)}${texts[f.key]?.reason ? `\n\nClass: ${escapeText(texts[f.key].reason)}` : ''}${span(texts[f.key]?.span)}` : ''}`;
  const fresh = state.findings.filter((f) => newKeys.includes(f.key));
  for (const f of fresh) {
    if (place[f.key]) comments.push({ path: f.file, line: place[f.key], side: 'RIGHT', body: `${PREFIX}finding ${f.key} -->\n${findingText(f, true)}` });
  }
  const was = new Map((prev?.findings || []).map((f) => [f.key, f]));
  const changed = (f, status) => f.status === status && was.get(f.key)?.status !== status && !newKeys.includes(f.key);
  const ref = (k) => (threads.get(k)?.url ? ` ([thread](${threads.get(k).url}))` : '');
  const build = (level) => {
    const full = level === 0;
    const out = [`reviewed by [concord](https://github.com/arinyaho/concord) at \`${short(head)}\`, round ${state.round}${carried ? '; the pull request diff is unchanged since the last reviewed head, so no agent ran' : ''}`];
    const t = tally(state);
    out.push(`${fresh.length} new finding(s), ${t.open} open, ${t.asked} for the reviewer to decide, ${t.blockers} blocking.`);
    for (const cls of CLASSES) {
      const list = fresh.filter((f) => f.class === cls);
      if (!list.length) continue;
      out.push(`### New ${cls === 'blocker' ? 'blockers' : 'minor findings'}`);
      for (const f of list) {
        if (place[f.key]) out.push(`- \`${f.key}\` is a line comment`);
        else out.push(`- ${findingText(f, full)}${full ? where(f) : ''}`);
      }
    }
    const section = (title, list, words) => {
      if (!list.length) return;
      out.push(`### ${title}`);
      for (const f of list) out.push(`- \`${f.key}\` (${f.class})${ref(f.key)}${full && words ? `${quote(texts[f.key]?.reply)}${span(texts[f.key]?.span)}` : ''}`);
    };
    section('For the reviewer to decide', state.findings.filter((f) => f.status === 'asked'), true);
    section('Fixed', state.findings.filter((f) => changed(f, 'fixed')), true);
    section('Answered', state.findings.filter((f) => changed(f, 'answered')), true);
    section('Still open', state.findings.filter((f) => f.status === 'open' && !newKeys.includes(f.key)), true);
    const subs = state.subs.filter((s) => !s.ok);
    if (subs.length) {
      out.push(`### Unreviewed submodules (approval waits for your decision on each)`);
      // A fence never opens on a list item's line: it would end at the next unindented line and show the path live.
      for (const s of subs) out.push(`Change \`${s.from ? short(s.from) : 'new'}\` to \`${short(s.to)}\`${full ? `:\n\n${fencePath(s.path)}` : ''}`);
    }
    if (approve) {
      const minors = state.findings.filter((f) => f.status === 'open' && f.class === 'minor');
      if (minors.length) out.push(`### Follow-ups (not blocking)\n${minors.map((f) => `- \`${f.key}\`${ref(f.key)}`).join('\n')}`);
    }
    if (setAside.length || notFlagged) {
      out.push(`### Set aside by the reviewer's notes`);
      if (notFlagged) out.push(`${notFlagged} minor finding(s) not flagged, as the reviewer's notes ask.`);
      if (full) for (const x of setAside) out.push(`- **${x.class}**${quote(x.text)}${where(x)}${span(x.span)}`);
      else if (setAside.length) out.push(`${setAside.length} finding(s) set aside.`);
    }
    if (unverified.length) out.push(`### Unverified${full ? unverified.map((u) => `\n\n${escapeText(u)}`).join('') : `\n\n${unverified.length} item(s)`}`);
    return out;
  };
  const withMarker = (out, s) => [...out, stateLine(s)].join('\n\n');
  let body = withMarker(build(0), state);
  if (body.length <= MAX_BODY) return { event: approve ? 'APPROVE' : 'COMMENT', body, comments, state, overflow: false };
  body = withMarker(build(1), state);
  if (body.length <= MAX_BODY) return { event: approve ? 'APPROVE' : 'COMMENT', body, comments, state, overflow: false };
  // Then fixed and answered findings closed before the previous round, without a user decision, leave the marker.
  const kept = { ...state, findings: state.findings.filter((f) => !(['fixed', 'answered'].includes(f.status) && f.closedRound !== null && f.closedRound < state.round - 1 && !f.decided)) };
  body = withMarker(build(1), kept);
  if (body.length <= MAX_BODY) return { event: approve ? 'APPROVE' : 'COMMENT', body, comments, state: kept, overflow: false };
  const note = `reviewed by [concord](https://github.com/arinyaho/concord) at \`${short(head)}\`, round ${state.round}\n\nThis review is over GitHub's 65,536-character limit even with findings listed by key, so it lists ${kept.findings.length} finding(s) only in its state and does not approve. The reviewer is asked how to go on.`;
  body = withMarker([note], kept);
  return { event: 'COMMENT', body: body.length <= MAX_BODY ? body : note, comments: [], state: kept, overflow: true };
}

// Every text a review posts must pass the scan; returns the refusal reason or null.
function scan(review, secrets) {
  for (const t of [review.body, ...review.comments.map((c) => c.body)]) {
    const why = refusal(t, { markers: [PREFIX], secrets });
    if (why) return why;
  }
  return null;
}

// Submits one review pinned to the reviewed head. `start` is what the round read: a newer state review, a decision
// posted since, or an item edited since means the review would drop or ignore it, so nothing is posted. `inBody`
// composes the same review with every finding in the body, used once after GitHub refused a line position; it returns
// null when its text does not pass the scan. Returns { posted, url, review }, { superseded }, or { failed }.
function submit(repo, n, login, review, start, inBody) {
  const url = `repos/${repo}/pulls/${n}/reviews`;
  const now = fold(readAll(repo, n, login), login);
  if (now.newest !== start.newest || now.applied.length !== start.applied.length || now.unreadable !== start.unreadable) return { superseded: true };
  const payload = (r) => ({ commit_id: r.state.head, event: r.event, body: r.body, comments: r.comments });
  const ours = () => readMeta(repo, n, login).reviews.find((r) => { const s = stateOf(r.body); return s && s.round === review.state.round && s.head === review.state.head; });
  let r = review;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = post(url, payload(r));
      return { posted: true, url: res.html_url, review: r };
    } catch (e) {
      if (e.status === '422' && r.comments.length) {
        r = inBody();
        if (!r) return { failed: 'refused' };
        continue;
      }
      if (e.status === '422') return { failed: 'refused' };
      // The call may have reached GitHub: a review with this round's number and head counts as posted.
      try {
        const found = ours();
        if (found) return { posted: true, url: found.url, review: r };
      } catch { /* read failed: submit once more */ }
      if (attempt === 1) return { failed: 'submission' };
    }
  }
  return { failed: 'submission' };
}

// After the review: thread replies decided by the state alone, resolved and unresolved threads, and the label.
// GitHub refusals are logged, not retried; a reply that failed is posted by the next publish.
function settle(repo, n, view, f, state, reviewUrl, prev) {
  const done = new Set(f.replies.map((r) => `${r.key} ${r.status} ${r.head}`));
  const was = new Map((prev?.findings || []).map((x) => [x.key, x]));
  for (const x of state.findings) {
    const t = f.threads.get(x.key);
    if (!t) continue;
    if ((x.status !== 'open' || x.at !== x.raised) && !done.has(`${x.key} ${x.status} ${x.at}`)) {
      const body = `${PREFIX}reply ${x.key} ${x.status} ${x.at} -->\n**${x.status}** at \`${short(x.at)}\`; see the review${reviewUrl ? `: ${reviewUrl}` : '.'}`;
      try { post(`repos/${repo}/pulls/${n}/comments/${t.comment}/replies`, { body }); } catch { /* the next publish posts it */ }
    }
    const closed = ['fixed', 'answered'].includes(x.status);
    const reopened = ['open', 'asked'].includes(x.status) && ['fixed', 'answered'].includes(was.get(x.key)?.status);
    const mutation = closed && !t.resolved ? 'resolveReviewThread' : reopened && t.resolved ? 'unresolveReviewThread' : null;
    if (mutation) {
      try { gh(['api', 'graphql', '-f', `query=mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{id}}}`, '-f', `id=${t.id}`]); } catch { /* logged */ }
    }
  }
  label(repo, n, view, blocking(state).length > 0 || f.unreadable);
}
function label(repo, n, view, blocked) {
  const has = view.labels.includes('review-blocked');
  try {
    if (blocked && !has) post(`repos/${repo}/issues/${n}/labels`, { labels: ['review-blocked'] });
    if (!blocked && has) gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${n}/labels/review-blocked`]);
  } catch { /* an account without write access cannot set it */ }
}

// Publishes a review whose state carries the folded state forward, with no agent: a base merge, a ready pull request,
// or an approval after a decision. Returns the printed line.
function publishCarried(ctx, { carried = false, head }) {
  const { f } = ctx;
  const state = { ...structuredClone(f.state), round: f.nextRound, agents: false, head: head || f.state.head };
  if (head && head !== f.state.head) Object.assign(state, { base: ctx.mergeBase, mergeBase: ctx.mergeBase });
  return publish(ctx, { state, prev: f.state, carried });
}

// Composes, scans, and submits one review, then settles threads and the label. Approval is decided on a fresh read.
function publish(ctx, { state, prev, texts, place, unverified, newKeys = [], carried = false, setAside, notFlagged }) {
  const { repo, n, login, f } = ctx;
  if (ctx.fromWatcher && !watched(ctx)) return [{ event: 'unwatched', pr: tagOf(repo, n) }];
  const live = readMeta(repo, n, login);
  const make = (where, approve) => compose({ state, prev, texts, place: where, threads: f.threads, unverified, newKeys, carried, approve, setAside, notFlagged });
  let review = make(place, false);
  const cond = approval({ state: review.state, live, login, unreadable: f.unreadable, approvedHeads: approvedHeads(live), overflow: review.overflow });
  if (cond.approve) review = make(place, true);
  if (review.overflow) cond.why = [...new Set([...cond.why, 'overflow'])];
  const scanned = (r) => {
    const why = scan(r, ctx.secrets);
    if (why) log('scan', why);
    return why ? null : r;
  };
  if (!scanned(review)) return [{ event: 'failed', reason: 'refused' }];
  const res = submit(repo, n, login, review, f, () => scanned(make({}, review.event === 'APPROVE')));
  if (res.superseded) return [{ event: 'superseded' }];
  if (res.failed) return [{ event: 'failed', reason: res.failed }];
  const s = res.review.state;
  settle(repo, n, { ...ctx.view, labels: live.labels }, f, s, res.url, prev);
  const t = tally(s);
  const out = [{
    event: 'published', review: res.review.event, round: s.round, head: s.head, agents: s.agents, carried,
    new: newKeys.length, fixed: s.findings.filter((x) => x.status === 'fixed' && prev?.findings.find((p) => p.key === x.key)?.status !== 'fixed').length,
    answered: s.findings.filter((x) => x.status === 'answered' && prev?.findings.find((p) => p.key === x.key)?.status !== 'answered').length,
    ...t, ...(res.url && link(res.url) && { link: res.url }),
  }];
  // The review posted may be the one composed again after a position error, which can overflow where the first did not.
  if (res.review.overflow) cond.why = [...new Set([...cond.why.filter((w) => w !== 'overflow'), 'overflow'])];
  if (res.review.event !== 'APPROVE') out[0].why = cond.why;
  if (res.review.overflow) out.push({ event: 'question', ask: 'overflow', link: ctx.view.url });
  return out;
}

// ---- the round's inputs ---------------------------------------------------------------------------------------------

const prsDir = (harness) => path.join(dataDir('explain-pr', harness), 'prs');
const remote = (repo) => `https://${process.env.GH_HOST || 'github.com'}/${repo}.git`;

function compare(repo, a, b) {
  return ghJson(['api', `repos/${repo}/compare/${a}...${b}?per_page=1`]);
}
function fetchCommits(gitDir, repo, oids) {
  git(gitDir, ['fetch', '-q', '--depth', '1', remote(repo), ...new Set(oids)]);
}
const diffArgs = ['-M', '--no-ext-diff', '--no-textconv', '--no-color'];
function patchId(gitDir, from, to) {
  const d = git(gitDir, ['diff', ...diffArgs, '--binary', from, to], { encoding: 'buffer' });
  return git(gitDir, ['patch-id', '--verbatim'], { input: d }).trim().split(/\s+/)[0] || '';
}
// Changed gitlinks between two commits: { path, from, to }.
function gitlinks(gitDir, from, to) {
  const raw = git(gitDir, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', from, to]).split('\0');
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) (\w)/.exec(raw[i]);
    if (m && m[2] === '160000') out.push({ path: raw[i + 1], from: m[1] === '160000' ? m[3] : null, to: m[4] });
  }
  return out;
}

// Same-owner repositories the project's rules list, read at the merge base so the pull request cannot choose them.
function relatedRepos(gitDir, repo, mergeBase) {
  const owner = repo.split('/')[0];
  const names = new Set();
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md']) {
    let text = '';
    try { text = git(gitDir, ['show', `${mergeBase}:${file}`]); } catch { continue; }
    const re = new RegExp(`github\\.com/${owner.replace(/[.]/g, '\\.')}/([\\w.-]+)`, 'gi');
    for (const m of text.matchAll(re)) {
      const name = m[1].replace(/\.git$/, '').replace(/[.]+$/, '');
      if (name && `${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) names.add(name);
    }
  }
  return [...names].slice(0, 5).map((name) => `${owner}/${name}`);
}

function extract(gitDir, rev, into) {
  const tar = path.join(gitDir, `${crypto.randomBytes(4).toString('hex')}.tar`);
  git(gitDir, ['-c', 'core.attributesFile=', 'archive', '--format=tar', '-o', tar, rev]);
  fs.mkdirSync(into, { recursive: true });
  const r = spawnSync('tar', ['-xf', tar, '-C', into], { stdio: 'ignore' });
  fs.rmSync(tar, { force: true });
  if (r.status !== 0) throw new Error('tar failed');
  return removeSymlinks(into);
}

// The round directory, a fresh owner-only directory among explain-pr's prepared pull requests.
function prepare(ctx, rangeBase) {
  const { repo, n, view, f, gitDir, mergeBase, harness } = ctx;
  fs.mkdirSync(prsDir(harness), { recursive: true, mode: 0o700 });
  // A round, work, or git directory a day old belongs to a round that was killed: no round lives that long.
  const sweep = (dir, prefix) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((x) => x.startsWith(prefix)); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e);
      try { if (Date.now() - fs.statSync(p).mtimeMs > DAY) fs.rmSync(p, { recursive: true, force: true }); } catch { /* vanished */ }
    }
  };
  sweep(prsDir(harness), 'rua-');
  sweep(path.join(ctx.data, 'rounds'), 'r-');
  sweep(os.tmpdir(), 'rua-git-');
  const dir = fs.mkdtempSync(path.join(prsDir(harness), `rua-${repo.replace('/', '__')}__${n}-`));
  ctx.roundDir = dir;
  OWNED.add(dir);
  EXCLUDE = dir;
  const write = (file, v) => fs.writeFileSync(path.join(dir, file), typeof v === 'string' || Buffer.isBuffer(v) ? v : `${JSON.stringify(v, null, 2)}\n`);
  write('pr.json', { number: Number(n), title: view.title, body: view.body, author: view.author, draft: view.draft, head: view.head, mergeBase });
  const full = git(gitDir, ['diff', ...diffArgs, '--src-prefix=a/', '--dst-prefix=b/', mergeBase, view.head], { encoding: 'buffer' });
  write('diff.patch', rangeBase === mergeBase ? full : git(gitDir, ['diff', ...diffArgs, '--src-prefix=a/', '--dst-prefix=b/', rangeBase, view.head], { encoding: 'buffer' }));
  if (rangeBase !== mergeBase) write('pr.patch', full);
  extract(gitDir, view.head, path.join(dir, 'head'));
  write('checks.json', graphless(() => ghJson(['api', '--paginate', '--slurp', `repos/${repo}/commits/${view.head}/check-runs`])
    .flatMap((p) => p.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }))));
  write('prior.json', {
    findings: (f.state?.findings || []).map((x) => ({ ...x, text: f.threads.get(x.key)?.text, replies: (f.threads.get(x.key)?.others || []).map((c) => ({ author: c.author?.login, body: c.body, createdAt: c.createdAt })) })),
    conversation: view.comments.filter((c) => lower(c.author?.login) !== ctx.login && c.databaseId > (f.state?.seen.issue ?? 0)).map((c) => ({ author: c.author?.login, body: c.body, createdAt: c.createdAt })),
  });
  // Private material is read only where its audience matches: a private repository's closing tickets and related
  // repositories, of the same owner.
  if (view.private) {
    const owner = lower(repo.split('/')[0]);
    fs.mkdirSync(path.join(dir, 'issues'));
    const [o, name] = repo.split('/');
    const refs = graphless(() => ghJson(['api', 'graphql', '-f', `query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}}}}`, '-f', `o=${o}`, '-f', `r=${name}`, '-F', `n=${n}`])
      .data.repository.pullRequest.closingIssuesReferences.nodes) || [];
    for (const ref of refs) {
      const r = ref.repository?.nameWithOwner || '';
      if (lower(r.split('/')[0]) !== owner || !Number.isInteger(ref.number)) continue;
      const i = graphless(() => ghJson(['api', `repos/${r}/issues/${ref.number}`]));
      if (i) write(`issues/${r.replace('/', '__')}__${ref.number}.json`, { repo: r, number: ref.number, title: i.title, body: i.body, state: i.state });
    }
    for (const r of relatedRepos(gitDir, repo, mergeBase)) {
      try {
        const head = ghJson(['api', `repos/${r}/commits/HEAD`]).sha;
        if (!HEX.test(head || '')) continue;
        fetchCommits(gitDir, r, [head]);
        extract(gitDir, head, path.join(dir, 'related', r.replace('/', '__')));
      } catch { /* listed as unavailable by its absence */ }
    }
  }
  return dir;
}
// An optional read: null when it fails.
function graphless(fn) { try { return fn(); } catch { return null; } }

// ---- the agents and the verifier's list -----------------------------------------------------------------------------

function request(name, fill) {
  return fs.readFileSync(path.join(REQUESTS, name), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
}

const str = (v) => typeof v === 'string';
const optStr = (v) => v === null || v === undefined || str(v);
const optLine = (v) => v === null || v === undefined || (Number.isInteger(v) && v > 0);
function reviewerOk(text) {
  try {
    const r = JSON.parse(text);
    return r && typeof r === 'object' && Array.isArray(r.findings) && (r.verdicts === undefined || Array.isArray(r.verdicts));
  } catch { return false; }
}

// The verifier's list after the checks: { ok, list } or { ok: false }. A span must occur in its file at the head; a
// verdict claiming the code settles something without a quoted span becomes `asked`.
// The sentences of the notes, without list markers and normalized, that are long enough to recognize: three words or
// more and at least 12 characters, so that a path or a name the notes mention is not one. Agent text that contains
// one is not posted. Paraphrase and shorter sentences are not caught.
const noteLines = (notes) => String(notes || '').split(/\r\n|\r|\n/).map((l) => l.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, ''))
  .flatMap((l) => l.split(/(?<=[.!?;:])\s+/)).map(norm).map((l) => l.replace(/[.!?;:]+$/, ''))
  .filter((l) => l.length >= 12 && l.split(' ').length >= 3);
const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
function checkList(text, { state, roundDir, secrets, notes = '' }) {
  let v;
  try { v = JSON.parse(text); } catch { return { ok: false, why: 'parse' }; }
  const optList = (x) => x === undefined || Array.isArray(x);
  if (!v || typeof v !== 'object' || !Array.isArray(v.findings) || !Array.isArray(v.verdicts) || !optList(v.unverified) || !optList(v.notFlagged) || !optList(v.setAside)) return { ok: false, why: 'shape' };
  const head = path.join(roundDir, 'head');
  const occurs = (file, s) => {
    if (!str(file) || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return false;
    try { return fs.readFileSync(path.join(head, file), 'utf8').includes(s); } catch { return false; }
  };
  const quoted = noteLines(notes);
  const textOk = (t) => !t || (refusal(escapeText(t), { markers: [], secrets }) === null && !quoted.some((l) => norm(t).includes(l)));
  const spanOk = (s) => !s || refusal(fence(s), { markers: [], secrets }) === null;
  const pathOk = (p) => { if (!p) return true; try { return refusal(fencePath(p), { markers: [], secrets }) === null; } catch { return false; } };
  const kept = (x) => {
    if (!x || !CLASSES.includes(x.class) || !str(x.text) || !x.text.trim() || !optStr(x.file) || !optLine(x.line) || !optStr(x.span) || !optStr(x.reason) || ![undefined, null, true, false].includes(x.asked)) return 'shape';
    if (x.span && !occurs(x.file, x.span)) return 'span';
    if (!textOk(x.text) || !textOk(x.reason) || !spanOk(x.span) || !pathOk(x.file)) return 'text';
    return { class: x.class, file: x.file || null, line: x.line || null, span: x.span || null, text: x.text, reason: x.reason || null, asked: x.asked === true };
  };
  // Weighed against the notes: a finding that conflicts with a note on judgment is published as `asked`. A blocker is
  // never left unflagged by a note, and a finding is set aside only by a span quoted from the head; either becomes
  // `asked` instead.
  const findings = [];
  const setAside = [];
  let notFlagged = 0;
  for (const [list, kind] of [[v.findings, 'finding'], [v.notFlagged || [], 'notFlagged'], [v.setAside || [], 'setAside']]) {
    for (const x of list) {
      const k = kept(x);
      if (typeof k === 'string') return { ok: false, why: k };
      if (kind === 'notFlagged' && k.class === 'minor') notFlagged++;
      else if (kind === 'setAside' && k.span) setAside.push(k);
      else findings.push(kind === 'finding' ? k : { ...k, asked: true });
    }
  }
  const known = new Map(state ? state.findings.map((x) => [x.key, x]) : []);
  const verdicts = [];
  const seen = new Set();
  for (const x of v.verdicts) {
    if (!x || !str(x.key) || !['fixed', 'answered', 'open', 'asked'].includes(x.status) || !optStr(x.file) || !optStr(x.span) || !optStr(x.reply)) return { ok: false, why: 'shape' };
    if (!known.has(x.key) || seen.has(x.key)) return { ok: false, why: 'key' };
    seen.add(x.key);
    if (x.span && !occurs(x.file, x.span)) return { ok: false, why: 'span' };
    if (!textOk(x.reply) || !spanOk(x.span)) return { ok: false, why: 'text' };
    verdicts.push({ key: x.key, status: x.status === 'answered' && !x.span ? 'asked' : x.status, span: x.span || null, reply: x.reply || null });
  }
  const unverified = (v.unverified || []).filter(str);
  if (!unverified.every(textOk)) return { ok: false, why: 'text' };
  return { ok: true, list: { findings, verdicts, unverified, setAside, notFlagged } };
}

// Runs one agent, once more on a malformed output. Returns { output } or { stop: ask } or { fail: reason }.
async function agent(ctx, role, prompt, accept) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const outputDir = path.join(ctx.work, `${role}-${attempt}`);
    const outputName = role === 'reviewer' ? 'result.json' : 'verified.json';
    const output = path.join(outputDir, outputName);
    const r = await runConfined({ harness: ctx.harness, kind: 'agent', model: ctx.model, effort: ctx.effort, dir: ctx.roundDir, outputDir, outputName, prompt: prompt(output) });
    log(`${role} ${attempt}`, `${r.status}${r.reason ? ` ${r.reason}` : ''}`);
    if (r.status === 'cannot start' || r.status === 'preflight failed') return { stop: 'agent-cannot-start' };
    if (r.status === 'hook did not run') return { stop: 'hook-did-not-run' };
    if (r.status === 'ok') {
      const got = accept(r.output);
      if (got) return { output: got };
    }
  }
  return { fail: role === 'reviewer' ? 'reviewer-output' : 'verifier-list' };
}

// The new state from the verified list.
function nextState(ctx, list, round) {
  const { view, f, mergeBase, rangeBase } = ctx;
  const head = view.head;
  const prev = f.state;
  const findings = structuredClone(prev?.findings || []);
  const texts = {};
  for (const v of list.verdicts) {
    const x = findings.find((y) => y.key === v.key);
    texts[x.key] = { reply: v.reply, span: v.span };
    if (x.status === 'waived') continue;
    // An asked finding waits for the user unless a round finds it fixed; a finding the user decided on is closed only
    // by the user or by `fixed`.
    if (x.status === 'asked' && v.status !== 'fixed') continue;
    if (x.decided && ['answered', 'asked'].includes(v.status)) continue;
    if (v.status === x.status) continue;
    x.status = v.status;
    x.at = head;
    if (['fixed', 'answered'].includes(v.status)) Object.assign(x, { closed: head, closedRound: round });
    else Object.assign(x, { closed: null, closedRound: null });
  }
  const newKeys = [];
  list.findings.forEach((x, i) => {
    const key = `${round}.${i + 1}`;
    newKeys.push(key);
    texts[key] = { text: x.text, span: x.span, reason: x.reason };
    findings.push({ key, class: x.class, status: x.asked ? 'asked' : 'open', file: x.file, line: x.line, raised: head, at: head, closed: null, closedRound: null, decided: false });
  });
  const subs = gitlinks(ctx.gitDir, mergeBase, head).map((s) => ({ ...s, ok: Boolean(prev?.subs.some((p) => p.path === s.path && p.to === s.to && p.ok)) }));
  return {
    state: { v: 1, round, agents: true, head, base: rangeBase, mergeBase, desc: descHash(view.title, view.body), notes: ctx.notes.hash, lang: ctx.lang, seen: seenOf(view), subs, findings },
    texts, newKeys,
  };
}

// ---- verbs ----------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opts };
}
function usage(msg) {
  process.stderr.write(`review-until-approve: ${msg}\n`);
  process.exit(2);
}
// The same refusal from inside a lock: the caller returns, so the lock is released.
function refuse(msg) {
  process.stderr.write(`review-until-approve: ${msg}\n`);
  process.exitCode = 2;
}

// Who the account is and what the pull request says. Prints the question about the account when it cannot read it.
function begin(repo, n, opts) {
  const harness = harnessOf(opts);
  const data = ensureDataDir(SKILL, harness);
  LOG = path.join(data, 'log');
  let login;
  try { login = lower(ghJson(['api', 'user']).login); } catch {
    print({ event: 'question', ask: 'account' });
    return null;
  }
  return { repo, n, harness, data, login, id: slug(repo, n, login), fromWatcher: opts.from === 'watcher' };
}
function readView(ctx) {
  try {
    ctx.view = readAll(ctx.repo, ctx.n, ctx.login);
  } catch (e) {
    print(e instanceof GhError && e.notFound ? { event: 'question', ask: 'account' } : { event: 'error', reason: 'github' });
    return false;
  }
  ctx.f = fold(ctx.view, ctx.login);
  return true;
}
// What this process must remove if it is stopped: the round directory (it can hold private material), the work and
// git directories, and its lock. A running agent is stopped first: it runs in its own process group, which a signal to
// this process does not reach, and its time and size limits are timers in this process.
const OWNED = new Set();
let LOCK = null;
// ponytail: children are found with `ps`, so on Windows a running agent is not stopped; a job object would close it.
function stopChildren() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  for (const line of (r.stdout || '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (ppid !== process.pid || !pid) continue;
    for (const target of [-pid, pid]) { try { process.kill(target, 'SIGKILL'); } catch { /* gone */ } }
  }
}
function trapSignals() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      stopChildren();
      for (const d of OWNED) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (LOCK) { try { releaseLock(LOCK); } catch { /* best effort */ } }
      process.exit(130);
    });
  }
}

// One lock file per pull request and account: a second round or decision on it prints `locked`.
async function withLock(ctx, fn) {
  const file = path.join(ownerDir(path.join(ctx.data, 'locks')), `${ctx.id}.lock`);
  if (!takeLock(file)) return print({ event: 'locked' });
  LOCK = file;
  try {
    return await fn();
  } finally {
    releaseLock(file);
  }
}
function ended(view) {
  if (view.state === 'MERGED') return print({ event: 'merged' }) || true;
  if (view.state === 'CLOSED') return print({ event: 'closed' }) || true;
  return false;
}

function stateVerb(ctx) {
  if (!readView(ctx)) return;
  const { view, f } = ctx;
  if (ended(view)) return;
  const notes = loadNotes(ctx, f.state?.notes || '');
  const p = pendingOf(ctx.repo, view, f, ctx.login, notes.ask ? f.state?.notes : notes.hash);
  const cond = approval({ state: f.state, live: view, login: ctx.login, unreadable: f.unreadable, approvedHeads: approvedHeads(view) });
  print({ event: 'state', pending: p.pending, approvable: cond.approve, why: cond.why, ...(f.state && { round: f.state.round, head: f.state.head, ...tally(f.state) }), link: view.url });
  if (notes.ask) print(notesQuestion(notes, view.url));
  else if (notes.duplicates) print({ event: 'notes', duplicates: notes.duplicates });
  askAll(ctx, ctx.repo, view, f);
}

async function roundVerb(ctx, opts) {
  ctx.model = opts.model;
  ctx.effort = opts.effort;
  if (opts.language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(opts.language)) return refuse('--language must be a BCP 47 tag such as ko or en');
  if (ctx.fromWatcher && !watched(ctx)) return print({ event: 'unwatched', pr: tagOf(ctx.repo, ctx.n) });
  if (!readView(ctx)) return;
  const { repo, n, view, login } = ctx;
  if (ended(view)) return;
  if (view.author === login) return print({ event: 'error', reason: 'author' });
  ctx.secrets = credentials(ctx.harness);
  const f = ctx.f;
  ctx.lang = opts.language ?? f.state?.lang ?? '';
  // No round runs, and nothing is approved, without the notes from their store.
  const notes = loadNotes(ctx, f.state?.notes || '');
  if (notes.ask) return print(notesQuestion(notes, view.url));
  ctx.notes = notes;
  if (notes.duplicates) print({ event: 'notes', duplicates: notes.duplicates });
  const { pending, keys } = pendingOf(repo, view, f, login, notes.hash);
  const work = { gitDir: null };
  try {
    if (!pending.length) {
      // Nothing to review: approve when the condition holds (a pull request made ready, or state from another machine).
      const cond = approval({ state: f.state, live: view, login, unreadable: f.unreadable, approvedHeads: approvedHeads(view) });
      if (cond.approve) for (const l of publishCarried(ctx, {})) print(l);
      else {
        // Replies that failed earlier, thread resolution, and the label follow the state even when nothing is pending.
        settle(repo, n, view, f, f.state, f.base?.url, f.state);
        print({ event: 'nothing', approvable: false, why: cond.why, round: f.state.round, head: f.state.head, ...tally(f.state), link: view.url });
      }
      askAll(ctx, repo, view, f);
      return;
    }
    ctx.gitDir = work.gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rua-git-'));
    OWNED.add(ctx.gitDir);
    git(ctx.gitDir, ['init', '-q', '--bare']);
    fs.mkdirSync(path.join(ctx.gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(ctx.gitDir, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    const cmp = compare(repo, view.baseTip, view.head);
    ctx.mergeBase = cmp.merge_base_commit?.sha;
    if (!HEX.test(ctx.mergeBase || '')) throw new Error('bad merge base');
    const s = f.state;
    const ancestor = s && s.head !== view.head && ['ahead'].includes(graphless(() => compare(repo, s.head, view.head).status));
    fetchCommits(ctx.gitDir, repo, [view.head, ctx.mergeBase, ...(ancestor ? [s.head, s.mergeBase] : [])]);

    // A base merge: the last reviewed head is an ancestor, nothing else is pending, and the diff is the same.
    if (ancestor && pending.length === 1 && pending[0] === 'head' && patchId(ctx.gitDir, s.mergeBase, s.head) === patchId(ctx.gitDir, ctx.mergeBase, view.head)) {
      for (const l of publishCarried(ctx, { carried: true, head: view.head })) print(l);
      askAll(ctx, repo, view, f);
      return;
    }
    // The daily cap counts rounds that ran an agent: published ones from the state reviews, failed ones locally.
    const used = f.states.filter((x) => x.state?.agents && Date.now() - x.at < DAY).length + failedRounds(ctx.data, ctx.id).length;
    if (used >= CAP) return print({ event: 'question', ask: 'cap', rounds: used, link: view.url });
    const rangeBase = ancestor && s.mergeBase === ctx.mergeBase && !pending.includes('description') && !pending.includes('notes') ? s.head : ctx.mergeBase;
    ctx.rangeBase = rangeBase;
    const failed = (reason) => { countFailed(ctx.data, ctx.id); print({ event: 'failed', reason }); };
    try { prepare(ctx, rangeBase); } catch (e) {
      log('prepare', e.stack);
      return print({ event: 'failed', reason: 'prepare' });
    }
    ctx.work = fs.mkdtempSync(path.join(ownerDir(path.join(ctx.data, 'rounds')), 'r-'));
    OWNED.add(ctx.work);
    const round = f.nextRound;
    const focus = pending.length === 1 && pending[0] === 'reply' && keys.length ? keys.join(', ') : 'every finding in prior.json';
    const fill = { ROUND_DIR: ctx.roundDir, NOTES: notes.hash ? fence(notes.text) : 'none', LANGUAGE: ctx.lang || 'the language of the pull request description', FOCUS: focus, BROAD: rangeBase === ctx.mergeBase ? 'the whole pull request' : 'the commits since the last reviewed head (diff.patch), with pr.patch for context' };
    const rev = await agent(ctx, 'reviewer', (output) => request('reviewer-request.md', { ...fill, OUTPUT: output }), (t) => (reviewerOk(t) ? t : null));
    if (rev.stop) return print({ event: 'question', ask: rev.stop, link: view.url });
    if (rev.fail) return failed(rev.fail);
    fs.mkdirSync(path.join(ctx.roundDir, 'review'));
    fs.writeFileSync(path.join(ctx.roundDir, 'review', 'result.json'), rev.output);
    const ver = await agent(ctx, 'verifier', (output) => request('verifier-request.md', { ...fill, OUTPUT: output, RESULT: path.join(ctx.roundDir, 'review', 'result.json') }),
      (t) => { const c = checkList(t, { state: f.state, roundDir: ctx.roundDir, secrets: ctx.secrets, notes: notes.text }); if (!c.ok) log('verifier list', c.why); return c.ok ? c.list : null; });
    if (ver.stop) return print({ event: 'question', ask: ver.stop, link: view.url });
    if (ver.fail) return failed(ver.fail);
    const next = nextState(ctx, ver.output, round);
    const hunks = hunksOf(git(ctx.gitDir, ['diff', ...diffArgs, '--src-prefix=a/', '--dst-prefix=b/', ctx.mergeBase, view.head]));
    const place = {};
    for (const key of next.newKeys) {
      const x = next.state.findings.find((y) => y.key === key);
      if (!x.file || !next.texts[key].span) continue;
      let content = '';
      try { content = fs.readFileSync(path.join(ctx.roundDir, 'head', x.file), 'utf8'); } catch { continue; }
      const line = placeLine(content, next.texts[key].span, x.file, hunks);
      if (line) place[key] = line;
    }
    const out = publish(ctx, { state: next.state, prev: f.state, texts: next.texts, place, unverified: ver.output.unverified, newKeys: next.newKeys, setAside: ver.output.setAside, notFlagged: ver.output.notFlagged });
    // A round that ran its agents and could not publish counts against the daily cap like any failed round.
    if (out[0].event === 'failed') countFailed(ctx.data, ctx.id);
    for (const l of out) print(l);
    const after = { ...f, state: next.state };
    askAll(ctx, repo, view, after);
  } finally {
    for (const d of [ctx.roundDir, ctx.work, work.gitDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  }
}

function decideVerb(ctx, pos, opts) {
  const [what, decision] = pos;
  const reason = String(opts.reason || '').trim();
  if (!reason) return refuse('decide needs --reason with the user\'s words');
  let d;
  if (['continue', 'start-over'].includes(what) && decision === undefined) d = { ruling: what };
  else if (KEY.test(what || '') && DECISIONS.includes(decision)) d = { key: what, decision };
  else if (/^submodule:./.test(what || '') && decision === 'accept') d = { submodule: what.slice('submodule:'.length), decision };
  else return refuse('usage: decide <owner/repo> <n> <key> keep|waive|blocker|minor | submodule:<path> accept | continue|start-over --reason <text>');
  if (!readView(ctx)) return;
  const { repo, n, view, f, login } = ctx;
  if (ended(view)) return;
  if (d.ruling && !f.unreadable) return refuse('the state is readable; there is nothing to rule on');
  if (d.key && !f.state?.findings.some((x) => x.key === d.key)) return refuse(`no finding ${d.key} in the state`);
  if (d.submodule !== undefined) {
    const s = f.state?.subs.find((x) => x.path === d.submodule && !x.ok);
    if (!s) return refuse('no undecided submodule change at that path');
    d.to = s.to;
  }
  const words = d.ruling ? `the state: **${d.ruling}**` : d.key ? `\`${d.key}\`: **${d.decision}**` : `the submodule change to \`${short(d.to)}\`: **accept**`;
  const body = `${PREFIX}decision ${enc(d)} -->\nThe reviewer's decision on ${words}\n\n${escapeText(reason)}`;
  if (refusal(body, { markers: [PREFIX], secrets: credentials(ctx.harness) })) return print({ event: 'failed', reason: 'reason-refused' });
  try { post(`repos/${repo}/issues/${n}/comments`, { body }); } catch { return print({ event: 'failed', reason: 'submission' }); }
  print({ event: 'decided', decision: d.ruling || d.decision, ...(d.key && { key: d.key }) });
  if (!readView(ctx)) return;
  ctx.secrets = credentials(ctx.harness);
  const g = ctx.f;
  if (!g.state) return;
  // Nothing is approved without the notes from their store, or before a round has weighed changed notes.
  const notes = loadNotes(ctx, g.state.notes);
  if (notes.ask) print(notesQuestion(notes, ctx.view.url));
  const cond = approval({ state: g.state, live: ctx.view, login, unreadable: g.unreadable, approvedHeads: approvedHeads(ctx.view) });
  if (cond.approve && !notes.ask && notes.hash === g.state.notes) for (const l of publishCarried(ctx, {})) print(l);
  else label(repo, n, ctx.view, blocking(g.state).length > 0 || g.unreadable);
  askAll(ctx, repo, ctx.view, g);
}

// notes: the only writer of the user's notes. With `-` it saves the complete set read from stdin; without it, it saves
// notes only the cache holds, or else looks the notes up. `--store` records the store the user chose. The notes go to
// the cache first, so that nothing the user said is lost while no store holds it.
function notesVerb(ctx, pos, opts) {
  if (opts.store !== undefined && opts.store !== 'gist' && !REPO_STORE.test(opts.store)) return refuse('--store must be gist or repo:OWNER/NAME');
  if (pos.length > 1 || (pos.length && pos[0] !== '-')) return refuse('usage: notes <owner/repo> <n> [-] [--store gist|repo:OWNER/NAME]');
  let text = null;
  if (pos[0] === '-') {
    text = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(text) > NOTES_MAX) return refuse('notes are limited to 64 KiB');
  }
  if (opts.store) recordStore(ctx.data, opts.store);
  const store = notesStore(ctx.data);
  const cache = readCache(ctx);
  const notes = text !== null ? { key: cache?.key || crypto.randomBytes(32).toString('hex'), text } : cache && !cache.stored ? cache : null;
  if (!notes) {
    if (!store) return print({ event: 'question', ask: 'notes-store' });
    const l = loadNotes(ctx, '');
    if (l.ask) return print(notesQuestion(l));
    return print({ event: 'notes', saved: false, empty: !l.hash, ...(l.duplicates && { duplicates: l.duplicates }) });
  }
  writeCache(ctx, { ...notes, stored: false });
  if (!store) return print({ event: 'question', ask: 'notes-store' });
  try {
    const was = readStore(ctx, store);
    // The key stays the one the store holds, so that saving the same notes again changes no hash.
    const saved = { key: was.notes?.key || notes.key, text: notes.text };
    writeCache(ctx, { ...saved, stored: false });
    writeStore(ctx, store, saved, was);
    writeCache(ctx, { ...saved, stored: true });
    print({ event: 'notes', saved: true, empty: !notesHash(saved), ...(was.duplicates && { duplicates: was.duplicates }) });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    print(notesQuestion({ ask: 'notes-unusable', problem: e.problem }));
  }
}

// ---- waiting --------------------------------------------------------------------------------------------------------

const interval = () => (Number(process.env.CONCORD_WATCH_INTERVAL) || 300) * 1000;
const NAME = /^[A-Za-z0-9][\w.:[\]-]{0,99}$/;

// watch add: the pull request goes on the watch list with the account gh is logged in as and the harness, model, and
// effort, and the watcher starts unless it runs. It starts only where it can do its work: outside any harness sandbox,
// which a process keeps for life. The probe writes in the state directory and reads the GitHub API; where either
// fails, nothing is added or started, and the user runs the command in a terminal.
function watchAdd(harness, repo, n, opts) {
  for (const k of ['model', 'effort']) if (opts[k] !== undefined && !NAME.test(opts[k])) usage(`--${k} must be a name`);
  let data, login;
  try {
    data = ensureDataDir(SKILL, harness);
    writeAtomic(path.join(data, 'probe'), 'ok');
    fs.rmSync(path.join(data, 'probe'));
    login = lower(ghJson(['api', 'user']).login);
  } catch { /* below */ }
  if (!login) return print({ event: 'watcher', running: Boolean(data) && runtime.watcherRunning(data), started: false, reason: 'probe' });
  // Only a pull request the account can read and did not write goes on the list.
  let meta;
  try { meta = readMeta(repo, n, login); } catch (e) {
    return print(e instanceof GhError && e.notFound ? { event: 'question', ask: 'account' } : { event: 'error', reason: 'github' });
  }
  if (meta.author === login) return print({ event: 'error', reason: 'author' });
  runtime.updateWatch(data, (list) => { list.entries[tagOf(repo, n)] = { repo, n: Number(n), login, harness, model: opts.model ?? null, effort: opts.effort ?? null }; });
  const { checked } = readRecord(data, slug(repo, n, login));
  print({ event: 'watching', pr: tagOf(repo, n), ...(FIELDS.checked(checked) && { checked }) });
  const was = runtime.watcherRunning(data);
  if (!was) runtime.startDetached(__filename, ['watcher', '--harness', harness]);
  print({ event: 'watcher', running: was, started: !was });
}

// watch remove: the user's stop. The entry and its pending lines go; nothing is posted.
function watchRemove(harness, repo, n) {
  const data = ensureDataDir(SKILL, harness);
  runtime.updateWatch(data, (list) => { delete list.entries[tagOf(repo, n)]; });
  const pr = tagOf(repo, n);
  markShown(pendingNotices(runtime.baseDir(harness), SKILL).filter((x) => x.line.startsWith(`${pr} `)));
  print({ event: 'unwatched', pr });
}

// watch status: whether the watcher runs, each entry with its last check, and the pending lines. Lines other than
// questions are marked shown; a question stays until it is answered.
function watchStatus(harness) {
  const data = ensureDataDir(SKILL, harness);
  print({ event: 'watcher', running: runtime.watcherRunning(data) });
  for (const e of Object.values(runtime.readWatch(data).entries)) {
    const { checked } = readRecord(data, slug(e.repo, e.n, e.login));
    print({ event: 'watching', pr: tagOf(e.repo, e.n), ...(FIELDS.checked(checked) && { checked }) });
  }
  const pending = pendingNotices(runtime.baseDir(harness), SKILL);
  for (const x of pending) if (FIELDS.notice(x.line)) print({ event: 'notice', notice: x.line });
  markShown(pending.filter((x) => !/^\S+ question /.test(x.line)));
}

// Whether a round or decision of this skill runs, on any pull request: rounds run one after another.
function roundRunning(data) {
  let names = [];
  try { names = fs.readdirSync(path.join(data, 'locks')).filter((x) => x.endsWith('.lock')); } catch { return false; }
  return names.some((x) => running(readJson(path.join(data, 'locks', x), null)));
}

// One check over the watch list, as docs/design/review-until-approve.md's event table says. A round runs as its own
// detached process, started from this copy of the script, so that a check ends in seconds; it takes the pull request's
// lock, and the next check leaves that pull request alone until it ends. Returns 1 when gh or a pull request could not
// be read, which the watcher counts toward ten failed checks in a row.
function checkVerb(harness) {
  const data = ensureDataDir(SKILL, harness);
  LOG = path.join(data, 'log');
  const base = runtime.baseDir(harness);
  const entries = Object.entries(runtime.readWatch(data).entries);
  if (!entries.length) return 0;
  let login;
  try { login = lower(ghJson(['api', 'user']).login); } catch { return 1; }
  let failed = false;
  let notable = 0;
  let next = null;
  for (const [key, e] of entries) {
    const pr = tagOf(e.repo, e.n);
    const id = slug(e.repo, e.n, e.login);
    // A pull request a round or decision is working on is left alone. The check takes no lock itself, so the user's
    // own round never finds one the check holds.
    if (running(readJson(path.join(data, 'locks', `${id}.lock`), null))) continue;
    const rec = readRecord(data, id);
    try {
      rec.checked = new Date().toISOString();
      if (login !== e.login) {
        notable += reconcile(base, rec, pr, [`${pr} question account ${e.login}`], []);
        continue;
      }
      let view;
      try { view = readAll(e.repo, e.n, login); } catch (err) {
        // The account cannot read it: the user is asked which account to use. Anything else is a failed check.
        if (err instanceof GhError && err.notFound) notable += reconcile(base, rec, pr, [`${pr} question account`], []);
        else failed = true;
        continue;
      }
      if (view.state !== 'OPEN') {
        runtime.updateWatch(data, (list) => { delete list.entries[key]; });
        markShown(pendingNotices(base, SKILL).filter((x) => x.line.startsWith(`${pr} `)));
        addNotice(base, SKILL, `${pr} ${view.state === 'MERGED' ? 'merged' : 'closed'}; no longer watched`);
        notable++;
        continue;
      }
      const f = fold(view, login);
      if (((f.state && blocking(f.state).length) || f.unreadable) && !view.labels.includes('review-blocked')) {
        try {
          post(`repos/${e.repo}/issues/${e.n}/labels`, { labels: ['review-blocked'] });
          addNotice(base, SKILL, `${pr} review-blocked label restored`);
        } catch { /* an account without write access cannot set it */ }
      }
      // The notes, from their store: a check that cannot have them lists the question and runs nothing.
      let notes;
      try { notes = loadNotes({ data, repo: e.repo, n: e.n, login, id }, f.state?.notes || ''); } catch {
        failed = true;
        continue;
      }
      const asks = [...questions(e.repo, view, f), ...(notes.ask ? [notesQuestion(notes, view.url)] : [])];
      notable += reconcile(base, rec, pr, asks.map((q) => questionText(pr, q)), ['asked', 'unreadable', 'submodule', 'account', ...NOTES_ASKS]);
      if (notes.ask) continue;
      const sig = sigOf(view, notes.hash);
      // Held: a watcher round failed on this view, or the watcher stopped at the daily cap and nothing runs until the
      // user invokes the skill.
      if (rec.view?.sig !== sig) rec.view = { sig, since: Date.now() };
      else if (next || rec.held === sig || rec.capHeld) continue;
      else if (pendingOf(e.repo, view, f, login, notes.hash).pending.length) {
        if (Date.now() - rec.view.since >= interval()) next = e;
      } else if (approval({ state: f.state, live: view, login, unreadable: f.unreadable, approvedHeads: approvedHeads(view) }).approve) next = e;
    } finally {
      // Only the fields a check owns are written over a fresh read, so a round or decision that wrote meanwhile loses nothing.
      const { view, checked, noticed } = rec;
      writeRecord(data, id, { ...readRecord(data, id), view, checked, noticed });
    }
  }
  if (next && !roundRunning(data)) {
    runtime.startDetached(__filename, ['round', next.repo, String(next.n), '--harness', harness, '--from', 'watcher',
      ...(next.model ? ['--model', next.model] : []), ...(next.effort ? ['--effort', next.effort] : [])]);
  }
  notifyCount(notable);
  return failed ? 1 : 0;
}

const harnessOf = (opts) => {
  const h = opts.harness || (process.env.CLAUDE_CODE_SESSION_ID && !process.env.CODEX_THREAD_ID ? 'claude' : 'codex');
  if (!['claude', 'codex'].includes(h)) usage('--harness must be claude or codex');
  return h;
};
const target = (repo, n) => /^[\w.-]+\/[\w.-]+$/.test(repo || '') && /^\d+$/.test(n || '');

async function main(argv) {
  const [verb, ...more] = argv;
  if (verb === 'watch') {
    const [sub, ...rest] = more;
    const { pos, opts } = parseArgs(rest);
    const harness = harnessOf(opts);
    if (sub === 'status' && !pos.length) return watchStatus(harness);
    if (!['add', 'remove'].includes(sub) || pos.length !== 2 || !target(...pos)) usage('usage: review-until-approve.js watch add|remove <owner/repo> <n> | watch status');
    return sub === 'add' ? watchAdd(harness, ...pos, opts) : watchRemove(harness, ...pos);
  }
  if (verb === 'check') { process.exitCode = checkVerb(harnessOf(parseArgs(more).opts)); return; }
  if (verb === 'watcher') return runtime.watch({ skill: SKILL, harness: harnessOf(parseArgs(more).opts), own: __filename });
  const [repo, n, ...rest] = more;
  if (!['state', 'round', 'decide', 'notes'].includes(verb) || !target(repo, n)) usage('usage: review-until-approve.js state|round|decide|notes <owner/repo> <n> [...] | watch ... | check | watcher');
  const { pos, opts } = parseArgs(rest);
  trapSignals();
  const ctx = begin(repo, n, opts);
  if (!ctx) return;
  // A failed GitHub read in state, notes, or decide is reported as `github`; no stack is logged, so nothing names the
  // store.
  const guarded = (fn) => {
    try { return fn(); } catch (e) {
      log(verb, e instanceof GhError ? 'gh failed' : e && e.name);
      print({ event: 'error', reason: e instanceof GhError ? 'github' : 'internal' });
      process.exitCode = 1;
      return undefined;
    }
  };
  if (verb === 'state') return guarded(() => stateVerb(ctx));
  if (verb === 'notes') return guarded(() => notesVerb(ctx, pos, opts));
  if (verb === 'decide') return withLock(ctx, () => { guarded(() => decideVerb(ctx, pos, opts)); recordRun(ctx, false); });
  return withLock(ctx, async () => {
    // A round that throws is recorded like a failed one, so that the watcher holds it and the user hears of it.
    try { await roundVerb(ctx, opts); } catch (e) {
      log('crash', e && e.stack);
      if (ctx.work) countFailed(ctx.data, ctx.id);
      print({ event: 'error', reason: e instanceof GhError ? 'github' : 'internal' });
      process.exitCode = 1;
    }
    recordRun(ctx, ctx.fromWatcher);
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    log('crash', e && e.stack);
    try { print({ event: 'error', reason: 'internal' }); } catch { /* nothing else to say */ }
    process.exitCode = 1;
  });
}

module.exports = { compose, approval, stateOf, decisionOf, stateLine, fold, checkList, valid, FIELDS, MAX_BODY, hunksOf, placeLine };
