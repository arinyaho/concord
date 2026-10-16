#!/usr/bin/env node
'use strict';
// Round runner of review-until-approve. Every verb prints one JSON line.
//   start <owner/repo> <pr> [--reviewer codex|claude] [--model <m>]   check identity, open or resume the ledger, say what to do next
//   round <owner/repo> <pr>                                           review, publish, approve when clean
//   approve <owner/repo> <pr>                                         approve the reviewed head if the approval condition holds
//   waive <owner/repo> <pr> <finding-id|key>                          the user dismisses a finding, then approve if possible
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

// The review clone's .git is writable for an unconfined reviewer, which could plant refs/replace/* to make a head read differently; evidence is read as stored.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

const MAX_ROUNDS = 10;
const MAX_DISCARDS = 3;
const GUIDANCE_FINDINGS = 20;
const UNRESTRICTED = '--allow-unrestricted-home';
const WARNING = 'the claude reviewer can read your real home directory (gh, ssh and cloud credentials); a malicious pull request could make it publish their contents, and it is not trusted to leave the review clone intact. Use the codex reviewer to avoid this.';
const die = (message, code = 1) => { process.stderr.write(`review-until-approve: ${message}\n`); process.exit(code); };
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// An unrestricted-home run says so in every result, and on stderr where the user sees it.
const outFor = (ledger, value) => {
  if (!ledger.unrestrictedHome) return out(value);
  process.stderr.write(`review-until-approve: WARNING: ${WARNING}\n`);
  out({ ...value, warning: [value.warning, WARNING].filter(Boolean).join(' ') });
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
function reviewerEnv(provider, claudeConfig, home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ENV_ALLOWED.test(name)));
  env.HOME = home;
  if (provider === 'codex') env.CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (provider === 'claude' && process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return { ...env, CLAUDE_CONFIG_DIR: claudeConfig };
}

function snapshot(repo, pr) {
  const v = ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,baseRefOid,title,body,state,isDraft,author']);
  const mergeBase = gh(['api', `repos/${repo}/compare/${v.baseRefOid}...${v.headRefOid}`, '--jq', '.merge_base_commit.sha']).trim();
  return { head: v.headRefOid, baseTip: v.baseRefOid, mergeBase, intent: lib.sha(`${v.title}\n\n${v.body}`), title: v.title, body: v.body, state: v.state, isDraft: v.isDraft, author: v.author.login };
}

const secrets = () => [process.env.GH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.OPENAI_API_KEY, (() => { try { return gh(['auth', 'token']).trim(); } catch (_) { return ''; } })()];

function post(repo, pr, payload) {
  const text = JSON.stringify(payload);
  if (publish.containsSecret(text, secrets())) throw new Error('the review text holds a credential; nothing was posted');
  return ghJson(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], text);
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

const opt = (args, name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const lastRound = (ledger) => ledger.rounds[ledger.rounds.length - 1];

function start(repo, pr, args) {
  const { reviewer, file, ledger: found } = identify(repo, pr, args);
  const snap = snapshot(repo, pr);
  if (snap.state !== 'OPEN') die(`the pull request is ${snap.state}`);
  if (snap.author === reviewer) die(`${reviewer} is the author; GitHub rejects self-approval`);
  const provider = opt(args, '--reviewer') || found?.provider || (process.env.CLAUDECODE ? 'claude' : 'codex');
  if (!['codex', 'claude'].includes(provider)) die('--reviewer must be codex or claude');
  if (provider === 'claude' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) die('the claude reviewer needs CLAUDE_CODE_OAUTH_TOKEN; use codex otherwise');
  // The Claude reviewer cannot yet be kept from the account's home directory (tracked in its own issue), so it runs only on an explicit opt-in.
  if (provider === 'claude' && !args.includes(UNRESTRICTED)) die(`the claude reviewer can read the real home directory, and a malicious pull request could publish what it reads; pass ${UNRESTRICTED} to accept that, or use --reviewer codex`);
  const ledger = found || { version: 1, repo, pr, reviewer, provider, model: opt(args, '--model') || null, author: snap.author, startedAt: new Date().toISOString(), rounds: [], findings: [], nudged: null, approval: null, stopped: null };
  ledger.provider = provider;
  ledger.unrestrictedHome = provider === 'claude';
  if (opt(args, '--model')) ledger.model = opt(args, '--model');
  ledger.stopped = null;
  save(file, ledger);
  const viewer = gh(['repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission']).trim();
  const warning = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(viewer) ? undefined : `permission ${viewer}: an approval will not satisfy branch protection`;
  let action = 'watch';
  if (ledger.rounds.length === 0 || snap.head !== lastRound(ledger).head) action = 'round';
  else if (lib.evaluateApproval(ledger, snap, lastRound(ledger).head).approve) action = 'approve';
  outFor(ledger, { ledger: file, action, round: ledger.rounds.length + 1, ...(warning && { warning }) });
}

// The findings the reviewer is told about. Telling it decides nothing: a finding is fixed by the code, never by the reviewer's silence.
function guidance(open) {
  if (!open.length) return undefined;
  return `Earlier findings on this pull request. If one is still present at this head, raise it again with the same id and the current path: ${open.slice(0, GUIDANCE_FINDINGS).map((f) => `${f.id} (${f.file}): ${f.summary.slice(0, 200)}`).join('; ')}`;
}

const MAX_SPAN_FILE_BYTES = 20 * 1024 * 1024;
// A file as stored in the git object of `rev`, never from the working tree: a Buffer, null when the path is
// absent, 'other' when it is not a regular file (symlink, submodule, directory, or a path git rejects), 'big' when too large or the name does not survive decoding as UTF-8.
function gitBlob(cwd, rev, file) {
  if (file.includes('\uFFFD')) return 'big';
  const ls = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', rev, '--', file], { cwd, encoding: 'utf8' });
  if (ls.status !== 0) return 'other';
  const entry = ls.stdout.split('\0').find((e) => e.slice(e.indexOf('\t') + 1) === file && e.includes('\t'));
  if (!entry) return null;
  const [mode, , oid] = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (mode !== '100644' && mode !== '100755') return 'other';
  const size = spawnSync('git', ['cat-file', '-s', oid], { cwd, encoding: 'utf8' });
  if (size.status !== 0 || Number(size.stdout) > MAX_SPAN_FILE_BYTES) return 'big';
  const blob = spawnSync('git', ['cat-file', 'blob', oid], { cwd, maxBuffer: MAX_SPAN_FILE_BYTES + 1024 });
  return blob.status === 0 ? blob.stdout : 'big';
}
// A finding is verified when its span occurs byte for byte in the file at the head it was recorded against.
const verifiedAt = (cwd, head, f) => {
  const blob = f.span ? gitBlob(cwd, head, f.file) : null;
  return Buffer.isBuffer(blob) && blob.includes(Buffer.from(f.span, 'utf8'));
};

function reviewRound(repo, pr, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger) die('no ledger; run start first');
  if (ledger.provider === 'claude' && !ledger.unrestrictedHome) die(`the ledger runs the claude reviewer without the opt-in; run start with ${UNRESTRICTED} first`);
  if (ledger.rounds.length >= MAX_ROUNDS) return outFor(ledger, { event: 'round-limit', rounds: ledger.rounds.length });
  for (let discards = 0; discards < MAX_DISCARDS; discards++) {
    const result = attempt(repo, pr, ledger, file);
    if (result) return outFor(ledger, result);
  }
  outFor(ledger, { event: 'head-keeps-moving' });
}

// One round against the live head. Returns the summary, or null when the head moved and the result is discarded.
function attempt(repo, pr, ledger, file) {
  const snap = snapshot(repo, pr);
  if (snap.state !== 'OPEN') return { event: snap.state.toLowerCase() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-until-approve-'));
  const work = path.join(dir, 'work');
  const remote = `${process.env.REVIEW_APPROVE_REMOTE || 'https://github.com'}/${repo}.git`;
  try {
    git(dir, ['clone', '--quiet', remote, work], GIT_AUTH);
    git(work, ['fetch', '--quiet', 'origin', `pull/${pr}/head`], GIT_AUTH);
    git(work, ['checkout', '-q', '-B', `concord-pr-${pr}`, snap.head], GIT_AUTH);
    git(work, ['fetch', '--quiet', 'origin', snap.baseTip], GIT_AUTH);
    if (git(work, ['merge-base', snap.baseTip, 'HEAD']).trim() !== snap.mergeBase) throw new Error('the local merge base differs from the snapshot');
    const prior = ledger.rounds.length ? lastRound(ledger) : null;
    const isAncestor = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: work }).status === 0;
    const range = prior ? lib.chooseRange(prior, snap, isAncestor) : { base: snap.mergeBase, broad: true };

    // The delta from the head where each open finding's span was last verified to this head; a head that is gone is fetched, else the finding stays open.
    const deltas = new Map();
    const resolve = (p) => {
      if (!deltas.has(p.spanVerified)) {
        let delta = null;
        try {
          if (spawnSync('git', ['cat-file', '-e', `${p.spanVerified}^{commit}`], { cwd: work }).status !== 0) git(work, ['fetch', '--quiet', 'origin', p.spanVerified], GIT_AUTH);
          delta = lib.parseNameStatus(git(work, ['diff', '-z', '--name-status', '-M', p.spanVerified, snap.head]));
        } catch (_) { /* unreachable head: its findings stay open */ }
        deltas.set(p.spanVerified, delta);
      }
      return deltas.get(p.spanVerified);
    };
    const open = ledger.findings.filter((f) => f.status === 'open');
    const shown = open.map((p) => { const d = typeof p.spanVerified === 'string' && p.span ? resolve(p) : null; return { ...p, file: d?.renames.get(p.file) || p.file }; });

    const intentFile = path.join(dir, 'intent.md');
    fs.writeFileSync(intentFile, `# ${snap.title}\n\n${snap.body}`);
    const realClaudeConfig = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const claudeConfig = fs.mkdtempSync(path.join(dir, 'claude-'));
    const reviewerHome = fs.mkdtempSync(path.join(dir, 'home-'));
    const runnerOptions = { ref: `concord-pr-${pr}`, base: range.base, broad: range.broad, noBroad: !range.broad, reviewer: ledger.provider, reviewerModel: ledger.model || undefined, reviewDenyRead: [realClaudeConfig], reviewRealHome: os.homedir(), reviewerGuidance: guidance(shown), intentFile: range.broad ? intentFile : undefined };
    const env = reviewerEnv(ledger.provider, claudeConfig, reviewerHome);
    const runner = process.env.REVIEW_APPROVE_RUNNER || path.join(__dirname, 'run-review.js');
    const reviewed = JSON.parse(run('node', [runner, JSON.stringify(runnerOptions)], { cwd: work, env }).trim().split('\n').pop());
    if (reviewed.decision !== 'review-only' || !Array.isArray(reviewed.findings)) throw new Error(`the review did not complete: ${JSON.stringify(reviewed).slice(0, 200)}`);

    const n = ledger.rounds.length + 1;
    const verdict = lib.classifyPrior(open, reviewed.findings, resolve, (file) => gitBlob(work, snap.head, file), snap.head);
    const next = JSON.parse(JSON.stringify(ledger));
    const inNext = (key, status) => next.findings.find((f) => f.key === key && f.status === status);
    for (const r of verdict) {
      const f = inNext(r.key, 'open');
      if (r.status === 'fixed') Object.assign(f, { status: 'fixed', fixedRound: n });
      else {
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
      known.key = lib.findingKey(known);
      reopened.add(lib.findingKey(f));
    }
    for (const f of fresh.filter((g) => !reopened.has(lib.findingKey(g)))) {
      next.findings.push({ key: lib.findingKey(f), id: f.id, category: f.category, file: f.file, line: f.line, span: f.span, summary: f.summary, requirement: f.requirement || '', status: 'open', firstRound: n, ...(verifiedAt(work, snap.head, f) && { spanVerified: snap.head }) });
    }
    for (const f of next.findings) if (f.status === 'open' && !verified(f)) f.openReason = 'unverified';
    for (const f of next.findings) if (f.status === 'open' && verified(f) && f.openReason === 'unverified') delete f.openReason;
    const fixedIds = verdict.filter((r) => r.status === 'fixed').map((r) => r.id);
    const openIds = verdict.filter((r) => r.status === 'open').map((r) => r.id);
    const held = next.findings.filter((f) => f.status === 'open' && ['unverified', 'path-unresolved'].includes(f.openReason)).map((f) => ({ id: f.id, key: f.key, file: f.file, reason: f.openReason }));
    const openNow = next.findings.filter((f) => f.status === 'open').map((f) => ({ id: f.id, key: f.key, file: f.file }));

    const diff = git(work, ['diff', '-U3', range.base, 'HEAD']);
    const verdictNow = lib.evaluateApproval(next, snapshot(repo, pr), snap.head);
    const input = { head: snap.head, round: n, rangeBase: range.base, reviewer: ledger.provider, hunks: publish.hunksOf(diff), findings: fresh, fixed: fixedIds, stillOpen: openIds, previousHead: prior ? prior.head : snap.head, approve: verdictNow.approve };
    if (verdictNow.reason === 'head-moved') return null;
    const known = newestId(reviewsOf(repo, pr));
    const entry = (review) => ({ n, head: snap.head, base: range.base, mergeBase: snap.mergeBase, intent: snap.intent, mode: range.broad ? 'broad' : 'diff', reviewId: review.id, submittedAt: review.submitted_at || new Date().toISOString(), commentIds: [], event: input.approve ? 'APPROVE' : 'COMMENT' });
    // Saved before an APPROVE is posted, so a crash after GitHub accepts it is recovered by the next start.
    // Only the marker is saved: the verdict's findings travel inside it and apply when the review is found.
    if (input.approve) { save(file, { ...ledger, pending: { head: snap.head, after: known, round: entry({}), findings: next.findings } }); }
    let review;
    try { review = post(repo, pr, publish.renderReview(input, 'inline')); } catch (error) {
      if (snapshot(repo, pr).head !== snap.head) return null;
      review = landed(reviewsOf(repo, pr), ledger.reviewer, snap.head, known, input.approve ? 'APPROVED' : 'COMMENTED') || post(repo, pr, publish.renderReview(input, 'body'));
    }
    // Saved before anything else can fail, so a posted review (an APPROVE above all) is never forgotten.
    next.rounds.push(entry(review));
    delete next.pending;
    if (input.approve) next.approval = { head: snap.head, reviewId: review.id, at: next.rounds[next.rounds.length - 1].submittedAt };
    save(file, next);
    // Best effort: replies to a thread are recognized by these ids; without them only conversation replies count.
    try {
      next.rounds[next.rounds.length - 1].commentIds = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews/${review.id}/comments`]).flat().map((c) => c.id);
      save(file, next);
    } catch (_) { /* ponytail: ids stay empty; thread replies are then missed until the next round */ }
    return { event: 'published', round: n, mode: range.broad ? 'broad' : 'diff', review: input.approve ? 'APPROVE' : 'COMMENT', new: fresh.length, fixed: fixedIds.length, stillOpen: openIds.length, open: openNow, ...(verdictNow.approve ? {} : { notApproved: verdictNow.reason }), ...(held.length && { held, hint: 'These findings cannot be settled from the code; run waive <key> (or waive <id> when the id is unique) to clear one you accept.' }) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function approve(repo, pr, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger || !ledger.rounds.length) die('no reviewed round to approve');
  const reviewed = lastRound(ledger);
  const verdict = lib.evaluateApproval(ledger, snapshot(repo, pr), reviewed.head);
  if (!verdict.approve) return out({ event: 'not-approved', reason: verdict.reason });
  const after = newestId(reviewsOf(repo, pr));
  ledger.pending = { head: reviewed.head, after, round: null };
  save(file, ledger);
  let review;
  try {
    review = post(repo, pr, publish.renderReview({ head: reviewed.head, round: reviewed.n, rangeBase: reviewed.base, reviewer: ledger.provider, hunks: [], findings: [], fixed: [], stillOpen: [], previousHead: reviewed.head, approve: true }, 'body'));
  } catch (error) {
    review = landed(reviewsOf(repo, pr), ledger.reviewer, reviewed.head, after, 'APPROVED');
    if (!review) { delete ledger.pending; save(file, ledger); throw error; }
  }
  delete ledger.pending;
  ledger.approval = { head: reviewed.head, reviewId: review.id, at: new Date().toISOString() };
  save(file, ledger);
  out({ event: 'approved', head: reviewed.head });
}

function waive(repo, pr, id, args) {
  const { file, ledger } = identify(repo, pr, args);
  const matching = (ledger?.findings || []).filter((f) => (f.id === id || f.key === id) && f.status === 'open');
  if (!matching.length) die(`no open finding ${id}`);
  if (matching.length > 1) die(`${id} matches more than one open finding; pass the key of one: ${matching.map((f) => `${f.key} (${f.file})`).join(', ')}`);
  const [finding] = matching;
  Object.assign(finding, { status: 'waived', waivedAt: new Date().toISOString() });
  save(file, ledger);
  approve(repo, pr, args);
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
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(pr || '')) die('usage: approve.js <start|round|approve|waive|stop|nudged> <owner/repo> <pr> [...]', 2);
const verbs = { start, round: reviewRound, approve, stop, waive: (r, p, a) => waive(r, p, a[0], a), nudged: (r, p, a) => nudged(r, p, a[0], a) };
if (!verbs[verb]) die(`unknown verb ${verb}`, 2);
try { verbs[verb](repo, pr, rest); } catch (error) { die(error.message); }
