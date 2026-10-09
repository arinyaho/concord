'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lgtmState = require('../../core/lgtm-state');

const CLI = path.join(__dirname, '..', 'review-lgtm-state.js');
const PR = 172;
const HEAD = 'f9cfe0fec4f559d125a72f7b93a2cd1dd1d3b328';
const BASE = 'a00dc8c9eaee93a7462bb819bd4ac81320b22528';
const NEW_BASE = '611e8cfe3995372f7ca4926142e82728c6369481';
const OTHER_HEAD = '0123456789abcdef0123456789abcdef01234567';
const CONTRACT = 'a'.repeat(64);
const THREAD = (id) => `https://github.com/arinyaho/concord/pull/172#discussion_r${id}`;
const ISSUE = (n) => `https://github.com/arinyaho/concord/issues/${n}`;

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-disposition-')); }
function cli(stateDir, args, input) {
  return JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_LGTM_STATE_DIR: stateDir }, input }));
}

// The #172 shape: findings fixed in earlier rounds plus four current residuals
// that share two root causes and were rolled over to #173 and #174.
function pr172Packet(overrides = {}) {
  return {
    baseSha: BASE,
    contractDigest: CONTRACT,
    reviewIds: [],
    acceptance: [{ id: 'AC1', met: true }, { id: 'AC2', met: true }],
    requiredChecks: [{ name: 'test (ubuntu)', conclusion: 'success' }, { name: 'test (windows)', conclusion: 'success' }],
    reviewsTerminal: true,
    openChoices: [],
    findings: [
      { id: 'r1-normalize-retry', url: THREAD(4100000001), disposition: 'fixed' },
      { id: 'r2-retry-budget', url: THREAD(4100000002), disposition: 'fixed' },
      { id: 'r3-snapshot-hash', url: THREAD(4100000003), disposition: 'fixed' },
      { id: 'c-4192088461', url: THREAD(4192088461), disposition: 'follow-up', rootCause: 'artifact-repair-admission', rationale: 'Admission hardening; the bounded retry outcome and its checks hold without it.' },
      { id: 'c-4192088466', url: THREAD(4192088466), disposition: 'follow-up', rootCause: 'artifact-repair-admission', rationale: 'Snapshot provenance is defense in depth for the same admission path.' },
      { id: 'c-4192088470', url: THREAD(4192088470), disposition: 'follow-up', rootCause: 'artifact-repair-admission', rationale: 'Mixed-defect eligibility widens repair scope beyond the approved outcome.' },
      { id: 'c-4192088475', url: THREAD(4192088475), disposition: 'follow-up', rootCause: 'initiative-identity', rationale: 'Checkpoint identity binding is a separate initiative contract.' },
    ],
    tickets: [
      { rootCause: 'artifact-repair-admission', url: ISSUE(173), readBack: true },
      { rootCause: 'initiative-identity', url: ISSUE(174), readBack: true },
    ],
    ...overrides,
  };
}

function withActiveReview(stateDir) {
  lgtmState.recordReview({ stateDir, pr: PR, headSha: HEAD, now: 1000, observation: {
    reviewId: 4192088400, reviewer: 'chatgpt-codex-connector[bot]', reviewUrl: 'https://github.com/arinyaho/concord/pull/172#pullrequestreview-4192088400',
    commitId: HEAD, state: 'completed', lgtm: false,
    findings: [THREAD(4192088461), THREAD(4192088466), THREAD(4192088470), THREAD(4192088475)].map((url) => ({ url, priority: 'P2', signals: [] })),
  } });
}

test('#172 shape: four residuals map to two root-cause tickets and no further review or fix launches', () => {
  const stateDir = temp();
  withActiveReview(stateDir);
  const before = lgtmState.status({ stateDir, pr: PR, headSha: HEAD });
  const record = cli(stateDir, ['record-delivery', String(PR), HEAD], JSON.stringify(pr172Packet({ reviewIds: ['4192088400'] })));

  assert.strictEqual(record.classification, 'mergeable-with-follow-ups');
  assert.deepStrictEqual(record.reasons, []);
  assert.strictEqual(record.headSha, HEAD);
  assert.strictEqual(record.baseSha, BASE);
  assert.deepStrictEqual(record.groups, [
    { rootCause: 'artifact-repair-admission', ticket: ISSUE(173), findingIds: ['c-4192088461', 'c-4192088466', 'c-4192088470'] },
    { rootCause: 'initiative-identity', ticket: ISSUE(174), findingIds: ['c-4192088475'] },
  ]);
  assert.deepStrictEqual(record.findings.map((f) => [f.id, f.disposition, f.ticket]), [
    ['r1-normalize-retry', 'fixed', null],
    ['r2-retry-budget', 'fixed', null],
    ['r3-snapshot-hash', 'fixed', null],
    ['c-4192088461', 'follow-up', ISSUE(173)],
    ['c-4192088466', 'follow-up', ISSUE(173)],
    ['c-4192088470', 'follow-up', ISSUE(173)],
    ['c-4192088475', 'follow-up', ISSUE(174)],
  ]);
  assert.deepStrictEqual(record.pending, []);

  // Launch non-occurrence: an active finding batch would otherwise allow a fix claim.
  assert.deepStrictEqual(cli(stateDir, ['claim-fix-round', String(PR), HEAD]), { claimed: false, reason: 'delivery-terminal', classification: 'mergeable-with-follow-ups' });
  assert.deepStrictEqual(cli(stateDir, ['claim-initial-request', String(PR), HEAD, 'codex']), { claimed: false, reason: 'delivery-terminal', classification: 'mergeable-with-follow-ups' });
  const after = cli(stateDir, ['status', String(PR), HEAD]);
  assert.deepStrictEqual(after.fixBudget, before.fixBudget);
  assert.deepStrictEqual(after.requestBudget, before.requestBudget);
  assert.strictEqual(after.delivery.classification, 'mergeable-with-follow-ups');
  assert.strictEqual(after.delivery.digest, record.digest);
  assert.strictEqual(after.reconciliation.action, 'report-delivery');
  assert.strictEqual(after.reconciliation.humanRequired, false);
});

test('no residuals is mergeable-clean and an empty follow-up ticket blocks', () => {
  const findings = pr172Packet().findings.filter((f) => f.disposition === 'fixed');
  const clean = lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...pr172Packet({ findings, tickets: [] }) });
  assert.strictEqual(clean.classification, 'mergeable-clean');
  assert.deepStrictEqual(clean.groups, []);
  const empty = lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...pr172Packet({ findings, tickets: [{ rootCause: 'x', url: ISSUE(999), readBack: true }] }) });
  assert.strictEqual(empty.classification, 'blocked');
  assert.deepStrictEqual(empty.reasons, ['ticket-without-findings:x']);
});

test('release blockers stay blocked even with the fix budget exhausted and never become follow-up work', () => {
  const stateDir = temp();
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(stateDir, `pr-${PR}.fix-round-slot-${i + 1}.json`), JSON.stringify({ pr: PR, headSha: OTHER_HEAD, owner: 'o', claimedAtMs: i }));
  const packet = pr172Packet();
  packet.findings[3] = { ...packet.findings[3], releaseBlocking: ['security'] };
  packet.acceptance = [{ id: 'AC1', met: false }, { id: 'AC2', met: true }];
  packet.requiredChecks = [{ name: 'test (ubuntu)', conclusion: 'success' }, { name: 'test (windows)', conclusion: 'pending' }];
  packet.openChoices = ['retry ownership semantics'];
  const record = lgtmState.recordDelivery({ stateDir, pr: PR, headSha: HEAD, now: 5000, packet });
  assert.strictEqual(record.classification, 'blocked');
  assert.deepStrictEqual(record.reasons, ['acceptance-unmet:AC1', 'required-check:test (windows):pending', 'open-choice:retry ownership semantics', 'release-blocker:c-4192088461:security']);
  assert.deepStrictEqual(record.budgets.fix, { max: 3, spent: 3, remaining: 0 });
  for (const disposition of ['accepted', 'blocking']) {
    const p = pr172Packet();
    p.findings[3] = { ...p.findings[3], disposition, acceptedBy: 'arinyaho', releaseBlocking: ['data-integrity'] };
    assert.ok(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...p }).reasons.includes('release-blocker:c-4192088461:data-integrity'));
  }
});

test('without tracker access the residual group is a pending packet, not an invented ticket', () => {
  const record = lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...pr172Packet({ tickets: [{ rootCause: 'initiative-identity', url: ISSUE(174), readBack: true }] }) });
  assert.strictEqual(record.classification, 'blocked');
  assert.deepStrictEqual(record.reasons, ['rollover-pending:artifact-repair-admission']);
  assert.deepStrictEqual(record.pending, [{ rootCause: 'artifact-repair-admission', findingIds: ['c-4192088461', 'c-4192088466', 'c-4192088470'], urls: [THREAD(4192088461), THREAD(4192088466), THREAD(4192088470)], rationales: pr172Packet().findings.slice(3, 6).map((f) => f.rationale) }]);
  assert.deepStrictEqual(record.groups.map((g) => g.ticket), [null, ISSUE(174)]);
});

test('ticket reuse needs a recorded duplicate check and one ticket cannot own unrelated root causes', () => {
  const reused = (duplicateCheck) => pr172Packet({ tickets: [
    { rootCause: 'artifact-repair-admission', url: ISSUE(173), readBack: true, reused: true, duplicateCheck },
    { rootCause: 'initiative-identity', url: ISSUE(174), readBack: true },
  ] });
  assert.deepStrictEqual(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...reused('') }).reasons, ['duplicate-unchecked:artifact-repair-admission']);
  assert.strictEqual(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...reused('#173 carries the same admission outcome and evidence') }).classification, 'mergeable-with-follow-ups');
  const shared = pr172Packet({ tickets: [
    { rootCause: 'artifact-repair-admission', url: ISSUE(173), readBack: true },
    { rootCause: 'initiative-identity', url: ISSUE(173), readBack: true },
  ] });
  assert.deepStrictEqual(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...shared }).reasons, [`ticket-shared:${ISSUE(173)}`]);
  const unread = pr172Packet();
  unread.tickets[1] = { ...unread.tickets[1], readBack: false };
  assert.deepStrictEqual(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...unread }).reasons, ['ticket-unread:initiative-identity']);
  const dup = pr172Packet();
  dup.findings.push({ ...dup.findings[0] });
  assert.throws(() => lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...dup }), /duplicate finding id r1-normalize-retry/);
});

test('unowned findings and follow-ups without a rationale block', () => {
  const p = pr172Packet();
  p.findings[0] = { id: 'r1-normalize-retry', url: THREAD(4100000001) };
  p.findings[6] = { ...p.findings[6], rationale: '' };
  p.findings.push({ id: 'h-accepted', url: THREAD(4100000009), disposition: 'accepted' });
  assert.deepStrictEqual(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...p }).reasons, ['unowned:r1-normalize-retry', 'no-rationale:c-4192088475', 'unowned:h-accepted']);
});

test('reopening an unchanged head reuses the record; drift is recorded as new evidence and re-enables claims', () => {
  const stateDir = temp();
  withActiveReview(stateDir);
  const first = lgtmState.recordDelivery({ stateDir, pr: PR, headSha: HEAD, now: 5000, packet: pr172Packet({ reviewIds: ['4192088400'] }) });
  const again = lgtmState.recordDelivery({ stateDir, pr: PR, headSha: HEAD, now: 9000, packet: pr172Packet({ reviewIds: ['4192088400'] }) });
  assert.deepStrictEqual(again, first);
  assert.strictEqual(fs.readdirSync(stateDir).filter((name) => name.includes('.delivery-')).length, 1);

  // Another head has no record and is unaffected.
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: OTHER_HEAD }).delivery, null);

  const drift = lgtmState.recordDelivery({ stateDir, pr: PR, headSha: HEAD, now: 10000, packet: pr172Packet({ reviewIds: ['4192088400'], baseSha: NEW_BASE, reviewsTerminal: false }) });
  assert.strictEqual(drift.classification, 'blocked');
  assert.deepStrictEqual(drift.reasons, ['reviews-not-terminal']);
  assert.strictEqual(lgtmState.status({ stateDir, pr: PR, headSha: HEAD }).delivery.baseSha, NEW_BASE);
  assert.strictEqual(lgtmState.claimFixRound({ stateDir, pr: PR, headSha: HEAD, now: 11000 }).claimed, true);
});

test('every distribution shares the delivery disposition contract', () => {
  const plugins = path.join(__dirname, '..', '..', '..');
  const read = (file) => fs.readFileSync(path.join(plugins, file), 'utf8');
  for (const pkg of ['concord', 'concord-codex', 'concord-copilot']) {
    const lgtm = read(`${pkg}/skills/review-until-lgtm/SKILL.md`);
    assert.match(lgtm, /record-delivery <pr> <head-sha>/);
    assert.match(lgtm, /`mergeable-clean`, `mergeable-with-follow-ups`, or `blocked`/);
    assert.match(lgtm, /release-blocking finding blocks unless it is `fixed`, whatever the remaining budget/);
    assert.match(lgtm, /`rollover-pending`.*no ticket URL is invented/s);
    assert.match(lgtm, /never report `mergeable-with-follow-ups` as clean or green/);
    assert.doesNotMatch(lgtm, /propose a single follow-up issue/);
    const ticket = read(`${pkg}/skills/ticket-to-pr/SKILL.md`);
    assert.match(ticket, /### Delivery disposition/);
    assert.match(ticket, /never becomes follow-up work/);
    assert.match(read(`${pkg}/skills/initiative-to-prs/references/stages.md`), /`rollover-pending`.*leaves the unit `BLOCKED`/s);
    assert.match(read(`${pkg}/skills/initiative-to-prs/SKILL.md`), /each PR's delivery disposition/);
  }
  for (const file of ['concord/core/review-driver.md', 'concord/commands/review-and-fix.md', 'concord-codex/commands/review-and-fix.md', 'concord-copilot/skills/review-and-fix/references/review-driver.md']) {
    assert.match(read(file), /A `clean` ledger means this loop's own rounds converged; it is not the PR's delivery disposition/, file);
  }
  for (const pkg of ['concord-codex', 'concord-copilot']) {
    assert.strictEqual(read(`${pkg}/engine/lgtm-state.js`), read('concord/core/lgtm-state.js'));
  }
});

test('recovery is refused, ordering follows write sequence, and the digest is canonical', () => {
  const stateDir = temp();
  const input = { stateDir, pr: PR, headSha: HEAD };
  lgtmState.claimInitialRequest({ ...input, provider: 'codex', now: 0 });
  lgtmState.claimInitialRequest({ ...input, provider: 'codex', now: 200000 });
  const first = lgtmState.recordDelivery({ ...input, now: 9000, packet: pr172Packet() });
  assert.deepStrictEqual(lgtmState.recoverInitialRequest({ ...input, provider: 'codex', now: 10 * 60 * 60 * 1000 }), { claimed: false, reason: 'delivery-terminal', classification: 'mergeable-with-follow-ups' });

  // Same evidence with reordered keys, padded text and upper-case SHAs is the same record.
  const reordered = Object.fromEntries(Object.entries(pr172Packet({ baseSha: BASE.toUpperCase(), extra: 'ignored' })).reverse());
  reordered.findings[3] = { ...reordered.findings[3], rootCause: '  artifact-repair-admission ' };
  assert.deepStrictEqual(lgtmState.recordDelivery({ ...input, now: 9500, packet: reordered }), first);

  // A later write with an earlier clock is still the latest record.
  const failed = lgtmState.recordDelivery({ ...input, now: 1, packet: pr172Packet({ requiredChecks: [{ name: 'test (ubuntu)', conclusion: 'failure' }] }) });
  assert.strictEqual(failed.sequence, first.sequence + 1);
  assert.deepStrictEqual(lgtmState.status(input).delivery.reasons, ['required-check:test (ubuntu):failure']);
  const contract = lgtmState.recordDelivery({ ...input, now: 2, packet: pr172Packet({ contractDigest: 'b'.repeat(64), acceptance: [] }) });
  assert.deepStrictEqual(contract.reasons, ['acceptance-missing']);
  assert.strictEqual(lgtmState.status(input).delivery.contractDigest, 'b'.repeat(64));
  // Returning to the original evidence writes a new latest record, not the old one.
  const back = lgtmState.recordDelivery({ ...input, now: 3, packet: pr172Packet() });
  assert.strictEqual(back.sequence, contract.sequence + 1);
  assert.strictEqual(back.digest, first.digest);
});

test('every text field is trimmed, entries are validated, and an open fix round refuses a record', () => {
  const padded = pr172Packet();
  padded.acceptance = padded.acceptance.map((ac) => ({ ...ac, id: ` ${ac.id} ` }));
  padded.requiredChecks = padded.requiredChecks.map((check) => ({ name: ` ${check.name}`, conclusion: 'success ' }));
  padded.findings = padded.findings.map((f) => ({ ...f, id: ` ${f.id}`, url: `${f.url} ` }));
  padded.tickets = padded.tickets.map((t) => ({ ...t, url: ` ${t.url}` }));
  const stateDir = temp();
  const input = { stateDir, pr: PR, headSha: HEAD };
  const first = lgtmState.recordDelivery({ ...input, now: 1, packet: pr172Packet() });
  assert.deepStrictEqual(lgtmState.recordDelivery({ ...input, now: 2, packet: padded }), first);

  const shared = pr172Packet();
  shared.tickets[1] = { ...shared.tickets[1], url: ` ${ISSUE(173)} ` };
  assert.deepStrictEqual(lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...shared }).reasons, [`ticket-shared:${ISSUE(173)}`]);
  const dupId = pr172Packet();
  dupId.findings.push({ ...dupId.findings[0], id: ` ${dupId.findings[0].id} ` });
  assert.throws(() => lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...dupId }), /duplicate finding id r1-normalize-retry/);
  for (const [field, value, pattern] of [['acceptance', [{ met: true }], /acceptance needs id/], ['acceptance', [null], /acceptance needs id/], ['requiredChecks', [{ conclusion: 'success' }], /required check needs name/], ['requiredChecks', [{ name: 'ci' }], /required check ci needs conclusion/], ['openChoices', [''], /openChoices entries/]]) {
    assert.throws(() => lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...pr172Packet({ [field]: value }) }), pattern);
  }

  const open = temp();
  withActiveReview(open);
  assert.strictEqual(lgtmState.claimFixRound({ stateDir: open, pr: PR, headSha: HEAD, owner: 'fixer', now: 1 }).claimed, true);
  assert.deepStrictEqual(lgtmState.recordDelivery({ stateDir: open, pr: PR, headSha: HEAD, now: 2, packet: pr172Packet() }), { recorded: false, reason: 'fix-round-open' });
  assert.strictEqual(lgtmState.status({ stateDir: open, pr: PR, headSha: HEAD }).delivery, null);
});

test('a later review lifts the terminal record, a clean head reports delivery, and evidence persists', () => {
  const stateDir = temp();
  const input = { stateDir, pr: PR, headSha: HEAD };
  withActiveReview(stateDir);
  const record = lgtmState.recordDelivery({ ...input, now: 2000, packet: pr172Packet({ reviewIds: ['4192088400'] }) });
  assert.deepStrictEqual(record.reviewIds, ['4192088400']);
  assert.deepStrictEqual(record.findings[3], { id: 'c-4192088461', url: THREAD(4192088461), disposition: 'follow-up', rootCause: 'artifact-repair-admission', releaseBlocking: [], rationale: pr172Packet().findings[3].rationale, acceptedBy: null, ticket: ISSUE(173) });
  assert.strictEqual(lgtmState.status(input).delivery.current, true);

  // A delayed exact-head review with findings arrives after the record.
  lgtmState.recordReview({ ...input, now: 3000, observation: {
    reviewId: 4192088500, reviewer: 'copilot-pull-request-reviewer[bot]', reviewUrl: 'https://github.com/arinyaho/concord/pull/172#pullrequestreview-4192088500',
    commitId: HEAD, state: 'completed', lgtm: false, findings: [{ url: THREAD(4192099999), priority: 'P1', signals: [] }],
  } });
  const after = lgtmState.status(input);
  assert.strictEqual(after.delivery.current, false);
  assert.notStrictEqual(after.reconciliation.action, 'report-delivery');
  assert.strictEqual(lgtmState.claimFixRound({ ...input, owner: 'fixer', now: 4000 }).claimed, true);

  // A head that finished with no review record still reports its terminal delivery.
  const clean = { stateDir: temp(), pr: PR, headSha: OTHER_HEAD };
  const findings = pr172Packet().findings.filter((f) => f.disposition === 'fixed');
  assert.strictEqual(lgtmState.recordDelivery({ ...clean, now: 1, packet: pr172Packet({ findings, tickets: [] }) }).classification, 'mergeable-clean');
  assert.strictEqual(lgtmState.status(clean).reconciliation.action, 'report-delivery');
});

test('a packet built before a new review arrived is refused, and a non-array releaseBlocking is rejected', () => {
  const stateDir = temp();
  const input = { stateDir, pr: PR, headSha: HEAD };
  withActiveReview(stateDir);
  lgtmState.recordReview({ ...input, now: 3000, observation: {
    reviewId: 4192088500, reviewer: 'copilot-pull-request-reviewer[bot]', reviewUrl: 'https://github.com/arinyaho/concord/pull/172#pullrequestreview-4192088500',
    commitId: HEAD, state: 'completed', lgtm: false, findings: [{ url: THREAD(4192099999), priority: 'P2', signals: [] }],
  } });
  assert.deepStrictEqual(lgtmState.recordDelivery({ ...input, now: 4000, packet: pr172Packet({ reviewIds: ['4192088400'] }) }), { recorded: false, reason: 'review-batch-changed', reviewIds: ['4192088400', '4192088500'] });
  assert.strictEqual(lgtmState.status(input).delivery, null);
  assert.strictEqual(lgtmState.claimFixRound({ ...input, owner: 'fixer', now: 5000 }).claimed, true);

  for (const bad of ['', 0, 'security', {}]) {
    const p = pr172Packet();
    p.findings[3] = { ...p.findings[3], releaseBlocking: bad };
    assert.throws(() => lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...p }), /releaseBlocking must be an array/);
  }
  assert.throws(() => lgtmState.classifyDelivery({ pr: PR, headSha: HEAD, ...pr172Packet({ reviewIds: ['abc'] }) }), /reviewIds must be review ids/);
});

test('a recorded fix-budget waiver lifts a terminal delivery so the waived rounds can be claimed', () => {
  const stateDir = temp();
  withActiveReview(stateDir);
  cli(stateDir, ['record-delivery', String(PR), HEAD], JSON.stringify(pr172Packet({ reviewIds: ['4192088400'] })));
  assert.strictEqual(cli(stateDir, ['claim-fix-round', String(PR), HEAD]).reason, 'delivery-terminal');
  cli(stateDir, ['waive-fix-budget', String(PR), 'someone', '1']);
  const claim = cli(stateDir, ['claim-fix-round', String(PR), HEAD]);
  assert.strictEqual(claim.claimed, true);
  assert.strictEqual(claim.budget.max, 4);
});

test('a fix-budget waiver does not reopen review requests on a terminal delivery', () => {
  const stateDir = temp();
  withActiveReview(stateDir);
  cli(stateDir, ['record-delivery', String(PR), HEAD], JSON.stringify(pr172Packet({ reviewIds: ['4192088400'] })));
  cli(stateDir, ['waive-fix-budget', String(PR), 'someone', '1']);
  assert.strictEqual(cli(stateDir, ['claim-initial-request', String(PR), HEAD, 'codex']).reason, 'delivery-terminal');
  assert.strictEqual(cli(stateDir, ['claim-fix-round', String(PR), HEAD]).claimed, true);
});

test('status reopens the reconciliation packet when a waiver lifts a terminal delivery', () => {
  const stateDir = temp();
  withActiveReview(stateDir);
  cli(stateDir, ['record-delivery', String(PR), HEAD], JSON.stringify(pr172Packet({ reviewIds: ['4192088400'] })));
  assert.strictEqual(cli(stateDir, ['status', String(PR), HEAD]).reconciliation.action, 'report-delivery');
  cli(stateDir, ['waive-fix-budget', String(PR), 'someone', '1']);
  assert.strictEqual(cli(stateDir, ['status', String(PR), HEAD]).reconciliation.action, 'verify-and-fix');
  assert.strictEqual(cli(stateDir, ['claim-fix-round', String(PR), HEAD]).claimed, true);
});
