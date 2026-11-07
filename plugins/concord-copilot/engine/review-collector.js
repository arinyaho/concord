'use strict';
const { execFileSync } = require('node:child_process');
const { crossPlatformCommand, crossPlatformArgs, crossPlatformOpts, needsDoubleEscape } = require('./spawn-cross-platform');

// The collector turns one PR head's GitHub review activity into one packet
// shaped as the input of lgtm-state `record-review`, plus the context a session
// needs (summary status, reaction, checks). Everything read from GitHub is
// data: bodies are size-limited and marked untrusted, and a packet only hints;
// the session re-reads the state before acting.

const CODEX_REVIEWER = 'chatgpt-codex-connector';
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const MAX_BODY_CHARS = 4000;
const MAX_PAGES = 20; // per connection; a longer one fails the collection instead of being truncated
const WINDOW_SECONDS = 900;
const DEFAULT_INTERVAL_MS = 30000;
const MIN_INTERVAL_MS = 30000;

// Account type and id: an author is matched to a selected reviewer by both, never by a login another account could carry.
const AUTHOR_FIELDS = 'author{__typename login ... on User{databaseId} ... on Bot{databaseId}}';
const COMMENT_FIELDS = 'id databaseId url body path line commit{oid} originalCommit{oid}';
const CONTEXT_FIELDS = '__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}';
// A thread comment is a human item: it carries its author, its revision and the review GitHub created it in.
const THREAD_COMMENT_FIELDS = `${COMMENT_FIELDS} ${AUTHOR_FIELDS} createdAt lastEditedAt pullRequestReview{databaseId url state submittedAt commit{oid}}`;
const THREAD_FIELDS = `id isResolved comments(first:100){pageInfo{hasNextPage endCursor} nodes{${THREAD_COMMENT_FIELDS}}}`;
const REVIEW_FIELDS = `id databaseId url state submittedAt createdAt lastEditedAt body ${AUTHOR_FIELDS} commit{oid} comments(first:100){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}`;
const PR_COMMENT_FIELDS = `id databaseId url body createdAt lastEditedAt ${AUTHOR_FIELDS}`;
const QUERY = `query($owner:String!,$name:String!,$pr:Int!){viewer{login databaseId} repository(owner:$owner,name:$name){pullRequest(number:$pr){id headRefOid mergeStateStatus reviewDecision ${AUTHOR_FIELDS}
reviews(first:100){pageInfo{hasNextPage endCursor} nodes{${REVIEW_FIELDS}}}
reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}
comments(first:100){pageInfo{hasNextPage endCursor} nodes{${PR_COMMENT_FIELDS}}}
commits(last:1){nodes{commit{oid statusCheckRollup{id contexts(first:100){pageInfo{hasNextPage endCursor} nodes{${CONTEXT_FIELDS}}}}}}}}}}`;
// Follow-up pages for a pull request with more than 100 reviews, conversation comments or review threads, a review with more than 100 inline comments and a check rollup with more than 100 contexts.
const REVIEWS_PAGE_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequest{reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${REVIEW_FIELDS}}}}}}`;
const PR_COMMENTS_PAGE_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequest{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${PR_COMMENT_FIELDS}}}}}}`;
const THREADS_PAGE_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequest{reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}}}}`;
const THREAD_COMMENTS_PAGE_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${THREAD_COMMENT_FIELDS}}}}}}`;
const COMMENTS_PAGE_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReview{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}}}}`;
const CONTEXTS_PAGE_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on StatusCheckRollup{contexts(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${CONTEXT_FIELDS}}}}}}`;
const REACTIONS_QUERY = 'query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid reactionGroups{content reactors(first:100){edges{reactedAt node{__typename ... on Bot{databaseId}}}}}}}}';

// The selection is a list of accounts `{ login, id, type, gone? }`. An author is a selected reviewer only when its GitHub type and account id are a live selected account's;
// the login never matches, so a person who takes a bot's login, or a login freed by a rename, never stands in for the reviewer.
function selectedOf(author, selection) { return (author && selection.find((account) => !account.gone && account.type === author.__typename && account.id === author.databaseId)) || null; }

// Codex's summary comment and clean-result reaction count only from the selected Codex Bot account.
function codexOf(selection) { return selection.find((account) => !account.gone && account.type === 'Bot' && account.login === CODEX_REVIEWER) || null; }

// The bot path reads only the selected Bot accounts; a selected person is collected through the human path.
function botsOf(selection) { return selection.filter((account) => account.type === 'Bot'); }

// An author as the human path names it. A deleted account's author is null on GitHub and shows as ghost.
// Any account type other than a bot (Mannequin, Organization, ...) is recorded as a User; the query gives such an author no id.
function identityOf(author) { return author ? { login: String(author.login).replace(/\[bot\]$/, ''), id: author.databaseId ?? null, type: author.__typename === 'Bot' ? 'Bot' : 'User' } : { login: 'ghost', id: null, type: 'User' }; }

// A feedback item is one revision of one GitHub node, so an edit after an answer is a new item.
function itemKey(nodeId, revision) { return `${nodeId}@${revision}`; }

function oidOf(commit) { return commit && commit.oid ? commit.oid.toLowerCase() : null; }

function wholeSeconds(iso) { return Math.floor(Date.parse(iso) / 1000); }

function limited(body) {
  const text = typeof body === 'string' ? body : '';
  return { body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
}

function suggestionsOf(body) {
  return [...(typeof body === 'string' ? body : '').matchAll(/```suggestion[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1].replace(/\n$/, ''));
}

function priorityOf(body) {
  const match = /\[P([12])(?: Badge)?\]/.exec(typeof body === 'string' ? body : '');
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
function summaryOf(comments, head, codex) {
  const comment = codex && comments.find((c) => selectedOf(c.author, [codex]) && typeof c.body === 'string' && c.body.includes(SUMMARY_MARKER));
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

// Fills `connection.nodes` with every following page. Read once per collection, so a huge review costs extra reads only when it exists.
async function fillPages(connection, query, id, field, graphql) {
  for (let pages = 0; connection.pageInfo && connection.pageInfo.hasNextPage && connection.pageInfo.endCursor; pages += 1) {
    if (pages >= MAX_PAGES) throw new Error(`review-collector: ${field} exceeds ${MAX_PAGES} pages`);
    const page = (await graphql(query, { id, cursor: connection.pageInfo.endCursor })).data.node[field];
    connection.nodes.push(...page.nodes);
    connection.pageInfo = page.pageInfo;
  }
}

// Every review, PR comment and thread comment is paged; a review's own inline comments only for a selected Bot.
async function read(graphql, pr, selection) {
  const response = await graphql(QUERY, { pr });
  const pull = pullRequestOf(response);
  await fillPages(pull.comments, PR_COMMENTS_PAGE_QUERY, pull.id, 'comments', graphql);
  await fillPages(pull.reviews, REVIEWS_PAGE_QUERY, pull.id, 'reviews', graphql);
  await fillPages(pull.reviewThreads, THREADS_PAGE_QUERY, pull.id, 'reviewThreads', graphql);
  await Promise.all(pull.reviewThreads.nodes.map((thread) => fillPages(thread.comments, THREAD_COMMENTS_PAGE_QUERY, thread.id, 'comments', graphql)));
  const bots = botsOf(selection);
  await Promise.all(pull.reviews.nodes.filter((review) => selectedOf(review.author, bots)).map((review) => fillPages(review.comments, COMMENTS_PAGE_QUERY, review.id, 'comments', graphql)));
  const commit = pull.commits.nodes[0] && pull.commits.nodes[0].commit;
  if (commit && commit.statusCheckRollup) await fillPages(commit.statusCheckRollup.contexts, CONTEXTS_PAGE_QUERY, commit.statusCheckRollup.id, 'contexts', graphql);
  return response;
}

// An interrupted reply: a post by the acting account whose first line is the item's hidden marker, so a resumed session settles the claim without posting twice.
async function findReply({ pr, graphql, itemId }) {
  const response = await read(graphql, pr, []);
  const pull = pullRequestOf(response);
  const actorId = response.data.viewer.databaseId;
  const marker = `<!-- concord-lgtm-reply: ${itemId} -->`;
  const comments = [...pull.comments.nodes, ...pull.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes)];
  const hit = comments.find((node) => node.author && node.author.databaseId === actorId && String(node.body).split('\n')[0].trim() === marker);
  return hit ? { found: true, url: hit.url } : { found: false };
}

// Timeline position, rather than timestamps, ties a recovered request to the live head's last commit event.
function requestSettled(timeline, { actorLogin, reviewerId, headSha }) {
  let start = 0;
  timeline.forEach((event, i) => { if (event.event === 'committed' && event.sha === headSha) start = i + 1; });
  return timeline.slice(start).some((event) => event.event === 'review_requested' && event.actor?.login === actorLogin && event.requested_reviewer?.id === reviewerId);
}

function branchRulesSatisfied({ mergeStateStatus, reviewDecision }) {
  return ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(mergeStateStatus) && (reviewDecision === 'APPROVED' || reviewDecision === null);
}

function submittedReviews(pull) {
  return pull.reviews.nodes.filter((review) => !['PENDING', 'DISMISSED'].includes(review.state)).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || Number(a.databaseId) - Number(b.databaseId));
}

function reviewerStatuses(pull, { selection, head }) {
  const reviews = submittedReviews(pull);
  return selection.filter((account) => account.type === 'User').map((account) => {
    const own = reviews.filter((review) => selectedOf(review.author, [account]));
    const decisive = own.filter((review) => ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)).at(-1);
    const review = decisive || own.filter((entry) => entry.state === 'COMMENTED').at(-1);
    const status = account.gone ? 'gone' : decisive ? (decisive.state === 'CHANGES_REQUESTED' ? 'changes-requested' : oidOf(decisive.commit) === head ? 'approved' : 'stale-approval') : review ? 'commented' : 'pending';
    return { login: account.login, id: account.id, type: 'User', status, reviewId: review ? String(review.databaseId) : null, commitId: review ? oidOf(review.commit) : null };
  });
}

function humanReviewOf(pull, { selection, head, human }) {
  const findings = human.observations.flatMap((observation) => observation.findings.map((item) => ({ ...item, group: observation.reviewId })));
  if (selection.length > 0 && !selection.some((account) => account.type === 'User') && !human.hasHumanFeedback) return undefined;
  const decisive = new Map();
  for (const review of submittedReviews(pull)) {
    const author = identityOf(review.author);
    if (author.type === 'User' && ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)) decisive.set(author.id === null ? review.id : author.id, review);
  }
  const changesRequested = [...decisive.values()].filter((review) => review.state === 'CHANGES_REQUESTED').map((review) => {
    const author = identityOf(review.author);
    return { login: author.login, id: author.id, selected: !!selectedOf(review.author, selection), answered: !findings.some((item) => item.group === String(review.databaseId)) };
  });
  return { branchRules: { mergeStateStatus: pull.mergeStateStatus, reviewDecision: pull.reviewDecision }, reviewers: reviewerStatuses(pull, { selection, head }), unanswered: findings.map((item) => item.itemId), changesRequested };
}

// Every unanswered feedback item on the PR, wherever it was made, grouped into one observation per review or conversation comment.
// `mode` 'all' (empty selection) takes every account; 'named' takes every person and leaves the bots to the bot path.
// An item already in `answered` (replied to, claimed, or fixed in a round) is neither a finding nor an author answer.
function humanFeedback(pull, { head, mode, selection, prAuthorId, actorId, answered = new Set() }) {
  const byAnswerer = (node) => { const { id } = identityOf(node.author); return id !== null && (id === prAuthorId || id === actorId); };
  const eligible = ({ id, type }) => id === null || (id !== prAuthorId && id !== actorId && (type !== 'Bot' || mode === 'all'));
  // A review is made when it is submitted; its createdAt is when the pending draft was started.
  const after = (node, revision) => Date.parse(node.submittedAt ?? node.createdAt) >= Date.parse(revision);
  const reviews = pull.reviews.nodes.filter((review) => review.state !== 'PENDING');
  // A review body or conversation comment is answered by a later author comment or review body that links it, as GitHub's "Quote reply" and "Copy link" do.
  const answers = [...pull.comments.nodes, ...reviews].filter(byAnswerer);
  const linkAnswer = (url) => {
    const link = new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
    return (revision) => answers.find((node) => after(node, revision) && link.test(node.body || '')) || null;
  };
  const entries = [];
  let hasHumanFeedback = reviews.some((review) => identityOf(review.author).type === 'User' && eligible(identityOf(review.author)) && ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state));
  const add = (node, { kind, group, review, originalCommitId, answerOf, revision = node.lastEditedAt || node.createdAt }) => {
    const author = identityOf(node.author);
    if (!eligible(author)) return;
    if (author.type === 'User') hasHumanFeedback = true;
    if (answered.has(itemKey(node.id, revision))) return;
    const answer = answerOf(revision);
    const { body, truncated } = limited(node.body);
    const item = { itemId: itemKey(node.id, revision), kind, url: node.url, author, originalCommitId, group, reviewUrl: review.url, reviewCommitId: oidOf(review.commit), submittedAt: review.submittedAt, body, truncated, untrusted: true, answered: answer !== null };
    entries.push({ item, answer, priority: priorityOf(node.body), suggestions: suggestionsOf(body), approved: review.state === 'APPROVED' && oidOf(review.commit) === head });
  };
  for (const review of reviews) {
    if ((review.body || '').trim() !== '') add(review, { kind: 'review-body', group: String(review.databaseId), review, originalCommitId: oidOf(review.commit), answerOf: linkAnswer(review.url) });
  }
  for (const thread of pull.reviewThreads.nodes.filter((t) => !t.isResolved)) {
    const comments = thread.comments.nodes;
    // An inline item is answered by a later comment of the author in the same thread.
    // GraphQL allows a thread comment without a review; it is its own observation, keyed apart from every review and conversation comment.
    comments.forEach((comment, i) => { const review = comment.pullRequestReview; add(comment, { kind: i === 0 ? 'inline' : 'reply', group: review ? String(review.databaseId) : `thread-${comment.databaseId}`, review: review || { url: comment.url, commit: null, submittedAt: comment.createdAt }, originalCommitId: oidOf(comment.originalCommit), answerOf: (revision) => comments.slice(i + 1).find((later) => byAnswerer(later) && after(later, revision)) || null }); });
  }
  // A bot that updates its conversation comment in place makes no new revision.
  for (const comment of pull.comments.nodes) add(comment, { kind: 'comment', group: `comment-${comment.databaseId}`, review: { url: comment.url, commit: null, submittedAt: comment.createdAt }, originalCommitId: null, answerOf: linkAnswer(comment.url), revision: identityOf(comment.author).type === 'Bot' ? comment.createdAt : undefined });
  // A person's approval is the latest review GitHub's review decision reads (a comment-only review does not replace it), and only on the commit it is attached to.
  const latest = new Map();
  const accountKey = (author, group) => `${author.type}:${author.id === null ? group : author.id}`;
  for (const review of submittedReviews(pull)) if (['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)) latest.set(accountKey(identityOf(review.author), String(review.databaseId)), String(review.databaseId));
  const observationOf = (author, { reviewUrl, reviewCommitId, submittedAt }, group, approved) => ({ reviewId: group, reviewer: author.login, reviewerId: author.id, reviewerType: author.type, reviewUrl, commitId: head, reviewCommitId, submittedAt, state: 'completed', lgtm: approved && (author.type === 'User' || mode === 'all') && latest.get(accountKey(author, group)) === group, findings: [] });
  const groups = new Map();
  for (const { item, priority, suggestions, approved } of entries.filter((e) => !e.item.answered)) {
    if (!groups.has(item.group)) groups.set(item.group, observationOf(item.author, item, item.group, approved));
    groups.get(item.group).findings.push({ url: item.url, priority, signals: [], itemId: item.itemId, kind: item.kind, author: item.author, originalCommitId: item.originalCommitId, body: item.body, truncated: item.truncated, suggestions, untrusted: true });
  }
  // Empty mode records every clean approval, but none is awaited.
  const people = selection.filter((account) => account.type === 'User');
  for (const review of reviews) {
    const group = String(review.databaseId);
    if (groups.has(group) || (mode === 'all' ? !eligible(identityOf(review.author)) : !selectedOf(review.author, people))) continue;
    const observation = observationOf(identityOf(review.author), { reviewUrl: review.url, reviewCommitId: oidOf(review.commit), submittedAt: review.submittedAt }, group, review.state === 'APPROVED' && oidOf(review.commit) === head);
    if (observation.lgtm) groups.set(group, observation);
  }
  return {
    observations: [...groups.values()],
    hasHumanFeedback,
    authorAnswered: entries.filter((e) => e.item.answered).map(({ item, answer }) => ({ itemId: item.itemId, url: item.url, answerUrl: answer.url, kind: item.kind, author: item.author, originalCommitId: item.originalCommitId })),
  };
}

// A review belongs to the head when its own commit is the head or when any of
// its inline comments was made on the head (originalCommit): GitHub moves a
// comment's current commit to every later head, so `commit` says nothing about
// where the finding was made.
// The bot path observes the selected Bots; the human result from the same read is carried beside it to `complete`, so the watch's activity and fingerprint stay bot-only.
function analyze(response, head, selection, answered = new Set()) {
  const pr = pullRequestOf(response);
  const live = pr.headRefOid.toLowerCase();
  if (live !== head) return { stale: true, head, liveHead: live };
  const bots = botsOf(selection);
  const codex = codexOf(selection);
  const summary = summaryOf(pr.comments.nodes, head, codex);
  const resolved = new Set(pr.reviewThreads.nodes.filter((t) => t.isResolved).flatMap((t) => t.comments.nodes.map((c) => c.id)));
  const observations = [];
  const observed = new Set();
  for (const review of pr.reviews.nodes) {
    const account = selectedOf(review.author, bots);
    if (!account || review.state === 'PENDING') continue;
    const inline = review.comments.nodes;
    const reviewCommit = review.commit ? review.commit.oid.toLowerCase() : null; // null once a force-push drops the commit
    const madeOnHead = (c) => c.originalCommit && c.originalCommit.oid.toLowerCase() === head;
    if (reviewCommit !== head && !inline.some(madeOnHead)) continue;
    // Only comments made on this head count (a reply keeps its thread's older original commit), and a comment in a resolved thread is no longer a finding.
    const own = inline.filter((c) => (c.originalCommit ? madeOnHead(c) : reviewCommit === head) && !resolved.has(c.id));
    observed.add(account);
    observations.push({ reviewId: String(review.databaseId), reviewer: account.login, reviewUrl: review.url, commitId: head, reviewCommitId: reviewCommit, submittedAt: review.submittedAt, state: 'completed', lgtm: review.state === 'APPROVED', findings: own.map(finding), ...limited(review.body), untrusted: true });
  }
  // A gone (deleted) account can no longer answer, so it is never pending.
  const pending = bots.filter((account) => !account.gone && (account === codex && summary ? summary.status !== 'completed' : !observed.has(account))).map((account) => account.login);
  const activity = observations.length > 0 || summary !== null;
  const human = humanFeedback(pr, { head, mode: selection.length > 0 ? 'named' : 'all', selection, prAuthorId: identityOf(pr.author).id, actorId: response.data.viewer.databaseId, answered });
  const humanReview = humanReviewOf(pr, { selection, head, human });
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
      comments: pr.comments.nodes.map((c) => [c, selectedOf(c.author, bots)]).filter(([c, account]) => account && !(c.body || '').includes(SUMMARY_MARKER)).map(([c, account]) => ({ url: c.url, author: account.login, ...limited(c.body), untrusted: true })),
      checks: checksOf(pr, head),
    },
    activity,
    summaryId: summary && summary.id,
    human,
    ...(humanReview === undefined ? {} : { humanReview }),
  };
}

// The reaction list is read once, when the Codex summary has turned Completed
// for this head; GitHub sends no event for a reaction, so this is the only way
// to see the clean-result thumbs-up.
async function botPacket(analysis, { pr, graphql, selection }) {
  const { untrusted, ...rest } = analysis.model;
  const packet = { untrusted, pr: Number(pr), ...rest, awaitingReaction: false };
  const summary = packet.summary;
  if (!summary || summary.status !== 'completed' || !summary.completedAt) return packet;
  const reactions = pullRequestOf(await graphql(REACTIONS_QUERY, { pr }));
  // The head may have moved while the reaction was read: a packet for a head that is no longer live is stale.
  const live = reactions.headRefOid.toLowerCase();
  if (live !== packet.head) return { stale: true, head: packet.head, liveHead: live };
  // Reaction.user is typed User, so a bot's reaction is read through the Reactor union, where the account type is visible: only the selected Codex Bot's id counts.
  // A summary exists only when the Codex account is selected.
  const codex = codexOf(selection);
  const nodes = (reactions.reactionGroups || [])
    .filter((group) => group.content === 'THUMBS_UP')
    .flatMap((group) => group.reactors.edges)
    .filter((edge) => selectedOf(edge.node, [codex]))
    .map((edge) => ({ content: 'THUMBS_UP', createdAt: edge.reactedAt }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (nodes.length > 0) {
    const node = nodes[0];
    packet.reaction = { reviewer: codex.login, content: node.content, createdAt: node.createdAt, fresh: wholeSeconds(node.createdAt) >= wholeSeconds(summary.completedAt) };
  }
  // A clean Codex review (no findings) is green once a fresh thumbs-up at least as new as the review itself arrives. Codex posts no thumbs-up when any review of the batch has findings, so the packet waits for it only when the whole batch is clean.
  const batchClean = packet.observations.every((o) => o.findings.length === 0);
  for (const observation of packet.observations) {
    if (observation.reviewer !== CODEX_REVIEWER || observation.findings.length > 0 || observation.lgtm) continue;
    observation.lgtm = !!(packet.reaction && packet.reaction.fresh && (!observation.submittedAt || wholeSeconds(packet.reaction.createdAt) >= wholeSeconds(observation.submittedAt)));
    if (!observation.lgtm && batchClean) packet.awaitingReaction = true;
  }
  if (!packet.observations.some((o) => o.reviewer === CODEX_REVIEWER)) {
    packet.observations.push({ reviewId: String(analysis.summaryId), reviewer: CODEX_REVIEWER, reviewUrl: summary.url, commitId: packet.head, reviewCommitId: packet.head, state: 'completed', lgtm: !!(packet.reaction && packet.reaction.fresh), findings: [] });
    packet.awaitingReaction = !(packet.reaction && packet.reaction.fresh);
  }
  return packet;
}

// Human observations follow the bot ones and come after the Codex reaction logic, so they never hold a clean bot batch waiting for its reaction.
async function complete(analysis, options) {
  const packet = await botPacket(analysis, options);
  if (packet.stale) return packet;
  return { ...packet, observations: [...packet.observations, ...analysis.human.observations], authorAnswered: analysis.human.authorAnswered, ...(analysis.humanReview === undefined ? {} : { humanReview: analysis.humanReview }) };
}

async function collect({ pr, head, graphql, selection = [], answered = new Set() }) {
  const normalized = String(head).toLowerCase();
  const analysis = analyze(await read(graphql, pr, selection), normalized, selection, answered);
  if (analysis.stale) return { stale: true, head: analysis.head, liveHead: analysis.liveHead };
  return complete(analysis, { pr, graphql, selection });
}

// `--reviewer <login>` (repeatable) names the reviewers to select; every one must be terminal. None named is an empty list.
function reviewersFrom(args) {
  const reviewers = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--reviewer') continue;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('review-collector: --reviewer needs a reviewer login');
    reviewers.push(args[i + 1]);
    i += 1;
  }
  return reviewers;
}

function formatPacketLine(packet) { return JSON.stringify(packet); }

// Shell-level polling: the model is not involved between lines. One packet
// line per terminal head; the loop ends on a recorded delivery or the deadline.
async function watch({ pr, graphql, state, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = DEFAULT_INTERVAL_MS, write, selection = [] }) {
  if (intervalMs < MIN_INTERVAL_MS) throw new Error(`review-collector: the watch interval must be at least ${MIN_INTERVAL_MS} ms`);
  const printed = new Map(); // head -> the reviews its last packet covered
  const awaitingReaction = new Map(); // head -> a clean result still waits for its reaction
  const windowed = new Set();
  const named = selection.length > 0; // an empty selection observes every account: no reviewer is awaited, so the window runs from the first poll of a head
  const since = new Map();
  for (;;) {
    const response = await read(graphql, pr, selection);
    const head = pullRequestOf(response).headRefOid.toLowerCase();
    if (!since.has(head)) since.set(head, now());
    const analysis = analyze(response, head, selection, state.answered ? state.answered(head) : new Set()); // replies are recorded while the watch runs
    if ((analysis.activity || !named) && !windowed.has(head)) { state.openWindow(head); windowed.add(head); }
    const status = state.status(head);
    if (status.delivery && status.delivery.current === true) { write(JSON.stringify({ event: 'delivery', pr: Number(pr), head, classification: status.delivery.classification })); return 'delivery'; }
    // The deadline bounds the wait for a first packet; once one was printed the watch runs on to catch later reviews until a delivery is recorded.
    const expired = now() >= (status.deadlineMs ?? since.get(head) + WINDOW_SECONDS * 1000);
    // With nothing awaited the window's end is the packet: whatever was observed by then is the batch.
    if (!named && !printed.has(head) && expired) {
      const packet = await complete(analysis, { pr, graphql, selection });
      if (!packet.stale) { printed.set(head, true); write(formatPacketLine({ event: 'packet', ...packet, pending: [], terminal: true })); }
    } else if (named && !printed.has(head) && expired) { write(JSON.stringify({ event: 'deadline', pr: Number(pr), head, pending: analysis.model.pending, awaitingReaction: awaitingReaction.get(head) === true })); return 'deadline'; }
    // The summary joins the fingerprint: it can appear after the review, and a second clean result only moves its completion time.
    const summary = analysis.model.summary;
    const covered = `${analysis.model.observations.map((o) => o.reviewId).join(',')}|${summary ? `${summary.status}@${summary.completedAt}` : ''}`;
    if (named && analysis.model.terminal && printed.get(head) !== covered) {
      // A clean Codex result is final only with its reaction, which arrives after the summary: keep reading until it does or the deadline passes.
      const packet = await complete(analysis, { pr, graphql, selection });
      if (!packet.stale) {
        awaitingReaction.set(head, packet.awaitingReaction);
        if (!packet.awaitingReaction) { printed.set(head, covered); write(formatPacketLine({ event: 'packet', ...packet })); }
      }
    }
    await sleep(intervalMs);
  }
}

function ghGraphql(cwd = process.cwd()) {
  const gh = crossPlatformCommand('gh', cwd);
  return async (query, variables) => JSON.parse(execFileSync(gh, crossPlatformArgs(['api', 'graphql', ...(variables.pr === undefined ? [] : ['-F', 'owner={owner}', '-F', 'name={repo}', '-F', `pr=${variables.pr}`]), ...['id', 'cursor'].filter((key) => variables[key] !== undefined).flatMap((key) => ['-f', `${key}=${variables[key]}`]), '-f', `query=${query}`], needsDoubleEscape('gh', cwd)), crossPlatformOpts({ cwd, encoding: 'utf8', maxBuffer: 64 << 20 })));
}

module.exports = { QUERY, REVIEWS_PAGE_QUERY, PR_COMMENTS_PAGE_QUERY, THREADS_PAGE_QUERY, THREAD_COMMENTS_PAGE_QUERY, REACTIONS_QUERY, identityOf, reviewersFrom, MAX_BODY_CHARS, WINDOW_SECONDS, collect, watch, analyze, complete, formatPacketLine, ghGraphql, findReply, requestSettled, branchRulesSatisfied, reviewerStatuses };
