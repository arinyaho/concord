#!/usr/bin/env node
'use strict';
// Round runner of review-until-approve. Every verb prints one JSON line.
//   start <owner/repo> <pr> [--reviewer codex|claude] [--model <m>]   check identity, open or resume the ledger, say what to do next
//   round <owner/repo> <pr>                                           review, publish, approve when clean
//   approve <owner/repo> <pr>                                         approve the reviewed head if the approval condition holds
//   waive <owner/repo> <pr> <finding-id>                              the user dismisses a finding, then approve if possible
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

const MAX_ROUNDS = 10;
const MAX_DISCARDS = 3;
const GUIDANCE_FINDINGS = 20;
const die = (message, code = 1) => { process.stderr.write(`review-until-approve: ${message}\n`); process.exit(code); };
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

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
// file-system profile or a bubblewrap wrapper. The Codex engine copies auth.json from CODEX_HOME into a home of its own.
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
  // The engine confines the Claude reviewer with bubblewrap so it cannot read the account's home; refuse before round 1 where that cannot run.
  if (provider === 'claude' && (process.platform !== 'linux' || spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status !== 0)) die('the claude reviewer needs Linux with a working bubblewrap (bwrap) to be kept from the real home directory; use codex otherwise');
  const ledger = found || { version: 1, repo, pr, reviewer, provider, model: opt(args, '--model') || null, author: snap.author, startedAt: new Date().toISOString(), rounds: [], findings: [], nudged: null, approval: null, stopped: null };
  ledger.provider = provider;
  if (opt(args, '--model')) ledger.model = opt(args, '--model');
  ledger.stopped = null;
  save(file, ledger);
  const viewer = gh(['repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission']).trim();
  const warning = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(viewer) ? undefined : `permission ${viewer}: an approval will not satisfy branch protection`;
  let action = 'watch';
  if (ledger.rounds.length === 0 || snap.head !== lastRound(ledger).head) action = 'round';
  else if (lib.evaluateApproval(ledger, snap, lastRound(ledger).head).approve) action = 'approve';
  out({ ledger: file, action, round: ledger.rounds.length + 1, ...(warning && { warning }) });
}

// The findings the reviewer is told about; only those can be judged fixed from its silence.
const shownFindings = (ledger) => ledger.findings.filter((f) => f.status === 'open').slice(0, GUIDANCE_FINDINGS);

function guidance(open) {
  if (!open.length) return undefined;
  return `Earlier findings on this pull request. If one is still present at this head, raise it again with the same id: ${open.map((f) => `${f.id} (${f.file}): ${f.summary.slice(0, 200)}`).join('; ')}`;
}

function reviewRound(repo, pr, args) {
  const { file, ledger } = identify(repo, pr, args);
  if (!ledger) die('no ledger; run start first');
  if (ledger.rounds.length >= MAX_ROUNDS) return out({ event: 'round-limit', rounds: ledger.rounds.length });
  for (let discards = 0; discards < MAX_DISCARDS; discards++) {
    const result = attempt(repo, pr, ledger, file);
    if (result) return out(result);
  }
  out({ event: 'head-keeps-moving' });
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

    const shown = shownFindings(ledger);
    const intentFile = path.join(dir, 'intent.md');
    fs.writeFileSync(intentFile, `# ${snap.title}\n\n${snap.body}`);
    const realClaudeConfig = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const claudeConfig = fs.mkdtempSync(path.join(dir, 'claude-'));
    const reviewerHome = fs.mkdtempSync(path.join(dir, 'home-'));
    const runnerOptions = { ref: `concord-pr-${pr}`, base: range.base, broad: range.broad, noBroad: !range.broad, reviewer: ledger.provider, reviewerModel: ledger.model || undefined, reviewDenyRead: [realClaudeConfig], reviewRealHome: os.homedir(), reviewWritable: [reviewerHome, claudeConfig], reviewerGuidance: guidance(shown), intentFile: range.broad ? intentFile : undefined };
    const env = reviewerEnv(ledger.provider, claudeConfig, reviewerHome);
    const runner = process.env.REVIEW_APPROVE_RUNNER || path.join(__dirname, 'run-review.js');
    const reviewed = JSON.parse(run('node', [runner, JSON.stringify(runnerOptions)], { cwd: work, env }).trim().split('\n').pop());
    if (reviewed.decision !== 'review-only' || !Array.isArray(reviewed.findings)) throw new Error(`the review did not complete: ${JSON.stringify(reviewed).slice(0, 200)}`);

    const n = ledger.rounds.length + 1;
    const { changed, renames } = lib.parseNameStatus(git(work, ['diff', '-z', '--name-status', '-M', range.base, 'HEAD']));
    // A merge-base range cannot see a rename of a file the PR itself added, so renames since the last reviewed head count too.
    if (prior && range.base !== prior.head) {
      try { for (const [from, to] of lib.parseNameStatus(git(work, ['diff', '-z', '--name-status', '-M', prior.head, 'HEAD'])).renames) renames.set(from, to); } catch (_) { /* the prior head is gone after a rewrite */ }
    }
    const collapse = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    // A reviewer-supplied path is evidence only as a regular file inside the checkout, with no symlink on the way.
    const spanAtHead = (f, span) => {
      if (!collapse(span)) return true;
      try {
        const root = fs.realpathSync(work), requested = path.resolve(root, f), real = fs.realpathSync(requested);
        if (real !== requested || !real.startsWith(root + path.sep) || !fs.lstatSync(real).isFile()) return false;
        return collapse(fs.readFileSync(real, 'utf8')).includes(collapse(span));
      } catch (_) { return false; }
    };
    const open = ledger.findings.filter((f) => f.status === 'open');
    const verdict = lib.classifyPrior(open, reviewed.findings, changed, spanAtHead, renames, { incremental: prior ? range.base === prior.head : false, evaluated: new Set(shown.map((f) => lib.findingKey(f))) });
    const next = JSON.parse(JSON.stringify(ledger));
    for (const m of verdict.moved) for (const f of next.findings) if (f.key === m.key) Object.assign(f, { file: m.file, key: lib.findingKey({ ...f, file: m.file }) });
    const fresh = reviewed.findings.filter((f, i, all) => !lib.isPublished(next, f) && all.findIndex((g) => lib.findingKey(g) === lib.findingKey(f)) === i);
    for (const f of next.findings) if (f.status === 'open' && verdict.fixedKeys.includes(f.key)) Object.assign(f, { status: 'fixed', fixedRound: n });
    for (const f of fresh) next.findings.push({ key: lib.findingKey(f), id: f.id, category: f.category, file: f.file, line: f.line, span: f.span, summary: f.summary, requirement: f.requirement || '', status: 'open', firstRound: n });

    const diff = git(work, ['diff', '-U3', range.base, 'HEAD']);
    const verdictNow = lib.evaluateApproval(next, snapshot(repo, pr), snap.head);
    const input = { head: snap.head, round: n, rangeBase: range.base, reviewer: ledger.provider, hunks: publish.hunksOf(diff), findings: fresh, fixed: verdict.fixed, stillOpen: verdict.open, previousHead: prior ? prior.head : snap.head, approve: verdictNow.approve };
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
    return { event: 'published', round: n, mode: range.broad ? 'broad' : 'diff', review: input.approve ? 'APPROVE' : 'COMMENT', new: fresh.length, fixed: verdict.fixed.length, stillOpen: verdict.open.length, ...(verdictNow.approve ? {} : { notApproved: verdictNow.reason }) };
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
  const finding = ledger?.findings.find((f) => f.id === id && f.status === 'open');
  if (!finding) die(`no open finding ${id}`);
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
