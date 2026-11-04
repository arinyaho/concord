'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lgtmState = require('../../core/lgtm-state');
const { tempDir } = require('./temp-dir');
const PR = 7;
const ACCOUNTS = { alice: { login: 'alice', id: 101, type: 'User' }, 'copilot-pull-request-reviewer[bot]': { login: 'copilot-pull-request-reviewer[bot]', id: 900, type: 'Bot' }, acme: { login: 'acme', id: 50, type: 'Organization' }, author: { login: 'author', id: 1, type: 'User' } };
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

test('select-reviewers --none returns to observing every account', () => {
  const stateDir = temp();
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() });
  lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, none: true, github: github() });
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers, []);
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
  racing.userByLogin = (login) => { if (!raced) { raced = true; lgtmState.selectReviewers({ stateDir, pr: PR, logins: null, none: true, github: github(), now: 5 }); } return ACCOUNTS[login] || null; };
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: racing }), { selected: false, reason: 'transition-busy' });
  assert.deepStrictEqual(lgtmState.latestSelection({ stateDir, pr: PR }).reviewers, []);
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

test('select-reviewers selects the user when a bare login has no bot form', () => {
  const stateDir = temp();
  assert.deepStrictEqual(lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], github: github() }).selection, [ACCOUNTS.alice]);
});

test('select-reviewers rejects named reviewers together with none', () => {
  const stateDir = temp();
  assert.throws(() => lgtmState.selectReviewers({ stateDir, pr: PR, logins: ['alice'], none: true, github: github() }), /not both/);
  assert.strictEqual(lgtmState.latestSelection({ stateDir, pr: PR }), null);
});
