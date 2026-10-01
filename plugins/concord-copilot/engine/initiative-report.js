'use strict';
// Completion reports for a finalised keyed initiative run, and the project-level
// index of finalised runs. Both are derived from the run ledgers, never a source
// of truth. See docs/design/2026-10-01-initiative-completion-report.md.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./atomic-write');
const { lockOwner, reclaimStaleLock } = require('./run-lock');
const { MODES, ESCALATION_TRIGGERS } = require('./initiative-review-run');

const SCHEMA = 1;
const LEDGER_FILE = /^initiative-review-([0-9a-f]{64})\.json$/;
const REASONS = ['finalised', 'unreserved-evidence'];
const BOUNDED = /^[a-z-]{1,32}$/;
const LISTS = ['launches', 'rounds', 'targets', 'dispositions', 'checks', 'telemetry'];
const USAGE = ['elapsedMs', 'inputTokens', 'cacheWriteInputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'outputTokens', 'totalTokens'];
const INDEX_LOCK_WAIT_MS = 10000;

const bound = (value) => (typeof value === 'string' && BOUNDED.test(value) ? value : 'other');
const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const time = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function bump(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

// The one allowlist projection: named ledger fields only, keys bounded by pattern.
// report.json, report.md and every index line are built from this value.
function project(ledger, runId) {
  const byRole = {};
  for (const launch of ledger.launches) bump(byRole, bound(launch?.role));
  const findings = {};
  for (const [kind, n] of Object.entries(ledger.findings || {})) if (count(n)) bump(findings, bound(kind), n);
  const byStatus = {};
  for (const check of ledger.checks) bump(byStatus, bound(check?.status));
  const tokenRole = () => ({ launches: 0, calls: 0, ...Object.fromEntries(USAGE.map((field) => [field, 0])) });
  const roles = {};
  const total = tokenRole();
  for (const [role, n] of Object.entries(byRole)) { roles[role] = tokenRole(); roles[role].launches = n; total.launches += n; }
  for (const entry of ledger.telemetry) {
    const role = roles[bound(entry?.role)] || (roles[bound(entry?.role)] = tokenRole());
    const calls = count(entry?.count) || 1;
    for (const target of [role, total]) {
      target.calls += calls;
      for (const field of USAGE) target[field] += number(entry?.[field]);
    }
  }
  const openedAt = time(ledger.openedAt);
  const finalisedAt = time(ledger.terminal?.at);
  return {
    schema: SCHEMA,
    runId,
    mode: ledger.mode,
    escalation: ESCALATION_TRIGGERS.includes(ledger.escalation?.trigger) ? ledger.escalation.trigger : null,
    outcome: { status: 'terminal', reason: REASONS.includes(ledger.terminal?.reason) ? ledger.terminal.reason : 'other' },
    targets: { count: ledger.targets.length, ids: [...new Set(ledger.targets.map((target) => sha(JSON.stringify(target))))] },
    counts: { launches: ledger.launches.length, rounds: ledger.rounds.length, byRole },
    findings,
    checks: { total: ledger.checks.length, byStatus },
    tokens: { total, byRole: roles },
    elapsed: { wallClockMs: openedAt && finalisedAt ? Date.parse(finalisedAt) - Date.parse(openedAt) : null, reviewerMs: total.elapsedMs },
    openedAt,
    finalisedAt,
  };
}

// A terminal version 5 ledger with every list present, or a thrown reason.
function checked(ledger, name) {
  if (!ledger || typeof ledger !== 'object' || ledger.status !== 'terminal') throw new Error(`initiative report: ${name} is not a terminal ledger`);
  if (!MODES.includes(ledger.mode)) throw new Error(`initiative report: ${name} has no valid mode`);
  const missing = LISTS.filter((list) => !Array.isArray(ledger[list]));
  if (missing.length) throw new Error(`initiative report: ${name} is a partial terminal ledger (missing ${missing.join(', ')})`);
  return ledger;
}

function readLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`initiative report: cannot read ${path.basename(file)}: ${error.message}`);
  }
}

function renderMarkdown(report) {
  const fixed = (object) => Object.entries(object).map(([key, value]) => `${key} ${value}`).join(', ') || 'none';
  const usage = (tokens) => `${tokens.calls} calls over ${tokens.launches} launches, ${tokens.totalTokens} tokens, ${tokens.elapsedMs} ms`;
  return [
    `# Initiative completion report ${report.runId}`,
    '',
    `- Mode: ${report.mode}${report.escalation ? ` (escalated from lite: ${report.escalation})` : ''}`,
    `- Outcome: ${report.outcome.status} (${report.outcome.reason})`,
    `- Targets: ${report.targets.count}`,
    `- Rounds: ${report.counts.rounds}`,
    `- Launches: ${report.counts.launches} (${fixed(report.counts.byRole)})`,
    `- Findings: ${fixed(report.findings)}`,
    `- Checks: ${report.checks.total} (${fixed(report.checks.byStatus)})`,
    `- Opened: ${report.openedAt ?? 'unmeasured'}`,
    `- Finalised: ${report.finalisedAt ?? 'unmeasured'}`,
    `- Wall clock: ${report.elapsed.wallClockMs === null ? 'unmeasured' : `${report.elapsed.wallClockMs} ms`}`,
    `- Reviewer time: ${report.elapsed.reviewerMs} ms`,
    '',
    '## Tokens by role',
    '',
    `- all roles: ${usage(report.tokens.total)}`,
    ...Object.entries(report.tokens.byRole).map(([role, tokens]) => `- ${role}: ${usage(tokens)}`),
    '',
    'Runs that never finalise are excluded from this report and from the index. Waiting time is not measured. Token and reviewer-time figures are lower bounds: missing or partial telemetry is skipped.',
    '',
  ].join('\n');
}

// Exclusive mkdir lock beside the index, with the run lock's stale-owner recovery.
function withIndexLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reclaimStaleLock(lock)) continue;
      if (Date.now() > deadline) throw new Error(`initiative report: index lock ${lock} is held (owner pid ${lockOwner(lock) || 'unknown'}); if no review is running, remove it with: rm -r "${lock}"`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    try { fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`); } catch (_) { /* informational only */ }
    return fn();
  } finally { if (lockOwner(lock) === process.pid) fs.rmSync(lock, { recursive: true, force: true }); }
}

// Terminal version 5 ledgers in the directory, projected. An unparseable file or a
// malformed terminal version 5 ledger throws; other versions and active runs are skipped.
function scanIndex(dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const match = LEDGER_FILE.exec(name);
    if (!match) continue;
    const ledger = readLedger(path.join(dir, name));
    if (ledger?.version !== 5 || ledger.status !== 'terminal') continue;
    entries.push(project(checked(ledger, name), match[1]));
  }
  const key = (entry) => entry.finalisedAt ?? '';
  return entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

// Renders report.json and report.md for the run, then rebuilds the index. Throws,
// writing nothing for the failing step, when the ledger is not a complete terminal one.
function renderInitiativeReports(run) {
  const dir = path.dirname(run.path);
  const match = LEDGER_FILE.exec(path.basename(run.path));
  if (!match) throw new Error('initiative report: not a run ledger path');
  const ledger = readLedger(run.path);
  if (ledger?.version !== 5) throw new Error('initiative report: the ledger is not schema version 5');
  const report = project(checked(ledger, path.basename(run.path)), match[1]);
  const reportDir = path.join(dir, `initiative-report-${match[1]}`);
  fs.mkdirSync(reportDir, { recursive: true });
  writeFileAtomic(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileAtomic(path.join(reportDir, 'report.md'), renderMarkdown(report));
  const index = path.join(dir, 'initiative-reports.jsonl');
  withIndexLock(index, () => writeFileAtomic(index, scanIndex(dir).map((entry) => `${JSON.stringify(entry)}\n`).join('')));
  return report;
}

module.exports = { renderInitiativeReports };
