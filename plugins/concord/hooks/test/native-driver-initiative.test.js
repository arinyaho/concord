'use strict';
// Native (Claude/Copilot) review CLI: keyed initiative budget, batch reservation,
// and enforcement at evidence acceptance. Runs the same scenarios against both
// providers' CLI entry points.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const { openInitiativeRun, reserveLaunch, recordDisposition, publicInitiativeSummary } = require('../../core/initiative-review-run');
const review = require('../../core/review');
const { safeIdForFilename } = require('../../core/artifact-name');

const PLUGINS = path.join(__dirname, '..', '..', '..');
const PROVIDERS = {
  claude: path.join(PLUGINS, 'concord', 'hooks', 'review-cli.js'),
  copilot: path.join(PLUGINS, 'concord-copilot', 'bin', 'review-cli.js'),
};

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function initRepo(config = { dod: ['true'] }) {
  const repo = tmp('native-init-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: repo });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify(config));
  git('add', '-A'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('commit', '-aqm', 'change');
  return repo;
}

function setup(provider, { config, maxLaunches = 20, maxRounds = 5 } = {}) {
  const repo = initRepo(config);
  const dir = tmp('native-init-state-');
  const initDir = tmp('native-init-ledger-');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const keyed = ['--initiative-run-key', 'key-1', '--initiative-state-dir', initDir, '--initiative-max-launches', String(maxLaunches), '--initiative-max-rounds', String(maxRounds)];
  const cli = (args, { key = true } = {}) => {
    const r = spawnSync('node', [PROVIDERS[provider], ...args, ...(key ? keyed : [])], { encoding: 'utf8', env, cwd: repo });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status, json: () => JSON.parse(r.stdout) };
  };
  const ok = (args) => { const r = cli(args); assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return r.json(); };
  const ledgerFile = () => path.join(initDir, fs.readdirSync(initDir).find((f) => /^initiative-review-.*\.json$/.test(f)));
  const initiative = () => JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
  const write = (n, name, obj) => fs.writeFileSync(path.join(dir, `round-${n}-${name.replace(/^fix-(.*)$/, (_, id) => `fix-${safeIdForFilename(id)}`)}.json`), JSON.stringify(obj));
  const start = () => { const r = cli(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { key: false }); assert.strictEqual(r.status, 0, r.stderr); return r.json().round; };
  return { repo, dir, initDir, env, cli, ok, initiative, write, start, ledgerFile };
}

const CLEAN = { status: 'ok', examined: ['a.txt'], findings: [] };
const finding = { id: 'correctness:bug', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' };

for (const provider of Object.keys(PROVIDERS)) {
  test(`${provider}: one budget is shared between a Codex-runner-opened ledger and native reservations (AC1)`, () => {
    const t = setup(provider, { maxLaunches: 3 });
    const run = openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches: 3, maxRounds: 5 });
    assert.ok(reserveLaunch(run, { role: 'correctness', round: 1, target: 'feat/x' }));
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'verify']).status, 'granted');
    assert.strictEqual(t.initiative().launches.length, 3);
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'intent']).status, 'denied');
    assert.strictEqual(reserveLaunch(run, { role: 'fix', round: 1, target: 'feat/x' }), false);
    assert.strictEqual(t.initiative().launches.length, 3);
  });

  test(`${provider}: a fan-out batch is granted or denied as a unit and a denial consumes nothing (AC2)`, () => {
    const t = setup(provider, { maxLaunches: 5 });
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    const denied = t.ok(['reserve', 'feat/x', 'lens']);
    assert.strictEqual(denied.status, 'denied');
    assert.strictEqual(denied.token, undefined);
    assert.strictEqual(t.initiative().launches.length, 1);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_reservations.length, 1);
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'verify']).status, 'granted');
    assert.strictEqual(t.initiative().launches.length, 2);
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'gate-review']).status, 'granted');
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'lens']).status, 'denied'); // 3 used + 5 lenses > 5
    assert.strictEqual(t.initiative().launches.length, 3);
  });

  test(`${provider}: a lock-contended reserve returns denied and consumes nothing (AC2)`, () => {
    const t = setup(provider);
    t.start();
    openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches: 20, maxRounds: 5 });
    const before = t.initiative();
    const lock = `${t.ledgerFile()}.lock`;
    fs.mkdirSync(lock);
    const r = t.ok(['reserve', 'feat/x', 'correctness']);
    fs.rmdirSync(lock);
    assert.strictEqual(r.status, 'denied');
    assert.deepStrictEqual(t.initiative().launches, before.launches);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_reservations, undefined);
  });

  test(`${provider}: a lock-contended reserve denial names the lock, its owner pid and how to remove it`, () => {
    const t = setup(provider);
    t.start();
    openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches: 20, maxRounds: 5 });
    const lock = `${t.ledgerFile()}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
    const r = t.ok(['reserve', 'feat/x', 'correctness']);
    const real = path.join(fs.realpathSync(path.dirname(lock)), path.basename(lock)); // the CLI reports the canonical path
    fs.rmSync(lock, { recursive: true, force: true });
    assert.strictEqual(r.status, 'denied');
    assert.ok(String(r.lockDiagnosis).includes(real), JSON.stringify(r));
    assert.match(r.lockDiagnosis, new RegExp(`owner pid ${process.pid} \\(still running\\)`));
    assert.ok(r.lockDiagnosis.includes(`rm -r ${real}`), r.lockDiagnosis);
  });

  test(`${provider}: unreserved evidence is rejected and fails the keyed run closed (AC3)`, () => {
    const t = setup(provider);
    const n = t.start();
    t.write(n, 'correctness', CLEAN);
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    const r = t.cli(['plan-fixes', 'feat/x']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /harness-failure: .*reservation/);
    assert.strictEqual(t.initiative().status, 'terminal');
    assert.strictEqual(t.cli(['reserve', 'feat/x', 'fix']).json().status, 'denied');
  });

  test(`${provider}: record, commit-fix and the panel each require a matching reservation (AC3)`, () => {
    for (const verb of ['record', 'commit-fix', 'panel']) {
      const t = setup(provider, { config: { dod: ['true'], gate: { panel: true } } });
      const n = t.start();
      const slug = review.targetSlug('feat/x');
      let args;
      if (verb === 'panel') {
        t.write(n, 'gate-panel-1-silent-gap', { status: 'ok', findings: [] });
        args = ['gate-panel-round-record', 'feat/x'];
      } else {
        t.ok(['reserve', 'feat/x', 'correctness']); t.ok(['reserve', 'feat/x', 'verify']);
        t.write(n, 'correctness', { ...CLEAN, findings: [finding] });
        t.write(n, 'verify', { status: 'ok', rejected: [] });
        assert.deepStrictEqual(t.ok(['plan-fixes', 'feat/x']).fixes.map((f) => f.id), ['correctness:bug']);
        t.write(n, 'fix-correctness:bug', { status: 'ok', edited: true, files: ['a.txt'] });
        args = verb === 'record' ? ['record', 'feat/x'] : ['commit-fix', 'feat/x', 'correctness:bug'];
      }
      assert.ok(review.readLedger(t.dir, slug));
      const r = t.cli(args);
      assert.notStrictEqual(r.status, 0, `${verb} accepted unreserved evidence`);
      assert.match(r.stderr, /harness-failure: .*reservation/);
      assert.strictEqual(t.initiative().status, 'terminal');
    }
  });

  test(`${provider}: reserved evidence is accepted, fix reservation is consumed by commit-fix (AC3)`, () => {
    const t = setup(provider);
    const n = t.start();
    t.ok(['reserve', 'feat/x', 'correctness']); t.ok(['reserve', 'feat/x', 'verify']);
    t.write(n, 'correctness', { ...CLEAN, findings: [finding] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    assert.strictEqual(t.ok(['plan-fixes', 'feat/x']).fixes.length, 1);
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'fix', '--count', '1']).status, 'granted');
    fs.writeFileSync(path.join(t.repo, 'a.txt'), 'three\n');
    t.write(n, 'fix-correctness:bug', { status: 'ok', edited: true, files: ['a.txt'] });
    const committed = t.ok(['commit-fix', 'feat/x', 'correctness:bug']);
    assert.strictEqual(committed.committed, true, JSON.stringify(committed));
    assert.strictEqual(t.initiative().status, 'active');
  });

  test(`${provider}: a material intent finding gives an empty fixer plan and no fixer reservation (AC4)`, () => {
    const t = setup(provider, { config: { dod: ['true'], intent: { command: 'printf "REQ: retry three times"' } } });
    const n = t.start();
    for (const role of ['correctness', 'verify', 'intent']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', { ...CLEAN, findings: [finding] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.write(n, 'intent', { status: 'ok', findings: [{ id: 'intent:retry', file: 'a.txt', span: 'two', summary: 's', requirement: 'retry three times' }] });
    assert.deepStrictEqual(t.ok(['plan-fixes', 'feat/x']).fixes, []);
    const out = t.ok(['record', 'feat/x']);
    assert.strictEqual(out.decision.reconciliation, true);
    assert.ok(!t.initiative().launches.some((l) => l.role === 'fix'));
    const disposition = t.initiative().dispositions[0];
    assert.deepStrictEqual([disposition.kind, disposition.reason], ['terminal', 'reconciliation-required']);
  });

  test(`${provider}: initiative ledger keeps no artifact path or token; public summary is aggregate only (AC5)`, () => {
    const t = setup(provider);
    const n = t.start();
    const tokens = ['correctness', 'verify'].map((role) => t.ok(['reserve', 'feat/x', role]).token);
    assert.ok(tokens.every((token) => typeof token === 'string' && token.length >= 16));
    t.write(n, 'correctness', CLEAN);
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.ok(['plan-fixes', 'feat/x']);
    const out = t.ok(['record', 'feat/x']);
    assert.strictEqual(out.decision.converged, true);
    const raw = fs.readFileSync(t.ledgerFile(), 'utf8');
    for (const secret of [t.dir, ...tokens, 'round-1-']) assert.ok(!raw.includes(secret), `initiative ledger leaked ${secret}`);
    const ledger = JSON.parse(raw);
    const disposition = ledger.dispositions[0];
    assert.strictEqual(disposition.target, 'feat/x');
    assert.match(disposition.revision.head_sha, /^[0-9a-f]{40}$/);
    assert.strictEqual(disposition.reason, 'clean');
    const summary = JSON.stringify(publicInitiativeSummary({ path: t.ledgerFile() }));
    assert.ok(!summary.includes('feat/x') && !summary.includes(disposition.revision.head_sha));
    assert.match(JSON.parse(summary).targetIds[0], /^[0-9a-f]{64}$/);
    assert.strictEqual(JSON.parse(summary).counts.launches, 2);
  });

  test(`${provider}: a retried launch needs a fresh reservation (P2-1)`, () => {
    for (const reserveAgain of [false, true]) {
      const t = setup(provider);
      const n = t.start();
      t.ok(['reserve', 'feat/x', 'correctness']); t.ok(['reserve', 'feat/x', 'verify']);
      t.write(n, 'correctness', { status: 'ok', examined: [], findings: [] });
      assert.strictEqual(t.ok(['artifact-normalize', 'feat/x', 'correctness']).status, 'retry');
      if (reserveAgain) assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
      t.write(n, 'correctness', CLEAN);
      assert.strictEqual(t.ok(['artifact-normalize', 'feat/x', 'correctness']).status, 'ok');
      t.write(n, 'verify', { status: 'ok', rejected: [] });
      const r = t.cli(['plan-fixes', 'feat/x']);
      if (reserveAgain) assert.strictEqual(r.status, 0, r.stderr);
      else {
        assert.notStrictEqual(r.status, 0, 'retry accepted on one reservation');
        assert.match(r.stderr, /harness-failure: .*reservation/);
        assert.strictEqual(t.initiative().status, 'terminal');
      }
    }
  });

  test(`${provider}: parallel reserve calls serialize: budget consumed equals tokens kept (P2-2)`, async () => {
    const t = setup(provider, { maxLaunches: 5 });
    t.start();
    const args = [PROVIDERS[provider], 'reserve', 'feat/x', 'correctness', '--initiative-run-key', 'key-1', '--initiative-state-dir', t.initDir, '--initiative-max-launches', '5', '--initiative-max-rounds', '5'];
    const child = () => new Promise((resolve) => {
      const c = spawn('node', args, { env: t.env, cwd: t.repo });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', () => resolve(out));
    });
    const outs = (await Promise.all(Array.from({ length: 5 }, child))).map((o) => { try { return JSON.parse(o); } catch (_) { throw new Error(o); } });
    assert.deepStrictEqual(outs.map((o) => o.status), Array(5).fill('granted'));
    assert.strictEqual(t.initiative().launches.length, 5);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_reservations.length, 5);
    assert.ok(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_reservations.every((r) => !('used' in r)));
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'verify']).status, 'denied');
    assert.strictEqual(t.initiative().launches.length, 5);
  });

  test(`${provider}: parallel reserve and telemetry-slot never lose a write over 20 trials (P2)`, async () => {
    const t = setup(provider, { maxLaunches: 100 });
    const n = t.start();
    const keyed = ['--initiative-run-key', 'key-1', '--initiative-state-dir', t.initDir, '--initiative-max-launches', '100', '--initiative-max-rounds', '5'];
    const child = (args) => new Promise((resolve) => {
      const c = spawn('node', [PROVIDERS[provider], ...args, ...keyed], { env: t.env, cwd: t.repo });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
    });
    const slotArgs = ['telemetry-slot', 'feat/x', path.join(t.dir, `round-${n}-correctness.json`), '--engine', 'claude-code'];
    const slug = review.targetSlug('feat/x');
    for (let i = 0; i < 20; i++) {
      const results = await Promise.all([child(['reserve', 'feat/x', 'correctness']), child(slotArgs), child(['reserve', 'feat/x', 'verify']), child(slotArgs)]);
      for (const r of results) assert.strictEqual(r.code, 0, r.out);
      const ledger = review.readLedger(t.dir, slug);
      assert.ok(ledger, `trial ${i}: ledger unreadable`);
      assert.strictEqual(ledger.initiative_reservations.length, 2 * (i + 1), `trial ${i}: lost reservation`);
      assert.strictEqual(ledger.telemetrySlots.length, 2 * (i + 1), `trial ${i}: lost telemetry slot`);
    }
    assert.strictEqual(t.initiative().launches.length, 40);
  });

  test(`${provider}: commit-fix rerun after a thrown failure is not charged twice (P3)`, () => {
    const t = setup(provider);
    const n = t.start();
    t.ok(['reserve', 'feat/x', 'correctness']); t.ok(['reserve', 'feat/x', 'verify']);
    t.write(n, 'correctness', { ...CLEAN, findings: [finding] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.ok(['plan-fixes', 'feat/x']);
    t.ok(['reserve', 'feat/x', 'fix', '--count', '1']);
    fs.writeFileSync(path.join(t.repo, 'a.txt'), 'three\n');
    t.write(n, 'fix-correctness:bug', { status: 'ok', edited: true, files: ['a.txt'], resolvedFindingIds: 'not-an-array' });
    const failed = t.cli(['commit-fix', 'feat/x', 'correctness:bug']);
    assert.notStrictEqual(failed.status, 0);
    assert.strictEqual(t.initiative().status, 'active');
    t.write(n, 'fix-correctness:bug', { status: 'ok', edited: true, files: ['a.txt'] });
    const committed = t.ok(['commit-fix', 'feat/x', 'correctness:bug']);
    assert.strictEqual(committed.committed, true, JSON.stringify(committed));
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_fix_used[n], 1);
  });

  test(`${provider}: a stuck target-ledger lock error names the lock path and how to clear it (P3)`, () => {
    const t = setup(provider);
    t.start();
    const lock = `${path.join(t.dir, `review-${review.targetSlug('feat/x')}.json`)}.lock`;
    fs.mkdirSync(lock);
    const r = t.cli(['reserve', 'feat/x', 'correctness']);
    assert.notStrictEqual(r.status, 0);
    assert.ok(r.stderr.includes(lock), r.stderr);
    assert.match(r.stderr, /rm -r/);
    assert.match(r.stderr, /owner unknown/);
    assert.ok(fs.existsSync(lock), 'the lock is never reclaimed automatically');
  });

  test(`${provider}: a killed keyed verb leaves a lock whose error names the dead owner pid (AC1)`, async () => {
    const t = setup(provider, { config: { dod: ['sleep 3'] } });
    const child = spawn('node', [PROVIDERS[provider], 'round-start', 'feat/x', 'HEAD~1', '--no-broad', '--initiative-run-key', 'key-1', '--initiative-state-dir', t.initDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'], { env: t.env, cwd: t.repo });
    const lock = `${path.join(t.dir, `review-${review.targetSlug('feat/x')}.json`)}.lock`;
    for (let i = 0; i < 100 && !fs.existsSync(path.join(lock, 'owner')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(path.join(lock, 'owner')), 'the lock holder records its pid');
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGTERM');
    await closed;
    assert.ok(fs.existsSync(lock), 'SIGTERM leaves the lock behind');
    const r = t.cli(['reserve', 'feat/x', 'correctness']);
    assert.notStrictEqual(r.status, 0);
    assert.ok(r.stderr.includes(lock), r.stderr);
    assert.ok(r.stderr.includes(`owner pid ${child.pid} (not running)`), r.stderr);
    assert.ok(fs.existsSync(lock), 'non-interactive runs never remove the lock');
  });

  test(`${provider}: keyed record fails when the terminal disposition is contended and a re-run records it (P2)`, () => {
    const t = setup(provider);
    const n = t.start();
    const run = openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches: 20, maxRounds: 5 });
    assert.ok(recordDisposition(run, { target: 'feat/x', revision: { ref: 'feat/x', head_sha: 'seed' }, result: { decision: { continue: false, gatePending: true } } }));
    t.ok(['reserve', 'feat/x', 'correctness']); t.ok(['reserve', 'feat/x', 'verify']);
    t.write(n, 'correctness', CLEAN);
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.ok(['plan-fixes', 'feat/x']);
    const lock = `${t.ledgerFile()}.lock`;
    fs.mkdirSync(lock);
    const blocked = t.cli(['record', 'feat/x']);
    fs.rmdirSync(lock);
    assert.notStrictEqual(blocked.status, 0, blocked.stdout);
    assert.match(blocked.stderr, /contended; re-run record/);
    assert.strictEqual(t.initiative().dispositions.length, 1);
    assert.notStrictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).phase, 'done');
    t.ok(['record', 'feat/x']);
    assert.ok(t.initiative().dispositions.some((d) => d.target === 'feat/x' && d.kind === 'terminal'));
  });

  test(`${provider}: keyed show is read-only and never denies a parallel reserve over 30 trials (P3)`, async () => {
    for (let i = 0; i < 30; i++) {
      const t = setup(provider);
      t.start();
      const initDir = tmp('native-init-ledger-');
      const keyed = ['--initiative-run-key', 'key-1', '--initiative-state-dir', initDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'];
      const child = (args) => new Promise((resolve) => {
        const c = spawn('node', [PROVIDERS[provider], ...args, ...keyed], { env: t.env, cwd: t.repo });
        let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
      });
      const [show, reserve] = await Promise.all([child(['show', 'feat/x']), child(['reserve', 'feat/x', 'correctness'])]);
      assert.strictEqual(show.code, 0, show.out);
      assert.strictEqual(reserve.code, 0, reserve.out);
      assert.strictEqual(JSON.parse(reserve.out).status, 'granted', `trial ${i}`);
    }
  });

  test(`${provider}: a contended finalise while failing closed is an error, not a silent active run (P3-a)`, () => {
    const t = setup(provider);
    const n = t.start();
    t.write(n, 'correctness', CLEAN);
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches: 20, maxRounds: 5 });
    fs.mkdirSync(`${t.ledgerFile()}.lock`);
    const r = t.cli(['plan-fixes', 'feat/x']);
    fs.rmdirSync(`${t.ledgerFile()}.lock`);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /finalis\w* .*contended|contended .*finalis/);
    assert.strictEqual(t.initiative().status, 'active');
  });

  test(`${provider}: initiative budgets without a key are an error (P3-b)`, () => {
    const t = setup(provider);
    t.start();
    const r = spawnSync('node', [PROVIDERS[provider], 'reserve', 'feat/x', 'correctness', '--initiative-max-launches', '3'], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /must be used together/);
  });

  test(`${provider}: run key and state dir must be given together; no key keeps reserve a no-op (AC1)`, () => {
    const t = setup(provider);
    t.start();
    const r = spawnSync('node', [PROVIDERS[provider], 'reserve', 'feat/x', 'correctness', '--initiative-run-key', 'k'], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /must be used together/);
    assert.strictEqual(t.cli(['reserve', 'feat/x', 'correctness'], { key: false }).json().status, 'granted');
    assert.strictEqual(fs.readdirSync(t.initDir).length, 0);
  });
}

test('cross-provider: the reserve verb answers identically (AC6)', () => {
  const answers = Object.keys(PROVIDERS).map((provider) => {
    const t = setup(provider, { maxLaunches: 2 });
    t.start();
    return ['correctness', 'lens', 'verify'].map((role) => { const { token, ...rest } = t.ok(['reserve', 'feat/x', role]); return rest; });
  });
  assert.deepStrictEqual(answers[0], answers[1]);
});

test('an interactive confirmation removes a stuck target lock; no answer or no leaves it (AC2)', () => {
  const { withTargetLock } = require('../../core/review-cli');
  const dir = tmp('native-lock-');
  const ledgerFile = path.join(dir, 'review-x.json');
  const lock = `${ledgerFile}.lock`;
  const stick = () => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'owner'), '999999\n'); };
  const asked = [];
  stick();
  assert.throws(() => withTargetLock(ledgerFile, () => 'ran', { confirm: (q) => { asked.push(q); return false; }, waitMs: 50 }), /target ledger lock is held/);
  assert.ok(fs.existsSync(lock), 'a no answer leaves the lock');
  assert.match(asked[0], new RegExp(lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(asked[0], /owner pid 999999/);
  assert.throws(() => withTargetLock(ledgerFile, () => "ran", { confirm: null, waitMs: 50 }), /target ledger lock is held/);
  assert.ok(fs.existsSync(lock), 'without a confirm function nothing is offered or removed');
  assert.strictEqual(withTargetLock(ledgerFile, () => 'ran', { confirm: () => true, waitMs: 50 }), 'ran');
  assert.ok(!fs.existsSync(lock), 'the lock is released after the verb runs');
});

for (const provider of Object.keys(PROVIDERS)) {
  test(`${provider}: a contended gate-pending escape after an unconsumed intent-review escape at one head is not reported recorded (AC3)`, () => {
    const t = setup(provider);
    const slug = review.targetSlug('feat/x');
    const n = t.start();
    t.ok(['reserve', 'feat/x', 'correctness']); t.ok(['reserve', 'feat/x', 'verify']);
    t.write(n, 'correctness', CLEAN);
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.ok(['plan-fixes', 'feat/x']);
    const planned = review.readLedger(t.dir, slug);
    review.writeLedger(t.dir, slug, { ...planned, gate_open: [{ id: 'gate:cross-context:x', file: 'a.txt', summary: 's', gate: 'cross-context', span: 'two' }] });
    const run = openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches: 20, maxRounds: 5 });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.repo, encoding: 'utf8' }).trim();
    const revision = { ref: 'feat/x', ...(planned.target?.base ? { base: planned.target.base } : {}), head_sha: head };
    assert.ok(recordDisposition(run, { target: 'feat/x', revision, result: { decision: { continue: false, intentReview: true } } }));
    fs.mkdirSync(`${t.ledgerFile()}.lock`);
    const blocked = t.cli(['record', 'feat/x']);
    fs.rmdirSync(`${t.ledgerFile()}.lock`);
    assert.notStrictEqual(blocked.status, 0, blocked.stdout);
    assert.match(blocked.stderr, /contended; re-run record/);
    assert.notStrictEqual(review.readLedger(t.dir, slug).phase, 'done');
    t.ok(['record', 'feat/x']);
    assert.deepStrictEqual(t.initiative().dispositions.filter((d) => d.kind === 'escape').map((d) => d.reason), ['intent-review', 'gate-pending']);
  });
}

for (const provider of Object.keys(PROVIDERS)) {
  // Seeds a terminal disposition for the current revision pair of feat/x, then moves the branch to a new head
  // and re-arms the per-ref target ledger with `rerun`, as a re-verification after a fix pass does.
  const reverifyOnNewHead = (t, maxLaunches, result) => {
    const target = review.readLedger(t.dir, review.targetSlug('feat/x')).target;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.repo, encoding: 'utf8' }).trim();
    const run = openInitiativeRun({ stateDir: t.initDir, key: 'key-1', repository: t.repo, maxLaunches, maxRounds: 5 });
    assert.ok(recordDisposition(run, { target: 'feat/x', revision: { ref: 'feat/x', ...(target?.base ? { base: target.base } : {}), head_sha: head }, result }));
    fs.writeFileSync(path.join(t.repo, 'a.txt'), 'three\n');
    execFileSync('git', ['commit', '-aqm', 'fix'], { cwd: t.repo });
    t.ok(['rerun', 'feat/x']);
    t.start();
  };

  test(`${provider}: a new head of a terminal ref reserves from the same budget (revision pair, AC1)`, () => {
    const t = setup(provider, { maxLaunches: 3 });
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    reverifyOnNewHead(t, 3, { decision: { converged: true } });
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    assert.strictEqual(t.initiative().launches.length, 2);
    assert.strictEqual(new Set(t.initiative().targets.map((x) => x.head_sha).filter(Boolean)).size, 2);
  });

  test(`${provider}: a new head after reconciliation-required returns reconciliation-required and reserves nothing (AC3)`, () => {
    const t = setup(provider, { maxLaunches: 3 });
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    reverifyOnNewHead(t, 3, { status: 'reconciliation-required' });
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'reconciliation-required');
    assert.strictEqual(t.initiative().launches.length, 1);
  });

  test(`${provider}: a new head with an exhausted budget is denied as budget-exhausted (AC4)`, () => {
    const t = setup(provider, { maxLaunches: 1 });
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    reverifyOnNewHead(t, 1, { decision: { converged: true } });
    const denied = t.ok(['reserve', 'feat/x', 'correctness']);
    assert.strictEqual(denied.status, 'denied');
    assert.strictEqual(denied.reason, 'budget-exhausted');
  });

  test(`${provider}: reserve stores the resolved base commit, so a base name that moves makes a different pair`, () => {
    const t = setup(provider, { maxLaunches: 5 });
    t.start(); // the per-ref ledger keeps the base name HEAD~1
    const rev = () => execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: t.repo, encoding: 'utf8' }).trim();
    const first = rev();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    fs.writeFileSync(path.join(t.repo, 'b.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: t.repo });
    execFileSync('git', ['commit', '-qm', 'move the base name'], { cwd: t.repo });
    const second = rev();
    assert.notStrictEqual(first, second);
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'verify']).status, 'granted');
    const targets = t.initiative().targets;
    assert.deepStrictEqual(targets.map((x) => x.base), [first, second]);
    assert.strictEqual(new Set(targets.map((x) => x.head_sha)).size, 1);
  });

  test(`${provider}: record writes the terminal on the head reserve opened, so a later head is not refused target-terminal`, () => {
    const t = setup(provider, { maxLaunches: 6 });
    const n = t.start();
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.repo, encoding: 'utf8' }).trim();
    const h1 = head();
    for (const role of ['correctness', 'verify']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', CLEAN);
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    fs.writeFileSync(path.join(t.repo, 'a.txt'), 'three\n');
    execFileSync('git', ['commit', '-aqm', 'a commit lands mid-round'], { cwd: t.repo });
    t.ok(['plan-fixes', 'feat/x']);
    assert.strictEqual(t.ok(['record', 'feat/x']).decision.converged, true);
    assert.deepStrictEqual(t.initiative().dispositions.map((d) => d.revision.head_sha), [h1]);
    t.ok(['rerun', 'feat/x']);
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
  });

  test(`${provider}: record stores the resolved base commit in the disposition revision`, () => {
    const t = setup(provider, { config: { dod: ['true'], intent: { command: 'printf "REQ: retry three times"' } } });
    const n = t.start();
    for (const role of ['correctness', 'verify', 'intent']) assert.strictEqual(t.ok(['reserve', 'feat/x', role]).status, 'granted');
    t.write(n, 'correctness', { ...CLEAN, findings: [finding] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    t.write(n, 'intent', { status: 'ok', findings: [{ id: 'intent:retry', file: 'a.txt', span: 'two', summary: 's', requirement: 'retry three times' }] });
    t.ok(['plan-fixes', 'feat/x']);
    t.ok(['record', 'feat/x']);
    const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: t.repo, encoding: 'utf8' }).trim();
    assert.strictEqual(t.initiative().dispositions[0].revision.base, base);
  });
}
