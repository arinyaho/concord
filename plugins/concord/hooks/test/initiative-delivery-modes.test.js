'use strict';
// Initiative delivery modes: the run ledger owns `mode` (base|lite), keyed
// round-start enforces it, lite->base escalation is recorded and bounded, the
// native driver can finalise and consume, and a dead run-lock owner is recovered.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { openInitiativeRun, reserveLaunch, lockDiagnosis } = require('../../core/initiative-review-run');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { reviewerPrompt } = require('../../core/round-plan');
const review = require('../../core/review');
const { normalizeArtifact } = require('../../core/artifact-contract');
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
const open = (options) => openInitiativeRun({ repository: '/repo', ...options });
const read = (run) => JSON.parse(fs.readFileSync(run.path, 'utf8'));

// ---- ledger: mode, schema v5, escalation -------------------------------------------------

for (const [name, lib] of RUNTIMES) {
  test(`${name}: a run opened without a mode records base in a v5 ledger (AC1)`, () => {
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: tmp('mode-'), key: 'k', maxLaunches: 4, maxRounds: 2 });
    const ledger = read(run);
    assert.strictEqual(ledger.version, 5);
    assert.strictEqual(ledger.mode, 'base');
  });

  test(`${name}: an explicit lite run records lite, and an unknown mode is rejected (AC1)`, () => {
    const dir = tmp('mode-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2, mode: 'lite' });
    assert.strictEqual(read(run).mode, 'lite');
    assert.throws(() => lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'other', maxLaunches: 4, maxRounds: 2, mode: 'turbo' }), /mode must be base or lite/);
  });

  test(`${name}: a v4 ledger is rejected with preserved-state reconciliation instructions (AC4)`, () => {
    const dir = tmp('mode-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2 });
    const { mode, ...v4 } = read(run);
    fs.writeFileSync(run.path, JSON.stringify({ ...v4, version: 4 }));
    for (const attempt of [
      () => lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2 }),
      () => lib.reserveLaunch(run, { role: 'correctness', round: 1 }),
      () => lib.terminalTarget(run, 'feature/x', { ref: 'feature/x', base: 'b', head_sha: 'h' }, ['terminal']),
    ]) assert.throws(attempt, (error) => /schemaVersion must be 5/.test(error.message) && /preserve the original initiative and target ledgers/.test(error.message) && /reconcile their history and spent budgets/.test(error.message) && /new run key in a separate target review state directory/.test(error.message) && /source index/.test(error.message));
  });

  test(`${name}: reopening is keyed on budgets only; the ledger mode is authoritative (AC4)`, () => {
    const dir = tmp('mode-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2, mode: 'lite' });
    const again = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2 });
    assert.strictEqual(again.path, run.path);
    assert.strictEqual(read(run).mode, 'lite');
    assert.throws(() => lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 9, maxRounds: 2, mode: 'lite' }), /immutable configured budgets/);
  });

  test(`${name}: lite escalates to base before the first launch with its trigger recorded, then never again (AC2)`, () => {
    const dir = tmp('mode-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2, mode: 'lite' });
    assert.ok(lib.escalateInitiativeRun({ stateDir: dir, key: 'k', repository: '/repo', trigger: 'public-api', maxLaunches: 20, maxRounds: 5 }));
    const ledger = read(run);
    assert.strictEqual(ledger.mode, 'base');
    assert.deepStrictEqual(ledger.escalation, { from: 'lite', to: 'base', trigger: 'public-api' });
    assert.deepStrictEqual(ledger.budget, { maxLaunches: 20, maxRounds: 5 });
    assert.throws(() => lib.escalateInitiativeRun({ stateDir: dir, key: 'k', repository: '/repo', trigger: 'security', maxLaunches: 20, maxRounds: 5 }), /not a lite run/);
  });

  test(`${name}: a new AC2 exclusion trigger (legal) is accepted by escalate (AC2)`, () => {
    const dir = tmp('mode-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2, mode: 'lite' });
    assert.ok(lib.escalateInitiativeRun({ stateDir: dir, key: 'k', repository: '/repo', trigger: 'legal', maxLaunches: 20, maxRounds: 5 }));
    const ledger = read(run);
    assert.strictEqual(ledger.mode, 'base');
    assert.deepStrictEqual(ledger.escalation, { from: 'lite', to: 'base', trigger: 'legal' });
  });

  test(`${name}: escalation after the first launch, with an unknown trigger, or on a missing run is refused (AC2)`, () => {
    const dir = tmp('mode-');
    const run = lib.openInitiativeRun({ repository: '/repo', stateDir: dir, key: 'k', maxLaunches: 4, maxRounds: 2, mode: 'lite' });
    assert.throws(() => lib.escalateInitiativeRun({ stateDir: dir, key: 'k', repository: '/repo', trigger: 'because', maxLaunches: 20, maxRounds: 5 }), /trigger must be one of/);
    assert.ok(lib.reserveLaunch(run, { role: 'correctness', round: 1 }));
    assert.throws(() => lib.escalateInitiativeRun({ stateDir: dir, key: 'k', repository: '/repo', trigger: 'public-api', maxLaunches: 20, maxRounds: 5 }), /after the first launch/);
    assert.strictEqual(read(run).mode, 'lite');
    assert.throws(() => lib.escalateInitiativeRun({ stateDir: dir, key: 'absent', repository: '/repo', trigger: 'public-api', maxLaunches: 20, maxRounds: 5 }), /no initiative review run/);
  });
}

// ---- run lock: stale recovery and diagnosis -----------------------------------------------

function plantLock(run, owner) {
  fs.mkdirSync(`${run.path}.lock`, { recursive: true });
  if (owner !== undefined) fs.writeFileSync(path.join(`${run.path}.lock`, 'owner'), `${owner}\n`);
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid;
}

test('a run lock left by a dead process is recovered and the launch is reserved (AC7)', () => {
  const run = open({ stateDir: tmp('lock-'), key: 'k', maxLaunches: 2, maxRounds: 2 });
  plantLock(run, deadPid());
  assert.ok(reserveLaunch(run, { role: 'correctness', round: 1 }));
  assert.strictEqual(read(run).launches.length, 1);
  assert.strictEqual(fs.existsSync(`${run.path}.lock`), false);
});

test('a run lock held by a live process is not recovered and is diagnosable (AC7)', () => {
  const run = open({ stateDir: tmp('lock-'), key: 'k', maxLaunches: 2, maxRounds: 2 });
  plantLock(run, process.pid);
  assert.strictEqual(reserveLaunch(run, { role: 'correctness', round: 1 }), false);
  const message = lockDiagnosis(run);
  assert.ok(message.includes(`${run.path}.lock`), message);
  assert.ok(message.includes(`owner pid ${process.pid} (still running)`), message);
  assert.match(message, /rm -r/);
  assert.ok(fs.existsSync(`${run.path}.lock`));
});

test('the printed removal command quotes a lock path that contains a space (correctness:lock-diagnosis-rm-command-unquoted-path)', () => {
  const stateDir = path.join(tmp('lock-'), 'Application Support');
  fs.mkdirSync(stateDir);
  const run = open({ stateDir, key: 'k', maxLaunches: 2, maxRounds: 2 });
  plantLock(run, process.pid);
  assert.ok(lockDiagnosis(run).endsWith(`rm -r "${run.path}.lock"`), lockDiagnosis(run));
});

test('an ownerless run lock is recovered only once it is old (AC7)', () => {
  const run = open({ stateDir: tmp('lock-'), key: 'k', maxLaunches: 2, maxRounds: 2 });
  plantLock(run);
  assert.strictEqual(reserveLaunch(run, { role: 'correctness', round: 1 }), false);
  assert.match(lockDiagnosis(run), /owner unknown/);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(`${run.path}.lock`, old, old);
  assert.ok(reserveLaunch(run, { role: 'correctness', round: 1 }));
});

test('lockDiagnosis is null when nothing holds the run lock', () => {
  const run = open({ stateDir: tmp('lock-'), key: 'k', maxLaunches: 2, maxRounds: 2 });
  assert.strictEqual(lockDiagnosis(run), null);
});

// ---- lite gate prompt ---------------------------------------------------------------------

test('the lite gate prompt asks for design-conformance findings only (AC3)', () => {
  const lite = reviewerPrompt('gate', { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x', gateMode: 'design-conformance' });
  assert.match(lite, /gate:design-conformance:<slug>/);
  assert.doesNotMatch(lite, /cross-context, silent-gap, ac-coverage/);
  assert.match(lite, /Do not report ac-coverage, cross-context or silent-gap/);
  const base = reviewerPrompt('gate', { stateDir: '/state', round: 1, targetType: 'git', slug: 'feat-x' });
  assert.match(base, /cross-context, silent-gap, ac-coverage, design-conformance/);
});

// ---- Codex runner -------------------------------------------------------------------------

const work = (extra = {}) => ({ decision: 'work', round: 1, base: 'main', head: 'h2', stateDir: tmp('runner-'), targetType: 'git', dodPassed: true, dodDeferred: false, intentApplied: false, gateApplied: false, ...extra });

async function drive({ mode, started, key = 'runner-key', maxLaunches = 20, maxRounds = 5 }) {
  const stateDir = tmp('runner-state-');
  const cliCalls = [];
  const prompts = [];
  await runReviewUntilGreen({
    ref: 'feature/x', base: 'main', repoRoot: '/repo', initiativeRunKey: key, initiativeStateDir: stateDir, initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: maxRounds,
    ...(mode ? { initiativeMode: mode } : {}), targetIdentity: () => 'h2',
    runCli: (args) => {
      cliCalls.push(args);
      const verb = args[0];
      return verb === 'reserve' ? { status: 'granted' } : verb === 'round-start' ? started : verb === 'artifact-normalize' ? { status: 'ok' } : verb === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] }
        : verb === 'record' ? { decision: { continue: false, converged: true }, handoff: 'LGTM' } : {};
    },
    spawn: async (input) => { prompts.push(input); return { status: 0 }; },
  });
  return { stateDir, cliCalls, prompts };
}

test('the Codex runner passes the initiative flags and the mode to round-start (AC3)', async () => {
  const { stateDir, cliCalls } = await drive({ mode: 'lite', started: work() });
  const start = cliCalls.find((args) => args[0] === 'round-start');
  const flag = (name) => start[start.indexOf(name) + 1];
  assert.strictEqual(flag('--initiative-run-key'), 'runner-key');
  assert.strictEqual(flag('--initiative-state-dir'), fs.realpathSync(stateDir));
  assert.strictEqual(flag('--initiative-max-launches'), '20');
  assert.strictEqual(flag('--initiative-max-rounds'), '5');
  assert.strictEqual(flag('--initiative-mode'), 'lite');
});

test('without an initiative run the Codex runner passes no initiative flag to round-start', async () => {
  const cliCalls = [];
  await runReviewUntilGreen({ ref: 'feature/x', base: 'main', repoRoot: '/repo', targetIdentity: () => 'h2',
    runCli: (args) => { cliCalls.push(args); return args[0] === 'round-start' ? work() : args[0] === 'artifact-normalize' ? { status: 'ok' } : args[0] === 'plan-fixes' ? { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] } : args[0] === 'record' ? { decision: { continue: false, converged: true }, handoff: 'LGTM' } : {}; },
    spawn: async () => ({ status: 0 }) });
  assert.ok(!cliCalls.find((args) => args[0] === 'round-start').some((arg) => arg.startsWith('--initiative')));
});

test('a lite Codex round launches one design-conformance gate reviewer and no gate-verify (AC3, AC8)', async () => {
  const { prompts } = await drive({ mode: 'lite', started: work({ gateApplied: true, gateMode: 'design-conformance', mode: 'lite' }) });
  const roles = prompts.map((p) => p.role);
  assert.ok(roles.includes('gate'), roles.join());
  assert.ok(!roles.includes('gate-verify'), roles.join());
  assert.match(prompts.find((p) => p.role === 'gate').prompt, /Do not report ac-coverage, cross-context or silent-gap/);
});

test('a base Codex round still launches the full gate pair (AC3)', async () => {
  const { prompts } = await drive({ started: work({ gateApplied: true, gateMode: 'pair', mode: 'base' }) });
  const roles = prompts.map((p) => p.role);
  assert.ok(roles.includes('gate') && roles.includes('gate-verify'), roles.join());
});

// ---- review-cli verbs ---------------------------------------------------------------------

function initRepo(config = { dod: ['true'] }) {
  const repo = tmp('modes-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: repo });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify(config));
  git('add', '-A'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('commit', '-aqm', 'change');
  return repo;
}

function setup(cliName, { mode, maxLaunches = 20, maxRounds = 5, config } = {}) {
  const repo = initRepo(config);
  const stateDir = tmp('modes-state-');
  const initDir = tmp('modes-ledger-');
  const env = { ...process.env, REVIEW_STATE_DIR: stateDir, REVIEW_REPO_ROOT: repo };
  const keyed = (m = mode, launches = maxLaunches, rounds = maxRounds) => ['--initiative-run-key', 'key-1', '--initiative-state-dir', initDir, '--initiative-max-launches', String(launches), '--initiative-max-rounds', String(rounds), ...(m ? ['--initiative-mode', m] : [])];
  const cli = (args, flags = keyed()) => {
    const r = spawnSync('node', [CLIS[cliName], ...args, ...flags], { encoding: 'utf8', env, cwd: repo });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status, json: () => JSON.parse(r.stdout) };
  };
  const preparePlan = (ref, flags) => {
    const ledger = review.readLedger(stateDir, review.targetSlug(ref));
    const n = ledger.round;
    const read = (role) => {
      const file = path.join(stateDir, `round-${n}-${role}.json`);
      if (!fs.existsSync(file)) return { findings: [], rejected: [] };
      const artifact = normalizeArtifact(role, fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, `${JSON.stringify(artifact)}\n`);
      return artifact;
    };
    const correctness = read('correctness'); const verify = read('verify');
    const rejected = new Set((verify.rejected || []).map((entry) => typeof entry === 'string' ? entry : entry.id));
    const candidates = [...(correctness.findings || []), ...(verify.findings || [])].filter((entry) => !rejected.has(entry.id));
    fs.writeFileSync(path.join(stateDir, `round-${n}-plan.json`), `${JSON.stringify({ status: 'ok', protocolVersion: 2, groups: candidates.map((entry) => ({ groupId: entry.id, findingIds: [entry.id], rootCause: entry.summary, invariants: ['fixed behavior'], changeClass: 'local', structuralEffects: [], action: 'fix' })) })}\n`);
    const reserved = cli(['reserve', ref, 'plan'], flags);
    assert.strictEqual(reserved.status, 0, reserved.stderr);
  };
  const ok = (args, flags) => {
    if (args[0] === 'plan-fixes') preparePlan(args[1], flags);
    const r = cli(args, flags); assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return r.json();
  };
  const ledgerFile = () => path.join(initDir, fs.readdirSync(initDir).find((f) => /^initiative-review-.*\.json$/.test(f)));
  const initiative = () => JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
  const write = (n, name, obj) => fs.writeFileSync(path.join(stateDir, `round-${n}-${name.replace(/^fix-(.*)$/, (_, id) => `fix-${safeIdForFilename(id)}`)}.json`), `${JSON.stringify(obj)}\n`);
  return { repo, stateDir, initDir, env, cli, ok, initiative, write, keyed, ledgerFile };
}

for (const cliName of Object.keys(CLIS)) {
  test(`${cliName}: keyed round-start on a lite run fires one design-conformance gate and reports the mode (AC3)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    const out = t.ok(['round-start', 'feat/x', 'HEAD~1']);
    assert.strictEqual(out.mode, 'lite');
    assert.strictEqual(out.gateApplied, true);
    assert.strictEqual(out.gateMode, 'design-conformance');
    assert.strictEqual(t.initiative().mode, 'lite');
    const ledger = review.readLedger(t.stateDir, review.targetSlug('feat/x'));
    assert.deepStrictEqual(ledger.execution.pending, ['correctness', 'verify', 'plan', 'gate']);
  });

  test(`${cliName}: keyed round-start on a base run keeps the full gate pair (AC3)`, () => {
    const t = setup(cliName);
    const out = t.ok(['round-start', 'feat/x', 'HEAD~1']);
    assert.strictEqual(out.mode, 'base');
    assert.strictEqual(out.gateMode, 'pair');
    const ledger = review.readLedger(t.stateDir, review.targetSlug('feat/x'));
    assert.deepStrictEqual(ledger.execution.pending, ['correctness', 'verify', 'plan', 'gate', 'gate-verify']);
  });

  test(`${cliName}: a lite run rejects --broad, --gate and --no-broad and changes no state (AC3)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    for (const flag of ['--broad', '--gate', '--no-broad']) {
      const r = t.cli(['round-start', 'feat/x', 'HEAD~1', flag]);
      assert.notStrictEqual(r.status, 0, flag);
      assert.match(r.stderr, /lite/, r.stderr);
    }
    assert.strictEqual(review.readLedger(t.stateDir, review.targetSlug('feat/x')), null);
  });

  test(`${cliName}: a base run still accepts --no-broad (AC3)`, () => {
    const t = setup(cliName);
    const out = t.ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad']);
    assert.strictEqual(out.gateApplied, false);
  });

  test(`${cliName}: a mode flag that disagrees with the run ledger is refused (AC3)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    t.ok(['round-start', 'feat/x', 'HEAD~1']);
    const r = t.cli(['reserve', 'feat/x', 'correctness'], t.keyed('base'));
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /run mode is lite/);
  });

  test(`${cliName}: plan-fixes in lite accepts a design-conformance gate finding as reconciliation and rejects any other class (AC3, AC5)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1']).round;
    for (const role of ['correctness', 'verify', 'gate-review']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.write(n, 'gate', { status: 'ok', findings: [{ id: 'gate:ac-coverage:x', file: 'a.txt', span: 'two', summary: 's' }] });
    const bad = t.cli(['plan-fixes', 'feat/x']);
    assert.notStrictEqual(bad.status, 0);
    assert.match(bad.stderr, /lite gate accepts only gate:design-conformance/);
    t.write(n, 'gate', { status: 'ok', findings: [{ id: 'gate:design-conformance:x', file: 'a.txt', span: 'two', summary: 's' }] });
    const planned = t.ok(['plan-fixes', 'feat/x']);
    assert.deepStrictEqual(planned.fixes, []);
    assert.strictEqual(planned.reconciliation.trigger, 'material-finding');
    assert.ok(!t.initiative().launches.some((l) => l.role === 'fix'));
  });

  test(`${cliName}: a round parked for reconciliation grants no fix reservation and commits no fix (AC5)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1']).round;
    for (const role of ['correctness', 'verify', 'gate-review']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    // A correctness finding alongside the design-conformance gate finding:
    // plan-fixes parks the WHOLE round for reconciliation (planned: []),
    // even though the correctness finding on its own would have been
    // ordinarily fixable.
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:1', file: 'a.txt', span: 'two', summary: 'bug' }] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.write(n, 'gate', { status: 'ok', findings: [{ id: 'gate:design-conformance:x', file: 'a.txt', span: 'two', summary: 's' }] });
    const planned = t.ok(['plan-fixes', 'feat/x']);
    assert.deepStrictEqual(planned.fixes, []);
    assert.strictEqual(planned.reconciliation.trigger, 'material-finding');
    const launchesBefore = t.initiative().launches.length;
    const reserved = t.ok(['reserve', 'feat/x', 'fix']);
    assert.strictEqual(reserved.status, 'reconciliation-required');
    assert.strictEqual(t.initiative().launches.length, launchesBefore, 'a reconciliation-required reserve must not be charged');
    t.write(n, 'fix-correctness:1', { status: 'ok', edited: true, files: ['a.txt'] });
    const committed = t.cli(['commit-fix', 'feat/x', 'correctness:1']);
    assert.notStrictEqual(committed.status, 0);
    assert.match(committed.stderr, /transaction membership differs|not authorized by plan|not in this round's planned fixes/);
    assert.deepStrictEqual(review.readLedger(t.stateDir, review.targetSlug('feat/x')).journal || [], []);
  });

  test(`${cliName}: commit-fix of an id outside this round's planned fixes is refused in a normal run (AC5)`, () => {
    const t = setup(cliName);
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad']).round;
    for (const role of ['correctness', 'verify']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    const planned = t.ok(['plan-fixes', 'feat/x']);
    assert.deepStrictEqual(planned.fixes, []);
    const committed = t.cli(['commit-fix', 'feat/x', 'correctness:never-planned']);
    assert.notStrictEqual(committed.status, 0);
    assert.match(committed.stderr, /not authorized by plan|not in this round's planned fixes/);
  });

  test(`${cliName}: lite does not run the broad panel even when the repository enables it (AC8)`, () => {
    const t = setup(cliName, { mode: 'lite', config: { dod: ['true'], gate: { panel: true } } });
    const started = t.ok(['round-start', 'feat/x', 'HEAD~1']);
    const n = started.round;
    for (const role of ['correctness', 'verify', 'gate-review']) t.ok(['reserve', 'feat/x', role]);
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.write(n, 'gate', { status: 'ok', findings: [] });
    t.ok(['plan-fixes', 'feat/x']);
    const out = t.ok(['record', 'feat/x']);
    assert.ok(!out.decision.panelPending, JSON.stringify(out.decision));
    assert.strictEqual(out.decision.converged, true, JSON.stringify(out.decision));
    // AC8: a lite run that skips the broad panel still retains red-to-green
    // evidence -- the exact review revision pair and a passed DoD check --
    // in the initiative run's disposition, not just the target ledger.
    const resolvedBase = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: t.repo, encoding: 'utf8' }).trim();
    const disposition = t.initiative().dispositions[0];
    assert.strictEqual(disposition.revision.head_sha, started.head);
    assert.strictEqual(disposition.revision.base, resolvedBase);
    assert.strictEqual(disposition.packet.dod.status, 'passed');
  });

  test(`${cliName}: escalate records the trigger before the first launch and is refused after it (AC2)`, () => {
    const t = setup(cliName, { mode: 'lite', maxLaunches: 4, maxRounds: 2 });
    t.ok(['round-start', 'feat/x', 'HEAD~1']);
    const out = t.ok(['escalate', 'public-api'], t.keyed('lite', 20, 5));
    assert.deepStrictEqual([out.status, out.mode, out.trigger], ['escalated', 'base', 'public-api']);
    const ledger = t.initiative();
    assert.strictEqual(ledger.mode, 'base');
    assert.deepStrictEqual(ledger.escalation, { from: 'lite', to: 'base', trigger: 'public-api' });
    assert.deepStrictEqual(ledger.budget, { maxLaunches: 20, maxRounds: 5 });
  });

  test(`${cliName}: escalate after a launch is refused and leaves the run lite (AC2)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    t.ok(['round-start', 'feat/x', 'HEAD~1']);
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    const r = t.cli(['escalate', 'security'], t.keyed('lite', 20, 5));
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /after the first launch/);
    assert.strictEqual(t.initiative().mode, 'lite');
  });

  test(`${cliName}: finalise ends the run and later reservations are denied as inactive (AC7)`, () => {
    const t = setup(cliName);
    t.ok(['round-start', 'feat/x', 'HEAD~1']);
    const out = t.ok(['finalise']);
    assert.strictEqual(out.status, 'finalised');
    assert.strictEqual(t.initiative().status, 'terminal');
    const denied = t.ok(['reserve', 'feat/x', 'correctness']);
    assert.deepStrictEqual([denied.status, denied.reason], ['denied', 'inactive']);
    assert.strictEqual(t.ok(['finalise']).status, 'finalised');
  });

  test(`${cliName}: record exposes the delivery claim and consume acknowledges it exactly once (AC7)`, () => {
    const t = setup(cliName, { config: { dod: ['true'] } });
    const n = t.ok(['round-start', 'feat/x', 'HEAD~1', '--no-broad']).round;
    for (const role of ['correctness', 'verify']) t.ok(['reserve', 'feat/x', role]);
    t.write(n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.ok(['plan-fixes', 'feat/x']);
    const out = t.ok(['record', 'feat/x']);
    assert.ok(out.initiative.claim, JSON.stringify(out));
    assert.strictEqual(t.initiative().dispositions[0].packet.delivery.consumed, false);
    assert.strictEqual(t.ok(['consume', out.initiative.claim]).status, 'consumed');
    assert.strictEqual(t.initiative().dispositions[0].packet.delivery.consumed, true);
    const again = t.cli(['consume', out.initiative.claim]);
    assert.notStrictEqual(again.status, 0);
    assert.match(again.stderr, /no unconsumed delivery/);
  });

  test(`${cliName}: finalise, consume and escalate need a keyed run`, () => {
    const t = setup(cliName);
    for (const args of [['finalise'], ['consume', 'x:1'], ['escalate', 'public-api']]) {
      const r = t.cli(args, []);
      assert.notStrictEqual(r.status, 0, args[0]);
      assert.match(r.stderr, /initiative run/, r.stderr);
    }
  });
}

// ---- review fixes: lock reclaim exclusion, lock ownership on release, lite rejection ordering ----

test('two contenders cannot both reclaim the same stale run lock (correctness:stale-lock-reclaim-toctou)', () => {
  const { reclaimStaleLock } = require('../../core/run-lock');
  const lock = path.join(tmp('reclaim-'), 'run.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), '999999\n');
  const realRead = fs.readFileSync;
  let second = null;
  let armed = true;
  fs.readFileSync = function (file, ...rest) {
    const value = realRead.call(this, file, ...rest);
    if (armed && String(file) === path.join(lock, 'owner')) { armed = false; second = reclaimStaleLock(lock); }
    return value;
  };
  let first;
  try { first = reclaimStaleLock(lock); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(first, true);
  assert.strictEqual(second, false, 'a concurrent contender must not also reclaim the lock');
});

test('a run lock that changed owner during the update is not deleted by the previous holder (correctness:stale-lock-reclaim-toctou)', () => {
  const run = open({ stateDir: tmp('lock-'), key: 'k', maxLaunches: 2, maxRounds: 2 });
  const lock = `${run.path}.lock`;
  const realRead = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (String(file) === run.path) fs.writeFileSync(path.join(lock, 'owner'), `${process.pid + 1}\n`);
    return realRead.call(this, file, ...rest);
  };
  try { reserveLaunch(run, { role: 'correctness', round: 1 }); } finally { fs.readFileSync = realRead; }
  assert.ok(fs.existsSync(lock), 'the lock now belongs to another holder and must remain');
});

for (const [name, runtime] of RUNTIMES) {
  test(`${name}: a lock whose owner file could not be written is released, never leaked (correctness:run-lock-owner-write-failure-leaks-lock)`, () => {
    const run = runtime.openInitiativeRun({ repository: '/repo', stateDir: tmp('lock-'), key: 'k', maxLaunches: 2, maxRounds: 2 });
    const lock = `${run.path}.lock`;
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (file, ...rest) {
      if (String(file) === path.join(lock, 'owner')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return realWrite.call(this, file, ...rest);
    };
    try { assert.throws(() => runtime.reserveLaunch(run, { role: 'correctness', round: 1 }), /ENOSPC/); } finally { fs.writeFileSync = realWrite; }
    assert.ok(!fs.existsSync(lock), 'the lock this process created must not outlive the failed owner write');
  });
}

for (const cliName of Object.keys(CLIS)) {
  test(`${cliName}: a rejected lite flag deletes no cached intent from an intent-review ledger (gate:design-conformance:lite-reject-before-state-write)`, () => {
    const t = setup(cliName, { mode: 'lite' });
    const slug = review.targetSlug('feat/x');
    review.writeLedger(t.stateDir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'intent-review', intentHash: 'h', intentBytes: 3 });
    const intent = path.join(t.stateDir, `intent-${slug}.md`);
    fs.writeFileSync(intent, 'req');
    const r = t.cli(['round-start', 'feat/x', 'HEAD~1', '--broad']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /lite/);
    assert.ok(fs.existsSync(intent), 'cached intent must survive a rejected round-start');
    assert.strictEqual(review.readLedger(t.stateDir, slug).status, 'intent-review');
  });
}
