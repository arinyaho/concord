'use strict';
const { execFileSync } = require('node:child_process');
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('./spawn-cross-platform');

// The collector turns one PR head's GitHub review activity into one packet
// shaped as the input of lgtm-state `record-review`, plus the context a session
// needs (summary status, reaction, checks). Everything read from GitHub is
// data: bodies are size-limited and marked untrusted, and a packet only hints;
// the session re-reads the state before acting.

const DEFAULT_REVIEWERS = ['chatgpt-codex-connector'];
const CODEX_REVIEWER = 'chatgpt-codex-connector';
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const MAX_BODY_CHARS = 4000;
const WINDOW_SECONDS = 900;
const DEFAULT_INTERVAL_MS = 30000;
const MIN_INTERVAL_MS = 30000;

const QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid
reviews(last:100){nodes{databaseId url state submittedAt author{login} commit{oid} comments(first:100){nodes{databaseId url body path line commit{oid} originalCommit{oid}}}}}
comments(last:100){nodes{databaseId url body createdAt author{login}}}
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}`;
const REACTIONS_QUERY = 'query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reactions(first:100,content:THUMBS_UP){nodes{content createdAt user{login}}}}}}';

// Reactions carry the bot account's login with a [bot] suffix; review and comment authors do not.
function loginOf(login) { return typeof login === 'string' ? login.replace(/\[bot\]$/, '') : login; }

function wholeSeconds(iso) { return Math.floor(Date.parse(iso) / 1000); }

function limited(body) {
  const text = typeof body === 'string' ? body : '';
  return { body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
}

function suggestionsOf(body) {
  return [...(typeof body === 'string' ? body : '').matchAll(/```suggestion[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1].replace(/\n$/, ''));
}

function priorityOf(body) {
  const match = /!\[P([12]) Badge\]/.exec(typeof body === 'string' ? body : '');
  return match ? `P${match[1]}` : null;
}

function finding(comment) {
  const { body, truncated } = limited(comment.body);
  return {
    url: comment.url,
    priority: priorityOf(comment.body),
    signals: [],
    commitId: comment.commit && comment.commit.oid,
    path: comment.path || null,
    line: Number.isSafeInteger(comment.line) ? comment.line : null,
    body,
    truncated,
    suggestions: suggestionsOf(body),
    untrusted: true,
  };
}

// The Codex summary comment holds one table row per review kind; only rows for
// this head count, and the summary is Completed only when every such row is.
function summaryOf(comments, head) {
  const comment = comments.find((c) => c.author && loginOf(c.author.login) === CODEX_REVIEWER && typeof c.body === 'string' && c.body.includes(SUMMARY_MARKER));
  if (!comment) return null;
  const rows = [...comment.body.matchAll(/^\|[^|\n]*\|([^|\n]*)\|\s*`([0-9a-f]{7,64})`\s*\|/gim)]
    .filter((row) => head.startsWith(row[2].toLowerCase()));
  if (rows.length === 0) return null;
  const completed = rows.every((row) => row[1].includes('**Completed**'));
  const times = rows.map((row) => /datetime="([^"]+)"/.exec(row[1])).filter(Boolean).map((m) => m[1]).sort();
  return { id: comment.databaseId, url: comment.url, commit: rows[0][2], status: completed ? 'completed' : 'in-progress', completedAt: completed && times.length > 0 ? times[times.length - 1] : null };
}

function checksOf(pr, head) {
  const commit = pr.commits.nodes[0] && pr.commits.nodes[0].commit;
  if (!commit || commit.oid.toLowerCase() !== head || !commit.statusCheckRollup) return null;
  return commit.statusCheckRollup.contexts.nodes.map((node) => node.__typename === 'CheckRun'
    ? { name: node.name, conclusion: node.status === 'COMPLETED' ? String(node.conclusion).toLowerCase() : 'pending' }
    : { name: node.context, conclusion: String(node.state).toLowerCase() });
}

function pullRequestOf(response) {
  if (response.errors) throw new Error(`review-collector: GitHub GraphQL error: ${JSON.stringify(response.errors).slice(0, 500)}`);
  const pr = response.data && response.data.repository && response.data.repository.pullRequest;
  if (!pr) throw new Error('review-collector: pull request not found');
  return pr;
}

// A review belongs to the head when its own commit is the head or when any of
// its inline comments was made on the head (originalCommit): GitHub moves a
// comment's current commit to every later head, so `commit` says nothing about
// where the finding was made.
function analyze(response, head, reviewers = DEFAULT_REVIEWERS) {
  const pr = pullRequestOf(response);
  const live = pr.headRefOid.toLowerCase();
  if (live !== head) return { stale: true, head, liveHead: live };
  const comments = pr.comments.nodes.filter((c) => c.author).map((c) => ({ ...c, author: { login: loginOf(c.author.login) } }));
  const summary = reviewers.includes(CODEX_REVIEWER) ? summaryOf(comments, head) : null;
  const observations = [];
  for (const review of pr.reviews.nodes) {
    const reviewer = review.author && loginOf(review.author.login);
    if (!reviewers.includes(reviewer) || review.state === 'PENDING') continue;
    const inline = review.comments.nodes;
    const reviewCommit = review.commit ? review.commit.oid.toLowerCase() : null; // null once a force-push drops the commit
    const madeOnHead = (c) => c.originalCommit && c.originalCommit.oid.toLowerCase() === head;
    if (reviewCommit !== head && !inline.some(madeOnHead)) continue;
    // A review on an older commit keeps only the comments it made on this head.
    const own = inline.filter((c) => reviewCommit === head || madeOnHead(c));
    observations.push({ reviewId: String(review.databaseId), reviewer, reviewUrl: review.url, commitId: head, reviewCommitId: reviewCommit, state: 'completed', lgtm: review.state === 'APPROVED', findings: own.map(finding) });
  }
  const pending = reviewers.filter((reviewer) => {
    const hasReview = observations.some((o) => o.reviewer === reviewer);
    if (reviewer === CODEX_REVIEWER && summary) return summary.status !== 'completed';
    return !hasReview;
  });
  const activity = observations.length > 0 || summary !== null;
  return {
    stale: false,
    model: {
      untrusted: true,
      head,
      terminal: pending.length === 0,
      pending,
      summary: summary && { url: summary.url, commit: summary.commit, status: summary.status, completedAt: summary.completedAt },
      reaction: null,
      observations,
      comments: comments.filter((c) => reviewers.includes(c.author.login) && !(c.body || '').includes(SUMMARY_MARKER)).map((c) => ({ url: c.url, author: c.author.login, ...limited(c.body), untrusted: true })),
      checks: checksOf(pr, head),
    },
    activity,
    summaryId: summary && summary.id,
  };
}

// The reaction list is read once, when the Codex summary has turned Completed
// for this head; GitHub sends no event for a reaction, so this is the only way
// to see the clean-result thumbs-up.
async function complete(analysis, { pr, graphql, reviewers = DEFAULT_REVIEWERS }) {
  const { untrusted, ...rest } = analysis.model;
  const packet = { untrusted, pr: Number(pr), ...rest, awaitingReaction: false };
  const summary = packet.summary;
  if (!summary || summary.status !== 'completed' || !summary.completedAt) return packet;
  const nodes = pullRequestOf(await graphql(REACTIONS_QUERY, { pr })).reactions.nodes
    .filter((node) => node.content === 'THUMBS_UP' && node.user && loginOf(node.user.login) === CODEX_REVIEWER)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (nodes.length > 0) {
    const node = nodes[0];
    packet.reaction = { reviewer: loginOf(node.user.login), content: node.content, createdAt: node.createdAt, fresh: wholeSeconds(node.createdAt) >= wholeSeconds(summary.completedAt) };
  }
  if (!packet.observations.some((o) => o.reviewer === CODEX_REVIEWER) && reviewers.includes(CODEX_REVIEWER)) {
    packet.observations.push({ reviewId: String(analysis.summaryId), reviewer: CODEX_REVIEWER, reviewUrl: summary.url, commitId: packet.head, reviewCommitId: packet.head, state: 'completed', lgtm: !!(packet.reaction && packet.reaction.fresh), findings: [] });
    packet.awaitingReaction = !(packet.reaction && packet.reaction.fresh);
  }
  return packet;
}

async function collect({ pr, head, graphql, reviewers = DEFAULT_REVIEWERS }) {
  const normalized = String(head).toLowerCase();
  const analysis = analyze(await graphql(QUERY, { pr }), normalized, reviewers);
  if (analysis.stale) return { stale: true, head: analysis.head, liveHead: analysis.liveHead };
  return complete(analysis, { pr, graphql, reviewers });
}

// `--reviewer <login>` (repeatable) names the configured automated reviewers; every one must be terminal.
function reviewersFrom(args) {
  const reviewers = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--reviewer') continue;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('review-collector: --reviewer needs a reviewer login');
    reviewers.push(args[i + 1]);
    i += 1;
  }
  return reviewers.length > 0 ? reviewers : DEFAULT_REVIEWERS;
}

function formatPacketLine(packet) { return JSON.stringify(packet); }

// Shell-level polling: the model is not involved between lines. One packet
// line per terminal head; the loop ends on a recorded delivery or the deadline.
async function watch({ pr, graphql, state, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = DEFAULT_INTERVAL_MS, write, reviewers = DEFAULT_REVIEWERS }) {
  if (intervalMs < MIN_INTERVAL_MS) throw new Error(`review-collector: the watch interval must be at least ${MIN_INTERVAL_MS} ms`);
  const printed = new Set();
  let awaitingReaction = false;
  const windowed = new Set();
  const since = new Map();
  for (;;) {
    const response = await graphql(QUERY, { pr });
    const head = pullRequestOf(response).headRefOid.toLowerCase();
    if (!since.has(head)) since.set(head, now());
    const analysis = analyze(response, head, reviewers);
    if (analysis.activity && !windowed.has(head)) { state.openWindow(head); windowed.add(head); }
    const status = state.status(head);
    if (status.delivery) { write(JSON.stringify({ event: 'delivery', pr: Number(pr), head, classification: status.delivery.classification })); return 'delivery'; }
    if (now() >= (status.deadlineMs ?? since.get(head) + WINDOW_SECONDS * 1000)) { write(JSON.stringify({ event: 'deadline', pr: Number(pr), head, pending: analysis.model.pending, awaitingReaction })); return 'deadline'; }
    if (analysis.model.terminal && !printed.has(head)) {
      // A clean Codex result is final only with its reaction, which arrives after the summary: keep reading until it does or the deadline passes.
      const packet = await complete(analysis, { pr, graphql, reviewers });
      awaitingReaction = packet.awaitingReaction;
      if (!awaitingReaction) { printed.add(head); write(formatPacketLine({ event: 'packet', ...packet })); }
    }
    await sleep(intervalMs);
  }
}

function ghGraphql(cwd = process.cwd()) {
  const gh = crossPlatformCommand('gh', cwd);
  return async (query, { pr }) => JSON.parse(execFileSync(gh, crossPlatformArgs(['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `pr=${pr}`, '-f', `query=${query}`], needsDoubleEscape('gh', cwd)), crossPlatformOpts({ cwd, encoding: 'utf8', maxBuffer: 64 << 20 })));
}

module.exports = { DEFAULT_REVIEWERS, reviewersFrom, MAX_BODY_CHARS, WINDOW_SECONDS, collect, watch, analyze, complete, formatPacketLine, ghGraphql };
