'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lgtmState = require('../../core/lgtm-state');
const { tempDir } = require('./temp-dir');
const PR = 7;
const ACCOUNTS = { alice: { login: 'alice', id: 101, type: 'User' }, 'copilot-pull-request-reviewer': { login: 'copilot-pull-request-reviewer', id: 899, type: 'Organization' }, 'copilot-pull-request-reviewer[bot]': { login: 'Copilot', id: 900, type: 'Bot' }, acme: { login: 'acme', id: 50, type: 'Organization' }, author: { login: 'author', id: 1, type: 'User' } };
function github(overrides = {}) {
  const accounts = { ...ACCOUNTS, ...overrides };
  return { userByLogin: (l) => accounts[l] || null, userById: (id) => Object.values(accounts).find((a) => a && a.id === id) || null, prAuthorId: () => 1 };
}
const temp = () => tempDir('lgtm-human-');

test('select-reviewers stores login, id and GitHub type for each reviewer', () => {
  const stateDir = temp();
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice', 'copilot-pull-request-reviewer'], github: github(), now: 10 });
  assert.deepStrictEqual(result.selection, [{ login: 'alice', id: 101, type: 'User' }, { login: 'copilot-pull-request-reviewer', id: 900, type: 'Bot' }]);
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers, result.selection);
  // GitHub's REST login for this bot is `Copilot`; the stored slug survives a refresh by id.
  const refreshed = lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: github(), now: 11 });
  assert.strictEqual(refreshed.recorded, false);
  assert.deepStrictEqual(refreshed.selection, result.selection);
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).sequence, 1);
});

test('select-reviewers refuses the PR author and an organization', () => {
  const stateDir = temp();
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['author', 'acme', 'nobody'], github: github() });
  assert.deepStrictEqual(result, { selected: false, reason: 'refused', refused: [{ login: 'author', why: 'pr-author' }, { login: 'acme', why: 'organization' }, { login: 'nobody', why: 'not-found' }] });
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }), null);
});

test('select-reviewers strips one leading @', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['@alice'], github: github() }).selection, [ACCOUNTS.alice]);
});

test('a run that names reviewers replaces the selection and keeps the earlier record', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github(), now: 1 });
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['copilot-pull-request-reviewer'], github: github(), now: 2 });
  const latest = lgtmState.latestSelection({ stateDir, pr: PR });
  assert.strictEqual(latest.sequence, 2);
  assert.deepStrictEqual(latest.reviewers.map((r) => r.id), [900]);
  assert.ok(require('node:fs').existsSync(require('node:path').join(stateDir, `pr-${PR}.reviewers-000001.json`)));
});

test('a repeated identical --reviewer call writes nothing and needs no transition lock', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  require('node:fs').mkdirSync(require('node:path').join(stateDir, `pr-${PR}.transition.lock`));
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() }), { selected: true, recorded: false, selection: [ACCOUNTS.alice], gone: [] });
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).sequence, 1);
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['copilot-pull-request-reviewer'], github: github() }), { selected: false, reason: 'transition-busy' });
});

test('a resume without --reviewer uses the stored selection', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: github() });
  assert.strictEqual(result.recorded, false);
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).sequence, 1);
});

test('a resume with no stored selection writes nothing', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: github() }), { selected: true, recorded: false, selection: [], gone: [] });
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }), null);
});

test('a renamed reviewer is matched by account id and the selection records the new login', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  const renamed = github({ alice: { login: 'mallory', id: 999, type: 'User' }, 'alice-2': { login: 'alice-2', id: 101, type: 'User' } });
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: renamed });
  assert.strictEqual(result.recorded, true);
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers, [{ login: 'alice-2', id: 101, type: 'User' }]);
});

test('a deleted reviewer is gone and stays in the selection', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: github({ alice: null }) });
  assert.deepStrictEqual(result.gone, [101]);
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers, [{ login: 'alice', id: 101, type: 'User', gone: true }]);
});

test('select-reviewers rejects a non-numeric PR number and writes nothing', () => {
  const stateDir = temp();
  for (const pr of ['--reviewer', 'abc', '0', undefined]) assert.throws(() => lgtmState.selectReviewers({ stateDir, pr, logins: null, github: github() }), /PR number must be a positive integer/);
  assert.deepStrictEqual(require('node:fs').readdirSync(stateDir), []);
});

test('select-reviewers answers transition-busy when another selection lands during the lookups', () => {
  const stateDir = temp();
  const racing = github();
  let raced = false;
  racing.userByLogin = (login) => { if (!raced) { raced = true; lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['copilot-pull-request-reviewer'], github: github(), now: 5 }); } return ACCOUNTS[login] || null; };
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: racing }), { selected: false, reason: 'transition-busy' });
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers.map((r) => r.id), [900]);
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).sequence, 1);
});

test('select-reviewers stores one account once however it is named', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice', '@alice'], github: github() }).selection, [ACCOUNTS.alice]);
});

test('ghUsers maps 404 to null for users and throws for a missing PR or other failures', () => {
  const failing = (stderr) => () => { throw Object.assign(new Error('gh failed'), { stderr }); };
  const missing = lgtmState.ghUsers(process.cwd(), failing('gh: Not Found (HTTP 404)'));
  assert.strictEqual(missing.userByLogin('nobody'), null);
  assert.strictEqual(missing.userById(5), null);
  assert.throws(() => missing.prAuthorId(PR), /not found/);
  assert.throws(() => lgtmState.ghUsers(process.cwd(), failing('HTTP 500')).userByLogin('x'), /gh failed/);
  assert.strictEqual(lgtmState.ghUsers(process.cwd(), () => '42\n').prAuthorId(PR), 42);
});

test('select-reviewers selects the bot when its [bot] login is typed', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['copilot-pull-request-reviewer[bot]'], github: github() }).selection, [{ login: 'copilot-pull-request-reviewer', id: 900, type: 'Bot' }]);
});

test('select-reviewers refuses a bare login that names both a person and a bot, and writes nothing', () => {
  const stateDir = temp();
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['twin'], github: github({ twin: { login: 'twin', id: 300, type: 'User' }, 'twin[bot]': { login: 'twin[bot]', id: 301, type: 'Bot' } }) });
  assert.deepStrictEqual(result, { selected: false, reason: 'refused', refused: [{ login: 'twin', why: 'ambiguous' }] });
  assert.deepStrictEqual(require('node:fs').readdirSync(stateDir), []);
});

test('select-reviewers selects the bot of an ambiguous name only when its [bot] login is typed', () => {
  const stateDir = temp();
  const twins = github({ twin: { login: 'twin', id: 300, type: 'User' }, 'twin[bot]': { login: 'twin[bot]', id: 301, type: 'Bot' } });
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['twin[bot]'], github: twins }).selection, [{ login: 'twin', id: 301, type: 'Bot' }]);
});

test('select-reviewers refuses a typed [bot] login that is not a Bot account', () => {
  const stateDir = temp();
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['odd[bot]'], github: github({ 'odd[bot]': { login: 'odd[bot]', id: 302, type: 'User' } }) });
  assert.deepStrictEqual(result, { selected: false, reason: 'refused', refused: [{ login: 'odd[bot]', why: 'not-found' }] });
});

test('select-reviewers selects the bot when its bare login is an organization', () => {
  const stateDir = temp();
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['gh-app'], github: github({ 'gh-app': { login: 'gh-app', id: 400, type: 'Organization' }, 'gh-app[bot]': { login: 'gh-app[bot]', id: 401, type: 'Bot' } }) });
  assert.deepStrictEqual(result.selection, [{ login: 'gh-app', id: 401, type: 'Bot' }]);
});

test('select-reviewers selects the user when a bare login has no bot form', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() }).selection, [ACCOUNTS.alice]);
});

const HEAD = 'c'.repeat(40);
const humanObs = (reviewId, findings = 1, extra = {}) => ({ reviewId, reviewer: 'alice', reviewerId: 101, reviewerType: 'User', reviewUrl: `https://x/${reviewId}`, commitId: HEAD, reviewCommitId: 'd'.repeat(40), submittedAt: '2026-11-01T00:00:00Z', state: 'completed', lgtm: false, findings: Array.from({ length: findings }, (_, i) => ({ url: `https://x/${reviewId}/${i}`, priority: null, signals: [], itemId: `N${reviewId}${i}@2026-11-01T00:00:00Z`, kind: 'comment', author: { login: 'alice', id: 101, type: 'User' }, originalCommitId: null, body: 'secret text' })), ...extra });
const botObs = (reviewId) => ({ reviewId, reviewer: 'chatgpt-codex-connector', reviewUrl: `https://x/${reviewId}`, commitId: HEAD, state: 'completed', lgtm: false, findings: [{ url: `https://x/${reviewId}/f`, priority: 'P2', signals: [] }] });

test('a comment observation records under comment-<id> and keeps provenance without the body', () => {
  const stateDir = temp();
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('comment-70') }).recorded, true);
  const [review] = lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.reviews;
  assert.strictEqual(review.id, 'comment-70');
  assert.deepStrictEqual(Object.keys(review.findings[0]).sort(), ['author', 'itemId', 'kind', 'originalCommitId', 'priority', 'signals', 'url']);
  const record = JSON.parse(require('node:fs').readFileSync(require('node:path').join(stateDir, `pr-${PR}-${HEAD}.comment-70.json`), 'utf8'));
  assert.deepStrictEqual([record.reviewerId, record.reviewerType, record.reviewCommitId, record.submittedAt], [101, 'User', 'd'.repeat(40), '2026-11-01T00:00:00Z']);
});

test('a ghost author and a null review commit are accepted', () => {
  const stateDir = temp();
  const obs = humanObs('comment-72', 1, { reviewCommitId: null });
  obs.findings[0].author = { login: 'ghost', id: null, type: 'User' };
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs }).recorded, true);
});

test('a bot record keeps its exact shape when the human fields are absent', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, now: 5, observation: botObs('900') });
  const record = JSON.parse(require('node:fs').readFileSync(require('node:path').join(stateDir, `pr-${PR}-${HEAD}.review-900.json`), 'utf8'));
  assert.deepStrictEqual(Object.keys(record).sort(), ['findings', 'headSha', 'pr', 'recordedAtMs', 'reviewId', 'reviewUrl', 'reviewer']);
  assert.deepStrictEqual(Object.keys(record.findings[0]).sort(), ['priority', 'signals', 'url']);
});

test('the human records of a head count as one batch in the classification', () => {
  const stateDir = temp();
  for (const id of ['5', 'comment-70', 'comment-71']) lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs(id) });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.classification, 'light-implementation-eligible');
});

test('a bot record plus human feedback counts as two records', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: botObs('900') });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('comment-70') });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.classification, 'requires-architecture-review');
});

test('a malformed comment id fails closed', () => {
  for (const id of ['comment-0', 'comment-', 'comment-x', 'comment-01x']) assert.throws(() => lgtmState.recordReview({ stateDir: temp(), pr: PR, headSha: HEAD, observation: humanObs(id) }), /reviewId/);
});

test('malformed optional human fields fail closed', () => {
  for (const extra of [{ reviewerType: 'Organization' }, { reviewerId: 1.5 }, { reviewCommitId: 'abc' }, { submittedAt: 5 }]) assert.throws(() => lgtmState.recordReview({ stateDir: temp(), pr: PR, headSha: HEAD, observation: humanObs('comment-70', 1, extra) }), /review-lgtm-state/);
  const bad = humanObs('comment-70');
  bad.findings[0].kind = 'tweet';
  assert.throws(() => lgtmState.recordReview({ stateDir: temp(), pr: PR, headSha: HEAD, observation: bad }), /kind/);
});

test('a doubled comment prefix is not a review id', () => {
  assert.throws(() => lgtmState.recordReview({ stateDir: temp(), pr: PR, headSha: HEAD, observation: humanObs('comment-comment-5') }), /reviewId/);
});

test('delivery reviewIds accept comment-<n> and revision records', () => {
  const packet = { baseSha: 'a'.repeat(40), contractDigest: 'a'.repeat(64), reviewIds: ['comment-70', 'comment-70~0123456789abcdef', '5~0123456789abcdef'], acceptance: [], requiredChecks: [], reviewsTerminal: true, openChoices: [], findings: [], droppedMinors: [], tickets: [] };
  assert.doesNotThrow(() => lgtmState.classifyDelivery({ ...packet, pr: PR, headSha: HEAD }));
});

test('select-reviewers --none returns to observing every account', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  const result = lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, none: true, github: github() });
  assert.deepStrictEqual(result, { selected: true, recorded: true, selection: [], gone: [] });
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers, []);
  assert.strictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, none: true, github: github() }).recorded, false);
});

test('a later run without --reviewer keeps the empty record and writes nothing', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, none: true, github: github() });
  const before = require('node:fs').readdirSync(stateDir).sort();
  assert.deepStrictEqual(lgtmState.reviewerSelection({ stateDir, pr: PR, logins: [], github: github() }), { selected: true, recorded: false, selection: [], gone: [] });
  assert.deepStrictEqual(require('node:fs').readdirSync(stateDir).sort(), before);
});

const ITEM = 'IC_75@2026-11-01T00:00:02Z';
const reply = (extra = {}) => ({ kind: 'comment', url: 'https://x/75', author: { login: 'bob', id: 202, type: 'User' }, originalCommitId: null, disposition: 'rejected', reason: 'covered by test a.test.js:12', replyUrl: 'https://x/99', ...extra });

test('two sessions answer one item once', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: ITEM }), { claimed: true });
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: ITEM }), { claimed: false, reason: 'reply-claimed' });
  assert.ok(lgtmState.answeredItemIds({ stateDir, pr: PR }).has(ITEM));
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).claimedReplies, [ITEM]);
});

test('record-reply writes the handled record once and validates each disposition', () => {
  const stateDir = temp();
  const first = lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply(), now: 5 });
  assert.deepStrictEqual([first.recorded, first.feedback.revision, first.feedback.disposition], [true, '2026-11-01T00:00:02Z', 'rejected']);
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply() }).existing, true);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).claimedReplies, []);
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'X@2026-11-01T00:00:00Z', record: reply({ disposition: 'blocker' }) }), /fixCommit/);
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'Y@2026-11-01T00:00:00Z', record: reply({ disposition: 'author-answered', replyUrl: undefined }) }), /answerUrl/);
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: 'Z@2026-11-01T00:00:00Z', record: reply({ disposition: 'no-action', replyUrl: undefined }) }).recorded, true);
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: ITEM }), { claimed: false, reason: 'answered' });
});

test('an edited item is answered again once', () => {
  const stateDir = temp();
  lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply() });
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: 'IC_75@2026-11-03T00:00:00Z' }), { claimed: true });
});

test('the answered set reads the itemIds of the head\'s own slotted round and of a pushed round on any head', () => {
  const stateDir = temp();
  const D = 'd'.repeat(40);
  fs.writeFileSync(path.join(stateDir, `pr-${PR}.fix-round-slot-1.json`), JSON.stringify({ pr: PR, headSha: D, owner: 'o', claimedAtMs: 1 }));
  fs.writeFileSync(path.join(stateDir, `pr-${PR}-${D}.fix-round-claim.json`), JSON.stringify({ pr: PR, headSha: D, itemIds: [ITEM] }));
  assert.deepStrictEqual([D, D.toUpperCase(), H2].map((headSha) => lgtmState.answeredItemIds({ stateDir, pr: PR, headSha }).has(ITEM)), [true, true, false]);
  lgtmState.markFixPushed({ stateDir, pr: PR, headSha: D, fixCommit: H2, owner: 'o' });
  assert.ok(lgtmState.answeredItemIds({ stateDir, pr: PR, headSha: H2 }).has(ITEM));
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: ITEM }), { claimed: true });
});

test('a fixed item\'s reply can be claimed after its fix round', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] }).claimed, true);
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(obs) }), { claimed: true });
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(obs) }), { claimed: false, reason: 'reply-claimed' });
});

test('a resume of the empty selection answers nothing twice', async () => {
  const stateDir = temp();
  const f = require('./fixtures/review-collector/human');
  const collector = require('../../core/review-collector');
  lgtmState.recordReply({ stateDir, pr: PR, itemId: 'IC_75@2026-11-01T00:00:02Z', record: reply() });
  const packet = await collector.collect({ pr: PR, head: f.HEAD, graphql: f.graphqlOf(f.response({ comments: [f.prComment(75, f.BOB)] })), answered: lgtmState.answeredItemIds({ stateDir, pr: PR }) });
  assert.deepStrictEqual(packet.observations, []);
});

const H2 = 'e'.repeat(40);
const itemOf = (obs, i = 0) => obs.findings[i].itemId;
// Spent slots of pushed rounds on earlier heads.
const slots = (stateDir, human, count) => { for (let k = 1; k <= count; k += 1) { const headSha = String(k).repeat(40); fs.writeFileSync(path.join(stateDir, `pr-${PR}.${human ? 'human-' : ''}fix-round-slot-${k}.json`), JSON.stringify({ pr: PR, headSha, owner: 'o', claimedAtMs: k })); lgtmState.markFixPushed({ stateDir, pr: PR, headSha, fixCommit: H2, owner: 'o' }); } };
const mismatch = (expected) => ({ claimed: false, reason: 'item-ids-mismatch', expected });

test('a round with a human item spends the human cap', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  assert.deepStrictEqual([claim.claimed, claim.kind, claim.budget], [true, 'human', { max: 5, spent: 1, remaining: 4 }]);
  const s = lgtmState.status({ stateDir, pr: PR, headSha: HEAD });
  assert.deepStrictEqual([s.fixBudget.spent, s.humanFixBudget.spent], [0, 1]);
});

test('a round with only bot items spends the bot cap even when it lists bot item ids', () => {
  const stateDir = temp();
  const obs = { ...humanObs('comment-73'), reviewer: 'vercel', reviewerId: 901, reviewerType: 'Bot' };
  obs.findings[0].author = { login: 'vercel', id: 901, type: 'Bot' };
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] }).kind, 'bot');
});

test('an item taken by a fix round does not return in the next head\'s batch', async () => {
  const stateDir = temp();
  const f = require('./fixtures/review-collector/human');
  const collector = require('../../core/review-collector');
  const comments = [f.prComment(75, f.BOB)];
  const first = await collector.collect({ pr: PR, head: f.HEAD, graphql: f.graphqlOf(f.response({ comments })), answered: lgtmState.answeredItemIds({ stateDir, pr: PR }) });
  const [obs] = first.observations;
  lgtmState.recordReview({ stateDir, pr: PR, headSha: f.HEAD, observation: obs });
  const { owner } = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: f.HEAD, itemIds: [itemOf(obs)] });
  assert.ok(lgtmState.answeredItemIds({ stateDir, pr: PR, headSha: f.HEAD }).has(itemOf(obs)));
  lgtmState.markFixPushed({ stateDir, pr: PR, headSha: f.HEAD, fixCommit: f.H1, owner });
  const next = await collector.collect({ pr: PR, head: f.H1, graphql: f.graphqlOf(f.response({ head: f.H1, comments })), answered: lgtmState.answeredItemIds({ stateDir, pr: PR, headSha: f.H1 }) });
  assert.deepStrictEqual(next.observations.filter((o) => o.findings.some((x) => x.itemId === itemOf(obs))), []);
});

test('owed replies of a finished round are posted on resume', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const { owner } = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, []);
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2.toUpperCase(), owner, now: 9 }), { marked: true, pushed: { pr: PR, headSha: HEAD, fixCommit: H2, owner, pushedAtMs: 9 } });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, [{ itemId: itemOf(obs), headSha: HEAD, fixCommit: H2 }]);
  lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: { kind: 'comment', url: 'https://x/70', author: obs.findings[0].author, originalCommitId: null, disposition: 'minor', reason: 'renamed', replyUrl: 'https://x/r', fixCommit: H2 } });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, []);
});

test('an owed reply can be claimed and recorded, after which it leaves owedReplies', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const { owner } = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2, owner });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, [{ itemId: itemOf(obs), headSha: HEAD, fixCommit: H2 }]);
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(obs) }), { claimed: true });
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: { kind: 'comment', url: 'https://x/70', author: obs.findings[0].author, originalCommitId: null, disposition: 'blocker', reason: 'fixed', replyUrl: 'https://x/r', fixCommit: H2 } }).recorded, true);
  const s = lgtmState.status({ stateDir, pr: PR, headSha: H2 });
  assert.deepStrictEqual([s.owedReplies, s.claimedReplies], [[], []]);
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(obs) }), { claimed: false, reason: 'answered' });
});

test('an unpushed fix round on an earlier head returns its items to the batch and owes nothing', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.unansweredItemIds, []);
  lgtmState.recordReview({ stateDir, pr: PR, headSha: H2, observation: { ...obs, commitId: H2 } });
  const s = lgtmState.status({ stateDir, pr: PR, headSha: H2 });
  assert.deepStrictEqual([s.reconciliation.unansweredItemIds, s.owedReplies], [[itemOf(obs)], []]);
});

test('a late mark of a round whose items a later round took is refused as superseded', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const early = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)], now: 1 });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: H2, observation: { ...obs, commitId: H2 } });
  const late = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: H2, itemIds: [itemOf(obs)], now: 2 });
  assert.strictEqual(late.claimed, true);
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: 'f'.repeat(40), owner: early.owner, now: 3 }), { marked: false, reason: 'superseded', by: H2 });
  assert.strictEqual(fs.existsSync(lgtmState.markerPath({ stateDir, pr: PR, headSha: HEAD }, 'fix-round-pushed')), false);
  assert.strictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: H2, fixCommit: 'f'.repeat(40), owner: late.owner, now: 4 }).marked, true);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, [{ itemId: itemOf(obs), headSha: H2, fixCommit: 'f'.repeat(40) }]);
});

test('of two rounds claimed at the same time on different heads, only the one on the later head can be marked pushed', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const first = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)], now: 1 });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: H2, observation: { ...obs, commitId: H2 } });
  const second = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: H2, itemIds: [itemOf(obs)], now: 1 });
  assert.strictEqual(second.claimed, true);
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: 'f'.repeat(40), owner: first.owner, now: 2 }), { marked: false, reason: 'superseded', by: H2 });
  assert.strictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: H2, fixCommit: 'f'.repeat(40), owner: second.owner, now: 2 }).marked, true);
  assert.strictEqual(fs.existsSync(lgtmState.markerPath({ stateDir, pr: PR, headSha: HEAD }, 'fix-round-pushed')), false);
});

test('a pushed fix round owes its replies with the fix commit and keeps its items out of the next batch', () => {
  const stateDir = temp();
  const { execFileSync } = require('node:child_process');
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const { owner } = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  const marked = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), 'mark-fix-pushed', String(PR), HEAD, H2, owner], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir } }));
  assert.deepStrictEqual([marked.marked, marked.pushed.fixCommit, marked.pushed.owner], [true, H2, owner]);
  assert.strictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2, owner }).existing, true);
  lgtmState.recordReview({ stateDir, pr: PR, headSha: H2, observation: { ...obs, commitId: H2 } });
  const s = lgtmState.status({ stateDir, pr: PR, headSha: H2 });
  assert.deepStrictEqual([s.reconciliation.unansweredItemIds, s.owedReplies], [[], [{ itemId: itemOf(obs), headSha: HEAD, fixCommit: H2 }]]);
});

test('mark-fix-pushed refuses a non-owner and a malformed fix commit and writes no marker', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, owner: 'w', itemIds: [itemOf(obs)] });
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2, owner: 'other' }), { marked: false, reason: 'owner-mismatch' });
  for (const fixCommit of ['e'.repeat(39), undefined]) assert.throws(() => lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit, owner: 'w' }), /fixCommit is a full commit SHA/);
  assert.throws(() => lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2 }), /requires its claim owner/);
  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((name) => name.includes('fix-round-pushed')), []);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, []);
});

test('a repeated mark-fix-pushed keeps the recorded commit and refuses a different one', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, owner: 'w', itemIds: [itemOf(obs)] });
  const first = lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2, owner: 'w', now: 1 });
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: H2, owner: 'w', now: 2 }), { ...first, existing: true });
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: HEAD, fixCommit: 'f'.repeat(40), owner: 'w', now: 3 }), { marked: false, reason: 'fix-commit-conflict', fixCommit: H2 });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, [{ itemId: itemOf(obs), headSha: HEAD, fixCommit: H2 }]);
});

test('an unpushed round on an earlier head does not block a claim on the next head', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, owner: 'w', itemIds: [itemOf(obs)] });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: H2, observation: { ...obs, commitId: H2 } });
  const s = lgtmState.status({ stateDir, pr: PR, headSha: H2 });
  assert.deepStrictEqual([s.unpushedRounds, s.reconciliation.unansweredItemIds], [[{ headSha: HEAD, owner: 'w' }], [itemOf(obs)]]);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).unpushedRounds, []);
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: H2, owner: 'v', itemIds: [itemOf(obs)] }).claimed, true);
});

test('status and claim agree while an earlier round is unpushed', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, owner: 'w', itemIds: [itemOf(obs)] });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: H2, observation: { ...humanObs('comment-71'), commitId: H2 } });
  const { reconciliation } = lgtmState.status({ stateDir, pr: PR, headSha: H2 });
  assert.deepStrictEqual([reconciliation.action, reconciliation.humanRequired], ['verify-and-fix', false]);
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: H2, owner: 'v', itemIds: reconciliation.unansweredItemIds }).claimed, true);
});

test('an exhausted human cap stops for reconciliation', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4', '5', '6'].map((c) => c.repeat(40));
  heads.forEach((head, i) => {
    const obs = { ...humanObs(`comment-${80 + i}`), commitId: head };
    lgtmState.recordReview({ stateDir, pr: PR, headSha: head, observation: obs });
    const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: head, itemIds: [itemOf(obs)] });
    if (claim.claimed) lgtmState.markFixPushed({ stateDir, pr: PR, headSha: head, fixCommit: H2, owner: claim.owner });
    if (i < 5) assert.strictEqual(claim.claimed, true);
    else assert.deepStrictEqual([claim.claimed, claim.reason], [false, 'human-fix-round-budget-exhausted']);
  });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: heads[5] }).reconciliation.action, 'human-reconciliation');
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: heads[5] }).fixBudget.spent, 0);
});

test('a human waiver raises only the human cap', () => {
  const stateDir = temp();
  const first = lgtmState.waiveFixBudget({ stateDir, pr: PR, person: 'maintainer', count: 2, human: true });
  assert.deepStrictEqual(first.budget, { max: 7, spent: 0, remaining: 7 });
  assert.strictEqual(lgtmState.waiveFixBudget({ stateDir, pr: PR, person: 'maintainer', count: 2, human: true }).existing, true);
  const s = lgtmState.status({ stateDir, pr: PR, headSha: HEAD });
  assert.deepStrictEqual([s.fixBudget.max, s.humanFixBudget.max, s.waivers, s.humanWaivers.map((w) => w.count)], [3, 7, [], [2]]);
  // The same person and count for the bot cap is a separate waiver.
  assert.strictEqual(lgtmState.waiveFixBudget({ stateDir, pr: PR, person: 'maintainer', count: 2 }).existing, undefined);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).fixBudget.max, 5);
});

test('claim-fix-round refuses item ids outside the head\'s active findings', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: ['other@2026-11-01T00:00:00Z'] }), mismatch([itemOf(obs)]));
  assert.ok(!fs.existsSync(path.join(stateDir, `pr-${PR}-${HEAD}.fix-round-claim.json`)));
});

test('the CLI reads claim-fix-round item ids from stdin and waive-fix-budget --human', () => {
  const stateDir = temp();
  const { execFileSync } = require('node:child_process');
  const cli = (args, input) => JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir }, input }));
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  assert.deepStrictEqual(cli(['waive-fix-budget', String(PR), 'maintainer', '1', '--human']).budget, { max: 6, spent: 0, remaining: 6 });
  const claim = cli(['claim-fix-round', String(PR), HEAD], JSON.stringify({ itemIds: [itemOf(obs)] }));
  assert.deepStrictEqual([claim.kind, claim.budget], ['human', { max: 6, spent: 1, remaining: 5 }]);
});

test('waive-fix-budget refuses an argument after the count other than --human and writes no waiver', () => {
  const stateDir = temp();
  const { execFileSync } = require('node:child_process');
  for (const extra of [['--humans'], ['--human', 'x'], ['human']]) {
    assert.throws(() => execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), 'waive-fix-budget', String(PR), 'maintainer', '1', ...extra], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir } }), (error) => /waive-fix-budget takes <pr> <person> <n> \[--human\]/.test(error.stderr), extra.join(' '));
  }
  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((name) => name.includes('fix-waiver')), []);
});

const edited = (reviewId, revision) => { const obs = humanObs(reviewId); obs.findings[0].itemId = `N${reviewId}0@${revision}`; return obs; };

test('an edited item on the same head is recorded as a revision and can be claimed by a fix round', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('comment-70') });
  const later = edited('comment-70', '2026-11-02T00:00:00Z');
  assert.deepStrictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: later }), { outcome: 'needs-reconciliation', recorded: true, duplicate: false });
  const hex = require('node:crypto').createHash('sha256').update(itemOf(later)).digest('hex').slice(0, 16);
  assert.ok(fs.existsSync(path.join(stateDir, `pr-${PR}-${HEAD}.comment-70~${hex}.json`)));
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.reviews.map((r) => r.id), ['comment-70', `comment-70~${hex}`]);
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(later), itemOf(humanObs('comment-70'))] }), mismatch([itemOf(later)]));
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(later)] }).claimed, true);
});

test('a rejected record does not reject the later revision of its item', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('5') });
  assert.strictEqual(lgtmState.rejectReviewBatch({ stateDir, pr: PR, headSha: HEAD, reviewIds: ['5'], reason: 'not a finding' }).rejected, true);
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('5') }).outcome, 'rejected');
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: edited('5', '2026-11-02T00:00:00Z') }).recorded, true);
  const [review] = lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.reviews;
  assert.match(review.id, /^5~[0-9a-f]{16}$/);
  assert.ok(fs.existsSync(path.join(stateDir, `pr-${PR}-${HEAD}.review-${review.id}.json`)));
  assert.strictEqual(lgtmState.rejectReviewBatch({ stateDir, pr: PR, headSha: HEAD, reviewIds: [review.id], reason: 'not a finding' }).rejected, true);
});

test('a bot record and its revision record on one head classify as one bot record', () => {
  const stateDir = temp();
  const bot = (revision) => { const obs = { ...edited('comment-73', revision), reviewer: 'vercel', reviewerId: 901, reviewerType: 'Bot' }; obs.findings[0].author = { login: 'vercel', id: 901, type: 'Bot' }; return obs; };
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: bot('2026-11-01T00:00:00Z') });
  assert.strictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: bot('2026-11-02T00:00:00Z') }).recorded, true);
  const { reconciliation } = lgtmState.status({ stateDir, pr: PR, headSha: HEAD });
  assert.deepStrictEqual([reconciliation.batchCount, reconciliation.classification], [2, 'light-implementation-eligible']);
});

test('a repeated revision is a duplicate', () => {
  const stateDir = temp();
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('thread-9') });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: edited('thread-9', '2026-11-02T00:00:00Z') });
  assert.deepStrictEqual(lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: edited('thread-9', '2026-11-02T00:00:00Z') }), { outcome: 'needs-reconciliation', recorded: false, duplicate: true });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.reviews.length, 2);
  // A bot record never takes a revision suffix.
  assert.throws(() => lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: botObs('5~0123456789abcdef') }), /reviewId/);
});

test('self-feeding takes the latest earlier fix head across bot and human rounds by claim time', () => {
  const { execFileSync } = require('node:child_process');
  const repo = tempDir('lgtm-human-self-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const commit = (line) => { fs.appendFileSync(path.join(repo, 'a.md'), `${line}\n`); git('add', 'a.md'); git('commit', '-qm', line); return git('rev-parse', 'HEAD'); };
  const first = commit('one');
  const second = commit('two');
  const head = commit('three');
  const stateDir = temp();
  // The bot slot has the higher round number but the human round was claimed later.
  fs.writeFileSync(path.join(stateDir, `pr-${PR}.fix-round-slot-2.json`), JSON.stringify({ pr: PR, headSha: first, owner: 'o', claimedAtMs: 1000 }));
  fs.writeFileSync(path.join(stateDir, `pr-${PR}.human-fix-round-slot-1.json`), JSON.stringify({ pr: PR, headSha: second, owner: 'o', claimedAtMs: 2000 }));
  assert.deepStrictEqual(lgtmState.selfFeeding({ repoRoot: repo, stateDir, pr: PR, headSha: head, file: 'a.md', start: 2, end: 2 }), { selfFeeding: false, previousFixHead: second });
});

test('a claim that lists no item ids on a batch of feedback items is refused and spends no slot', () => {
  const stateDir = temp();
  const heads = ['1', '2', '3', '4', '5', '6'].map((c) => c.repeat(40));
  heads.forEach((head, i) => {
    const obs = { ...humanObs(`comment-${80 + i}`), commitId: head };
    lgtmState.recordReview({ stateDir, pr: PR, headSha: head, observation: obs });
    if (i < 5) lgtmState.markFixPushed({ stateDir, pr: PR, headSha: head, fixCommit: H2, owner: lgtmState.claimFixRound({ stateDir, pr: PR, headSha: head, itemIds: [itemOf(obs)] }).owner });
  });
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: heads[5] }), mismatch(['Ncomment-850@2026-11-01T00:00:00Z']));
  const s = lgtmState.status({ stateDir, pr: PR, headSha: heads[5] });
  assert.deepStrictEqual([s.fixBudget.spent, s.humanFixBudget.spent], [0, 5]);
  assert.ok(!fs.existsSync(path.join(stateDir, `pr-${PR}-${heads[5]}.fix-round-claim.json`)));
});

test('a head whose feedback items are all answered claims a bot round without item ids', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: botObs('900') });
  lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: reply({ url: 'https://x/70', author: obs.findings[0].author }) });
  const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD });
  assert.deepStrictEqual([claim.claimed, claim.kind, claim.budget.spent], [true, 'bot', 1]);
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).humanFixBudget.spent, 0);
});

test('a claim that lists a subset of the head\'s unanswered items is refused with the expected ids and spends no slot', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70', 2);
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] }), mismatch([itemOf(obs), itemOf(obs, 1)].sort()));
  assert.ok(!fs.existsSync(path.join(stateDir, `pr-${PR}-${HEAD}.fix-round-claim.json`)));
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs, 1), itemOf(obs), itemOf(obs)] }).kind, 'human');
});

test('a claim that lists a reply-claimed or handled item is refused', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70', 3);
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(obs) });
  lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs, 1), record: reply({ url: 'https://x/70/1', author: obs.findings[1].author }) });
  for (const itemIds of [[itemOf(obs), itemOf(obs, 2)], [itemOf(obs, 1), itemOf(obs, 2)]]) assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds }), mismatch([itemOf(obs, 2)]));
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs, 2)] }).claimed, true);
});

test('status and claim choose the bot cap when the person\'s item is reply-claimed and the human cap is exhausted', () => {
  const stateDir = temp();
  slots(stateDir, true, 5);
  const person = humanObs('comment-70');
  const bot = { ...humanObs('comment-73'), reviewer: 'vercel', reviewerId: 901, reviewerType: 'Bot' };
  bot.findings[0].author = { login: 'vercel', id: 901, type: 'Bot' };
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: person });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: bot });
  lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(person) });
  const reconciliation = lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation;
  assert.deepStrictEqual([reconciliation.action, reconciliation.humanRequired], ['verify-and-fix', false]);
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(person), itemOf(bot)] }), mismatch([itemOf(bot)]));
  const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(bot)] });
  assert.deepStrictEqual([claim.claimed, claim.kind, claim.budget.spent], [true, 'bot', 1]);
});

test('bot items with ids must be listed and spend the bot cap', () => {
  const stateDir = temp();
  const obs = { ...humanObs('comment-73'), reviewer: 'vercel', reviewerId: 901, reviewerType: 'Bot' };
  obs.findings[0].author = { login: 'vercel', id: 901, type: 'Bot' };
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [] }), mismatch([itemOf(obs)]));
  const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  assert.deepStrictEqual([claim.kind, claim.budget.spent, lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).humanFixBudget.spent], ['bot', 1, 0]);
});

test('a fix-round claim with item ids and no reserved slot leaves its items unanswered and owes nothing', () => {
  const stateDir = temp();
  fs.writeFileSync(path.join(stateDir, `pr-${PR}-${'d'.repeat(40)}.fix-round-claim.json`), JSON.stringify({ pr: PR, headSha: 'd'.repeat(40), owner: 'o', itemIds: [ITEM], claimedAtMs: 1 }));
  assert.ok(!lgtmState.answeredItemIds({ stateDir, pr: PR }).has(ITEM));
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, []);
});

test('status lists the exact unanswered item ids a claim takes, without answered items or superseded revisions', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70', 3);
  const bot = { ...humanObs('comment-73'), reviewer: 'vercel', reviewerId: 901, reviewerType: 'Bot' };
  bot.findings[0].author = { login: 'vercel', id: 901, type: 'Bot' };
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: bot });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: { ...humanObs('comment-70'), findings: [{ ...obs.findings[2], itemId: 'Ncomment-702@2026-11-02T00:00:00Z' }] } });
  lgtmState.claimReply({ stateDir, pr: PR, itemId: itemOf(obs) });
  const { unansweredItemIds } = lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation;
  assert.deepStrictEqual(unansweredItemIds, [itemOf(obs, 1), 'Ncomment-702@2026-11-02T00:00:00Z', itemOf(bot)].sort());
  const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: unansweredItemIds });
  assert.deepStrictEqual([claim.claimed, claim.kind], [true, 'human']);
});

test('a resumed owner re-claims its round without listing item ids', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, owner: 'w', itemIds: [itemOf(obs)] });
  assert.deepStrictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, owner: 'w' }), { claimed: true, resumed: true, owner: 'w', round: 1, kind: 'human', budget: { max: 5, spent: 1, remaining: 4 } });
});

test('claim-fix-round stdin that is not an object of item ids fails with a state message', () => {
  const stateDir = temp();
  const { execFileSync } = require('node:child_process');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: humanObs('comment-70') });
  for (const input of ['null', '5', '[]', '{"itemIds":null}', '{"itemIds":[1]}']) {
    assert.throws(() => execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), 'claim-fix-round', String(PR), HEAD], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir }, input }), (error) => /^Error: review-lgtm-state: /m.test(error.stderr) && !/TypeError/.test(error.stderr), input);
  }
});

test('the Approve prompt is sent once per reviewer and head', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  assert.deepStrictEqual(lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId: 101, itemId: ITEM }), { claimed: true });
  assert.deepStrictEqual(lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId: 101, itemId: 'IC_76@2026-11-01T00:00:03Z' }), { claimed: false, reason: 'approve-prompt-sent' });
  assert.deepStrictEqual(lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: H2, reviewerId: 101, itemId: ITEM }), { claimed: true });
});

test('a repeated Approve prompt claim for the same item resumes it', () => {
  const stateDir = temp();
  const { execFileSync } = require('node:child_process');
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  const cli = (item) => JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), 'claim-approve-prompt', String(PR), HEAD, '101', item], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir } }));
  assert.deepStrictEqual(cli(ITEM), { claimed: true });
  assert.deepStrictEqual(cli(ITEM), { claimed: true, resumed: true });
  assert.deepStrictEqual(cli('IC_76@2026-11-01T00:00:03Z'), { claimed: false, reason: 'approve-prompt-sent' });
  assert.throws(() => lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: H2, reviewerId: 101 }), /an item id is <node id>@<revision timestamp>/);
  assert.ok(!fs.existsSync(path.join(stateDir, `pr-${PR}-${H2}.approve-prompt-${lgtmState.accountFileKey(101)}.json`)));
});

test('the Approve prompt needs a positive account id and writes nothing otherwise', () => {
  const stateDir = temp();
  for (const reviewerId of [NaN, 0, -1, 1.5, '101', Number.MAX_SAFE_INTEGER + 1, undefined]) assert.throws(() => lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId }), /^Error: review-lgtm-state: reviewerId must be a positive account id$/, String(reviewerId));
  assert.deepStrictEqual(fs.readdirSync(stateDir), []);
  assert.throws(() => lgtmState.accountFileKey(NaN), /account id/);
  const { execFileSync } = require('node:child_process');
  assert.throws(() => execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), 'claim-approve-prompt', String(PR), HEAD, 'alice'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir } }), (error) => /reviewerId must be a positive account id/.test(error.stderr));
  assert.deepStrictEqual(fs.readdirSync(stateDir), []);
});

test('a claim whose round reserved no slot owes no reply', () => {
  const stateDir = temp();
  const D = 'd'.repeat(40);
  fs.writeFileSync(path.join(stateDir, `pr-${PR}-${D}.fix-round-claim.json`), JSON.stringify({ pr: PR, headSha: D, owner: 'o', itemIds: [ITEM], claimedAtMs: 1 }));
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, []);
  assert.deepStrictEqual(lgtmState.markFixPushed({ stateDir, pr: PR, headSha: D, fixCommit: H2, owner: 'o' }), { marked: false, reason: 'no-fix-round' });
  fs.writeFileSync(path.join(stateDir, `pr-${PR}.human-fix-round-slot-1.json`), JSON.stringify({ pr: PR, headSha: D, owner: 'o', claimedAtMs: 1 }));
  lgtmState.markFixPushed({ stateDir, pr: PR, headSha: D, fixCommit: H2, owner: 'o' });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).owedReplies, [{ itemId: ITEM, headSha: D, fixCommit: H2 }]);
});

test('the Approve prompt goes only to a selected person who is not gone', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId: 101, itemId: ITEM }), { claimed: false, reason: 'not-selected' });
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice', 'copilot-pull-request-reviewer'], github: github() });
  const before = fs.readdirSync(stateDir).sort();
  for (const reviewerId of [900, 202]) assert.deepStrictEqual(lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId, itemId: ITEM }), { claimed: false, reason: 'not-selected' });
  assert.deepStrictEqual(fs.readdirSync(stateDir).sort(), before);
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: github({ alice: null }) });
  assert.deepStrictEqual(lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId: 101, itemId: ITEM }), { claimed: false, reason: 'not-selected' });
});

test('status lists the selected reviewers with their Approve prompt for the head', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reviewers, []);
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice', 'copilot-pull-request-reviewer'], github: github() });
  lgtmState.claimApprovePrompt({ stateDir, pr: PR, headSha: HEAD, reviewerId: 101, itemId: ITEM });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reviewers, [{ ...ACCOUNTS.alice, approvePrompted: true }, { login: 'copilot-pull-request-reviewer', id: 900, type: 'Bot', approvePrompted: false }]);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: H2 }).reviewers.map((r) => r.approvePrompted), [false, false]);
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, github: github({ alice: null }) });
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reviewers[0], { ...ACCOUNTS.alice, gone: true, approvePrompted: true });
});

test('a deleted author\'s item is claimed and recorded', () => {
  const stateDir = temp();
  const ghost = { login: 'ghost', id: null, type: 'User' };
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: ITEM }), { claimed: true });
  assert.deepStrictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply({ author: ghost }) }).feedback.author, ghost);
  assert.deepStrictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).claimedReplies, []);
});

test('a fix commit is a full SHA of either length in any case and is stored lowercased', () => {
  const stateDir = temp();
  for (const [i, sha] of ['A'.repeat(40), 'b'.repeat(64), 'C'.repeat(64)].entries()) assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: `F${i}@2026-11-01T00:00:00Z`, record: reply({ disposition: 'blocker', fixCommit: sha }) }).feedback.fixCommit, sha.toLowerCase());
  for (const sha of ['a'.repeat(39), 'g'.repeat(40), 40]) assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'G@2026-11-01T00:00:00Z', record: reply({ disposition: 'blocker', fixCommit: sha }) }), /fixCommit/);
});

test('a withheld blocker or person\'s minor is recorded without a fix commit, and only when withheld', () => {
  const stateDir = temp();
  const withheld = (disposition, extra = {}) => reply({ disposition, withheld: true, reason: 'held back by a stop rule; goes to the delivery disposition', ...extra });
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W1@2026-11-01T00:00:00Z', record: withheld('blocker') }).feedback.withheld, true);
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W2@2026-11-01T00:00:00Z', record: withheld('minor') }).feedback.withheld, true);
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W3@2026-11-01T00:00:00Z', record: withheld('blocker', { withheld: false }) }), /needs a fixCommit/);
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W4@2026-11-01T00:00:00Z', record: withheld('blocker', { fixCommit: H2 }) }), /takes no fixCommit/);
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W5@2026-11-01T00:00:00Z', record: withheld('blocker', { replyUrl: undefined }) }), /needs a replyUrl/);
  for (const record of [withheld('rejected'), withheld('minor', { author: { login: 'bot', id: 9, type: 'Bot' } }), withheld('blocker', { withheld: 'yes' })]) assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W6@2026-11-01T00:00:00Z', record }), /withheld is a boolean/);
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: 'W7@2026-11-01T00:00:00Z', record: reply({ disposition: 'blocker', withheld: false, fixCommit: H2 }) }).feedback.withheld, undefined);
});

test('reply and answer URLs are non-empty bounded strings', () => {
  const stateDir = temp();
  for (const bad of [1, {}, ['x'], '', '   ', 'x'.repeat(501)]) {
    assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply({ replyUrl: bad }) }), /replyUrl/, JSON.stringify(bad));
    assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply({ disposition: 'author-answered', replyUrl: undefined, answerUrl: bad }) }), /answerUrl/, JSON.stringify(bad));
  }
  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((name) => name.includes('feedback')), []);
});

test('a handled reply url is a bounded string', () => {
  const stateDir = temp();
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply({ url: `https://x/${'y'.repeat(500)}` }) }), /url/);
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: ITEM, record: reply({ url: 'x'.repeat(500) }) }).recorded, true);
});

test('a human minor is fixed in the head\'s round', () => {
  const stateDir = temp();
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  const claim = lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, itemIds: [itemOf(obs)] });
  assert.deepStrictEqual([claim.claimed, claim.kind, claim.budget.spent], [true, 'human', 1]);
  const minor = { kind: 'comment', url: 'https://x/70', author: obs.findings[0].author, originalCommitId: null, disposition: 'minor', reason: 'renamed as asked', replyUrl: 'https://x/r' };
  assert.throws(() => lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: minor }), /needs a fixCommit/);
  assert.strictEqual(lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: { ...minor, fixCommit: H2 } }).feedback.fixCommit, H2);
  const s = lgtmState.status({ stateDir, pr: PR, headSha: H2 });
  assert.deepStrictEqual([s.minors, s.owedReplies, s.humanFixBudget.spent, s.fixBudget.spent], [[], [], 1, 0]);
});


test('the reconciliation picks the cap the claim would spend: an answered human item does not take the human cap', () => {
  const stateDir = temp();
  slots(stateDir, true, 5);
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: botObs('900') });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.requires, 'human decision: human fix-round budget exhausted');
  lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: reply({ url: 'https://x/70', author: obs.findings[0].author }) });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.action, 'verify-and-fix');
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD }).kind, 'bot');
});

test('the reconciliation reports the exhausted bot cap when the human items are answered', () => {
  const stateDir = temp();
  slots(stateDir, false, 3);
  const obs = humanObs('comment-70');
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: obs });
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, observation: botObs('900') });
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).reconciliation.action, 'verify-and-fix');
  lgtmState.recordReply({ stateDir, pr: PR, itemId: itemOf(obs), record: reply({ url: 'https://x/70', author: obs.findings[0].author }) });
  const { reconciliation } = lgtmState.status({ stateDir, pr: PR, headSha: HEAD });
  assert.deepStrictEqual([reconciliation.action, reconciliation.requires], ['human-reconciliation', 'human decision: fix-round budget exhausted']);
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD }).reason, 'fix-round-budget-exhausted');
});

test('the CLI claims and records a reply and requires an item id for the reply verbs', () => {
  const stateDir = temp();
  const { execFileSync } = require('node:child_process');
  const run = (args, input) => execFileSync('node', [path.join(__dirname, '..', 'review-lgtm-state.js'), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir }, input });
  assert.deepStrictEqual(JSON.parse(run(['claim-reply', String(PR), ITEM])), { claimed: true });
  assert.deepStrictEqual(JSON.parse(run(['claim-reply', String(PR), ITEM])), { claimed: false, reason: 'reply-claimed' });
  const recorded = JSON.parse(run(['record-reply', String(PR), ITEM], JSON.stringify(reply())));
  assert.deepStrictEqual([recorded.recorded, recorded.feedback.itemId, recorded.feedback.replyUrl], [true, ITEM, 'https://x/99']);
  assert.deepStrictEqual(JSON.parse(run(['status', String(PR), HEAD])).claimedReplies, []);
  for (const verb of ['claim-reply', 'record-reply', 'find-reply']) {
    for (const args of [[String(PR)], [String(PR), 'not-an-item']]) assert.throws(() => run([verb, ...args], '{}'), (error) => /an item id is <node id>@<revision timestamp>/.test(error.stderr), `${verb} ${args.join(' ')}`);
  }
});
