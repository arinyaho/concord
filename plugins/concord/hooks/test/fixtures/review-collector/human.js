'use strict';
// GraphQL responses in the shape of pr244-head-899a357.json, for the human-reviewer cases.
const HEAD = 'a'.repeat(40), H1 = 'b'.repeat(40);
const URL = 'https://github.com/o/r/pull/7';
const AUTHOR = { __typename: 'User', login: 'author', databaseId: 1 };
const ALICE = { __typename: 'User', login: 'alice', databaseId: 101 };
const BOB = { __typename: 'User', login: 'bob', databaseId: 202 };
const CODEX = { __typename: 'Bot', login: 'chatgpt-codex-connector', databaseId: 900 };
const STATUS_BOT = { __typename: 'Bot', login: 'vercel', databaseId: 901 };
const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
function review(id, author, { state = 'COMMENTED', body = '', commit = HEAD, at = '2026-11-01T00:00:00Z', edited = null } = {}) {
  return { id: `PRR_${id}`, databaseId: id, url: `${URL}#pullrequestreview-${id}`, state, body, submittedAt: at, createdAt: at, lastEditedAt: edited, author, commit: commit && { oid: commit }, comments: page([]) };
}
function inline(id, author, reviewId, { body = 'rename x', original = HEAD, at = '2026-11-01T00:00:01Z', edited = null, reviewState = 'COMMENTED' } = {}) {
  return { id: `PRRC_${id}`, databaseId: id, url: `${URL}#discussion_r${id}`, body, path: 'a.js', line: 1, commit: { oid: HEAD }, originalCommit: original && { oid: original }, createdAt: at, lastEditedAt: edited, author, pullRequestReview: { databaseId: reviewId, url: `${URL}#pullrequestreview-${reviewId}`, state: reviewState, submittedAt: at, commit: { oid: original } } };
}
const thread = (comments, isResolved = false) => ({ id: `PRRT_${comments[0].databaseId}`, isResolved, comments: page(comments) });
function prComment(id, author, { body = 'please explain', at = '2026-11-01T00:00:02Z', edited = null } = {}) {
  return { id: `IC_${id}`, databaseId: id, url: `${URL}#issuecomment-${id}`, body, createdAt: at, lastEditedAt: edited, author };
}
function response({ reviews = [], threads = [], comments = [], head = HEAD, isDraft = false, state = 'OPEN', mergeStateStatus = 'BLOCKED', reviewDecision = 'REVIEW_REQUIRED' } = {}) {
  return { data: { viewer: { login: 'author', databaseId: 1 }, repository: { pullRequest: { id: 'PR_7', headRefOid: head, isDraft, state, author: AUTHOR, mergeStateStatus, reviewDecision, reviews: page(reviews), reviewThreads: page(threads), comments: page(comments), commits: { nodes: [] } } } } };
}
// The selection as `reviewerSelection` returns it: the accounts, by login, id and GitHub type.
const selection = (...accounts) => accounts.map((a) => ({ login: a.login, id: a.databaseId, type: a.__typename }));
const graphqlOf = (data) => async () => (typeof data === 'function' ? data() : data);
module.exports = { HEAD, H1, URL, AUTHOR, ALICE, BOB, CODEX, STATUS_BOT, review, inline, thread, prComment, response, selection, graphqlOf };
