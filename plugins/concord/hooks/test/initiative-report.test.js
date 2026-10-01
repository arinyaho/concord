'use strict';
// Initiative completion reports: finalising a keyed run renders report.json and
// report.md from the terminal ledger, and a derived project-level index lists
// finalised runs by an allowlist of fields. See docs/design/2026-10-01-initiative-completion-report.md.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../../core/review');
const { safeIdForFilename } = require('../../core/artifact-name');

const PLUGINS = path.join(__dirname, '..', '..', '..');
const RUNTIMES = [
  ['core', require('../../core/initiative-review-run')],
  ['codex', require('../../../concord-codex/engine/initiative-review-run')],
  ['copilot', require('../../../concord-copilot/engine/initiative-review-run')],
];
const CLIS = {
  claude: path.join(PLUGINS, 'concord', 'hooks', 'review-cli.js'),
  codex: path.join(PLUGINS, 'concord-codex', 'bin', 'review-cli.js'),
  copilot: path.join(PLUGINS, 'concord-copilot', 'bin', 'review-cli.js'),
};

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const readLedger = (run) => JSON.parse(fs.readFileSync(run.path, 'utf8'));
const writeLedger = (run, ledger) => fs.writeFileSync(run.path, `${JSON.stringify(ledger)}\n`);
// Layout under the initiative state directory, keyed by the run key's hash.
const reportDir = (stateDir, key) => path.join(fs.realpathSync(stateDir), `initiative-report-${sha(key)}`);
const indexFile = (stateDir) => path.join(fs.realpathSync(stateDir), 'initiative-reports.jsonl');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readIndex = (stateDir) => fs.readFileSync(indexFile(stateDir), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

const usage = (role, round, totalTokens, elapsedMs) => ({ role, stage: 'review', round, elapsedMs, inputTokens: totalTokens - 10, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 10, totalTokens });

// Reopens a run handle for an existing key (finalise is called again on a terminal run).
const openedRun = (lib, stateDir, key) => lib.openInitiativeRun({ repository: '/repo', stateDir, key, maxLaunches: 6, maxRounds: 3, allowTerminal: true });

// One finalised run with two reserved launches, one terminal disposition carrying
// findings, a check and per-role telemetry.
function finalisedRun(lib, { stateDir, key, mode = 'base', repository = '/repo', ref = 'feat/x', head = 'a'.repeat(40), base = 'b'.repeat(40), handoff = 'handoff', findings = { correctness: 2, 'design-conformance': 1 } }) {
  const run = lib.openInitiativeRun({ repository, stateDir, key, maxLaunches: 6, maxRounds: 3, mode });
  assert.ok(lib.reserveLaunch(run, { role: 'correctness', round: 1, target: ref, revision: { ref, base, head_sha: head } }));
  assert.ok(lib.reserveLaunch(run, { role: 'verify', round: 1, target: ref, revision: { ref, base, head_sha: head } }));
  assert.ok(lib.recordDisposition(run, {
    target: ref, revision: { ref, base, head_sha: head }, result: { decision: { converged: true } },
    packet: { trigger: 'terminal', exit: { code: 0, signal: null }, dod: { status: 'passed' }, telemetry: { complete: true }, nextAction: 'replay', handoff },
    findings, checks: [{ name: 'definition-of-done', status: 'passed' }],
    telemetry: [usage('correctness', 1, 1000, 4000), usage('verify', 1, 500, 2000), usage('correctness', 2, 300, 1000)],
  }));
  assert.ok(lib.finaliseInitiativeRun(run));
  return run;
}

for (const [name, lib] of RUNTIMES) {
  test(`${name}: finalise stamps the ledger with code-generated timestamps (AC1)`, () => {
    const stateDir = tmp('report-ts-');
    const run = finalisedRun(lib, { stateDir, key: 'ts' });
    const ledger = readLedger(run);
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    assert.match(ledger.openedAt, iso);
    assert.match(ledger.terminal.at, iso);
    assert.ok(ledger.launches.every((launch) => iso.test(launch.at)));
    assert.match(ledger.dispositions[0].at, iso);
  });

  test(`${name}: finalise writes report.json and report.md that match the ledger (AC1)`, () => {
    const stateDir = tmp('report-main-');
    const run = finalisedRun(lib, { stateDir, key: 'main', mode: 'lite' });
    const dir = reportDir(stateDir, 'main');
    const report = readJson(path.join(dir, 'report.json'));
    assert.strictEqual(report.runId, sha('main'));
    assert.strictEqual(report.mode, 'lite');
    assert.deepStrictEqual([report.outcome.status, report.outcome.reason], ['terminal', 'finalised']);
    assert.strictEqual(report.counts.rounds, 1);
    assert.strictEqual(report.counts.launches, 2);
    assert.deepStrictEqual(report.findings, { correctness: 2, 'design-conformance': 1 });
    assert.deepStrictEqual(report.checks, { total: 1, byStatus: { passed: 1 } });
    assert.strictEqual(report.tokens.byRole.correctness.totalTokens, 1300);
    assert.strictEqual(report.tokens.byRole.correctness.calls, 2);
    assert.strictEqual(report.tokens.byRole.verify.totalTokens, 500);
    assert.strictEqual(report.tokens.total.totalTokens, 1800);
    const ledger = readLedger(run);
    assert.strictEqual(report.elapsed.wallClockMs, Date.parse(ledger.terminal.at) - Date.parse(ledger.openedAt));
    assert.strictEqual(report.elapsed.reviewerMs, 7000);
    const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
    assert.match(md, /lite/);
    assert.match(md, /never finalise/);
  });

  test(`${name}: elapsed time is the stamped wall clock and counts reviewer time separately (AC1)`, () => {
    const stateDir = tmp('report-elapsed-');
    const run = finalisedRun(lib, { stateDir, key: 'elapsed' });
    writeLedger(run, { ...readLedger(run), openedAt: '2026-10-01T00:00:00.000Z', terminal: { ...readLedger(run).terminal, at: '2026-10-01T00:01:30.000Z' } });
    assert.ok(lib.finaliseInitiativeRun(run));
    const report = readJson(path.join(reportDir(stateDir, 'elapsed'), 'report.json'));
    assert.strictEqual(report.elapsed.wallClockMs, 90000);
    assert.strictEqual(report.elapsed.reviewerMs, 7000);
  });

  test(`${name}: a negative wall-clock difference is unmeasured, not a negative value`, () => {
    const stateDir = tmp('report-negative-');
    const run = finalisedRun(lib, { stateDir, key: 'negative' });
    writeLedger(run, { ...readLedger(run), openedAt: '2026-10-01T00:01:30.000Z', terminal: { ...readLedger(run).terminal, at: '2026-10-01T00:00:00.000Z' } });
    assert.ok(lib.finaliseInitiativeRun(run));
    assert.strictEqual(readJson(path.join(reportDir(stateDir, 'negative'), 'report.json')).elapsed.wallClockMs, null);
  });

  test(`${name}: the index lock is released when its owner file cannot be written`, () => {
    const stateDir = tmp('report-lockowner-');
    const real = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).endsWith(`initiative-reports.jsonl.lock${path.sep}owner`)) throw new Error('disk full');
      return real(file, ...rest);
    };
    try { finalisedRun(lib, { stateDir, key: 'lockowner' }); } finally { fs.writeFileSync = real; }
    assert.ok(!fs.existsSync(`${indexFile(stateDir)}.lock`));
    assert.strictEqual(readIndex(stateDir).length, 1);
  });

  test(`${name}: launches and calls of one role share a key in the telemetry role vocabulary`, () => {
    const stateDir = tmp('report-roles-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir, key: 'roles', maxLaunches: 20, maxRounds: 2 });
    const revision = { ref: 'feat/x', base: 'b'.repeat(40), head_sha: 'a'.repeat(40) };
    for (const role of ['gate-review', 'lens', 'vote']) assert.ok(lib.reserveLaunch(run, { role, round: 1, target: 'feat/x', revision }));
    assert.ok(lib.recordDisposition(run, {
      target: 'feat/x', revision, result: { decision: { converged: true } }, packet: { trigger: 'terminal', nextAction: 'replay' },
      telemetry: [usage('gate', 1, 100, 10), usage('gate-panel-security', 1, 200, 10), usage('gate-panel-verify', 1, 300, 10)],
    }));
    assert.ok(lib.finaliseInitiativeRun(run));
    const report = readJson(path.join(reportDir(stateDir, 'roles'), 'report.json'));
    assert.deepStrictEqual(report.counts.byRole, { gate: 1, 'gate-panel': 1, 'gate-panel-verify': 1 });
    assert.deepStrictEqual(Object.keys(report.tokens.byRole).sort(), ['gate', 'gate-panel', 'gate-panel-verify']);
    assert.strictEqual(report.tokens.byRole['gate-panel'].totalTokens, 200);
  });

  test(`${name}: a crash after the ledger write and before rendering loses nothing; re-running regenerates the same reports (AC2)`, () => {
    const stateDir = tmp('report-crash-');
    const run = finalisedRun(lib, { stateDir, key: 'crash' });
    const dir = reportDir(stateDir, 'crash');
    const first = ['report.json', 'report.md'].map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
    const firstIndex = fs.readFileSync(indexFile(stateDir), 'utf8');
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(indexFile(stateDir));
    assert.strictEqual(readLedger(run).status, 'terminal');
    assert.ok(lib.finaliseInitiativeRun(run)); // terminal already: must still render
    assert.deepStrictEqual(['report.json', 'report.md'].map((file) => fs.readFileSync(path.join(dir, file), 'utf8')), first);
    assert.strictEqual(fs.readFileSync(indexFile(stateDir), 'utf8'), firstIndex);
  });

  test(`${name}: an unreadable or partial terminal ledger fails closed and renders nothing (constraint)`, () => {
    const stateDir = tmp('report-bad-');
    const run = finalisedRun(lib, { stateDir, key: 'bad' });
    fs.rmSync(reportDir(stateDir, 'bad'), { recursive: true, force: true });
    const { launches, ...partial } = readLedger(run);
    writeLedger(run, partial);
    assert.throws(() => lib.finaliseInitiativeRun(run), /initiative report/);
    fs.writeFileSync(run.path, '{"version":5,"status":"term');
    assert.throws(() => lib.finaliseInitiativeRun(run));
    assert.ok(!fs.existsSync(path.join(reportDir(stateDir, 'bad'), 'report.json')));
  });

  test(`${name}: a malformed terminal v5 ledger of another run fails the index rebuild; non-v5 and active ledgers are skipped (decision 2)`, () => {
    const stateDir = tmp('report-index-bad-');
    const other = (key, body) => fs.writeFileSync(path.join(fs.realpathSync(stateDir), `initiative-review-${sha(key)}.json`), typeof body === 'string' ? body : `${JSON.stringify(body)}\n`);
    finalisedRun(lib, { stateDir, key: 'mine' });
    other('old', { version: 4, status: 'terminal' });
    other('open', { version: 5, status: 'active', launches: [] });
    assert.ok(lib.finaliseInitiativeRun(openedRun(lib, stateDir, 'mine')));
    assert.deepStrictEqual(readIndex(stateDir).map((entry) => entry.runId), [sha('mine')]);
    other('broken', { version: 5, status: 'terminal' });
    assert.throws(() => lib.finaliseInitiativeRun(openedRun(lib, stateDir, 'mine')), /initiative report.*terminal/s);
    assert.deepStrictEqual(readIndex(stateDir).map((entry) => entry.runId), [sha('mine')]); // index left as it was
    other('broken', '{"version":5,"status":"term');
    assert.throws(() => lib.finaliseInitiativeRun(openedRun(lib, stateDir, 'mine')), /initiative report/);
  });

  test(`${name}: launches-by-role and check-status keys outside the pattern become other (bounded keys)`, () => {
    const stateDir = tmp('report-bound-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir, key: 'bound', maxLaunches: 4, maxRounds: 2 });
    const revision = { ref: 'feat/x', base: 'b'.repeat(40), head_sha: 'a'.repeat(40) };
    assert.ok(lib.reserveLaunch(run, { role: 'SENTINEL-ROLE', round: 1, target: 'feat/x', revision }));
    assert.ok(lib.recordDisposition(run, { target: 'feat/x', revision, result: { decision: { converged: true } }, packet: { trigger: 'terminal', nextAction: 'replay' }, checks: [{ name: 'x', status: 'SENTINEL-STATUS' }] }));
    assert.ok(lib.finaliseInitiativeRun(run));
    const report = readJson(path.join(reportDir(stateDir, 'bound'), 'report.json'));
    assert.deepStrictEqual(report.counts.byRole, { other: 1 });
    assert.deepStrictEqual(report.checks.byStatus, { other: 1 });
  });

  test(`${name}: index entries carry only allowlisted fields and no sentinel leaks into any emitted file (AC4)`, () => {
    const root = tmp('report-leak-');
    const stateDir = path.join(root, 'state');
    const repository = path.join(root, 'SENTINEL-REPO-PATH');
    fs.mkdirSync(repository);
    const sentinels = ['SENTINEL-CLASS', 'SENTINEL-REPO-PATH', 'SENTINEL-RAW-REF', 'c'.repeat(40), 'd'.repeat(40), 'SENTINEL-HANDOFF-TEXT', 'SENTINEL-ERROR-MESSAGE'];
    const run = lib.openInitiativeRun({ repository, stateDir, key: 'leak', maxLaunches: 6, maxRounds: 3 });
    const revision = { ref: 'SENTINEL-RAW-REF', base: 'c'.repeat(40), head_sha: 'd'.repeat(40) };
    assert.ok(lib.reserveLaunch(run, { role: 'correctness', round: 1, target: 'SENTINEL-RAW-REF', revision }));
    assert.ok(lib.recordDisposition(run, { target: 'SENTINEL-RAW-REF', revision, result: new Error('SENTINEL-ERROR-MESSAGE'), packet: { trigger: 'error', nextAction: 'resume', error: { message: 'SENTINEL-ERROR-MESSAGE' } } }));
    assert.ok(lib.recordDisposition(run, { target: 'SENTINEL-RAW-REF', revision, result: { decision: { converged: true } }, packet: { trigger: 'terminal', nextAction: 'replay', handoff: 'SENTINEL-HANDOFF-TEXT' }, findings: { correctness: 1, 'SENTINEL-CLASS': 1 }, checks: [{ name: 'definition-of-done', status: 'passed' }], telemetry: [{ ...usage('SENTINEL-CLASS', 1, 100, 500), revision }, { ...usage('correctness', 1, 200, 500), revision }] }));
    assert.ok(lib.finaliseInitiativeRun(run));
    const emitted = [path.join(reportDir(stateDir, 'leak'), 'report.json'), path.join(reportDir(stateDir, 'leak'), 'report.md'), indexFile(stateDir)];
    for (const file of emitted) {
      const text = fs.readFileSync(file, 'utf8');
      for (const sentinel of sentinels) assert.ok(!text.includes(sentinel), `${path.basename(file)} leaked ${sentinel}`);
      assert.ok(!text.includes(root), `${path.basename(file)} leaked a path`);
    }
    const [entry] = readIndex(stateDir);
    assert.deepStrictEqual(entry.findings, { correctness: 1, other: 1 });
    assert.deepStrictEqual(Object.keys(entry.tokens.byRole).sort(), ['correctness', 'other']);
    assert.deepStrictEqual(Object.keys(entry).sort(), ['checks', 'counts', 'elapsed', 'escalation', 'finalisedAt', 'findings', 'mode', 'openedAt', 'outcome', 'runId', 'schema', 'targets', 'tokens']);
  });

  test(`${name}: the index compares one base run and one lite run by mode, rounds, findings and tokens, and omits a run that never finalised (AC5, AC6)`, () => {
    const stateDir = tmp('report-index-');
    finalisedRun(lib, { stateDir, key: 'base-run', mode: 'base' });
    finalisedRun(lib, { stateDir, key: 'lite-run', mode: 'lite', findings: { correctness: 1 } });
    const open = lib.openInitiativeRun({ repository: '/repo', stateDir, key: 'abandoned', maxLaunches: 2, maxRounds: 1 });
    assert.ok(lib.reserveLaunch(open, { role: 'correctness', round: 1, target: 'feat/y' }));
    const entries = readIndex(stateDir);
    assert.strictEqual(entries.length, 2);
    const byMode = Object.fromEntries(entries.map((entry) => [entry.mode, entry]));
    assert.deepStrictEqual(Object.keys(byMode).sort(), ['base', 'lite']);
    assert.strictEqual(byMode.base.counts.rounds, 1);
    assert.deepStrictEqual(byMode.lite.findings, { correctness: 1 });
    assert.strictEqual(byMode.base.tokens.total.totalTokens, 1800);
    assert.ok(!entries.some((entry) => entry.runId === sha('abandoned')));
    assert.ok(!fs.existsSync(reportDir(stateDir, 'abandoned')));
    const report = fs.readFileSync(path.join(reportDir(stateDir, 'base-run'), 'report.md'), 'utf8') + fs.readFileSync(path.join(reportDir(stateDir, 'base-run'), 'report.json'), 'utf8');
    assert.ok(!report.includes(sha('abandoned')));
  });
}

// ---- native driver: per-role token data in the report (AC3) ------------------------------

function nativeSetup(cliName) {
  const repo = tmp('report-native-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: repo });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '-A'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('commit', '-aqm', 'change');
  const dir = tmp('report-native-state-');
  const initDir = tmp('report-native-ledger-');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const keyed = ['--initiative-run-key', 'native-key', '--initiative-state-dir', initDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'];
  const ok = (args, { key = true } = {}) => {
    const r = spawnSync('node', [CLIS[cliName], ...args, ...(key ? keyed : [])], { encoding: 'utf8', env, cwd: repo });
    assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const write = (n, name, obj) => fs.writeFileSync(path.join(dir, `round-${n}-${name.replace(/^fix-(.*)$/, (_, id) => `fix-${safeIdForFilename(id)}`)}.json`), JSON.stringify(obj));
  return { dir, initDir, repo, ok, write };
}

for (const cliName of Object.keys(CLIS)) {
  test(`${cliName}: a native run's report carries per-role token data from the recorded telemetry (AC3)`, () => {
    const t = nativeSetup(cliName);
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { key: false }).round;
    for (const role of ['correctness', 'verify']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    const slug = review.targetSlug('feat/x');
    const invocation = (role, totalTokens, id) => ({ engine: 'claude', provider: 'anthropic', role, round: n, invocationId: id, status: 'completed', usagePartial: false, artifactPath: path.join(t.dir, `round-${n}-${role}.json`), elapsedMs: 1000, inputTokens: totalTokens - 10, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 10, totalTokens });
    fs.writeFileSync(path.join(t.dir, `telemetry-${slug}.json`), JSON.stringify({ invocations: [invocation('correctness', 700, 'inv-1'), invocation('verify', 300, 'inv-2')] }));
    t.ok(['plan-fixes', 'feat/x']);
    t.ok(['record', 'feat/x']);
    assert.strictEqual(t.ok(['finalise'])['status'], 'finalised');
    const report = readJson(path.join(reportDir(t.initDir, 'native-key'), 'report.json'));
    assert.strictEqual(report.tokens.byRole.correctness.totalTokens, 700);
    assert.strictEqual(report.tokens.byRole.verify.totalTokens, 300);
    assert.strictEqual(report.tokens.byRole.correctness.launches, 1);
    assert.strictEqual(report.tokens.total.totalTokens, 1000);
  });
}

for (const cliName of Object.keys(CLIS)) {
  test(`${cliName}: a lock or ledger error while failing closed on unreserved evidence is not reported as a failed-closed run`, () => {
    const t = nativeSetup(cliName);
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { key: false }).round;
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    fs.chmodSync(t.initDir, 0o500); // the run lock cannot be created
    try {
      const r = spawnSync('node', [CLIS[cliName], 'plan-fixes', 'feat/x', '--initiative-run-key', 'native-key', '--initiative-state-dir', t.initDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'], { encoding: 'utf8', env: { ...process.env, REVIEW_STATE_DIR: t.dir, REVIEW_REPO_ROOT: t.repo }, cwd: t.repo });
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /EACCES/);
      assert.doesNotMatch(r.stderr, /failed closed/);
    } finally { fs.chmodSync(t.initDir, 0o700); }
  });
}

for (const cliName of Object.keys(CLIS)) {
  test(`${cliName}: telemetry is forwarded once across two dispositions of one target, and a replayed record clears the cache`, () => {
    const t = nativeSetup(cliName);
    const slug = review.targetSlug('feat/x');
    const cache = path.join(t.dir, `telemetry-${slug}.json`);
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { key: false }).round;
    for (const role of ['correctness', 'verify']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    const invocation = (role, totalTokens, id) => ({ engine: 'claude', provider: 'anthropic', role, round: n, invocationId: id, status: 'completed', usagePartial: false, artifactPath: path.join(t.dir, `round-${n}-${role}.json`), elapsedMs: 1000, inputTokens: totalTokens - 10, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 10, totalTokens });
    fs.writeFileSync(cache, JSON.stringify({ invocations: [invocation('correctness', 700, 'inv-1'), invocation('verify', 300, 'inv-2')] }));
    t.ok(['plan-fixes', 'feat/x']);
    const planned = review.readLedger(t.dir, slug);
    review.writeLedger(t.dir, slug, { ...planned, gate_open: [{ id: 'gate:cross-context:x', file: 'a.txt', summary: 's', gate: 'cross-context', span: 'two' }] });
    t.ok(['record', 'feat/x']); // first disposition: a gate-pending escape carrying inv-1 and inv-2
    assert.ok(!fs.existsSync(cache), 'a recorded disposition clears the cache');
    const afterEscape = review.readLedger(t.dir, slug);
    assert.strictEqual(afterEscape.telemetryForwarded.length, 2);
    // Re-arm the same round as if the finding were resolved, keeping the forwarded keys, then add one more invocation.
    review.writeLedger(t.dir, slug, { ...planned, telemetry: afterEscape.telemetry, telemetryForwarded: afterEscape.telemetryForwarded });
    fs.writeFileSync(cache, JSON.stringify({ invocations: [invocation('correctness', 700, 'inv-1'), invocation('verify', 300, 'inv-2'), invocation('correctness', 50, 'inv-3')] }));
    t.ok(['record', 'feat/x']); // second disposition: a terminal carrying only inv-3
    assert.ok(!fs.existsSync(cache));
    const ledgerFile = path.join(t.initDir, fs.readdirSync(t.initDir).find((f) => /^initiative-review-[0-9a-f]{64}\.json$/.test(f)));
    const dispositions = readJson(ledgerFile).dispositions;
    assert.deepStrictEqual(dispositions.map((d) => d.kind), ['escape', 'terminal']);
    assert.strictEqual(readJson(ledgerFile).telemetry.length, 3, 'inv-1 and inv-2 are forwarded once, inv-3 once');
    assert.strictEqual(t.ok(['finalise'])['status'], 'finalised');
    assert.strictEqual(readJson(path.join(reportDir(t.initDir, 'native-key'), 'report.json')).tokens.total.totalTokens, 1050);
    // A record replayed on the terminal target must still clear a cache that hooks refilled in the meantime.
    fs.writeFileSync(cache, JSON.stringify({ invocations: [invocation('correctness', 5, 'inv-4')] }));
    t.ok(['record', 'feat/x']);
    assert.ok(!fs.existsSync(cache), 'the replay branch clears the cache');
  });
}
