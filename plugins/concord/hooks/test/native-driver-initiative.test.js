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
const { openInitiativeRun, reserveLaunch, recordDisposition, publicInitiativeSummary, runPath, canonicalPath } = require('../../core/initiative-review-run');
const review = require('../../core/review');
const { safeIdForFilename } = require('../../core/artifact-name');
const { PANEL_LENSES } = require('../../core/report');

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
  const start = () => { const bound = !!review.readLedger(dir, review.targetSlug('feat/x'))?.initiative_binding; const r = cli(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { key: bound }); assert.strictEqual(r.status, 0, r.stderr); return r.json().round; };
  return { repo, dir, initDir, env, keyed, cli, ok, initiative, write, start, ledgerFile };
}

const CLEAN = { status: 'ok', examined: ['a.txt'], findings: [] };
const finding = { id: 'correctness:bug', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' };

for (const provider of Object.keys(PROVIDERS)) {
  test(`${provider}: bound initiative rejects omitted flags without changing either ledger`, () => {
    const t = setup(provider);
    t.start();
    t.ok(['reserve', 'feat/x', 'correctness']);
    const targetBefore = fs.readFileSync(review.ledgerPath(t.dir, review.targetSlug('feat/x')), 'utf8');
    const runBefore = t.initiative();
    for (const args of [['reserve', 'feat/x', 'verify'], ['reset', 'feat/x'], ['rerun', 'feat/x'], ['record', 'feat/x'], ['round-start', 'feat/x', 'HEAD~1']]) {
      const result = t.cli(args, { key: false });
      assert.notStrictEqual(result.status, 0, `${args[0]} escaped the initiative budget`);
      assert.match(result.stderr, /initiative.*flags/i);
      assert.strictEqual(fs.readFileSync(review.ledgerPath(t.dir, review.targetSlug('feat/x')), 'utf8'), targetBefore);
      assert.deepStrictEqual(t.initiative(), runBefore);
    }
    assert.strictEqual(t.cli(['show', 'feat/x'], { key: false }).status, 0);
  });

  test(`${provider}: keyed reset cannot discard history or restore budget`, () => {
    const t = setup(provider, { maxLaunches: 1 });
    t.start();
    t.ok(['reserve', 'feat/x', 'correctness']);
    const before = t.initiative();
    const result = t.cli(['reset', 'feat/x']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /reset.*initiative.*rerun/i);
    assert.ok(review.readLedger(t.dir, review.targetSlug('feat/x')));
    assert.deepStrictEqual(t.initiative(), before);
    t.ok(['rerun', 'feat/x']);
    assert.ok(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding);
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'verify']).reason, 'budget-exhausted');
  });

  test(`${provider}: changing the initiative binding cannot restore exhausted budget`, () => {
    const t = setup(provider, { maxLaunches: 1 });
    t.start();
    t.ok(['reserve', 'feat/x', 'correctness']);
    const before = t.initiative();
    const targetBefore = review.readLedger(t.dir, review.targetSlug('feat/x'));
    const anotherDir = tmp('native-other-init-');
    for (const [flag, value] of [['--initiative-run-key', 'key-2'], ['--initiative-state-dir', anotherDir]]) {
      const options = [...t.keyed];
      options[options.indexOf(flag) + 1] = value;
      const result = spawnSync('node', [PROVIDERS[provider], 'rerun', 'feat/x', ...options], { encoding: 'utf8', env: t.env, cwd: t.repo });
      assert.notStrictEqual(result.status, 0, `${flag} restored the budget`);
      assert.match(result.stderr, /different initiative binding/);
      assert.deepStrictEqual(t.initiative(), before);
      assert.deepStrictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')), targetBefore);
    }
    assert.deepStrictEqual(fs.readdirSync(anotherDir), []);
    assert.strictEqual(fs.readdirSync(t.initDir).filter((f) => f.endsWith('.json')).length, 1);
  });

  test(`${provider}: legacy reservations without a binding cannot adopt an initiative identity`, () => {
    const t = setup(provider, { maxLaunches: 1 });
    t.start();
    t.ok(['reserve', 'feat/x', 'correctness']);
    const targetFile = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
    const legacy = review.readLedger(t.dir, review.targetSlug('feat/x'));
    delete legacy.initiative_binding;
    fs.writeFileSync(targetFile, JSON.stringify(legacy));
    const targetBefore = fs.readFileSync(targetFile, 'utf8');
    const runBefore = fs.readFileSync(t.ledgerFile(), 'utf8');
    const anotherDir = tmp('native-legacy-other-init-');
    const identities = [t.keyed, ...[['--initiative-run-key', 'key-2'], ['--initiative-state-dir', anotherDir]].map(([flag, value]) => {
      const options = [...t.keyed];
      options[options.indexOf(flag) + 1] = value;
      return options;
    })];
    for (const options of identities) {
      for (const args of [['reserve', 'feat/x', 'verify'], ['rerun', 'feat/x'], ['round-start', 'feat/x', 'HEAD~1', '--no-broad']]) {
        const result = spawnSync('node', [PROVIDERS[provider], ...args, ...options], { encoding: 'utf8', env: t.env, cwd: t.repo });
        assert.notStrictEqual(result.status, 0, `${args[0]} adopted an unproven legacy identity`);
        assert.match(result.stderr, /legacy.*binding.*reconcil/i);
        assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), targetBefore);
        assert.strictEqual(fs.readFileSync(t.ledgerFile(), 'utf8'), runBefore);
      }
    }
    assert.deepStrictEqual(fs.readdirSync(anotherDir), []);
    assert.strictEqual(fs.readdirSync(t.initDir).filter((f) => f.endsWith('.json')).length, 1);
    assert.strictEqual(t.cli(['show', 'feat/x'], { key: false }).status, 0);
    assert.strictEqual(t.cli(['show', 'feat/x']).status, 0);
    assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), targetBefore);
    assert.strictEqual(fs.readFileSync(t.ledgerFile(), 'utf8'), runBefore);
  });
}

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
    assert.ok(r.lockDiagnosis.includes(`rm -r "${real}"`), r.lockDiagnosis);
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

// `carry`: recovering a target whose shared budget was blocked mid-round under
// a new run key (issue #144). Every scenario shares one setup: maxLaunches:1
// so the correctness reservation succeeds and the verify reservation that
// follows is denied budget-exhausted on an already-bound target.
for (const provider of Object.keys(PROVIDERS)) {
  function carryFlags(t, key, { maxLaunches = 5, maxRounds = 5 } = {}) {
    return ['--initiative-run-key', key, '--initiative-state-dir', t.initDir, '--initiative-max-launches', String(maxLaunches), '--initiative-max-rounds', String(maxRounds)];
  }
  function carry(t, fromKey, toFlags) {
    return spawnSync('node', [PROVIDERS[provider], 'carry', 'feat/x', '--from-run-key', fromKey, ...toFlags], { encoding: 'utf8', env: t.env, cwd: t.repo });
  }
  function ledgerForKey(t, key) {
    return JSON.parse(fs.readFileSync(runPath(t.initDir, key), 'utf8'));
  }
  function blockedSetup(provider, opts = {}) {
    const t = setup(provider, { maxLaunches: 1, ...opts });
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    t.write(review.readLedger(t.dir, review.targetSlug('feat/x')).round, 'correctness', CLEAN);
    const denied = t.ok(['reserve', 'feat/x', 'verify']);
    assert.strictEqual(denied.status, 'denied');
    assert.strictEqual(denied.reason, 'budget-exhausted');
    return t;
  }

  test(`${provider}: a budget-exhausted denial on a bound target writes initiative_blocked; round-start under another key without carry is still refused (AC1)`, () => {
    const t = blockedSetup(provider);
    const ledger = review.readLedger(t.dir, review.targetSlug('feat/x'));
    assert.ok(ledger.initiative_blocked, 'no initiative_blocked marker written');
    assert.strictEqual(ledger.initiative_blocked.key, 'key-1');
    assert.strictEqual(ledger.initiative_blocked.stateDir, canonicalPath(t.initDir));
    assert.strictEqual(ledger.initiative_blocked.role, 'verify');
    assert.strictEqual(ledger.initiative_blocked.round, ledger.round);
    assert.strictEqual(ledger.initiative_blocked.attemptId, ledger.attemptId);
    const otherFlags = carryFlags(t, 'key-2');
    const result = spawnSync('node', [PROVIDERS[provider], 'round-start', 'feat/x', 'HEAD~1', '--no-broad', ...otherFlags], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /different initiative binding/);
  });

  test(`${provider}: carry A->B binds the target to B, leaves A's terminal carried, and only later launches are charged to B (AC2, AC3)`, () => {
    const t = blockedSetup(provider);
    const n = review.readLedger(t.dir, review.targetSlug('feat/x')).round;
    const aLaunchesBefore = ledgerForKey(t, 'key-1').launches.length;
    const bFlags = carryFlags(t, 'key-2');
    const carried = carry(t, 'key-1', bFlags);
    assert.strictEqual(carried.status, 0, carried.stderr);
    const result = JSON.parse(carried.stdout);
    assert.deepStrictEqual(result, { status: 'carried', from: 'key-1', to: 'key-2', round: n });

    const after = review.readLedger(t.dir, review.targetSlug('feat/x'));
    assert.strictEqual(after.initiative_binding.key, 'key-2');
    assert.strictEqual(after.initiative_binding.stateDir, canonicalPath(t.initDir));
    assert.strictEqual(after.initiative_blocked, undefined);
    assert.strictEqual(after.initiative_carries.length, 1);
    assert.strictEqual(after.initiative_carries[0].from, 'key-1');
    assert.strictEqual(after.initiative_carries[0].to, 'key-2');
    assert.strictEqual(after.phase, 'gates');
    assert.strictEqual(after.round, n);

    const a = ledgerForKey(t, 'key-1');
    assert.strictEqual(a.launches.length, aLaunchesBefore, "A's launches changed");
    const terminal = a.dispositions.find((d) => d.target === 'feat/x' && d.kind === 'terminal');
    assert.ok(terminal, 'no terminal disposition recorded on A');
    assert.strictEqual(terminal.reason, 'carried');
    assert.strictEqual(terminal.packet.carriedTo.key, 'key-2');
    assert.strictEqual(terminal.packet.carriedTo.stateDir, canonicalPath(t.initDir));
    assert.strictEqual(terminal.packet.nextAction, 'carried');

    const bBefore = ledgerForKey(t, 'key-2');
    assert.strictEqual(bBefore.launches.length, 0, 'B charged before any launch of its own');
    assert.strictEqual(bBefore.rounds.length, 0, 'B opened a round before any launch of its own');

    // B reserves only the round's remaining role and the round completes.
    const verifyReserve = spawnSync('node', [PROVIDERS[provider], 'reserve', 'feat/x', 'verify', ...bFlags], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.strictEqual(verifyReserve.status, 0, verifyReserve.stderr);
    assert.strictEqual(JSON.parse(verifyReserve.stdout).status, 'granted');
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    const planned = spawnSync('node', [PROVIDERS[provider], 'plan-fixes', 'feat/x', ...bFlags], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.strictEqual(planned.status, 0, planned.stderr);
    const recorded = spawnSync('node', [PROVIDERS[provider], 'record', 'feat/x', ...bFlags], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.strictEqual(recorded.status, 0, recorded.stderr);
    assert.strictEqual(JSON.parse(recorded.stdout).decision.converged, true);

    // Total launches charged across both keys equal the launches actually made: one correctness (A), one verify (B).
    assert.strictEqual(ledgerForKey(t, 'key-1').launches.length, 1);
    assert.strictEqual(ledgerForKey(t, 'key-2').launches.length, 1);
  });

  test(`${provider}: carry is refused for every invalid call (AC4)`, () => {
    const scenarios = [
      {
        name: 'no marker',
        build: () => { const t = setup(provider, { maxLaunches: 5 }); t.start(); assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted'); return t; },
        pattern: /no budget-exhausted marker/,
      },
      {
        name: 'marker from another round',
        build: () => {
          const t = blockedSetup(provider);
          const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
          const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
          fs.writeFileSync(file, JSON.stringify({ ...ledger, initiative_blocked: { ...ledger.initiative_blocked, round: ledger.round + 1 } }));
          return t;
        },
        pattern: /different round or attempt/,
      },
      {
        name: 'marker from another attempt',
        build: () => {
          const t = blockedSetup(provider);
          const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
          const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
          fs.writeFileSync(file, JSON.stringify({ ...ledger, initiative_blocked: { ...ledger.initiative_blocked, attemptId: `${ledger.initiative_blocked.attemptId}-other` } }));
          return t;
        },
        pattern: /different round or attempt/,
      },
      {
        name: 'wrong --from-run-key',
        build: () => blockedSetup(provider),
        fromKey: 'key-9',
        pattern: /not bound to --from-run-key/,
      },
      {
        name: 'same key',
        build: () => blockedSetup(provider),
        fromKey: 'key-1',
        toKey: 'key-1',
        pattern: /must differ/,
      },
      {
        name: 'mode change',
        build: () => blockedSetup(provider),
        toFlags: (t) => [...carryFlags(t, 'key-2'), '--initiative-mode', 'lite'],
        pattern: /mode differs/,
      },
      {
        name: 'finalised old run',
        build: (t = blockedSetup(provider)) => {
          const r = spawnSync('node', [PROVIDERS[provider], 'finalise', ...t.keyed], { encoding: 'utf8', env: t.env, cwd: t.repo });
          assert.strictEqual(r.status, 0, r.stderr);
          return t;
        },
        pattern: /old run is not active/,
      },
      {
        name: 'terminal old run for the same pair',
        build: () => {
          const t = blockedSetup(provider);
          const ledger = review.readLedger(t.dir, review.targetSlug('feat/x'));
          const run = { path: runPath(t.initDir, 'key-1') };
          assert.ok(recordDisposition(run, { target: 'feat/x', revision: { ref: 'feat/x', base: execFileSync('git', ['rev-parse', ledger.target.base], { cwd: t.repo, encoding: 'utf8' }).trim(), head_sha: ledger.target.head_sha }, result: { status: 'clean' } }));
          return t;
        },
        pattern: /already holds a terminal disposition \("clean"\)/,
      },
      {
        name: 'target under reconciliation',
        build: () => {
          const t = blockedSetup(provider);
          const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
          const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
          fs.writeFileSync(file, JSON.stringify({ ...ledger, reconciliation: { hint: { trigger: 'reconciliation-required' } } }));
          return t;
        },
        pattern: /parked for reconciliation/,
      },
      {
        name: 'moved HEAD',
        build: () => {
          const t = blockedSetup(provider);
          fs.writeFileSync(path.join(t.repo, 'b.txt'), 'x\n');
          execFileSync('git', ['add', '-A'], { cwd: t.repo });
          execFileSync('git', ['commit', '-qm', 'head moves after the block'], { cwd: t.repo });
          return t;
        },
        pattern: /live HEAD has moved|different revision pair/,
      },
      {
        name: 'a new run that is already exhausted',
        build: () => {
          const t = blockedSetup(provider);
          const run = openInitiativeRun({ stateDir: t.initDir, key: 'key-2', repository: t.repo, maxLaunches: 1, maxRounds: 5 });
          assert.ok(reserveLaunch(run, { role: 'correctness', round: 0, target: 'other' }));
          return t;
        },
        toFlags: (t) => carryFlags(t, 'key-2', { maxLaunches: 1 }),
        pattern: /new run refuses this pair \(budget-exhausted\)/,
        preCreatesNewRun: true,
      },
      {
        name: 'unbound target',
        build: () => { const t = setup(provider, { maxLaunches: 5 }); t.start(); return t; },
        pattern: /unbound|legacy/,
      },
      {
        name: 'legacy unbound reservations',
        build: () => {
          const t = blockedSetup(provider);
          const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
          const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
          delete legacy.initiative_binding;
          fs.writeFileSync(file, JSON.stringify(legacy));
          return t;
        },
        pattern: /unbound|legacy/,
      },
    ];
    for (const scenario of scenarios) {
      const t = scenario.build();
      const toKey = scenario.toKey || 'key-2';
      const fromKey = scenario.fromKey || 'key-1';
      const toFlags = scenario.toFlags ? scenario.toFlags(t) : carryFlags(t, toKey);
      const result = carry(t, fromKey, toFlags);
      assert.notStrictEqual(result.status, 0, `${scenario.name}: carry should have been refused`);
      assert.match(result.stderr, scenario.pattern, `${scenario.name}: ${result.stderr}`);
      // A refused carry must never leave behind a spare ledger for the new
      // key it never actually used (the P3 fix): skip only where the
      // scenario itself pre-created that key's run, or where toKey IS
      // fromKey (that run obviously exists already).
      if (!scenario.preCreatesNewRun && toKey !== fromKey) {
        assert.strictEqual(fs.existsSync(runPath(t.initDir, toKey)), false, `${scenario.name}: refused carry created the new key's run ledger`);
      }
    }
  });

  test(`${provider}: a second carry (A->C after A->B) is refused (AC4)`, () => {
    const t = blockedSetup(provider);
    const bFlags = carryFlags(t, 'key-2');
    assert.strictEqual(carry(t, 'key-1', bFlags).status, 0);
    const cFlags = carryFlags(t, 'key-3');
    const second = carry(t, 'key-1', cFlags);
    assert.notStrictEqual(second.status, 0);
    assert.match(second.stderr, /not bound to --from-run-key/);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-2');
  });

  test(`${provider}: a crash after the old-run disposition is written resumes on retry; a different key is refused (AC5)`, () => {
    const t = blockedSetup(provider);
    const ledger = review.readLedger(t.dir, review.targetSlug('feat/x'));
    const bFlags = carryFlags(t, 'key-2');
    const newStateDir = canonicalPath(t.initDir);
    // Simulate the crash window: the old run's terminal `carried` disposition
    // landed, but the target-ledger write (step 4) never did.
    const oldRun = { path: runPath(t.initDir, 'key-1') };
    assert.ok(recordDisposition(oldRun, {
      target: 'feat/x',
      revision: { ref: 'feat/x', base: execFileSync('git', ['rev-parse', ledger.target.base], { cwd: t.repo, encoding: 'utf8' }).trim(), head_sha: ledger.target.head_sha },
      result: { status: 'carried' },
      packet: { nextAction: 'carried', carriedTo: { key: 'key-2', stateDir: newStateDir } },
    }));
    // Retrying the same carry completes.
    const retried = carry(t, 'key-1', bFlags);
    assert.strictEqual(retried.status, 0, retried.stderr);
    assert.strictEqual(JSON.parse(retried.stdout).status, 'carried');
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-2');
  });

  test(`${provider}: unreserved evidence in the carried round fails the old run closed and aborts the carry (AC6)`, () => {
    const t = blockedSetup(provider);
    // Write a correctness artifact for a SECOND time without a matching
    // reservation -- requireReservations must see it as uncovered.
    const n = review.readLedger(t.dir, review.targetSlug('feat/x')).round;
    t.write(n, 'gate', CLEAN); // gate-review was never reserved for this round
    const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...ledger, gateApplied: true }));
    const bFlags = carryFlags(t, 'key-2');
    const result = carry(t, 'key-1', bFlags);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /harness-failure.*carry/);
    assert.strictEqual(ledgerForKey(t, 'key-1').status, 'terminal', 'the old run was not failed closed');
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-1', 'the target was carried despite unreserved evidence');
    assert.strictEqual(fs.existsSync(runPath(t.initDir, 'key-2')), false, "the new key's run ledger was created before the old run's reservations were validated");
  });

  test(`${provider}: a mismatched-mode carry is refused before any ledger for the new key is created (P2-1)`, () => {
    const t = blockedSetup(provider);
    const toFlags = [...carryFlags(t, 'key-2'), '--initiative-mode', 'lite'];
    const result = carry(t, 'key-1', toFlags);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /mode differs/);
    assert.strictEqual(fs.existsSync(runPath(t.initDir, 'key-2')), false, 'the new run ledger was created despite the mode mismatch');
  });

  test(`${provider}: a new run without room for the whole blocked batch is refused, not just room for one launch (P3-3)`, () => {
    const t = setup(provider, { maxLaunches: 1 });
    t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    t.write(review.readLedger(t.dir, review.targetSlug('feat/x')).round, 'correctness', CLEAN);
    const denied = t.ok(['reserve', 'feat/x', 'fix', '--count', '2']);
    assert.strictEqual(denied.status, 'denied');
    assert.strictEqual(denied.reason, 'budget-exhausted');
    const marker = review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_blocked;
    assert.strictEqual(marker.role, 'fix');
    assert.strictEqual(marker.count, 2);

    // A new run with room for only ONE launch would pass a count-1 readiness
    // probe but has no room for the blocked batch (2) -- it must be refused.
    const toFlags = carryFlags(t, 'key-2', { maxLaunches: 1 });
    const result = carry(t, 'key-1', toFlags);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /new run refuses this pair \(budget-exhausted\)/);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-1', 'the target was carried despite the new run having no room for the batch');
    assert.strictEqual(fs.existsSync(runPath(t.initDir, 'key-2')), false, "a fresh new key too small for the blocked batch was created before carry refused it");
  });

  test(`${provider}: a wrong --from-run-key with rerun_cleanup pending is refused before cleanup runs (P3-4)`, () => {
    const t = blockedSetup(provider);
    const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A deliberately bogus rerun_cleanup pointer: if the binding check does not
    // run before finishRerunCleanup, reading this nonexistent manifest throws,
    // masking the real carry refusal, and cleanup (deleting evidence) proceeds.
    const poisoned = { manifestPath: path.join(t.dir, 'does-not-exist-manifest.json'), sha256: '0'.repeat(64) };
    fs.writeFileSync(file, JSON.stringify({ ...ledger, rerun_cleanup: poisoned }));
    const result = carry(t, 'key-9', carryFlags(t, 'key-2'));
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /not bound to --from-run-key/);
    assert.strictEqual(fs.existsSync(runPath(t.initDir, 'key-2')), false, 'openKeyedRun ran for the new key before carry refused');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rerun_cleanup, poisoned, 'cleanup ran despite the wrong --from-run-key');
  });

  test(`${provider}: a carry under rerun_cleanup that omits --initiative-mode against a lite old run is refused before the new key's ledger is created (fix)`, () => {
    // Regression for a P3 fix: when rerun_cleanup is pending, main() used to
    // open the new key's run (defaulting its mode to 'base') before carry's
    // own mode check ever ran, poisoning the new key's ledger as 'base' even
    // though the old run is 'lite'. The mode check must run, and the new
    // key's run must stay unopened, before any rerun_cleanup side effect.
    const t = setup(provider, { maxLaunches: 1 });
    const liteKeyed = ['--initiative-run-key', 'key-1', '--initiative-state-dir', t.initDir, '--initiative-max-launches', '1', '--initiative-max-rounds', '5', '--initiative-mode', 'lite'];
    const run = (args) => spawnSync('node', [PROVIDERS[provider], ...args, ...liteKeyed], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.strictEqual(run(['round-start', 'feat/x', 'HEAD~1']).status, 0);
    const reserved = run(['reserve', 'feat/x', 'correctness']);
    assert.strictEqual(reserved.status, 0, reserved.stderr);
    assert.strictEqual(JSON.parse(reserved.stdout).status, 'granted');
    const n = review.readLedger(t.dir, review.targetSlug('feat/x')).round;
    t.write(n, 'correctness', CLEAN);
    const denied = run(['reserve', 'feat/x', 'verify']);
    assert.strictEqual(JSON.parse(denied.stdout).status, 'denied');
    assert.strictEqual(JSON.parse(denied.stdout).reason, 'budget-exhausted');

    const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A deliberately bogus rerun_cleanup pointer, same as P3-4: if cleanup ran
    // before the mode mismatch is reported, reading this nonexistent manifest
    // throws, masking the real refusal.
    const poisoned = { manifestPath: path.join(t.dir, 'does-not-exist-manifest.json'), sha256: '0'.repeat(64) };
    fs.writeFileSync(file, JSON.stringify({ ...ledger, rerun_cleanup: poisoned }));

    const result = carry(t, 'key-1', carryFlags(t, 'key-2')); // no --initiative-mode: defaults to base, but the old run is lite
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /mode differs/);
    assert.strictEqual(fs.existsSync(runPath(t.initDir, 'key-2')), false, "the new key's run ledger was created despite the mode mismatch under rerun_cleanup");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rerun_cleanup, poisoned, 'cleanup ran despite the mode mismatch');
  });

  test(`${provider}: a gate-panel-pending carry with an unreserved panel artifact fails the old run closed (P3-5)`, () => {
    const t = blockedSetup(provider);
    const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = ledger.round;
    fs.writeFileSync(file, JSON.stringify({ ...ledger, phase: 'done', status: 'gate-panel-pending', gate_panel: { round: 0 } }));
    // An unreserved lens artifact for the pending panel round (m = 1): no
    // 'lens' reservation was ever made for this target.
    t.write(n, `gate-panel-1-${PANEL_LENSES[0]}`, { status: 'ok', findings: [] });
    const result = carry(t, 'key-1', carryFlags(t, 'key-2'));
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /harness-failure.*carry/);
    assert.strictEqual(ledgerForKey(t, 'key-1').status, 'terminal', 'the old run was not failed closed');
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-1', 'the target was carried despite unreserved panel evidence');
  });

  test(`${provider}: carry succeeds from the gate-panel-pending phase when no panel evidence is unreserved (test gap)`, () => {
    const t = blockedSetup(provider);
    const file = review.ledgerPath(t.dir, review.targetSlug('feat/x'));
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...ledger, phase: 'done', status: 'gate-panel-pending', gate_panel: { round: 0 } }));
    const result = carry(t, 'key-1', carryFlags(t, 'key-2'));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).status, 'carried');
  });

  test(`${provider}: carry succeeds from the fixes phase (test gap)`, () => {
    const t = setup(provider, { maxLaunches: 2 });
    const n = t.start();
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'correctness']).status, 'granted');
    assert.strictEqual(t.ok(['reserve', 'feat/x', 'verify']).status, 'granted');
    t.write(n, 'correctness', { ...CLEAN, findings: [finding] });
    t.write(n, 'verify', { status: 'ok', rejected: [] });
    assert.strictEqual(t.ok(['plan-fixes', 'feat/x']).fixes.length, 1);
    const denied = t.ok(['reserve', 'feat/x', 'fix', '--count', '1']);
    assert.strictEqual(denied.status, 'denied');
    assert.strictEqual(denied.reason, 'budget-exhausted');
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).phase, 'fixes');

    const result = carry(t, 'key-1', carryFlags(t, 'key-2'));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).status, 'carried');
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-2');
  });

  test(`${provider}: a crash after the old-run disposition is written, then a DIFFERENT key, is refused (AC5 test gap)`, () => {
    const t = blockedSetup(provider);
    const ledger = review.readLedger(t.dir, review.targetSlug('feat/x'));
    const newStateDir = canonicalPath(t.initDir);
    const oldRun = { path: runPath(t.initDir, 'key-1') };
    assert.ok(recordDisposition(oldRun, {
      target: 'feat/x',
      revision: { ref: 'feat/x', base: execFileSync('git', ['rev-parse', ledger.target.base], { cwd: t.repo, encoding: 'utf8' }).trim(), head_sha: ledger.target.head_sha },
      result: { status: 'carried' },
      packet: { nextAction: 'carried', carriedTo: { key: 'key-2', stateDir: newStateDir } },
    }));
    const different = carry(t, 'key-1', carryFlags(t, 'key-3'));
    assert.notStrictEqual(different.status, 0);
    assert.match(different.stderr, /already carried to a different run key/);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-1', 'the crash window let a different key through');
  });

  test(`${provider}: a crash retry still resumes after the old run was finalised in between; a different key stays refused (P3-2)`, () => {
    const t = blockedSetup(provider);
    const ledger = review.readLedger(t.dir, review.targetSlug('feat/x'));
    const newStateDir = canonicalPath(t.initDir);
    const oldRun = { path: runPath(t.initDir, 'key-1') };
    assert.ok(recordDisposition(oldRun, {
      target: 'feat/x',
      revision: { ref: 'feat/x', base: execFileSync('git', ['rev-parse', ledger.target.base], { cwd: t.repo, encoding: 'utf8' }).trim(), head_sha: ledger.target.head_sha },
      result: { status: 'carried' },
      packet: { nextAction: 'carried', carriedTo: { key: 'key-2', stateDir: newStateDir } },
    }));
    // A reconciliation step finalises the old run before the crashed carry retries.
    const finalised = spawnSync('node', [PROVIDERS[provider], 'finalise', ...t.keyed], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.strictEqual(finalised.status, 0, finalised.stderr);
    assert.strictEqual(ledgerForKey(t, 'key-1').status, 'terminal');

    const retried = carry(t, 'key-1', carryFlags(t, 'key-2'));
    assert.strictEqual(retried.status, 0, retried.stderr);
    assert.strictEqual(JSON.parse(retried.stdout).status, 'carried');
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-2');
  });

  test(`${provider}: a new run parked for reconciliation on an unopened pair refuses the carry (test gap)`, () => {
    const t = blockedSetup(provider);
    const run2 = openInitiativeRun({ stateDir: t.initDir, key: 'key-2', repository: t.repo, maxLaunches: 5, maxRounds: 5 });
    const ledger2 = JSON.parse(fs.readFileSync(run2.path, 'utf8'));
    fs.writeFileSync(run2.path, JSON.stringify({ ...ledger2, reconciliation: { terminals: [], hint: { trigger: 'reconciliation-required' } } }));
    const result = carry(t, 'key-1', carryFlags(t, 'key-2'));
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /new run refuses this pair \(reconciliation-required\)/);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-1');
  });

  test(`${provider}: a new run already terminal for this pair refuses the carry (test gap)`, () => {
    const t = blockedSetup(provider);
    const ledger = review.readLedger(t.dir, review.targetSlug('feat/x'));
    const run2 = openInitiativeRun({ stateDir: t.initDir, key: 'key-2', repository: t.repo, maxLaunches: 5, maxRounds: 5 });
    const revision = { ref: 'feat/x', base: execFileSync('git', ['rev-parse', ledger.target.base], { cwd: t.repo, encoding: 'utf8' }).trim(), head_sha: ledger.target.head_sha };
    assert.ok(recordDisposition(run2, { target: 'feat/x', revision, result: { status: 'clean' } }));
    const result = carry(t, 'key-1', carryFlags(t, 'key-2'));
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /new run refuses this pair \(target-terminal\)/);
    assert.strictEqual(review.readLedger(t.dir, review.targetSlug('feat/x')).initiative_binding.key, 'key-1');
  });

  test(`${provider}: the old run finalising concurrently, between carry's reservation check and its disposition write, is reported as "not active", not contention (fix)`, { timeout: 15000 }, async (t2) => {
    // Regression: recordDisposition returns false both on genuine lock
    // contention and when its own fresh read finds the run no longer active.
    // carryBudgetBlockedTarget used to report the first message ("contended;
    // retry") for both, so a reconciler retrying after a concurrent finalise
    // kept hitting "not active" instead. Pause carry right after its own
    // requireReservations check (which reads the old run and finds it active)
    // and before recordDisposition's own fresh read, finalise the old run in
    // that window, then let carry proceed.
    const t = blockedSetup(provider);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-finalise-race-'));
    const hook = path.join(root, 'pause-read.cjs');
    const paused = path.join(root, 'paused');
    const release = path.join(root, 'release');
    t2.after(() => { try { fs.writeFileSync(release, 'release'); } catch (_) { /* already released */ } fs.rmSync(root, { recursive: true, force: true }); });
    // requireReservations' own active check is the 4th read of the old run's
    // ledger file in the carry process (after main()'s mode check, the initial load and
    // the old-run budget-exhausted re-check); pausing right after it lets
    // recordDisposition's own read, inside its lock, see a status this hook
    // just flipped to terminal.
    fs.writeFileSync(hook, `
'use strict';
const fs = require('node:fs');
const read = fs.readFileSync;
let count = 0, paused = false;
fs.readFileSync = function(file, ...args) {
  const result = read.call(this, file, ...args);
  if (!paused && process.env.RACE_PAUSE_PATH && file === process.env.RACE_PAUSE_PATH) {
    count += 1;
    if (count === Number(process.env.RACE_PAUSE_AFTER_READ)) {
      paused = true;
      fs.writeFileSync(process.env.RACE_PAUSED, 'paused');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(process.env.RACE_RELEASE)) {
        if (Date.now() > deadline) throw new Error('race test: release timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  return result;
};
`);
    const oldRunPath = runPath(t.initDir, 'key-1');
    const child = spawn(process.execPath, ['--require', hook, PROVIDERS[provider], 'carry', 'feat/x', '--from-run-key', 'key-1', ...carryFlags(t, 'key-2')], {
      cwd: t.repo,
      env: { ...t.env, RACE_PAUSE_PATH: oldRunPath, RACE_PAUSE_AFTER_READ: '4', RACE_PAUSED: paused, RACE_RELEASE: release },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const done = new Promise((resolve) => child.on('close', (status) => resolve(status)));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(paused)) {
      assert.ok(Date.now() < deadline, 'timed out waiting for carry to pause before its disposition write');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalised = spawnSync('node', [PROVIDERS[provider], 'finalise', ...t.keyed], { encoding: 'utf8', env: t.env, cwd: t.repo });
    assert.strictEqual(finalised.status, 0, finalised.stderr);
    assert.strictEqual(ledgerForKey(t, 'key-1').status, 'terminal');
    fs.writeFileSync(release, 'release');
    const status = await done;
    assert.notStrictEqual(status, 0, stdout);
    assert.match(stderr, /the old run is not active/, stderr);
    assert.doesNotMatch(stderr, /contended/);
  });
}
