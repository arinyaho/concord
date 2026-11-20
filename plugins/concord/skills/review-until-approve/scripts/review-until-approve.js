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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dataDir, ensureDataDir } = require('../../../runtime/data-dir');
const { runConfined } = require('../../../runtime/confined-agent');
const { escapeText, fence, fencePath, refusal, credentials } = require('../../../runtime/post-text');
const { takeLock, releaseLock, readJson, writeAtomic, ownerDir } = require('../../../runtime/watcher');
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

const ASKS = ['asked', 'unreadable', 'submodule', 'agent-cannot-start', 'hook-did-not-run', 'cap', 'account', 'overflow'];
const REASONS = ['reviewer-output', 'verifier-output', 'verifier-list', 'prepare', 'submission', 'refused', 'author', 'github', 'reason-refused', 'internal'];
const PENDING = ['first', 'head', 'reply', 'description', 'start-over'];
const WHY = ['closed', 'head-moved', 'draft', 'author', 'blocker', 'unreadable', 'submodule', 'approved', 'overflow'];
const sha = (v) => typeof v === 'string' && HEX.test(v);
const count = (v) => Number.isInteger(v) && v >= 0;
const oneOf = (list) => (v) => list.includes(v);
const listOf = (ok) => (v) => Array.isArray(v) && v.every(ok);
const link = (v) => typeof v === 'string' && /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+(#[\w-]+)?$/.test(v);
const keyish = (v) => typeof v === 'string' && KEY.test(v);
const FIELDS = {
  event: oneOf(['state', 'nothing', 'published', 'superseded', 'locked', 'failed', 'question', 'decided', 'closed', 'merged', 'error']),
  ask: oneOf(ASKS), reason: oneOf(REASONS), pending: listOf(oneOf(PENDING)), why: listOf(oneOf(WHY)),
  review: oneOf(['APPROVE', 'COMMENT']), decision: oneOf([...DECISIONS, 'accept', 'continue', 'start-over']),
  agents: (v) => typeof v === 'boolean', approvable: (v) => typeof v === 'boolean', carried: (v) => typeof v === 'boolean',
  head: sha, link, keys: listOf(keyish), key: keyish,
  round: count, new: count, fixed: count, answered: count, open: count, asked: count, blockers: count, minors: count,
  submodules: count, rounds: count, set: count,
};
// Every printed line is checked against the vocabulary; a line that does not fit is a bug and is not printed.
function valid(line) {
  return line && typeof line === 'object' && Object.entries(line).every(([k, v]) => Object.hasOwn(FIELDS, k) && FIELDS[k](v));
}
function print(line) {
  if (!valid(line)) throw new Error(`a line outside the vocabulary: ${Object.keys(line).join(',')}`);
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// ---- processes ------------------------------------------------------------------------------------------------------

let LOG = null;
function log(what, detail) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${what}: ${String(detail || '').slice(0, 4000)}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ }
}

class GhError extends Error {
  constructor(args, stderr) {
    super('gh failed');
    const m = /HTTP (\d{3})/.exec(stderr || '');
    this.status = m ? m[1] : null;
    this.notFound = /HTTP (403|404)|Could not resolve to a (Repository|PullRequest)|NOT_FOUND|FORBIDDEN/.test(stderr || '');
    log(`gh ${args.slice(0, 3).join(' ')}`, stderr);
  }
}
// GitHub reads and writes call gh directly from a neutral directory; the round's prepared checkout is never a cwd.
function gh(args, input) {
  const r = spawnSync('gh', args, {
    cwd: os.tmpdir(), input, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  if (r.error || r.status !== 0) throw new GhError(args, r.stderr || String(r.error));
  return r.stdout;
}
const ghJson = (args, input) => JSON.parse(gh(args, input));
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
  const nextRound = Math.max(0, ...states.filter((s) => s.state).map((s) => s.state.round)) + 1;
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

// Replies newer than the state review that count: from the author or an account with write access, in a finding
// thread or the conversation. Returns the keys replied to, and whether the conversation has one.
function repliesSince(repo, view, f, login) {
  const since = f.base?.at || 0;
  const counts = (c) => {
    const who = lower(c.author?.login);
    return who && who !== login && time(c.createdAt) > since && (who === view.author || canWrite(repo, who));
  };
  const keys = [];
  for (const k of f.state?.findings.map((x) => x.key) || []) {
    if ((f.threads.get(k)?.others || []).some(counts)) keys.push(k);
  }
  return { keys, conversation: view.comments.some(counts) };
}

function pendingOf(repo, view, f, login) {
  if (!f.state) return { pending: [f.startedOver ? 'start-over' : 'first'], keys: [] };
  const pending = [];
  if (view.head !== f.state.head) pending.push('head');
  if (descHash(view.title, view.body) !== f.state.desc) pending.push('description');
  const r = repliesSince(repo, view, f, login);
  if (r.keys.length || r.conversation) pending.push('reply');
  return { pending, keys: r.conversation ? [] : r.keys };
}

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

const tally = (state) => ({
  open: state.findings.filter((x) => x.status === 'open').length,
  asked: state.findings.filter((x) => x.status === 'asked').length,
  blockers: blocking(state).length,
});

// ---- local records --------------------------------------------------------------------------------------------------

const slug = (repo, n, login) => `${repo.replace('/', '__')}__${n}__${login}`;
// The notice record per pull request and account: the failed-round counter (times of failed rounds).
function failedRounds(dir, id) {
  const rec = readJson(path.join(dir, 'notices', `${id}.json`), {});
  return (Array.isArray(rec.failed) ? rec.failed : []).filter((t) => Number.isFinite(t) && Date.now() - t < DAY);
}
function countFailed(dir, id) {
  const file = path.join(ownerDir(path.join(dir, 'notices')), `${id}.json`);
  const rec = readJson(file, {});
  writeAtomic(file, JSON.stringify({ ...rec, failed: [...failedRounds(dir, id), Date.now()] }));
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
function compose({ state, prev, texts = {}, place = {}, threads = new Map(), unverified = [], approve, carried = false, newKeys = [] }) {
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
      for (const s of subs) out.push(`-${full ? ` ${fencePath(s.path)}\n` : ' '}\`${s.from ? short(s.from) : 'new'}\` to \`${short(s.to)}\``);
    }
    if (approve) {
      const minors = state.findings.filter((f) => f.status === 'open' && f.class === 'minor');
      if (minors.length) out.push(`### Follow-ups (not blocking)\n${minors.map((f) => `- \`${f.key}\`${ref(f.key)}`).join('\n')}`);
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

// Moves the line comments into the body, once, after GitHub refused a position.
function inBody(review) {
  const extra = review.comments.map((c) => `- ${fencePath(c.path)}\nline ${c.line}\n\n${lines(c.body).slice(1).join('\n')}`);
  const parts = review.body.split('\n\n');
  const marker = parts.pop();
  return { ...review, comments: [], body: [...parts, '### Placed in the body', ...extra, marker].join('\n\n') };
}

// Every text a review posts must pass the scan; returns the refusal reason or null.
function scan(review, secrets) {
  for (const t of [review.body, ...review.comments.map((c) => c.body)]) {
    const why = refusal(t, { markers: [PREFIX], secrets });
    if (why) return why;
  }
  return null;
}

// Submits one review pinned to the reviewed head. `fresh` is the account's newest state review id at the round's start:
// a newer one means another round published first. Returns { posted, url } or { superseded } or { failed }.
function submit(repo, n, login, review, startNewest) {
  const url = `repos/${repo}/pulls/${n}/reviews`;
  const mineNow = () => fold({ reviews: readMeta(repo, n, login).reviews, comments: [], threads: [] }, login);
  if (mineNow().newest !== startNewest) return { superseded: true };
  const payload = (r) => ({ commit_id: r.state.head, event: r.event, body: r.body, comments: r.comments });
  const ours = () => readMeta(repo, n, login).reviews.find((r) => { const s = stateOf(r.body); return s && s.round === review.state.round && s.head === review.state.head; });
  let r = review;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = post(url, payload(r));
      return { posted: true, url: res.html_url, review: r };
    } catch (e) {
      if (e.status === '422' && r.comments.length) { r = inBody(r); continue; }
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
function publish(ctx, { state, prev, texts, place, unverified, newKeys = [], carried = false }) {
  const { repo, n, login, f } = ctx;
  const live = readMeta(repo, n, login);
  let review = compose({ state, prev, texts, place, threads: f.threads, unverified, newKeys, carried, approve: false });
  const cond = approval({ state: review.state, live, login, unreadable: f.unreadable, approvedHeads: approvedHeads(live), overflow: review.overflow });
  if (cond.approve) review = compose({ state, prev, texts, place, threads: f.threads, unverified, newKeys, carried, approve: true });
  if (review.overflow) cond.why = [...new Set([...cond.why, 'overflow'])];
  const why = scan(review, ctx.secrets);
  if (why) {
    log('scan', why);
    return [{ event: 'failed', reason: 'refused' }];
  }
  const res = submit(repo, n, login, review, f.newest);
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
  if (res.review.event !== 'APPROVE') out[0].why = cond.why;
  if (review.overflow) out.push({ event: 'question', ask: 'overflow', link: ctx.view.url });
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
  const dir = fs.mkdtempSync(path.join(prsDir(harness), `rua-${repo.replace('/', '__')}__${n}-`));
  ctx.roundDir = dir;
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
    conversation: view.comments.filter((c) => lower(c.author?.login) !== ctx.login && time(c.createdAt) > (f.base?.at || 0)).map((c) => ({ author: c.author?.login, body: c.body, createdAt: c.createdAt })),
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
function checkList(text, { state, roundDir, secrets }) {
  let v;
  try { v = JSON.parse(text); } catch { return { ok: false, why: 'parse' }; }
  if (!v || typeof v !== 'object' || !Array.isArray(v.findings) || !Array.isArray(v.verdicts) || (v.unverified !== undefined && !Array.isArray(v.unverified))) return { ok: false, why: 'shape' };
  const head = path.join(roundDir, 'head');
  const occurs = (file, s) => {
    if (!str(file) || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return false;
    try { return fs.readFileSync(path.join(head, file), 'utf8').includes(s); } catch { return false; }
  };
  const textOk = (t) => !t || refusal(escapeText(t), { markers: [], secrets }) === null;
  const spanOk = (s) => !s || refusal(fence(s), { markers: [], secrets }) === null;
  const pathOk = (p) => { if (!p) return true; try { return refusal(fencePath(p), { markers: [], secrets }) === null; } catch { return false; } };
  const findings = [];
  for (const x of v.findings) {
    if (!x || !CLASSES.includes(x.class) || !str(x.text) || !x.text.trim() || !optStr(x.file) || !optLine(x.line) || !optStr(x.span) || !optStr(x.reason)) return { ok: false, why: 'shape' };
    if (x.span && !occurs(x.file, x.span)) return { ok: false, why: 'span' };
    if (!textOk(x.text) || !textOk(x.reason) || !spanOk(x.span) || !pathOk(x.file)) return { ok: false, why: 'text' };
    findings.push({ class: x.class, file: x.file || null, line: x.line || null, span: x.span || null, text: x.text, reason: x.reason || null });
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
  return { ok: true, list: { findings, verdicts, unverified } };
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
    // A finding the user decided on is closed only by the user or by `fixed`.
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
    findings.push({ key, class: x.class, status: 'open', file: x.file, line: x.line, raised: head, at: head, closed: null, closedRound: null, decided: false });
  });
  const subs = gitlinks(ctx.gitDir, mergeBase, head).map((s) => ({ ...s, ok: Boolean(prev?.subs.some((p) => p.path === s.path && p.to === s.to && p.ok)) }));
  return {
    state: { v: 1, round, agents: true, head, base: rangeBase, mergeBase, desc: descHash(view.title, view.body), notes: '', lang: ctx.lang, subs, findings },
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

// Who the account is and what the pull request says. Prints the question about the account when it cannot read it.
function begin(repo, n, opts) {
  const harness = opts.harness || (process.env.CLAUDE_CODE_SESSION_ID && !process.env.CODEX_THREAD_ID ? 'claude' : 'codex');
  if (!['claude', 'codex'].includes(harness)) usage('--harness must be claude or codex');
  const data = ensureDataDir(SKILL, harness);
  LOG = path.join(data, 'log');
  let login;
  try { login = lower(ghJson(['api', 'user']).login); } catch {
    print({ event: 'question', ask: 'account' });
    return null;
  }
  return { repo, n, harness, data, login, id: slug(repo, n, login) };
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
// One lock file per pull request and account: a second round or decision on it prints `locked`.
async function withLock(ctx, fn) {
  const file = path.join(ownerDir(path.join(ctx.data, 'locks')), `${ctx.id}.lock`);
  if (!takeLock(file)) return print({ event: 'locked' });
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
  const p = pendingOf(ctx.repo, view, f, ctx.login);
  const cond = approval({ state: f.state, live: view, login: ctx.login, unreadable: f.unreadable, approvedHeads: approvedHeads(view) });
  print({ event: 'state', pending: p.pending, approvable: cond.approve, why: cond.why, ...(f.state && { round: f.state.round, head: f.state.head, ...tally(f.state) }), link: view.url });
  for (const q of questions(ctx.repo, view, f)) print(q);
}

async function roundVerb(ctx, opts) {
  ctx.model = opts.model;
  ctx.effort = opts.effort;
  if (opts.language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(opts.language)) usage('--language must be a BCP 47 tag such as ko or en');
  if (!readView(ctx)) return;
  const { repo, n, view, login } = ctx;
  if (ended(view)) return;
  if (view.author === login) return print({ event: 'error', reason: 'author' });
  ctx.secrets = credentials(ctx.harness);
  const f = ctx.f;
  ctx.lang = opts.language ?? f.state?.lang ?? '';
  const { pending, keys } = pendingOf(repo, view, f, login);
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
      for (const q of questions(repo, view, f)) print(q);
      return;
    }
    const used = f.states.filter((s) => s.state?.agents && Date.now() - s.at < DAY).length + failedRounds(ctx.data, ctx.id).length;
    if (used >= CAP) return print({ event: 'question', ask: 'cap', rounds: used, link: view.url });

    ctx.gitDir = work.gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rua-git-'));
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
      for (const q of questions(repo, view, f)) print(q);
      return;
    }
    const rangeBase = ancestor && s.mergeBase === ctx.mergeBase && !pending.includes('description') ? s.head : ctx.mergeBase;
    ctx.rangeBase = rangeBase;
    const failed = (reason) => { countFailed(ctx.data, ctx.id); print({ event: 'failed', reason }); };
    try { prepare(ctx, rangeBase); } catch (e) {
      log('prepare', e.stack);
      return print({ event: 'failed', reason: 'prepare' });
    }
    ctx.work = fs.mkdtempSync(path.join(ownerDir(path.join(ctx.data, 'rounds')), 'r-'));
    const round = f.nextRound;
    const focus = pending.length === 1 && pending[0] === 'reply' && keys.length ? keys.join(', ') : 'every finding in prior.json';
    const fill = { ROUND_DIR: ctx.roundDir, LANGUAGE: ctx.lang || 'the language of the pull request description', FOCUS: focus, BROAD: rangeBase === ctx.mergeBase ? 'the whole pull request' : 'the commits since the last reviewed head (diff.patch), with pr.patch for context' };
    const rev = await agent(ctx, 'reviewer', (output) => request('reviewer-request.md', { ...fill, OUTPUT: output }), (t) => (reviewerOk(t) ? t : null));
    if (rev.stop) return print({ event: 'question', ask: rev.stop, link: view.url });
    if (rev.fail) return failed(rev.fail);
    fs.mkdirSync(path.join(ctx.roundDir, 'review'));
    fs.writeFileSync(path.join(ctx.roundDir, 'review', 'result.json'), rev.output);
    const ver = await agent(ctx, 'verifier', (output) => request('verifier-request.md', { ...fill, OUTPUT: output, RESULT: path.join(ctx.roundDir, 'review', 'result.json') }),
      (t) => { const c = checkList(t, { state: f.state, roundDir: ctx.roundDir, secrets: ctx.secrets }); if (!c.ok) log('verifier list', c.why); return c.ok ? c.list : null; });
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
    const out = publish(ctx, { state: next.state, prev: f.state, texts: next.texts, place, unverified: ver.output.unverified, newKeys: next.newKeys });
    // A round that ran its agents and could not publish counts against the daily cap like any failed round.
    if (out[0].event === 'failed') countFailed(ctx.data, ctx.id);
    for (const l of out) print(l);
    const after = { ...f, state: next.state };
    for (const q of questions(repo, view, after)) print(q);
  } finally {
    for (const d of [ctx.roundDir, ctx.work, work.gitDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  }
}

function decideVerb(ctx, pos, opts) {
  const [what, decision] = pos;
  const reason = String(opts.reason || '').trim();
  if (!reason) usage('decide needs --reason with the user\'s words');
  let d;
  if (['continue', 'start-over'].includes(what) && decision === undefined) d = { ruling: what };
  else if (KEY.test(what || '') && DECISIONS.includes(decision)) d = { key: what, decision };
  else if (/^submodule:./.test(what || '') && decision === 'accept') d = { submodule: what.slice('submodule:'.length), decision };
  else usage('usage: decide <owner/repo> <n> <key> keep|waive|blocker|minor | submodule:<path> accept | continue|start-over --reason <text>');
  if (!readView(ctx)) return;
  const { repo, n, view, f, login } = ctx;
  if (ended(view)) return;
  if (d.ruling && !f.unreadable) usage('the state is readable; there is nothing to rule on');
  if (d.key && !f.state?.findings.some((x) => x.key === d.key)) usage(`no finding ${d.key} in the state`);
  if (d.submodule !== undefined) {
    const s = f.state?.subs.find((x) => x.path === d.submodule && !x.ok);
    if (!s) usage('no undecided submodule change at that path');
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
  const cond = approval({ state: g.state, live: ctx.view, login, unreadable: g.unreadable, approvedHeads: approvedHeads(ctx.view) });
  if (cond.approve) for (const l of publishCarried(ctx, {})) print(l);
  else label(repo, n, ctx.view, blocking(g.state).length > 0 || g.unreadable);
  for (const q of questions(repo, ctx.view, g)) print(q);
}

async function main(argv) {
  const [verb, repo, n, ...rest] = argv;
  if (!['state', 'round', 'decide'].includes(verb) || !/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(n || '')) usage('usage: review-until-approve.js state|round|decide <owner/repo> <n> [...]');
  const { pos, opts } = parseArgs(rest);
  const ctx = begin(repo, n, opts);
  if (!ctx) return;
  if (verb === 'state') return stateVerb(ctx);
  if (verb === 'decide') return withLock(ctx, () => decideVerb(ctx, pos, opts));
  return withLock(ctx, () => roundVerb(ctx, opts));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    log('crash', e && e.stack);
    try { print({ event: 'error', reason: 'internal' }); } catch { /* nothing else to say */ }
    process.exitCode = 1;
  });
}

module.exports = { compose, approval, stateOf, decisionOf, stateLine, fold, checkList, valid, FIELDS, MAX_BODY, inBody, hunksOf, placeLine };
