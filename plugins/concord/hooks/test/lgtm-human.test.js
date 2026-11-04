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

test('delivery reviewIds accept comment-<n>', () => {
  const packet = { baseSha: 'a'.repeat(40), contractDigest: 'a'.repeat(64), reviewIds: ['comment-70'], acceptance: [], requiredChecks: [], reviewsTerminal: true, openChoices: [], findings: [], droppedMinors: [], tickets: [] };
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

test('the answered set also reads the itemIds of a fix-round claim of any head', () => {
  const stateDir = temp();
  fs.writeFileSync(path.join(stateDir, `pr-${PR}-${'d'.repeat(40)}.fix-round-claim.json`), JSON.stringify({ pr: PR, headSha: 'd'.repeat(40), itemIds: [ITEM] }));
  assert.ok(lgtmState.answeredItemIds({ stateDir, pr: PR }).has(ITEM));
  assert.deepStrictEqual(lgtmState.claimReply({ stateDir, pr: PR, itemId: ITEM }), { claimed: false, reason: 'answered' });
});

test('a resume of the empty selection answers nothing twice', async () => {
  const stateDir = temp();
  const f = require('./fixtures/review-collector/human');
  const collector = require('../../core/review-collector');
  lgtmState.recordReply({ stateDir, pr: PR, itemId: 'IC_75@2026-11-01T00:00:02Z', record: reply() });
  const packet = await collector.collect({ pr: PR, head: f.HEAD, graphql: f.graphqlOf(f.response({ comments: [f.prComment(75, f.BOB)] })), answered: lgtmState.answeredItemIds({ stateDir, pr: PR }) });
  assert.deepStrictEqual(packet.observations, []);
});
