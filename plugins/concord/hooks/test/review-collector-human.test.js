'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const collector = require('../../core/review-collector');
const f = require('./fixtures/review-collector/human');
const lgtmState = require('../../core/lgtm-state');
const { tempDir } = require('./temp-dir');
const collect = (data, opts = {}) => collector.collect({ pr: 7, head: f.HEAD, graphql: f.graphqlOf(data), ...opts });

test("a selected human's review becomes an observation that keeps identity, URL, commit and items", async () => {
  const data = f.response({ reviews: [f.review(5, f.ALICE)], threads: [f.thread([f.inline(51, f.ALICE, 5)]), f.thread([f.inline(52, f.ALICE, 5)])] });
  const packet = await collect(data, { selection: f.selection(f.ALICE) });
  const [obs] = packet.observations;
  assert.deepStrictEqual({ reviewId: obs.reviewId, reviewer: obs.reviewer, reviewerId: obs.reviewerId, reviewerType: obs.reviewerType, commitId: obs.commitId, reviewCommitId: obs.reviewCommitId }, { reviewId: '5', reviewer: 'alice', reviewerId: 101, reviewerType: 'User', commitId: f.HEAD, reviewCommitId: f.HEAD });
  assert.deepStrictEqual(obs.findings.map((x) => [x.itemId, x.kind, x.author.id, x.originalCommitId, x.priority]), [['PRRC_51@2026-11-01T00:00:01Z', 'inline', 101, f.HEAD, null], ['PRRC_52@2026-11-01T00:00:01Z', 'inline', 101, f.HEAD, null]]);
  assert.deepStrictEqual([obs.findings[0].body, obs.findings[0].untrusted, packet.pending], ['rename x', true, []]);
});

test('a request for changes with only a body is feedback, not completed-without-lgtm', async () => {
  const packet = await collect(f.response({ reviews: [f.review(6, f.ALICE, { state: 'CHANGES_REQUESTED', body: 'needs a test' })] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.lgtm, o.findings.map((x) => x.kind)]), [['6', false, ['review-body']]]);
});

test('an actionable PR comment becomes a comment observation', async () => {
  const packet = await collect(f.response({ comments: [f.prComment(70, f.BOB)] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.reviewer, o.findings[0].kind]), [['comment-70', 'bob', 'comment']]);
});

test('feedback made on an older head is collected on the live head with its original commit', async () => {
  const packet = await collect(f.response({ threads: [f.thread([f.inline(53, f.ALICE, 8, { original: f.H1 })])] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual([packet.observations[0].commitId, packet.observations[0].findings[0].originalCommitId], [f.HEAD, f.H1]);
});

test('a reply in an older thread is feedback on the live head', async () => {
  const data = f.response({ threads: [f.thread([f.inline(54, f.AUTHOR, 8, { original: f.H1 }), f.inline(55, f.ALICE, 9, { original: f.H1, at: '2026-11-02T00:00:00Z' })])] });
  const packet = await collect(data, { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.findings.map((x) => x.kind)]), [['9', ['reply']]]);
});

test('a reply on a later page of a thread is collected', async () => {
  const data = f.response({ threads: [f.thread([f.inline(59, f.AUTHOR, 8)])] });
  data.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo = { hasNextPage: true, endCursor: 'T1' };
  const graphql = async (query) => (/node\(id:/.test(query)
    ? { data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [f.inline(60, f.BOB, 10, { at: '2026-11-02T00:00:00Z' })] } } } }
    : data);
  const packet = await collector.collect({ pr: 7, head: f.HEAD, graphql, selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.findings.map((x) => x.kind)]), [['10', ['reply']]]);
});

test('feedback from an unselected person enters the batch', async () => {
  const packet = await collect(f.response({ reviews: [f.review(10, f.BOB, { body: 'why?' })] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => o.reviewer), ['bob']);
});

test('a humans-only list collects no bot', async () => {
  const data = f.response({ reviews: [f.review(11, f.CODEX, { body: '[P1] bug' })], comments: [f.prComment(71, f.STATUS_BOT, { body: 'Preview ready' })] });
  assert.deepStrictEqual((await collect(data, { selection: f.selection(f.ALICE) })).observations, []);
});

test('a bot outside a named list is ignored', async () => {
  const data = f.response({ comments: [f.prComment(72, f.STATUS_BOT)] });
  const packet = await collect(data, { selection: f.selection(f.ALICE, f.CODEX) });
  assert.ok(!packet.observations.some((o) => o.reviewer === 'vercel'));
  assert.deepStrictEqual(packet.pending, ['chatgpt-codex-connector']);
});

test('with no reviewer named every account is observed', async () => {
  const data = f.response({ reviews: [f.review(12, f.CODEX, { body: '[P2] nit' })], comments: [f.prComment(73, f.STATUS_BOT), f.prComment(74, f.BOB)] });
  const packet = await collect(data);
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.reviewerType]).sort(), [['12', 'Bot'], ['comment-73', 'Bot'], ['comment-74', 'User']]);
  assert.strictEqual(packet.observations.find((o) => o.reviewId === '12').findings[0].priority, 'P2');
  assert.deepStrictEqual(packet.pending, []);
});

test("an author's hand-written answer counts and the skill posts nothing", async () => {
  const data = f.response({ threads: [f.thread([f.inline(56, f.ALICE, 5), f.inline(57, f.AUTHOR, 13, { at: '2026-11-01T00:05:00Z' })])] });
  const packet = await collect(data, { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations, []);
  assert.deepStrictEqual(packet.authorAnswered.map((a) => [a.itemId, a.answerUrl]), [['PRRC_56@2026-11-01T00:00:01Z', `${f.URL}#discussion_r57`]]);
});

test('an author comment that links the item answers it', async () => {
  const data = f.response({ comments: [f.prComment(75, f.BOB), f.prComment(76, f.AUTHOR, { body: `Re ${f.URL}#issuecomment-75: done`, at: '2026-11-01T01:00:00Z' })] });
  assert.deepStrictEqual((await collect(data)).authorAnswered.map((a) => a.itemId), ['IC_75@2026-11-01T00:00:02Z']);
});

test('an author link to a longer comment id does not answer the shorter one', async () => {
  const data = f.response({ comments: [f.prComment(12, f.BOB), f.prComment(77, f.AUTHOR, { body: `see ${f.URL}#issuecomment-123`, at: '2026-11-01T01:00:00Z' })] });
  assert.deepStrictEqual((await collect(data)).observations.map((o) => o.reviewId), ['comment-12']);
});

test('an edited item is a new revision; an edited bot conversation comment is not', async () => {
  const data = f.response({ comments: [f.prComment(78, f.BOB, { edited: '2026-11-03T00:00:00Z' }), f.prComment(79, f.STATUS_BOT, { edited: '2026-11-03T00:00:00Z' })] });
  const items = (await collect(data)).observations.map((o) => o.findings[0].itemId);
  assert.deepStrictEqual(items, ['IC_78@2026-11-03T00:00:00Z', 'IC_79@2026-11-01T00:00:02Z']);
});

test('an author answer made before the item was edited does not answer the new revision', async () => {
  const data = f.response({ comments: [f.prComment(83, f.BOB, { edited: '2026-11-03T00:00:00Z' }), f.prComment(84, f.AUTHOR, { body: `${f.URL}#issuecomment-83 done`, at: '2026-11-01T01:00:00Z' })] });
  const packet = await collect(data);
  assert.deepStrictEqual([packet.observations.map((o) => o.reviewId), packet.authorAnswered], [['comment-83'], []]);
});

test('the PR author and the acting account never produce items', async () => {
  const data = f.response({ comments: [f.prComment(81, f.AUTHOR, { body: '<!-- concord-lgtm-reply: IC_1@x -->\nFixed in abc' })], reviews: [f.review(14, f.AUTHOR, { body: 'self note' })] });
  assert.deepStrictEqual((await collect(data)).observations, []);
});

test('a whitespace-only review body is not an item', async () => {
  assert.deepStrictEqual((await collect(f.response({ reviews: [f.review(15, f.ALICE, { body: '\n  \n' })] }), { selection: f.selection(f.ALICE) })).observations, []);
});

test('feedback from a deleted account is collected as ghost', async () => {
  const packet = await collect(f.response({ comments: [f.prComment(82, null)] }));
  assert.deepStrictEqual(packet.observations[0].findings[0].author, { login: 'ghost', id: null, type: 'User' });
});

test('a comment in a resolved thread is not human feedback', async () => {
  assert.deepStrictEqual((await collect(f.response({ threads: [f.thread([f.inline(58, f.ALICE, 5)], true)] }), { selection: f.selection(f.ALICE) })).observations, []);
});

test('only an Approve review on the live head sets lgtm for a person; a dropped commit approves nothing', async () => {
  const on = await collect(f.response({ reviews: [f.review(16, f.ALICE, { state: 'APPROVED' })] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(on.observations.map((o) => [o.lgtm, o.findings.length]), [[true, 0]]);
  const gone = await collect(f.response({ reviews: [f.review(17, f.ALICE, { state: 'APPROVED', commit: null })] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(gone.observations, []);
});

test('an approval followed by a request for changes is not lgtm', async () => {
  const data = f.response({ reviews: [f.review(18, f.ALICE, { state: 'APPROVED', body: 'ok' }), f.review(19, f.ALICE, { state: 'CHANGES_REQUESTED', body: 'wait', at: '2026-11-02T00:00:00Z' })] });
  const packet = await collect(data, { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.lgtm]), [['18', false], ['19', false]]);
});

test('watch without --reviewer observes every account', async () => {
  let tick = 0;
  const opened = [];
  const lines = [];
  const data = f.response({ reviews: [f.review(20, f.CODEX, { body: '[P2] nit' })], comments: [f.prComment(90, f.BOB)] });
  const exit = await collector.watch({
    pr: 7, graphql: f.graphqlOf(data), intervalMs: 30000,
    state: { openWindow: (head) => opened.push([head, tick]), status: () => ({ deadlineMs: 3 * 30000, delivery: tick >= 4 ? { classification: 'mergeable-clean', current: true } : null }) },
    now: () => tick * 30000, sleep: async () => { tick += 1; }, write: (l) => lines.push(JSON.parse(l)),
  });
  assert.strictEqual(exit, 'delivery');
  assert.deepStrictEqual(opened, [[f.HEAD, 0]]);
  assert.deepStrictEqual(lines.map((l) => l.event), ['packet', 'delivery']);
  assert.deepStrictEqual([lines[0].pending, lines[0].terminal], [[], true]);
  assert.deepStrictEqual(lines[0].observations.map((o) => o.reviewId).sort(), ['20', 'comment-90']);
});

test('the empty selection requests no default bot and does not await its LGTM', async () => {
  assert.strictEqual(collector.DEFAULT_REVIEWERS, undefined);
  assert.deepStrictEqual(collector.reviewersFrom([]), []);
  const packet = await collector.collect({ pr: 7, head: f.HEAD, graphql: f.graphqlOf(f.response()) });
  assert.deepStrictEqual([packet.terminal, packet.pending, packet.summary], [true, [], null]);
});

test('the bot packet lists only bots as pending', async () => {
  const packet = await collector.collect({ pr: 7, head: f.HEAD, graphql: f.graphqlOf(f.response()), selection: f.selection(f.ALICE, f.CODEX) });
  assert.deepStrictEqual(packet.pending, ['chatgpt-codex-connector']);
});

test('a bot LGTM ends nothing in empty mode', async () => {
  const data = f.response({ reviews: [f.review(21, f.CODEX, { state: 'APPROVED' })], comments: [f.prComment(91, f.BOB)] });
  const packet = await collector.collect({ pr: 7, head: f.HEAD, graphql: f.graphqlOf(data) });
  assert.ok(packet.observations.some((o) => o.reviewId === 'comment-91' && o.findings.length === 1));
});

test('an author review body is dated by its submission, not by when its pending draft started', async () => {
  const draft = { ...f.review(90, f.AUTHOR, { body: `${f.URL}#issuecomment-91 done`, at: '2026-11-01T01:00:00Z' }), createdAt: '2026-10-31T00:00:00Z' };
  const packet = await collect(f.response({ reviews: [draft], comments: [f.prComment(91, f.BOB)] }));
  assert.deepStrictEqual(packet.authorAnswered.map((a) => a.itemId), ['IC_91@2026-11-01T00:00:02Z']);
});

test('every collected human observation is recorded with its four kinds', async () => {
  const data = f.response({ reviews: [f.review(5, f.ALICE, { body: 'overall: needs work' })], threads: [f.thread([f.inline(51, f.ALICE, 5), f.inline(52, f.BOB, 9, { at: '2026-11-02T00:00:00Z' })])], comments: [f.prComment(70, f.BOB)] });
  const packet = await collect(data, { selection: f.selection(f.ALICE, f.BOB) });
  const stateDir = tempDir('collector-roundtrip-');
  for (const observation of packet.observations) assert.ok(lgtmState.recordReview({ stateDir, pr: 7, headSha: f.HEAD, observation }));
  const kinds = require('node:fs').readdirSync(stateDir).filter((n) => n.endsWith('.json')).flatMap((n) => { const r = JSON.parse(require('node:fs').readFileSync(require('node:path').join(stateDir, n), 'utf8')); return (r.findings || []).map((x) => x.kind); });
  assert.deepStrictEqual([...new Set(kinds)].sort(), ['comment', 'inline', 'reply', 'review-body']);
});

test('a thread comment without a review is collected and records', async () => {
  const orphan = { ...f.inline(61, f.ALICE, 5), pullRequestReview: null };
  const packet = await collect(f.response({ threads: [f.thread([orphan])] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.reviewCommitId, o.findings.map((x) => x.kind)]), [['thread-61', null, ['inline']]]);
  const stateDir = tempDir('collector-orphan-');
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: 7, headSha: f.HEAD, observation: packet.observations[0] }).recorded, true);
});

test('an author of another account type is collected as a User and records', async () => {
  const mannequin = { __typename: 'Mannequin', login: 'imported' };
  const packet = await collect(f.response({ comments: [f.prComment(73, mannequin)] }), { selection: f.selection(f.ALICE) });
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.reviewerType, o.reviewerId]), [['comment-73', 'User', null]]);
  const stateDir = tempDir('collector-mannequin-');
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: 7, headSha: f.HEAD, observation: packet.observations[0] }).recorded, true);
});

test('items in the answered set are not collected again', async () => {
  const data = f.response({ comments: [f.prComment(75, f.BOB), f.prComment(76, f.BOB), f.prComment(77, f.BOB), f.prComment(78, f.BOB)] });
  const stateDir = tempDir('collector-answered-');
  const at = (n) => `IC_${n}@2026-11-01T00:00:02Z`;
  lgtmState.claimReply({ stateDir, pr: 7, itemId: at(75) });
  lgtmState.recordReply({ stateDir, pr: 7, itemId: at(76), record: { kind: 'comment', url: 'https://x/76', author: { login: 'bob', id: 202, type: 'User' }, originalCommitId: null, disposition: 'no-action', reason: 'nothing to do' } });
  fs.writeFileSync(path.join(stateDir, `pr-7.fix-round-slot-1.json`), JSON.stringify({ pr: 7, headSha: 'd'.repeat(40), owner: 'o', claimedAtMs: 1 }));
  fs.writeFileSync(path.join(stateDir, `pr-7-${'d'.repeat(40)}.fix-round-claim.json`), JSON.stringify({ headSha: 'd'.repeat(40), itemIds: [at(77)] }));
  lgtmState.markFixPushed({ stateDir, pr: 7, headSha: 'd'.repeat(40), fixCommit: f.HEAD, owner: 'o' });
  const packet = await collect(data, { answered: lgtmState.answeredItemIds({ stateDir, pr: 7, headSha: f.HEAD }) });
  assert.deepStrictEqual(packet.observations.flatMap((o) => o.findings.map((x) => x.itemId)), [at(78)]);
  assert.deepStrictEqual(packet.authorAnswered, []);
});

test('the watch reads the answered set for each packet', async () => {
  const answered = new Set();
  const seen = [];
  const lines = [];
  let tick = 0;
  const data = f.response({ comments: [f.prComment(75, f.BOB)] });
  await collector.watch({
    pr: 7, graphql: f.graphqlOf(data), intervalMs: 30000,
    state: { openWindow() {}, answered: () => { seen.push(answered.size); return answered; }, status: () => ({ deadlineMs: 0, delivery: tick >= 2 ? { classification: 'mergeable-clean', current: true } : null }) },
    now: () => tick * 30000, sleep: async () => { tick += 1; answered.add('IC_75@2026-11-01T00:00:02Z'); }, write: (l) => lines.push(JSON.parse(l)),
  });
  assert.deepStrictEqual(seen.slice(0, 2), [0, 1]);
  assert.deepStrictEqual(lines.filter((l) => l.event === 'packet').map((l) => l.observations.length), [1]);
});

test('an interrupted reply is found by its marker and not posted twice', async () => {
  const item = 'IC_75@2026-11-01T00:00:02Z';
  const data = f.response({ comments: [f.prComment(75, f.BOB), f.prComment(76, f.AUTHOR, { body: `<!-- concord-lgtm-reply: ${item} -->\nKept as is: a.js:3`, at: '2026-11-01T01:00:00Z' })] });
  assert.deepStrictEqual(await collector.findReply({ pr: 7, graphql: f.graphqlOf(data), itemId: item }), { found: true, url: `${f.URL}#issuecomment-76` });
});

test('a reply claim with no post on GitHub posts once on resume', async () => {
  const data = f.response({ comments: [f.prComment(77, f.BOB, { body: '<!-- concord-lgtm-reply: IC_75@2026-11-01T00:00:02Z -->' })] });
  assert.deepStrictEqual(await collector.findReply({ pr: 7, graphql: f.graphqlOf(data), itemId: 'IC_75@2026-11-01T00:00:02Z' }), { found: false });
});

test('an interrupted review request is settled from the timeline', () => {
  const req = (login, id) => ({ event: 'review_requested', actor: { login }, requested_reviewer: { id } });
  const opts = { actorLogin: 'author', reviewerId: 101, headSha: f.HEAD };
  assert.strictEqual(collector.requestSettled([{ event: 'committed', sha: f.H1 }, req('author', 101), { event: 'committed', sha: f.HEAD }], opts), false);
  assert.strictEqual(collector.requestSettled([{ event: 'committed', sha: f.HEAD }, req('author', 101)], opts), true);
  assert.strictEqual(collector.requestSettled([{ event: 'committed', sha: f.HEAD }, req('someone', 101)], opts), false);
  assert.strictEqual(collector.requestSettled([{ event: 'committed', sha: f.HEAD }, req('author', 202)], opts), false);
  assert.strictEqual(collector.requestSettled([req('author', 101)], opts), true);
  assert.strictEqual(collector.requestSettled([{ event: 'committed', sha: f.HEAD }, req('author', 101), { event: 'committed', sha: f.HEAD }], opts), false);
  assert.strictEqual(collector.requestSettled([{ event: 'committed', sha: f.HEAD, created_at: 'later' }, { ...req('author', 101), created_at: 'earlier' }], opts), true);
});

const statusOf = async (reviews, sel = f.selection(f.ALICE), opts = {}) => (await collect(f.response({ reviews }), { selection: sel, ...opts })).humanReview;

test('an approval of an earlier head is stale for the new head', async () => {
  assert.deepStrictEqual((await statusOf([f.review(130, f.ALICE, { state: 'APPROVED', commit: f.H1 })])).reviewers,
    [{ login: 'alice', id: 101, type: 'User', status: 'stale-approval', reviewId: '130', commitId: f.H1 }]);
});

test('a review whose commit is gone approves nothing', async () => {
  assert.strictEqual((await statusOf([f.review(131, f.ALICE, { state: 'APPROVED', commit: null })])).reviewers[0].status, 'stale-approval');
});

test('a dismissed approval approves nothing', async () => {
  assert.deepStrictEqual((await statusOf([f.review(132, f.ALICE, { state: 'DISMISSED' })])).reviewers,
    [{ login: 'alice', id: 101, type: 'User', status: 'pending', reviewId: null, commitId: null }]);
});

test('an unselected approval does not stand in for a selected reviewer', async () => {
  assert.deepStrictEqual((await statusOf([f.review(133, f.BOB, { state: 'APPROVED' })])).reviewers.map((r) => [r.login, r.status]), [['alice', 'pending']]);
});

test('reviewer status matches type and id and picks submitted order rather than page order', async () => {
  const renamed = { ...f.ALICE, login: 'new-alice' };
  const sameLogin = { ...f.BOB, login: 'alice' };
  const fakeBot = { ...f.ALICE, __typename: 'Bot' };
  const packet = await statusOf([
    f.review(140, renamed, { state: 'CHANGES_REQUESTED', at: '2026-11-03T00:00:00Z' }),
    f.review(141, f.ALICE, { state: 'APPROVED' }),
    f.review(142, renamed, { state: 'COMMENTED', at: '2026-11-04T00:00:00Z' }),
    f.review(143, sameLogin, { state: 'APPROVED', at: '2026-11-05T00:00:00Z' }),
    f.review(144, fakeBot, { state: 'APPROVED', at: '2026-11-06T00:00:00Z' }),
  ]);
  assert.deepStrictEqual(packet.reviewers, [{ login: 'alice', id: 101, type: 'User', status: 'changes-requested', reviewId: '140', commitId: f.HEAD }]);
  assert.deepStrictEqual(packet.changesRequested, [{ login: 'new-alice', id: 101, selected: true, answered: true }]);
});

test('a selected deleted reviewer is gone and a comment-only reviewer is commented', async () => {
  const reviewers = f.selection(f.ALICE, f.BOB);
  reviewers[0].gone = true;
  assert.deepStrictEqual((await statusOf([f.review(145, f.ALICE, { state: 'APPROVED' }), f.review(146, f.BOB)], reviewers)).reviewers,
    [{ login: 'alice', id: 101, type: 'User', status: 'gone', reviewId: null, commitId: null }, { login: 'bob', id: 202, type: 'User', status: 'commented', reviewId: '146', commitId: f.HEAD }]);
});

test('an unselected request for changes blocks until every item is answered', async () => {
  const reviews = [f.review(134, f.BOB, { state: 'CHANGES_REQUESTED', body: 'add a test' })];
  const open = await statusOf(reviews);
  assert.deepStrictEqual(open.changesRequested, [{ login: 'bob', id: 202, selected: false, answered: false }]);
  assert.deepStrictEqual(open.unanswered, ['PRR_134@2026-11-01T00:00:00Z']);
  const answered = await statusOf(reviews, f.selection(f.ALICE), { answered: new Set(open.unanswered) });
  assert.deepStrictEqual(answered.changesRequested, [{ login: 'bob', id: 202, selected: false, answered: true }]);
  assert.deepStrictEqual(answered.unanswered, []);
});

test('a dismissed request for changes has no decisive status while its items remain feedback', async () => {
  const packet = await statusOf([f.review(147, f.BOB, { state: 'DISMISSED', body: 'still explain' })]);
  assert.deepStrictEqual(packet.changesRequested, []);
  assert.deepStrictEqual(packet.unanswered, ['PRR_147@2026-11-01T00:00:00Z']);
});

test('a reaction is never human approval', async () => {
  assert.strictEqual((await statusOf([])).reviewers[0].status, 'pending');
});

test('branch rules are satisfied only by the listed values', () => {
  assert.match(collector.QUERY, /mergeStateStatus reviewDecision/);
  for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) for (const reviewDecision of ['APPROVED', null]) assert.strictEqual(collector.branchRulesSatisfied({ mergeStateStatus, reviewDecision }), true);
  for (const [mergeStateStatus, reviewDecision] of [['UNKNOWN', 'APPROVED'], ['BLOCKED', 'APPROVED'], ['CLEAN', 'REVIEW_REQUIRED'], ['CLEAN', 'CHANGES_REQUESTED'], ['DIRTY', null], ['CLEAN', undefined]]) assert.strictEqual(collector.branchRulesSatisfied({ mergeStateStatus, reviewDecision }), false);
});

test('a bot-only packet carries no humanReview until human feedback enters it', async () => {
  assert.strictEqual((await collect(f.response(), { selection: f.selection(f.CODEX) })).humanReview, undefined);
  const packet = await collect(f.response({ comments: [f.prComment(148, f.BOB)] }), { selection: f.selection(f.CODEX) });
  assert.deepStrictEqual(packet.humanReview, { branchRules: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, reviewers: [], unanswered: ['IC_148@2026-11-01T00:00:02Z'], changesRequested: [] });
});

test('a clean approval is recorded in the empty-mode packet and ends nothing', async () => {
  for (const account of [f.ALICE, f.CODEX]) {
    const packet = await collect(f.response({ reviews: [f.review(149, account, { state: 'APPROVED' })], comments: [f.prComment(150, f.BOB)] }));
    assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.lgtm, o.findings.map((x) => x.itemId)]), [['comment-150', false, ['IC_150@2026-11-01T00:00:02Z']], ['149', true, []]]);
    assert.deepStrictEqual(packet.humanReview.unanswered, ['IC_150@2026-11-01T00:00:02Z']);
    assert.deepStrictEqual(packet.pending, []);
  }
});

test('a clean approval uses the latest decisive review even when pages are out of order', async () => {
  const packet = await collect(f.response({ reviews: [f.review(152, f.ALICE, { state: 'CHANGES_REQUESTED', at: '2026-11-03T00:00:00Z' }), f.review(151, f.ALICE, { state: 'APPROVED' })] }));
  assert.deepStrictEqual(packet.observations, []);
});

test('answered human feedback keeps branch rules visible in a named-bot packet', async () => {
  const packet = await collect(f.response({ reviews: [f.review(153, f.BOB, { state: 'CHANGES_REQUESTED', body: 'please fix' })] }), { selection: f.selection(f.CODEX), answered: new Set(['PRR_153@2026-11-01T00:00:00Z']) });
  assert.deepStrictEqual(packet.humanReview, { branchRules: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, reviewers: [], unanswered: [], changesRequested: [{ login: 'bob', id: 202, selected: false, answered: true }] });
});

test('an empty-body request for changes keeps branch rules visible in a named-bot packet', async () => {
  const packet = await collect(f.response({ reviews: [f.review(154, f.BOB, { state: 'CHANGES_REQUESTED' })] }), { selection: f.selection(f.CODEX) });
  assert.deepStrictEqual(packet.humanReview, { branchRules: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, reviewers: [], unanswered: [], changesRequested: [{ login: 'bob', id: 202, selected: false, answered: true }] });
});

test('deleted accounts with no identity never supersede each others approvals or changes requests', async () => {
  const packet = await collect(f.response({ reviews: [f.review(155, null, { state: 'APPROVED' }), f.review(156, null, { state: 'CHANGES_REQUESTED', at: '2026-11-02T00:00:00Z' })] }));
  assert.deepStrictEqual(packet.observations.map((o) => [o.reviewId, o.lgtm]), [['155', true]]);
  assert.deepStrictEqual(packet.humanReview.changesRequested, [{ login: 'ghost', id: null, selected: false, answered: true }]);
});
