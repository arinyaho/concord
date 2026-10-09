'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const review = require('../../core/review');
const { normalizeArtifact } = require('../../core/artifact-contract');
const { safeIdForFilename } = require('../../core/artifact-name');
const cli = require('../review-cli'); // must be requirable without running main()

const CLI = path.join(__dirname, '..', 'review-cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
}

// Broad review is ON by default (round-1 gate pair), which makes the round-1
// gate artifact mandatory in plan-fixes. The vast majority of these tests are
// about something else entirely and spawn no gate reviewer, so round-start is
// disarmed here unless the test says otherwise -- pass `{ broadDefault: true }`
// (or an explicit --broad/--no-broad in args) to exercise the real default.
function withBroadDefault(args, opts) {
  if (opts.broadDefault || args[0] !== 'round-start') return args;
  if (args.some((a) => a === '--broad' || a === '--gate' || a === '--no-broad')) return args;
  return [...args, '--no-broad'];
}

function run(args, opts = {}) {
  const { broadDefault, skipPlanSeed, ...execOpts } = opts;
  if (args[0] === 'plan-fixes' && !skipPlanSeed) seedV2Plan(args[1], execOpts.env);
  if (args[0] === 'commit-fix') seedV2Certification(args[1], args[2], execOpts.env);
  if (args[0] === 'record') seedFileCertifications(args[1], execOpts.env);
  return execFileSync('node', [CLI, ...withBroadDefault(args, opts)], { encoding: 'utf8', ...execOpts });
}

function seedV2Plan(ref, env) {
  const dir = env?.REVIEW_STATE_DIR;
  if (!dir) return;
  const ledger = review.readLedger(dir, review.targetSlug(ref));
  if (!ledger?.round) return;
  const planPath = path.join(dir, `round-${ledger.round}-plan.json`);
  let inputStamp = Date.now();
  for (const role of ['gate', 'correctness', 'verify', 'gate-verify', 'intent']) {
    const file = path.join(dir, `round-${ledger.round}-${role}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const canonical = `${JSON.stringify(normalizeArtifact(role, fs.readFileSync(file, 'utf8')))}\n`;
      if (fs.readFileSync(file, 'utf8') !== canonical) fs.writeFileSync(file, canonical);
    } catch (_) { /* invalid fixtures must still fail at the real contract boundary */ }
    inputStamp = Math.max(inputStamp, fs.statSync(file).mtimeMs) + 1;
    fs.utimesSync(file, new Date(inputStamp), new Date(inputStamp));
  }
  const stampAfterInputs = () => {
    const inputs = ['verify', 'intent'].map((role) => path.join(dir, `round-${ledger.round}-${role}.json`)).filter((file) => fs.existsSync(file));
    const newest = Math.max(Date.now(), ...inputs.map((file) => fs.statSync(file).mtimeMs));
    fs.utimesSync(planPath, new Date(newest + 1), new Date(newest + 1));
  };
  if (fs.existsSync(planPath)) { stampAfterInputs(); return; }
  const read = (role) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `round-${ledger.round}-${role}.json`), 'utf8')); } catch (_) { return {}; } };
  const correctness = read('correctness'); const verify = read('verify');
  const rejected = new Set((verify.rejected || []).map((entry) => typeof entry === 'string' ? entry : entry.id));
  const byId = new Map([...(correctness.findings || []), ...(verify.findings || [])].map((finding) => [finding.id, finding]));
  const surviving = [...byId.values()].filter((finding) => !rejected.has(finding.id));
  const covered = new Set();
  const evidence = { source: 'test-fixture', sourceHash: 'test', requirements: ['fixture-authorized contract'], uniqueness: 'the fixture supplies one expected result' };
  const groups = (verify.groups || []).filter((group) => group.findingIds.every((id) => byId.has(id) && !rejected.has(id))).map((group, index) => {
    group.findingIds.forEach((id) => covered.add(id));
    return { groupId: group.findingIds[0], structuralEffects: group.changeClass === 'structural' ? ['identity'] : [], ...group, ...(group.changeClass === 'structural' && group.action === 'fix' ? { designEvidence: evidence } : {}) };
  });
  for (const finding of surviving) if (!covered.has(finding.id)) groups.push({
    groupId: finding.id, findingIds: [finding.id], rootCause: finding.summary,
    invariants: ['the reported behavior is corrected'], changeClass: 'local', structuralEffects: [], action: 'fix',
  });
  fs.writeFileSync(planPath, JSON.stringify({ status: 'ok', protocolVersion: 2, groups }));
  stampAfterInputs();
}

function seedV2Certification(ref, transactionId, env) {
  const dir = env?.REVIEW_STATE_DIR; const repo = env?.REVIEW_REPO_ROOT;
  if (!dir || !repo) return;
  const ledger = review.readLedger(dir, review.targetSlug(ref));
  const plan = ledger?.fix_plan;
  if (!plan) return;
  const groups = plan.transactionScope === 'round' && transactionId === plan.planId ? plan.groups : plan.groups.filter((group) => group.groupId === transactionId);
  if (!groups.length) return;
  const certPath = path.join(dir, `round-${ledger.round}-certify-${safeIdForFilename(transactionId)}.json`);
  if (fs.existsSync(certPath)) return;
  const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `round-${ledger.round}-${name}.json`), 'utf8')); } catch (_) { return {}; } };
  const candidates = [...(read('correctness').findings || []), ...(read('verify').findings || [])];
  const files = [];
  for (const group of groups) {
    const fixPath = path.join(dir, `round-${ledger.round}-fix-${safeIdForFilename(group.groupId)}.json`);
    let fix; try { fix = JSON.parse(fs.readFileSync(fixPath, 'utf8')); } catch (_) { continue; }
    if (fix.edited !== true) continue;
    fix.groupId ||= group.groupId;
    fix.files ||= group.findingIds.map((id) => candidates.find((finding) => finding.id === id)?.file).filter(Boolean);
    fs.writeFileSync(fixPath, JSON.stringify(fix));
    files.push(...fix.files);
  }
  const uniqueFiles = [...new Set(files)];
  if (!uniqueFiles.length) return;
  const fileHashes = Object.fromEntries(uniqueFiles.map((file) => {
    const absolute = path.resolve(repo, file);
    return [file, absolute.startsWith(`${path.resolve(repo)}${path.sep}`) && fs.existsSync(absolute) ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null];
  }));
  fs.writeFileSync(certPath, JSON.stringify({
    status: 'ok', groupId: transactionId, resolvedFindingIds: groups.flatMap((group) => group.findingIds),
    invariants: [...new Set(groups.flatMap((group) => group.invariants || []))], files: uniqueFiles, fileHashes, evidence: ['test fixture certification'],
  }));
}

function seedFileCertifications(ref, env) {
  const dir = env?.REVIEW_STATE_DIR;
  if (!dir) return;
  const ledger = review.readLedger(dir, review.targetSlug(ref));
  if (ledger?.target?.type !== 'file') return;
  for (const group of ledger.fix_plan?.groups || []) seedV2Certification(ref, group.groupId, env);
}

function runCapture(args, opts = {}) {
  // Like run() but also captures stderr so tests can assert on warning messages.
  const { broadDefault, ...execOpts } = opts;
  const r = spawnSync('node', [CLI, ...withBroadDefault(args, opts)], { encoding: 'utf8', ...execOpts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

test('review-cli is requirable as a module without executing main (guarded)', () => {
  assert.strictEqual(typeof cli.gitDiff, 'function');
  assert.strictEqual(typeof cli.gitIsReachable, 'function');
  assert.strictEqual(typeof cli.runDod, 'function');
});

test('round-start inventories quoted Unicode rename and deletion paths', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/rename-inventory';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'é-old.js'), 'same\n');
  fs.writeFileSync(path.join(repo, 'é-gone.js'), 'gone\n');
  execFileSync('git', ['add', 'é-old.js', 'é-gone.js'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add unicode'], { cwd: repo });
  execFileSync('git', ['mv', 'é-old.js', 'é-new.js'], { cwd: repo });
  execFileSync('git', ['rm', 'a.txt', 'é-gone.js'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'rename and delete'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-changes.json`), 'utf8')).paths,
    ['a.txt', 'é-gone.js', 'é-new.js', 'é-old.js']);
});

test('round-start on a git ref with no base and no ledger refuses and names the base', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/no-base';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const r = runCapture(['round-start', ref], { env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /missing base/);
  assert.match(r.stderr, /round-start <ref> origin\/main/);
  assert.strictEqual(review.readLedger(dir, review.targetSlug(ref)), null);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('round-start fails closed when the base and the head are the same commit', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/same-commit';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const r = runCapture(['round-start', ref, 'HEAD'], { env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /harness-failure: review base and head resolve to the same commit/);
  assert.doesNotMatch(r.stdout, /"decision":"work"/);
});

test('round-start fails closed when the head is already contained in the base', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/merged-head';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'ahead'], { cwd: repo });
  execFileSync('git', ['branch', 'ahead'], { cwd: repo });
  execFileSync('git', ['checkout', '-q', 'HEAD~1'], { cwd: repo });
  const r = runCapture(['round-start', ref, 'ahead'], { env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /harness-failure: review base and head resolve to the same commit/);
  assert.doesNotMatch(r.stdout, /"decision":"work"/);
});

test('round-start replays a terminal ledger even when its head has since been merged into the base', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/terminal-then-merged';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'ahead'], { cwd: repo });
  const first = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env }));
  const slug = review.targetSlug(ref);
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), phase: 'done', status: 'clean' });
  execFileSync('git', ['branch', 'merged-base'], { cwd: repo });
  const replay = JSON.parse(run(['round-start', ref, 'merged-base'], { env }));
  assert.strictEqual(replay.decision, 'terminal');
  assert.strictEqual(replay.head, first.head);
});

test('round-start inventory ignores quoted header lookalikes in source hunks', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/hunk-inventory';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), '-- "a/phantom.js"\nold\n');
  execFileSync('git', ['commit', '-aqm', 'source with header lookalike'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), '++ "b/\\q.js"\nnew\n');
  execFileSync('git', ['commit', '-aqm', 'replace source'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-changes.json`), 'utf8')).paths, ['a.txt']);
});

test('round-start preserves unusual Git paths and rejects a declared NUL path', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/unusual-inventory';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const unusual = '\ufeffé\tline\n.txt';
  fs.writeFileSync(path.join(repo, unusual), 'content\n');
  execFileSync('git', ['add', unusual], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'unusual path'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  const manifestPath = path.join(dir, `round-${n}-changes.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepStrictEqual(manifest.paths, [unusual]);
  manifest.paths = ['bad\0path'];
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(manifestPath, bytes);
  const slug = review.targetSlug(ref);
  const ledger = review.readLedger(dir, slug);
  ledger.execution.changeManifest.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  review.writeLedger(dir, slug, ledger);
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: [unusual], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  assert.throws(() => run(['findings', ref], { env, skipPlanSeed: true }), /changed-path manifest binding is invalid/);
});

test('a SHA-256 Git repository binds and folds its 64-digit changed-path manifest', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-sha256-'));
  execFileSync('git', ['init', '-q', '--object-format=sha256'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const dir = tmpDir(); const ref = 'feat/sha256-manifest';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-changes.json`), 'utf8'));
  assert.match(manifest.target.baseSha, /^[0-9a-f]{64}$/);
  assert.match(manifest.target.headSha, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(manifest.paths, ['a.txt']);
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  assert.deepStrictEqual(JSON.parse(run(['findings', ref], { env, skipPlanSeed: true })).findings, []);
});

test('review-only CLI refuses a symlinked reviewer artifact before normalization', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/unsafe-artifact';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo, CONCORD_UNTRUSTED_ARTIFACTS: '1' };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  const external = path.join(tmpDir(), 'artifact.json');
  fs.writeFileSync(external, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.symlinkSync(external, path.join(dir, `round-${n}-correctness.json`));
  assert.throws(() => run(['artifact-normalize', ref, 'correctness'], { env }), /missing or unsafe gate artifact correctness/);
});

test('review-only CLI refuses a FIFO reviewer artifact without hanging', { skip: process.platform === 'win32' }, () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/fifo-artifact';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo, CONCORD_UNTRUSTED_ARTIFACTS: '1' };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  assert.strictEqual(spawnSync('mkfifo', [path.join(dir, `round-${n}-correctness.json`)]).status, 0);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../review-cli.js'), 'artifact-normalize', ref, 'correctness'],
    { cwd: repo, env, encoding: 'utf8', timeout: 3000 });
  assert.strictEqual(result.status, 1, `FIFO normalization stalled: ${result.error || result.stderr}`);
  assert.match(result.stderr, /missing or unsafe gate artifact correctness/);
});

test('review-only CLI refuses an occupied target lock before reading its FIFO owner', { skip: process.platform === 'win32' }, () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/fifo-lock';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo, CONCORD_UNTRUSTED_ARTIFACTS: '1' };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', ref, 'HEAD~1'], { env });
  const lock = `${review.ledgerPath(dir, review.targetSlug(ref))}.lock`;
  fs.mkdirSync(lock);
  assert.strictEqual(spawnSync('mkfifo', [path.join(lock, 'owner')]).status, 0);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../review-cli.js'), 'artifact-normalize', ref, 'correctness'],
    { cwd: repo, env, encoding: 'utf8', timeout: 3000 });
  assert.strictEqual(result.status, 1, `occupied review lock stalled: ${result.error || result.stderr}`);
  assert.match(result.stderr, /review target lock is occupied/);
});

test('review-only ledger publication refuses a planted temporary symlink', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/ledger-temp';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo, CONCORD_UNTRUSTED_ARTIFACTS: '1' };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  const ledgerFile = review.ledgerPath(dir, review.targetSlug(ref));
  const before = fs.readFileSync(ledgerFile);
  const sentinel = path.join(tmpDir(), 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched\n');
  const preload = path.join(tmpDir(), 'plant.cjs');
  fs.writeFileSync(preload, `require('node:fs').symlinkSync(${JSON.stringify(sentinel)}, ${JSON.stringify(ledgerFile)} + '.' + process.pid + '.tmp');`);
  const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../review-cli.js'), 'artifact-normalize', ref, 'correctness'],
    { cwd: repo, env, encoding: 'utf8', timeout: 3000 });
  assert.strictEqual(result.status, 1, `ledger write followed a planted temporary path: ${result.error || result.stderr}`);
  assert.match(result.stderr, /EEXIST/);
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'untouched\n');
  assert.deepStrictEqual(fs.readFileSync(ledgerFile), before);
});

test('review-only CLI refuses a repair candidate outside its state directory', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/unsafe-candidate';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo, CONCORD_UNTRUSTED_ARTIFACTS: '1' };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', ref, 'HEAD~1'], { env });
  const external = path.join(tmpDir(), 'candidate.json');
  fs.writeFileSync(external, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  assert.throws(() => run(['artifact-normalize', ref, 'correctness', '--candidate', external], { env }), /missing or unsafe repair candidate correctness/);
});

test('round-start freezes header-only Git changes for correctness coverage', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/header-only';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'empty.txt'), '');
  fs.writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 0]));
  fs.chmodSync(path.join(repo, 'a.txt'), 0o755);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'header-only changes'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: [], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  assert.throws(() => run(['plan-fixes', ref], { env }), /coverage -- changed file\(s\) never examined: a\.txt, binary\.bin, empty\.txt/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-changes.json`), 'utf8'));
  assert.deepStrictEqual(manifest.paths, ['a.txt', 'binary.bin', 'empty.txt']);
});

test('header-only changed files retain correctness and intent findings', () => {
  const repo = initRepoWithIntent('printf "REQ: empty file"'); const dir = tmpDir(); const ref = 'feat/header-findings';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'empty.txt'), '');
  execFileSync('git', ['add', 'empty.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add empty file'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'findings', examined: ['empty.txt'], findings: [
    { id: 'correctness:empty', file: 'empty.txt', span: '', summary: 'empty file needs content' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'findings', findings: [
    { id: 'intent:empty', file: 'empty.txt', span: '', requirement: 'REQ: empty file', summary: 'missing content' },
  ] });
  run(['plan-fixes', ref], { env });
  const ledger = review.readLedger(dir, review.targetSlug(ref));
  assert.deepStrictEqual(ledger.intent_parked.map((f) => f.id), ['intent:empty']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-plan.json`), 'utf8'))
    .groups.some((group) => group.findingIds.includes('correctness:empty')));
});

test('a Git round rejects changed manifest or diff bytes before folding findings', () => {
  for (const changed of ['manifest', 'diff']) {
    const repo = initRepo(); const dir = tmpDir(); const ref = `feat/tamper-${changed}`;
    const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
    const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
    writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
    const file = path.join(dir, `round-${n}-${changed === 'manifest' ? 'changes.json' : 'diff.txt'}`);
    fs.appendFileSync(file, 'tampered\n');
    assert.throws(() => run(['findings', ref], { env, skipPlanSeed: true }), /Git (changed-path manifest hash changed|review diff changed)/, changed);
  }
});

test('legacy Git round regenerates its manifest and discards old reviewer repair evidence on resume', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/legacy-manifest';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env }));
  const slug = review.targetSlug(ref);
  const ledger = review.readLedger(dir, slug);
  delete ledger.execution.changeManifest;
  review.writeLedger(dir, slug, ledger);
  const repairPath = path.join(dir, `round-${first.round}-correctness.repair.json`);
  fs.writeFileSync(repairPath, '{"legacy":true}');
  writeArtifact(dir, first.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, first.round, 'verify', { status: 'ok', rejected: [] });
  assert.throws(() => run(['findings', ref], { env, skipPlanSeed: true }), /changed-path manifest is missing/);
  const resumed = JSON.parse(run(['round-start', ref], { env }));
  assert.deepStrictEqual(resumed.completedArtifacts, []);
  assert.deepStrictEqual(resumed.repairArtifacts, {});
  assert.strictEqual(fs.existsSync(repairPath), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `round-${resumed.round}-changes.json`), 'utf8')).paths, ['a.txt']);
});

test('plan-fixes enforces coverage and keeps intent findings for a C-quoted Unicode file', () => {
  const repo = initRepoWithIntent('printf "REQ: unicode file"'); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'é.js'), 'old\n');
  execFileSync('git', ['add', 'é.js'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add unicode'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'é.js'), 'new\n');
  execFileSync('git', ['commit', '-aqm', 'change unicode'], { cwd: repo });
  const ref = 'feat/unicode'; const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  assert.match(fs.readFileSync(path.join(dir, `round-${n}-diff.txt`), 'utf8'), /\+\+\+ "b\/\\303\\251\.js"/);
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: [], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [{ id: 'intent:unicode', file: 'é.js', span: 'new', requirement: 'REQ: unicode file', summary: 'missing behavior' }] });
  assert.throws(() => run(['plan-fixes', ref], { env }), /coverage -- changed file\(s\) never examined: é\.js/);
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['é.js'], findings: [] });
  run(['plan-fixes', ref], { env });
  assert.deepStrictEqual(review.readLedger(dir, review.targetSlug(ref)).intent_parked.map((f) => f.id), ['intent:unicode']);
});

test('artifact-normalize fails closed on an invalid id instead of repairing evidence', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  const file = path.join(dir, `round-${n}-correctness.json`);
  fs.writeFileSync(file, JSON.stringify({ status: 'findings', examined: ['a.txt'], findings: [{ id: 'gate:wrong', file: 'a.txt', summary: 's' }] }));
  assert.throws(() => run(['artifact-normalize', 'feat/x', 'correctness'], { env }), /invalid id/);
});

test('artifact-normalize leaves missing and foreign evidence terminal', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const started = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad'], { env, broadDefault: true }));
  assert.strictEqual(started.gateApplied, true);
  const n = started.round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [{ id: 'correctness:wrong', file: 'a.txt', summary: 'wrong namespace' }] }));
  assert.throws(() => run(['artifact-normalize', 'feat/x', 'correctness'], { env }), /coverage is incomplete/);
  assert.throws(() => run(['artifact-normalize', 'feat/x', 'gate'], { env }), /invalid id/);
  assert.strictEqual(fs.existsSync(path.join(dir, `round-${n}-correctness.repair.json`)), false);
  assert.strictEqual(fs.existsSync(path.join(dir, `round-${n}-gate.repair.json`)), false);
});

test('artifact-normalize does not create a repair attempt for invalid evidence', () => {
  const repo = initRepo(); const dir = tmpDir(); const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', findings: [{ id: 'gate:wrong', file: 'a.txt', summary: 's' }] }));
  assert.throws(() => run(['artifact-normalize', 'feat/x', 'correctness'], { env }), /invalid id/);
  assert.strictEqual(fs.existsSync(path.join(dir, `round-${n}-correctness.repair.json`)), false);
});

test('artifact-normalize repairs only a known status spelling and fails closed on a correctness-only gate-verify artifact', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad'], { env, broadDefault: true })).round;
  const repairFile = path.join(dir, `round-${n}-gate.json`);
  const unsupported = JSON.stringify({ status: 'OK', findings: [] });
  fs.writeFileSync(repairFile, unsupported);

  const repair = JSON.parse(run(['artifact-normalize', 'feat/x', 'gate'], { env, broadDefault: true }));
  assert.strictEqual(repair.status, 'repair');
  assert.strictEqual(fs.readFileSync(repairFile, 'utf8'), unsupported, 'repair must retain the original artifact');
  assert.ok(fs.existsSync(path.join(dir, `round-${n}-gate.repair.json`)));

  const file = path.join(dir, `round-${n}-gate-verify.json`);
  const raw = JSON.stringify({
    status: 'ok',
    rejected: [{ id: 'correctness:some-candidate', reason: 'the gate evidence duplicates this candidate' }],
    findings: [],
  });
  fs.writeFileSync(file, raw);

  assert.throws(() => run(['artifact-normalize', 'feat/x', 'gate-verify'], { env, broadDefault: true }), /harness-failure.*invalid id/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), raw, 'normalization must not filter cross-namespace evidence');
});

test('artifact-normalize permits only a preserving mixed gate-verify candidate', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/mixed', 'HEAD~1', '--broad'], { env, broadDefault: true })).round;
  const original = { status: 'ok', rejected: [{ id: 'gate:real', reason: 'ran gate' }, { id: 'correctness:context', reason: 'context only' }], findings: [] };
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify(original));
  const repair = JSON.parse(run(['artifact-normalize', 'feat/mixed', 'gate-verify'], { env, broadDefault: true })).repair;
  const candidate = { status: 'ok', rejected: [{ id: 'gate:real', reason: 'ran gate' }], findings: [] };
  fs.writeFileSync(repair.candidatePath, JSON.stringify(candidate));
  assert.strictEqual(JSON.parse(run(['artifact-normalize', 'feat/mixed', 'gate-verify', '--candidate', repair.candidatePath], { env, broadDefault: true })).status, 'ok');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-gate-verify.json`), 'utf8')).rejected, candidate.rejected);
});

test('artifact-normalize repairs a verify artifact with foreign gate rejections and preserves its correctness verdict', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/mixed-verify', 'HEAD~1', '--broad'], { env, broadDefault: true })).round;
  const original = {
    status: 'ok',
    rejected: [{ id: 'gate:foreign-rejection', reason: 'belongs to gate verification' }],
    findings: [{ id: 'correctness:manual-staging', file: 'review-driver.md', summary: 'repair staging exposes state' }],
  };
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify(original));
  const repair = JSON.parse(run(['artifact-normalize', 'feat/mixed-verify', 'verify'], { env, broadDefault: true })).repair;
  const candidate = { status: 'ok', rejected: [], findings: original.findings };
  fs.writeFileSync(repair.candidatePath, JSON.stringify(candidate));
  assert.strictEqual(JSON.parse(run(['artifact-normalize', 'feat/mixed-verify', 'verify', '--candidate', repair.candidatePath], { env, broadDefault: true })).status, 'ok');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `round-${n}-verify.json`), 'utf8')), candidate);
  assert.strictEqual(review.readLedger(dir, review.targetSlug('feat/mixed-verify')).execution.retryArtifacts.verify, undefined);
});

test('artifact-normalize fails closed on missing correctness coverage', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'change two files'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  const artifact = path.join(dir, `round-${n}-correctness.json`);
  const raw = JSON.stringify({ status: 'findings', examined: ['a.txt'], findings: [] });
  fs.writeFileSync(artifact, raw);

  assert.throws(() => run(['artifact-normalize', 'feat/x', 'correctness'], { env }), /coverage is incomplete/);
  assert.strictEqual(fs.readFileSync(artifact, 'utf8'), raw, 'coverage failure must not infer or rewrite examined');
});

test('artifact-normalize fails closed when correctness coverage is still incomplete after its retry', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'change two files'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  const artifact = path.join(dir, `round-${n}-correctness.json`);
  fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));

  assert.throws(() => run(['artifact-normalize', 'feat/x', 'correctness'], { env }), /harness-failure.*coverage/);
});

function seedCopyRound(ref, examined) {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.mkdirSync(path.join(repo, 'copy'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'copy', 'a.txt'), 'two\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'change a and its copy'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined, findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  return { env };
}

test('coverage: a changed copy whose bytes equal an examined changed file counts as examined', () => {
  const { env } = seedCopyRound('feat/copy-ok', ['a.txt']);
  assert.strictEqual(JSON.parse(run(['artifact-normalize', 'feat/copy-ok', 'correctness'], { env })).status, 'ok');
  assert.doesNotThrow(() => run(['plan-fixes', 'feat/copy-ok'], { env }));
});

test('coverage: identical bytes cover in either direction', () => {
  const { env } = seedCopyRound('feat/copy-rev', ['copy/a.txt']);
  assert.doesNotThrow(() => run(['plan-fixes', 'feat/copy-rev'], { env }));
});

test('coverage: a changed file with no identical examined twin is still a harness-failure', () => {
  const { env } = seedCopyRound('feat/copy-none', []);
  assert.throws(() => run(['plan-fixes', 'feat/copy-none'], { env }), /harness-failure.*coverage.*a\.txt/);
});

test('artifact-normalize retries when a deleted path is not examined', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  execFileSync('git', ['rm', '-q', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'delete a'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/delete', 'HEAD~1'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: [], findings: [] }));

  assert.throws(() => run(['artifact-normalize', 'feat/delete', 'correctness'], { env }), /coverage is incomplete/);
});

test('git helpers operate on a real temp repo', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-git-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  assert.strictEqual(cli.gitIsDirty(repo), false);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  assert.strictEqual(cli.gitIsDirty(repo), true);
  const sha = cli.gitCommitFix(repo, 'correctness:x', 'fix it', ['a.txt']);
  assert.match(sha, /^[0-9a-f]{7,40}$/);
  assert.strictEqual(cli.gitIsReachable(repo, sha), true);
  cli.gitCheckoutTree(repo);
  assert.strictEqual(cli.gitIsDirty(repo), false);
});

test('review-cli show: prints an empty/fresh ledger summary for an unknown ref', () => {
  const dir = tmpDir();
  const out = run(['show', 'feat/x'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.status, 'converging');
  assert.strictEqual(parsed.round, 0);
});

test('round-start: fresh start defers DoD, writes diff file, sets phase gates, decision work', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  // commit a change so the tree is clean but a diff vs HEAD~1 exists
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.dodPassed, false);
  assert.strictEqual(out.dodPending, true);
  assert.strictEqual(out.stateDir, dir); // driver needs this to build <stateDir>/round-N-*.json paths
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.phase, 'gates');
  assert.ok(fs.existsSync(path.join(dir, `round-${ledger.round}-diff.txt`)));
});

test('DoD runs once after review convergence, not at round start', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const counter = path.join(tmpDir(), 'dod-runs');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: [`printf x >> ${counter}`] }));
  execFileSync('git', ['commit', '-aqm', 'count dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };

  const started = JSON.parse(run(['round-start', 'feat/final-dod', 'HEAD~1'], { env }));
  assert.strictEqual(fs.existsSync(counter), false, 'round-start must not execute the project DoD');
  fs.writeFileSync(path.join(dir, `round-${started.round}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${started.round}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/final-dod'], { env });

  const recorded = JSON.parse(run(['record', 'feat/final-dod'], { env }));
  assert.strictEqual(recorded.decision.converged, true);
  assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'x', 'final DoD must execute exactly once');
  assert.match(recorded.handoff, /DoD: passed/);
});

test('final DoD runs against committed files after discarding reviewer edits', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['false'] }));
  execFileSync('git', ['commit', '-aqm', 'failing dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const started = JSON.parse(run(['round-start', 'feat/dirty-dod', 'HEAD~1'], { env }));
  writeArtifact(dir, started.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, started.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/dirty-dod'], { env });
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));

  const recorded = JSON.parse(run(['record', 'feat/dirty-dod'], { env }));
  assert.strictEqual(recorded.decision.dodFailed, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(repo, 'review.config.json'), 'utf8')), { dod: ['false'] });
});

test('final DoD cannot pass by modifying the reviewed tree', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['printf dod-mutated > a.txt'] }));
  execFileSync('git', ['commit', '-aqm', 'mutable dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const started = JSON.parse(run(['round-start', 'feat/mutable-dod', 'HEAD~1'], { env }));
  writeArtifact(dir, started.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, started.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/mutable-dod'], { env });

  assert.throws(() => run(['record', 'feat/mutable-dod'], { env }), /harness-failure.*final DoD modified/);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'two\n');
});

test('final DoD cannot pass by moving HEAD', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['printf dod-commit > a.txt && git add a.txt && git commit -qm dod-mutation'] }));
  execFileSync('git', ['commit', '-aqm', 'committing dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const started = JSON.parse(run(['round-start', 'feat/head-moving-dod', 'HEAD~1'], { env }));
  writeArtifact(dir, started.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, started.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/head-moving-dod'], { env });

  assert.throws(() => run(['record', 'feat/head-moving-dod'], { env }), /harness-failure.*final DoD moved HEAD/);
});

test('final DoD ignores its untracked state directory inside the repository', () => {
  const repo = initRepo(); const dir = path.join(repo, '.review-state');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const started = JSON.parse(run(['round-start', 'feat/in-repo-state', 'HEAD~1'], { env }));
  writeArtifact(dir, started.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, started.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/in-repo-state'], { env });

  assert.strictEqual(JSON.parse(run(['record', 'feat/in-repo-state'], { env })).decision.converged, true);
});

test('DoD retry invalidates its delta and broad evidence when the base moves', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/dod-base-drift';
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['false'] }));
  execFileSync('git', ['commit', '-aqm', 'failing dod'], { cwd: repo });
  execFileSync('git', ['branch', 'review-base'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base-two\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'advance base'], { cwd: repo });
  const advancedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };

  const first = JSON.parse(run(['round-start', ref, 'review-base'], { env, broadDefault: true }));
  writeArtifact(dir, first.round, 'correctness', { status: 'ok', examined: ['a.txt', 'base.txt'], findings: [] });
  writeArtifact(dir, first.round, 'gate', { status: 'ok', findings: [] });
  writeArtifact(dir, first.round, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, first.round, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.dodFailed, true);

  execFileSync('git', ['branch', '-f', 'review-base', advancedBase], { cwd: repo });
  const retried = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(retried.gateApplied, true, 'base drift must re-arm broad review');
  const reviewed = fs.readFileSync(path.join(dir, `round-${retried.round}-diff.txt`), 'utf8');
  assert.match(reviewed, /-one/);
  assert.match(reviewed, /\+two/);
});

test('round-start resume preserves normalized artifacts and records an artifact write failure for retry', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/resume-artifact', 'HEAD~1'], { env }));
  const artifact = path.join(dir, `round-${first.round}-correctness.json`);
  fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  assert.strictEqual(JSON.parse(run(['artifact-normalize', 'feat/resume-artifact', 'correctness'], { env })).status, 'ok');
  const failure = { role: 'verify', kind: 'artifact-write-failure', message: 'missing gate artifact verify for round 1' };
  assert.strictEqual(JSON.parse(run(['round-failure', 'feat/resume-artifact', JSON.stringify(failure)], { env })).retryable, true);

  const resumed = JSON.parse(run(['round-start', 'feat/resume-artifact'], { env }));
  assert.deepStrictEqual(resumed.completedArtifacts, ['correctness']);
  assert.ok(fs.existsSync(artifact), 'normalized artifact survives an interrupted resume');
  const ledger = review.readLedger(dir, review.targetSlug('feat/resume-artifact'));
  assert.deepStrictEqual(ledger.execution.pending, ['verify', 'plan']);
  assert.deepStrictEqual(ledger.execution.failure, null, 'the prior failure is retained in history but cleared for the retry');
  assert.strictEqual(ledger.execution.failures.at(-1).kind, 'artifact-write-failure');
  assert.match(ledger.execution.artifactHashes.correctness, /^[0-9a-f]{64}$/, 'resume must retain the completed artifact hash');
  run(['round-failure', 'feat/resume-artifact', JSON.stringify(failure)], { env });
  assert.deepStrictEqual(JSON.parse(run(['round-start', 'feat/resume-artifact'], { env })).completedArtifacts, ['correctness'], 'a second interruption must preserve the same verified artifact');
});

test('round-start resume re-drives a normalized artifact changed after completion', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/resume-tampered', 'HEAD~1'], { env }));
  const artifact = path.join(dir, `round-${first.round}-correctness.json`);
  fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  run(['artifact-normalize', 'feat/resume-tampered', 'correctness'], { env });
  fs.writeFileSync(artifact, JSON.stringify({ status: 'findings', examined: ['a.txt'], findings: [{ id: 'correctness:altered', file: 'a.txt', span: 'two', summary: 'altered after completion' }] }));
  run(['round-failure', 'feat/resume-tampered', JSON.stringify({ role: 'verify', kind: 'artifact-write-failure', message: 'missing verify' })], { env });

  const resumed = JSON.parse(run(['round-start', 'feat/resume-tampered'], { env }));
  assert.deepStrictEqual(resumed.completedArtifacts, []);
  assert.ok(!fs.existsSync(artifact), 'a changed completed artifact must be re-driven');
});

test('round-start resume preserves only completed gate artifacts', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/resume-gate', 'HEAD~1', '--broad'], { env, broadDefault: true }));
  const gate = path.join(dir, `round-${first.round}-gate.json`);
  fs.writeFileSync(gate, JSON.stringify({ status: 'ok', findings: [] }));
  run(['artifact-normalize', 'feat/resume-gate', 'gate'], { env, broadDefault: true });

  const resumed = JSON.parse(run(['round-start', 'feat/resume-gate'], { env, broadDefault: true }));
  assert.deepStrictEqual(resumed.completedArtifacts, ['gate']);
  assert.ok(fs.existsSync(gate));
  assert.ok(review.readLedger(dir, review.targetSlug('feat/resume-gate')).execution.pending.includes('gate-verify'));
});

test('round-start resume invalidates gate verification when its gate artifact changed', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/resume-gate-pair', 'HEAD~1', '--broad'], { env, broadDefault: true }));
  const correctness = path.join(dir, `round-${first.round}-correctness.json`);
  const gate = path.join(dir, `round-${first.round}-gate.json`);
  const correctnessVerify = path.join(dir, `round-${first.round}-verify.json`);
  const verify = path.join(dir, `round-${first.round}-gate-verify.json`);
  fs.writeFileSync(correctness, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  run(['artifact-normalize', 'feat/resume-gate-pair', 'correctness'], { env, broadDefault: true });
  fs.writeFileSync(gate, JSON.stringify({ status: 'ok', findings: [] }));
  run(['artifact-normalize', 'feat/resume-gate-pair', 'gate'], { env, broadDefault: true });
  fs.writeFileSync(correctnessVerify, JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['artifact-normalize', 'feat/resume-gate-pair', 'verify'], { env, broadDefault: true });
  fs.writeFileSync(verify, JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  const slug = review.targetSlug('feat/resume-gate-pair');
  const ledger = review.readLedger(dir, slug);
  ledger.execution.completed.push('gate-verify');
  ledger.execution.artifactHashes['gate-verify'] = crypto.createHash('sha256').update(fs.readFileSync(verify, 'utf8')).digest('hex');
  review.writeLedger(dir, slug, ledger);
  fs.writeFileSync(gate, JSON.stringify({ status: 'ok', findings: [{ id: 'gate:changed', file: 'a.txt', summary: 'changed' }] }));
  run(['round-failure', 'feat/resume-gate-pair', JSON.stringify({ role: 'correctness', kind: 'artifact-write-failure', message: 'interrupted' })], { env, broadDefault: true });

  const resumed = JSON.parse(run(['round-start', 'feat/resume-gate-pair'], { env, broadDefault: true }));
  assert.deepStrictEqual(resumed.completedArtifacts, ['correctness'], 'neither pooled verifier can survive a changed finder');
  assert.ok(!fs.existsSync(correctnessVerify), 'the stale correctness verifier artifact must be re-driven');
  assert.ok(!fs.existsSync(verify), 'the stale gate verifier artifact must be re-driven');
});

test('record does not run final DoD when a fix round exhausts the review budget', () => {
  const repo = initRepo(); const dir = tmpDir();
  const counter = path.join(tmpDir(), 'dod-runs');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: [`printf x >> ${counter}`] }));
  execFileSync('git', ['commit', '-aqm', 'count dod'], { cwd: repo });
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const ref = 'feat/budget-handoff';
  const started = JSON.parse(run(['round-start', ref, 'HEAD~1'], { env }));
  fs.writeFileSync(path.join(dir, `round-${started.round}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [
    { id: 'correctness:budget', file: 'a.txt', span: 'two', summary: 'Fix the value.' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${started.round}-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['plan-fixes', ref], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${started.round}-fix-correctness_budget.json`), JSON.stringify({ status: 'ok', edited: true, files: ['a.txt'] }));
  run(['commit-fix', ref, 'correctness:budget'], { env });
  const slug = review.targetSlug(ref);
  const ledger = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...ledger, budget: { max_rounds: 1, spent: 1 } });

  const out = JSON.parse(run(['record', ref], { env }));
  assert.match(out.handoff, /termination: round budget exhausted with 0 open finding\(s\); DoD deferred but no clean confirmation round occurred/);
  assert.match(out.handoff, /DoD: pending \(runs once after review convergence\)/);
  assert.strictEqual(fs.existsSync(counter), false);
});

test('round-start: refuses a dirty working tree on a fresh start', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n'); // uncommitted
  assert.throws(() => run(['round-start', 'feat/x', 'HEAD'], { env }), /dirty/);
});

test('round-start: resume from phase fixes discards uncommitted edits and re-drives the same round at same budget', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'branch work\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'branch work'], { cwd: repo });
  // seed a ledger mid-round: phase fixes, round 1, a stale artifact, budget spent 1
  let l = review.emptyLedger({ kind: 'local', ref: 'feat/x', base: baseSha, head_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() });
  l = review.beginRound(l, 'h').ledger; // round 1
  l.phase = 'fixes';
  l.budget.spent = 1;
  l.planned = ['correctness:x'];
  review.writeLedger(dir, slug, l);
  fs.writeFileSync(path.join(dir, 'round-1-fix-correctness_x.json'), '{"status":"ok","edited":true}');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted fix\n'); // dirty from the crashed fix
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  JSON.parse(run(['round-start', 'feat/x'], { env }));
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.round, 1); // NOT advanced
  assert.strictEqual(after.budget.spent, 1); // NOT re-charged
  assert.strictEqual(after.phase, 'gates'); // re-driven
  assert.strictEqual(cli.gitIsDirty(repo), false); // uncommitted discarded
  assert.ok(!fs.existsSync(path.join(dir, 'round-1-fix-correctness_x.json'))); // stale artifact gone
});

// CRITICAL 2 (false-clean via empty resume diff): on `resume <ref>` the
// driver passes NO base token. Before the fix, round-start read only
// `rest[0]` and never fell back to the persisted `ledger.target.base`, so
// `gitDiff` fell back to `git diff HEAD` -- empty on a clean committed tree.
// This asserts the fallback: a resumed round-start with no base arg must
// still diff against the ORIGINAL base (persisted from the fresh start),
// and target.base must survive the resume, not be clobbered to undefined.
test('round-start: resume with no base arg falls back to the persisted target.base (does not review an empty diff)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  // Fresh start against HEAD~1 -- persists target.base = 'HEAD~1'.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const slug = review.targetSlug('feat/x');
  const afterFresh = review.readLedger(dir, slug);
  assert.strictEqual(afterFresh.target.base, 'HEAD~1');

  // Simulate a crash mid-round (phase left at 'gates') and a cross-session
  // resume: the driver calls round-start again with NO base token.
  let l = review.readLedger(dir, slug);
  l = { ...l, phase: 'gates' };
  review.writeLedger(dir, slug, l);

  const out = JSON.parse(run(['round-start', 'feat/x'], { env })); // no base arg -- resume form
  assert.strictEqual(out.decision, 'work');
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.target.base, 'HEAD~1'); // preserved, not clobbered to undefined
  const diffText = fs.readFileSync(path.join(dir, `round-${after.round}-diff.txt`), 'utf8');
  assert.ok(diffText.trim().length > 0, 'resumed round-start must diff against the persisted base, not an empty `git diff HEAD`');
});

// round-start has no "resume" keyword -- that syntax belongs to the
// review-until-green wrapper, which extracts the real ref and never forwards
// the literal token. Passing the wrapper's `resume <ref>` form straight to
// round-start must fail fast rather than silently treat "resume" as the ref
// (creating an unrelated ledger) and the real ref as the base.
test('round-start: rejects a literal "resume" ref instead of creating a phantom ledger', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  assert.throws(() => run(['round-start', 'resume', 'feat/x'], { env }), /"resume" is not a valid ref/);
  assert.ok(!fs.existsSync(path.join(dir, `review-${review.targetSlug('resume')}.json`)));
});

// After unpark, an ordinary round-start <ref> call (no literal "resume") must
// update phase/head_sha -- the phase/resume state machine itself is correct;
// only the literal-"resume" misuse above needs guarding.
test('round-start: after unpark, an ordinary round-start <ref> call updates phase and head_sha', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'branch work\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'branch work'], { cwd: repo });
  run(['round-start', 'feat/x', baseSha], { env }); // fresh round 1, base persisted as target.base
  const slug = review.targetSlug('feat/x');
  let l = review.readLedger(dir, slug);
  l = { ...l, status: 'parked', phase: 'done', last_recorded_round: 1, findings: [{ id: 'f1', gate: 'correctness', file: 'a.txt', status: 'parked', park_reason: 'needs-decision' }] };
  review.writeLedger(dir, slug, l);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change after park'], { cwd: repo });
  const realHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  run(['unpark', 'feat/x', 'f1'], { env });
  run(['round-start', 'feat/x'], { env }); // no base arg -- must fall back to persisted target.base

  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.phase, 'gates');
  assert.strictEqual(after.target.head_sha, realHeadSha);
});

test('review-cli unpark: reopens a parked finding', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.status = 'parked';
  ledger.findings.push({ id: 'f7', status: 'parked' });
  review.writeLedger(dir, slug, ledger);

  const out = run(['unpark', 'feat/x', 'f7'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  assert.ok(/f7/.test(out));
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.findings.find((f) => f.id === 'f7').status, 'open');
  assert.strictEqual(after.status, 'converging');
});

test('a failed final DoD preserves the ledger and re-enters with diff-only review after a fix', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const slug = review.targetSlug('feat/x');
  // Review converges first; only then does the configured DoD fail.
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['false'] }));
  execFileSync('git', ['commit', '-aqm', 'failing dod'], { cwd: repo });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', base], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec.decision.dodFailed, true);
  assert.strictEqual(review.readLedger(dir, slug).status, 'dod-failed');

  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['commit', '-aqm', 'fix dod'], { cwd: repo });
  const restarted = JSON.parse(run(['round-start', 'feat/x'], { env }));
  assert.strictEqual(restarted.decision, 'work');
  assert.strictEqual(restarted.gateApplied, false, 'the completed broad pass remains valid');
  const retryDiff = fs.readFileSync(path.join(dir, `round-${restarted.round}-diff.txt`), 'utf8');
  assert.match(retryDiff, /-.*false/);
  assert.match(retryDiff, /\+.*true/);
  assert.doesNotMatch(retryDiff, /-one/);
});

test('park-budget override clears a simultaneous final DoD retry without charging a round', () => {
  const { REVIEW_PARK_BUDGET_DEFAULT } = require('../../core/config');
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['false'] }));
  execFileSync('git', ['commit', '-aqm', 'failing dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const slug = review.targetSlug('feat/x');
  const ledger = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...ledger, findings: Array.from({ length: REVIEW_PARK_BUDGET_DEFAULT }, (_, i) => ({
    id: `correctness:old-${i}`, gate: 'correctness', file: 'a.txt', span: '', summary: 'x', status: 'parked', park_reason: { kind: 'needs-decision', text: 'prior' },
  })) });

  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.parked, true);
  assert.ok(!out.decision.dodFailed);
  assert.strictEqual(review.readLedger(dir, slug).budget.spent, 0);
});

test('review-cli reset: no ledger for the ref -> reports nothing to reset, exits 0', () => {
  const dir = tmpDir();
  const out = run(['reset', 'feat/nope'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  assert.match(out, /nothing to reset/);
});

test('review-cli reset: a completed initial run cannot erase the cumulative budget', () => {
  const dir = tmpDir(); const ref = 'feat/clean'; const slug = review.targetSlug(ref);
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref }), status: 'clean', phase: 'done' });
  const before = fs.readFileSync(review.ledgerPath(dir, slug));
  const reset = runCapture(['reset', ref], { env });
  assert.notStrictEqual(reset.status, 0);
  assert.match(reset.stderr, /cannot discard a completed run/);
  assert.deepStrictEqual(fs.readFileSync(review.ledgerPath(dir, slug)), before);
});

test('review-cli reset preserves every recorded resumable disposition', () => {
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  for (const status of ['dod-failed', 'gate-pending', 'intent-review', 'parked']) {
    const ref = `feat/${status}`; const slug = review.targetSlug(ref);
    review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref }), status, phase: 'done', round: 1, last_recorded_round: 1 });
    const before = fs.readFileSync(review.ledgerPath(dir, slug));
    const reset = runCapture(['reset', ref], { env });
    assert.notStrictEqual(reset.status, 0, status);
    assert.match(reset.stderr, /cannot discard a completed run/, status);
    assert.deepStrictEqual(fs.readFileSync(review.ledgerPath(dir, slug)), before, status);
  }
});

test('review-cli: missing ref argument exits non-zero with a message on stderr', () => {
  const dir = tmpDir();
  assert.throws(() => run(['show'], { env: { ...process.env, REVIEW_STATE_DIR: dir } }));
});

// Regression: core/review-cli.js's require.main === module guard is dead on
// the only path anyone actually invokes -- the manifest and the
// review-until-green command both run hooks/review-cli.js (the shim), whose
// require.main is the shim itself, not core. Before the fix, the shim called
// cli.main() bare, so a thrown error printed a raw Node stack trace to stderr
// instead of the graceful `review-cli: <msg>` one-liner core intended. This
// spawns the SHIM (CLI, the same path constant every other test in this file
// uses) on a deterministic throw (missing required <ref> argument) and
// asserts the operator-facing error contract: a clean `review-cli: ` prefixed
// line, exit code 1, and no raw Node stack-trace frame.
test('review-cli shim: a thrown error prints the graceful "review-cli: <msg>" line, not a raw stack trace', () => {
  const dir = tmpDir();
  const { stdout, stderr, status } = runCapture(['show'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  assert.strictEqual(status, 1);
  assert.strictEqual(stdout, '');
  assert.match(stderr, /^review-cli: /);
  assert.ok(!/\n {4}at /.test(stderr), `stderr must not contain a raw Node stack-trace frame, got:\n${stderr}`);
});

// `armBroad` runs the round with broad review at its real default (armed), and
// seeds the empty round-1 gate artifact the front pass would have written. The
// panel is broad review's other half, so a panel test must not disarm broad.
function seedGatesRound(repo, dir, ref, correctness, verify, { armBroad = false } = {}) {
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', ref, 'HEAD~1'], { env, broadDefault: armBroad });
  const n = review.readLedger(dir, review.targetSlug(ref)).round;
  if (armBroad) {
    fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  }
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify(correctness));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify(verify));
  if (armBroad) {
    fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  }
  return { env, n };
}

test('plan-fixes: returns confirmed, non-killed, still-open findings and sets phase fixes', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
      { id: 'correctness:fp', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' } ] },
    { status: 'ok', rejected: [{ id: 'correctness:fp', reason: 're-read a.txt: the span is inside a comment' }] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:real']);
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(l.phase, 'fixes');
  assert.deepStrictEqual(l.planned, ['correctness:real']);
});

test('plan-fixes: preserves verifier root-cause groups as one atomic fix group', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bad b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add b'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/grouped',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'first symptom' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'bad b', summary: 'second symptom' },
    ] },
    { status: 'ok', rejected: [], groups: [{
      findingIds: ['correctness:a', 'correctness:b'], rootCause: 'one shared protocol defect',
      invariants: ['one owner decides the outcome'], changeClass: 'structural', action: 'fix',
    }] });
  const slug = review.targetSlug('feat/grouped');
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), intentHash: 'test' });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] });
  const out = JSON.parse(run(['plan-fixes', 'feat/grouped'], { env }));
  assert.strictEqual(out.fixGroups.length, 1);
  assert.deepStrictEqual(out.fixGroups[0].findingIds, ['correctness:a', 'correctness:b']);
  assert.strictEqual(out.fixGroups[0].rootCause, 'one shared protocol defect');
});

test('plan-fixes: structural group with an unsettled design stops before any fixer', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/structural-stop',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:identity', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'identity is ambiguous' },
    ] },
    { status: 'ok', rejected: [], groups: [{
      findingIds: ['correctness:identity'], rootCause: 'attempt identity is undefined',
      invariants: ['stale attempts cannot decide the active result'], changeClass: 'structural', action: 'reconcile',
      reason: 'the approved design does not choose an identity contract',
    }] });
  const out = JSON.parse(run(['plan-fixes', 'feat/structural-stop'], { env }));
  assert.deepStrictEqual(out.fixes, []);
  assert.strictEqual(out.reconciliation.trigger, 'group-reconcile');
  assert.strictEqual(review.readLedger(dir, review.targetSlug('feat/structural-stop')).planned.length, 0);
  const recorded = JSON.parse(run(['record', 'feat/structural-stop'], { env }));
  assert.strictEqual(recorded.decision.continue, false);
  assert.strictEqual(recorded.decision.reconciliation, true);
  assert.match(recorded.decision.reason, /human decision before editing/i);
});

test('plan-fixes: local group that needs a human decision stops before any fixer', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/local-stop',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:evidence', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'empty evidence classification is undecided' },
    ] },
    { status: 'ok', rejected: [], groups: [{
      findingIds: ['correctness:evidence'], rootCause: 'empty evidence classification is undecided',
      invariants: ['a packet with no evidence is never mergeable-clean'], changeClass: 'local', action: 'reconcile',
      reason: 'whether empty acceptance evidence may classify as mergeable is a product decision',
    }] });
  const out = JSON.parse(run(['plan-fixes', 'feat/local-stop'], { env }));
  assert.deepStrictEqual(out.fixes, []);
  assert.deepStrictEqual(out.fixGroups, []);
  assert.strictEqual(out.reconciliation.trigger, 'group-reconcile');
  assert.deepStrictEqual(out.reconciliation.findings, { local: 1 });
  const recorded = JSON.parse(run(['record', 'feat/local-stop'], { env }));
  assert.strictEqual(recorded.decision.continue, false);
  assert.match(recorded.decision.reason, /human decision before editing/i);
});

test('plan-fixes: v2 refuses unclassified findings instead of inventing singleton fixes', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-missing-plan',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:identity', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'attempt identity is undefined' },
    ] },
    { status: 'ok', rejected: [], findings: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-plan.json`), JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [] }));
  assert.throws(() => run(['plan-fixes', 'feat/v2-missing-plan'], { env }), /classification.*correctness:identity/i);
});

test('plan-fixes: overlapping structural invariants promote the transaction to round scope', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bad b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add b'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-round-scope',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'first symptom' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'bad b', summary: 'second symptom' },
    ] },
    { status: 'ok', rejected: [], findings: [] });
  const evidence = { source: 'intent.md', sourceHash: 'abc', requirements: ['one owner'], uniqueness: 'one owner is explicit' };
  const slug = review.targetSlug('feat/v2-round-scope');
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), intentHash: 'abc' });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-plan.json`), JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [
    { groupId: 'a', findingIds: ['correctness:a'], rootCause: 'a', invariants: ['one active owner'], changeClass: 'structural', structuralEffects: ['ownership'], action: 'fix', designEvidence: evidence },
    { groupId: 'b', findingIds: ['correctness:b'], rootCause: 'b', invariants: ['one active owner'], changeClass: 'structural', structuralEffects: ['ownership'], action: 'fix', designEvidence: evidence },
  ] }));
  const out = JSON.parse(run(['plan-fixes', 'feat/v2-round-scope'], { env }));
  assert.strictEqual(out.protocolVersion, 2);
  assert.strictEqual(out.transactionScope, 'round');
});

test('plan-fixes: returns every blocked structural group in one reconciliation packet', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bad b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add b'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-multi-reconcile',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'first choice' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'bad b', summary: 'second choice' },
    ] },
    { status: 'ok', rejected: [], findings: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-plan.json`), JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [
    { groupId: 'a', findingIds: ['correctness:a'], rootCause: 'a', invariants: ['a invariant'], changeClass: 'structural', structuralEffects: ['identity'], action: 'reconcile', reason: 'choice a is open' },
    { groupId: 'b', findingIds: ['correctness:b'], rootCause: 'b', invariants: ['b invariant'], changeClass: 'structural', structuralEffects: ['ordering'], action: 'reconcile', reason: 'choice b is open' },
  ] }));
  const out = JSON.parse(run(['plan-fixes', 'feat/v2-multi-reconcile'], { env }));
  assert.deepStrictEqual(out.reconciliation.groups.map((group) => group.groupId), ['a', 'b']);
  assert.deepStrictEqual(out.reconciliation.groups.flatMap((group) => group.findingIds), ['correctness:a', 'correctness:b']);
});

test('commit-fix: v2 group cannot commit until every member is certified', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bad b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add b'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-partial',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'first symptom' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'bad b', summary: 'second symptom' },
    ] },
    { status: 'ok', rejected: [], findings: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-plan.json`), JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [{
    groupId: 'shared', findingIds: ['correctness:a', 'correctness:b'], rootCause: 'shared root', invariants: ['one outcome'], changeClass: 'local', structuralEffects: [], action: 'fix',
  }] }));
  run(['plan-fixes', 'feat/v2-partial'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
  writeArtifact(dir, n, 'fix-shared', { status: 'ok', edited: true, groupId: 'shared', files: ['a.txt'] });
  writeArtifact(dir, n, 'certify-shared', { status: 'ok', groupId: 'shared', resolvedFindingIds: ['correctness:a'], invariants: ['one outcome'] });
  assert.throws(() => run(['commit-fix', 'feat/v2-partial', 'shared'], { env }), /complete group certification/i);
});

function seedCertifiedSingleGroup(ref, certOverrides) {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, ref,
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'wrong' }] },
    { status: 'ok', rejected: [], findings: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-plan.json`), JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [{
    groupId: 'doc-fix', findingIds: ['correctness:a'], rootCause: 'wrong', invariants: ['States the order', 'No code moves'], changeClass: 'local', structuralEffects: [], action: 'fix',
  }] }));
  run(['plan-fixes', ref], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'a.txt'))).digest('hex');
  writeArtifact(dir, n, 'fix-doc-fix', { status: 'ok', edited: true, groupId: 'doc-fix', files: ['a.txt'] });
  writeArtifact(dir, n, 'certify-doc-fix', {
    status: 'ok', groupId: 'doc-fix', resolvedFindingIds: ['correctness:a'], files: ['a.txt'], fileHashes: { 'a.txt': hash },
    evidence: ['read the diff'], invariants: ['(1) the doc states the order', '(2) no code moves'], ...certOverrides,
  });
  return { repo, env };
}

test('commit-fix: a certificate that paraphrases the planned invariants but matches findings, files and hashes is committed', () => {
  const { env } = seedCertifiedSingleGroup('feat/cert-paraphrase', {});
  assert.strictEqual(JSON.parse(run(['commit-fix', 'feat/cert-paraphrase', 'doc-fix'], { env })).committed, true);
});

test('commit-fix: a certificate whose file hash does not match the worktree is still rejected', () => {
  const { env } = seedCertifiedSingleGroup('feat/cert-badhash', { fileHashes: { 'a.txt': 'deadbeef' } });
  assert.throws(() => run(['commit-fix', 'feat/cert-badhash', 'doc-fix'], { env }), /certified content changed/);
});

test('record keeps a rejected fix edit, restores every other path, and parks the run', () => {
  const { repo, env } = seedCertifiedSingleGroup('feat/cert-kept', { fileHashes: { 'a.txt': 'deadbeef' } });
  assert.throws(() => run(['commit-fix', 'feat/cert-kept', 'doc-fix'], { env }), /certified content changed/);
  const STRAY = JSON.stringify({ dod: ['true'], stray: 'edit no fixer declared' });
  fs.writeFileSync(path.join(repo, 'review.config.json'), STRAY);
  const recorded = JSON.parse(run(['record', 'feat/cert-kept'], { env }));
  assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'fixed a\n', 'record must not discard the uncommitted edit');
  assert.notStrictEqual(fs.readFileSync(path.join(repo, 'review.config.json'), 'utf8'), STRAY, 'record must restore paths no rejected fix declared');
  assert.strictEqual(recorded.decision.continue, false);
  assert.strictEqual(recorded.decision.parked, true);
  assert.match(recorded.decision.reason, /a\.txt.*commit or discard/);
  assert.strictEqual(review.readLedger(env.REVIEW_STATE_DIR, review.targetSlug('feat/cert-kept')).status, 'parked');
});

test('a kept fix edit blocks round-start until the person commits or discards it, then unpark resumes', () => {
  const { repo, env } = seedCertifiedSingleGroup('feat/cert-decide', { fileHashes: { 'a.txt': 'deadbeef' } });
  assert.throws(() => run(['commit-fix', 'feat/cert-decide', 'doc-fix'], { env }), /certified content changed/);
  run(['record', 'feat/cert-decide'], { env });
  run(['unpark', 'feat/cert-decide', 'correctness:a'], { env });
  assert.throws(() => run(['round-start', 'feat/cert-decide'], { env }), /working tree is dirty/);
  execFileSync('git', ['commit', '-qam', 'adopt the kept fix'], { cwd: repo });
  assert.strictEqual(JSON.parse(run(['round-start', 'feat/cert-decide'], { env })).decision, 'work');
});

test('commit-fix: certified shared-helper fix atomically resolves the whole group', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bad b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add b'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-complete',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'shared helper is wrong' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'bad b', summary: 'caller observes the same helper bug' },
    ] },
    { status: 'ok', rejected: [], findings: [] });
  const planPath = path.join(dir, `round-${n}-plan.json`);
  fs.writeFileSync(planPath, JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [{
    groupId: 'shared', findingIds: ['correctness:a', 'correctness:b'], rootCause: 'shared helper', invariants: ['one outcome'], changeClass: 'local', structuralEffects: [], action: 'fix',
  }] }));
  fs.utimesSync(planPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  run(['plan-fixes', 'feat/v2-complete'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed shared helper\n');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'a.txt'))).digest('hex');
  writeArtifact(dir, n, 'fix-shared', { status: 'ok', edited: true, groupId: 'shared', files: ['a.txt'] });
  writeArtifact(dir, n, 'certify-shared', {
    status: 'ok', groupId: 'shared', resolvedFindingIds: ['correctness:a', 'correctness:b'], invariants: ['one outcome'],
    files: ['a.txt'], fileHashes: { 'a.txt': hash }, evidence: ['focused shared-helper regression passed'],
  });
  const committed = JSON.parse(run(['commit-fix', 'feat/v2-complete', 'shared'], { env }));
  assert.strictEqual(committed.committed, true);
  assert.deepStrictEqual(committed.resolvedFindingIds, ['correctness:a', 'correctness:b']);
});

test('commit-fix: round scope publishes all structural groups in one commit', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bad b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add b'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-round-commit',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'first structural symptom' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'bad b', summary: 'second structural symptom' },
    ] }, { status: 'ok', rejected: [], findings: [] });
  const evidence = { source: 'intent.md', sourceHash: 'abc', requirements: ['one owner'], uniqueness: 'one owner is explicit' };
  const slug = review.targetSlug('feat/v2-round-commit');
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), intentHash: 'abc' });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] });
  const planPath = path.join(dir, `round-${n}-plan.json`);
  fs.writeFileSync(planPath, JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [
    { groupId: 'a', findingIds: ['correctness:a'], rootCause: 'a', invariants: ['one active owner'], changeClass: 'structural', structuralEffects: ['ownership'], action: 'fix', designEvidence: evidence },
    { groupId: 'b', findingIds: ['correctness:b'], rootCause: 'b', invariants: ['one active owner'], changeClass: 'structural', structuralEffects: ['ownership'], action: 'fix', designEvidence: evidence },
  ] }));
  fs.utimesSync(planPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  const plan = JSON.parse(run(['plan-fixes', 'feat/v2-round-commit'], { env }));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'fixed b\n');
  writeArtifact(dir, n, 'fix-a', { status: 'ok', edited: true, groupId: 'a', files: ['a.txt'] });
  writeArtifact(dir, n, 'fix-b', { status: 'ok', edited: true, groupId: 'b', files: ['b.txt'] });
  const hashes = Object.fromEntries(['a.txt', 'b.txt'].map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
  writeArtifact(dir, n, `certify-${plan.planId}`, {
    status: 'ok', groupId: plan.planId, resolvedFindingIds: ['correctness:a', 'correctness:b'], invariants: ['one active owner'],
    files: ['a.txt', 'b.txt'], fileHashes: hashes, evidence: ['combined ownership regression passed'],
  });
  const before = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
  const committed = JSON.parse(run(['commit-fix', 'feat/v2-round-commit', plan.planId], { env }));
  const after = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
  assert.strictEqual(committed.committed, true);
  assert.strictEqual(after, before + 1);
  assert.deepStrictEqual(committed.groupIds, ['a', 'b']);
});

test('commit-fix: refuses a certified candidate when HEAD moved after planning', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/v2-head-fence',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'local defect' },
    ] }, { status: 'ok', rejected: [], findings: [] });
  const planPath = path.join(dir, `round-${n}-plan.json`);
  fs.writeFileSync(planPath, JSON.stringify({ status: 'ok', protocolVersion: 2, groups: [{
    groupId: 'a', findingIds: ['correctness:a'], rootCause: 'local defect', invariants: ['one result'], changeClass: 'local', structuralEffects: [], action: 'fix',
  }] }));
  const afterVerify = new Date(Date.now() + 1000);
  fs.utimesSync(planPath, afterVerify, afterVerify);
  run(['plan-fixes', 'feat/v2-head-fence'], { env });
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'moves head\n');
  execFileSync('git', ['add', 'unrelated.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'unrelated'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'a.txt'))).digest('hex');
  writeArtifact(dir, n, 'fix-a', { status: 'ok', edited: true, groupId: 'a', files: ['a.txt'] });
  writeArtifact(dir, n, 'certify-a', {
    status: 'ok', groupId: 'a', resolvedFindingIds: ['correctness:a'], invariants: ['one result'],
    files: ['a.txt'], fileHashes: { 'a.txt': hash }, evidence: ['focused regression passed'],
  });
  assert.throws(() => run(['commit-fix', 'feat/v2-head-fence', 'a'], { env }), /planned predecessor.*HEAD moved/i);
});

test('plan-fixes: a finding reopened after being marked fixed is not silently dropped as concluded', () => {
  const repo = initRepo(); const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const finding = { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' };
  // Pre-seed a ledger where this id is already status 'fixed' in both `findings`
  // and `seen`, so this round's re-detection of the same id makes
  // dedupeAgainstSeen mark it `reopened: true` (fix didn't hold / was reverted).
  let ledger = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  ledger.findings = [{ id: finding.id, status: 'fixed' }];
  ledger.seen = [{ id: finding.id, status: 'fixed', hash: review.seenHash(finding) }];
  review.writeLedger(dir, slug, ledger);

  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [finding] },
    { status: 'ok', rejected: [] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:real']);
  const l = review.readLedger(dir, slug);
  assert.deepStrictEqual(l.planned, ['correctness:real']);
});

test('plan-fixes: a reopened finding is never resolved as a replay of its earlier journaled fix', () => {
  for (const kind of ['span-removed', 'file-deleted']) {
    const repo = initRepo(); const dir = tmpDir(); const ref = `feat/reopened-${kind}`;
    const slug = review.targetSlug(ref);
    const finding = { id: 'correctness:real', gate: 'correctness', file: kind === 'file-deleted' ? 'gone.txt' : 'a.txt', span: 'recurred span', summary: 'x' };
    // A later round brought the problem back: the id is 'fixed' in the ledger and seen,
    // the old fix is still journaled, and the evidence now is a missing span or file.
    let ledger = review.emptyLedger({ kind: 'local', ref });
    ledger.findings = [{ id: finding.id, status: 'fixed' }];
    ledger.seen = [{ id: finding.id, status: 'fixed', hash: review.seenHash(finding) }];
    ledger.journal = [{ id: finding.id, sha: 'earlier-fix' }];
    review.writeLedger(dir, slug, ledger);
    const { env } = seedGatesRound(repo, dir, ref,
      { status: 'ok', examined: ['a.txt'], findings: [finding] },
      { status: 'ok', rejected: [] });
    const out = JSON.parse(run(['plan-fixes', ref], { env }));
    assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:real'], kind);
    assert.deepStrictEqual(review.readLedger(dir, slug).resolved_absent, [], kind);
  }
});

test('plan-fixes: a missing correctness artifact is a harness-failure (never clean)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: a correctness artifact that vanishes before its mtime check is a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  const correctness = path.join(dir, `round-${n}-correctness.json`);
  fs.writeFileSync(correctness, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const originalArgv = process.argv;
  const originalEnv = process.env;
  const originalStatSync = fs.statSync;
  process.argv = ['node', CLI, 'plan-fixes', 'feat/x'];
  process.env = env;
  fs.statSync = (file, ...args) => {
    if (file === correctness) {
      const error = new Error(`ENOENT: no such file or directory, stat '${file}'`);
      error.code = 'ENOENT';
      throw error;
    }
    return originalStatSync(file, ...args);
  };
  try {
    assert.throws(() => cli.main(), /harness-failure: missing gate artifact correctness/);
  } finally {
    fs.statSync = originalStatSync;
    process.argv = originalArgv;
    process.env = originalEnv;
  }
});

test('plan-fixes: a verify artifact older than its correctness artifact is a harness-failure (spawn-ordering race)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const n = review.readLedger(dir, review.targetSlug('feat/x')).round;
  const cPath = path.join(dir, `round-${n}-correctness.json`);
  const vPath = path.join(dir, `round-${n}-verify.json`);
  fs.writeFileSync(cPath, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(vPath, JSON.stringify({ status: 'ok', rejected: [] }));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(vPath, past, past); // verify's file predates correctness's -- simulates a parallel spawn racing an empty file
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env, skipPlanSeed: true }), /harness-failure.*predates/);
});

test('plan-fixes: a pooled verify artifact older than gate is a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/pooled-order',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] }, { armBroad: true });
  const correctnessPath = path.join(dir, `round-${n}-correctness.json`);
  const verifyPath = path.join(dir, `round-${n}-verify.json`);
  const gatePath = path.join(dir, `round-${n}-gate.json`);
  const now = new Date(); const past = new Date(now.getTime() - 5000); const middle = new Date(now.getTime() - 2500);
  fs.utimesSync(correctnessPath, past, past);
  fs.utimesSync(verifyPath, middle, middle);
  fs.utimesSync(gatePath, now, now);
  assert.throws(() => run(['plan-fixes', 'feat/pooled-order'], { env, broadDefault: true, skipPlanSeed: true }), /round-\d+-verify\.json predates round-\d+-gate\.json/);
});

test('plan-fixes: a changed file never examined is a harness-failure (coverage)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: [], findings: [] },
    { status: 'ok', rejected: [] });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure|coverage/);
});

test('plan-fixes: a deleted path never examined is a harness-failure (coverage)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  execFileSync('git', ['rm', '-q', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'delete a'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/delete', 'HEAD~1'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));

  assert.throws(() => run(['plan-fixes', 'feat/delete'], { env }), /harness-failure.*coverage.*a\.txt/);
});

// A confirmed finding whose span is absent from the file is an idempotent replay
// ONLY when this run's journal proves a prior commit for it. Without journal
// evidence, plan-fixes routes it to the fixer (not resolved_absent) to prevent
// silently converging green when a confirmed bug is still live. This test covers
// the journal-proven replay path: absent + journaled -> resolved_absent -> fixed.
// The no-journal path (absent + no journal -> planned -> parked) is covered by
// the phantom-fix regression-lock tests added below.
test('plan-fixes + record: a confirmed finding whose span is already absent from the file is idempotent-fixed, not a phantom open', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:absent', gate: 'correctness', file: 'a.txt', span: 'this-span-is-not-in-the-file', summary: 'x' } ] },
    { status: 'ok', rejected: [] });
  // Seed the journal with a prior commit that proves this absent span was already
  // fixed in a crashed run. plan-fixes requires this evidence to classify an
  // absent span as an idempotent replay rather than routing it to the fixer.
  let ll = review.readLedger(dir, review.targetSlug('feat/x'));
  ll = { ...ll, journal: [{ id: 'correctness:absent', sha: 'priorsha123' }] };
  review.writeLedger(dir, review.targetSlug('feat/x'), ll);

  const planOut = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(planOut.fixes, []); // span absent -- not in the fixable set
  const afterPlan = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(afterPlan.planned, []);
  assert.deepStrictEqual(afterPlan.resolved_absent, ['correctness:absent']);

  // No fix subagent, no commit-fix call -- there is nothing to commit.
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  const f = l.findings.find((x) => x.id === 'correctness:absent');
  assert.strictEqual(f.status, 'fixed'); // NOT 'open' -- the phantom-open bug
  assert.strictEqual(l.findings.filter((x) => x.status === 'open').length, 0);
  assert.strictEqual(out.decision.parked, false); // does not strand convergence
});

test('record: a replayed absent span that returns before record is parked, not fixed', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/reintroduced-span',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:absent', gate: 'correctness', file: 'a.txt', span: 'this-span-is-not-in-the-file', summary: 'x' } ] },
    { status: 'ok', rejected: [] });
  const slug = review.targetSlug('feat/reintroduced-span');
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, journal: [{ id: 'correctness:absent', sha: 'priorsha123' }] };
  review.writeLedger(dir, slug, ledger);

  run(['plan-fixes', 'feat/reintroduced-span'], { env });
  assert.deepStrictEqual(review.readLedger(dir, slug).resolved_absent, ['correctness:absent']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nthis-span-is-not-in-the-file\n');

  const out = JSON.parse(run(['record', 'feat/reintroduced-span'], { env }));
  const finding = review.readLedger(dir, slug).findings.find((x) => x.id === 'correctness:absent');
  assert.strictEqual(finding.status, 'parked');
  assert.strictEqual(out.decision.parked, true);
});

test('record: a companion-file journal entry does not fix a distinct live finding', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'companion\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add companion'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/mirror',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'live-span', summary: 'still needs a fix' },
    ] },
    { status: 'ok', rejected: [] });
  const slug = review.targetSlug('feat/mirror');
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, journal: [{ id: 'correctness:a', sha: 'companionsha', file: 'a.txt', files: ['a.txt', 'b.txt'], span: 'live-span' }] };
  review.writeLedger(dir, slug, ledger);

  assert.deepStrictEqual(JSON.parse(run(['plan-fixes', 'feat/mirror'], { env })).fixes.map((f) => f.id), ['correctness:b']);
  const out = JSON.parse(run(['record', 'feat/mirror'], { env }));
  const finding = review.readLedger(dir, slug).findings.find((f) => f.id === 'correctness:b');
  assert.strictEqual(finding.status, 'parked');
  assert.notStrictEqual(out.decision.converged, true);
});

test('plan-fixes: a companion-file journal entry does not replay an absent-span finding with a different id', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'companion\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add companion'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/companion-absent',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'MISSING_FUNC_XYZ', summary: 'required function is absent' },
    ] },
    { status: 'ok', rejected: [] });
  const slug = review.targetSlug('feat/companion-absent');
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, journal: [{ id: 'correctness:a', sha: 'companionsha', file: 'a.txt', files: ['a.txt', 'b.txt'], span: 'MISSING_FUNC_XYZ' }] };
  review.writeLedger(dir, slug, ledger);

  const planOut = JSON.parse(run(['plan-fixes', 'feat/companion-absent'], { env }));
  assert.deepStrictEqual(planOut.fixes.map((f) => f.id), ['correctness:b']);
  assert.deepStrictEqual(review.readLedger(dir, slug).resolved_absent, []);
});

test('commit-fix + record: an explicit mirrored finding claim resolves the declared counterpart', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'source span\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror span\n');
  execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add mirrored files'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/mirror-claim',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'source mirror' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'mirror span', summary: 'companion mirror' },
    ] },
    { status: 'ok', rejected: [], groups: [{ findingIds: ['correctness:a', 'correctness:b'], rootCause: 'one mirror contract', invariants: ['both views agree'], changeClass: 'local', action: 'fix' }] });
  assert.deepStrictEqual(JSON.parse(run(['plan-fixes', 'feat/mirror-claim'], { env })).fixes.map((f) => f.id), ['correctness:a', 'correctness:b']);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'source fixed\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_a.json`), JSON.stringify({
    status: 'ok', edited: true, groupId: 'correctness:a', files: ['a.txt', 'b.txt'],
  }));
  const committed = JSON.parse(run(['commit-fix', 'feat/mirror-claim', 'correctness:a'], { env }));
  assert.strictEqual(committed.committed, true);

  const out = JSON.parse(run(['record', 'feat/mirror-claim'], { env }));
  const findings = review.readLedger(dir, review.targetSlug('feat/mirror-claim')).findings;
  assert.strictEqual(findings.find((f) => f.id === 'correctness:a').status, 'fixed');
  assert.strictEqual(findings.find((f) => f.id === 'correctness:b').status, 'fixed');
  assert.strictEqual(findings.find((f) => f.id === 'correctness:b').fix_commit, committed.sha);
  assert.strictEqual(out.decision.parked, false);
});

test('commit-fix: certified group permits either edited file to be deleted', () => {
  for (const deleted of ['a.txt', 'b.txt']) {
    const repo = initRepo(); const dir = tmpDir();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'source span\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror span\n');
    execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add mirrored files'], { cwd: repo });
    const { env, n } = seedGatesRound(repo, dir, `feat/deleted-${deleted}`,
      { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
        { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'source mirror' },
        { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'mirror span', summary: 'companion mirror' },
      ] },
      { status: 'ok', rejected: [], groups: [{ findingIds: ['correctness:a', 'correctness:b'], rootCause: 'one mirror contract', invariants: ['both views agree'], changeClass: 'local', action: 'fix' }] });
    run(['plan-fixes', `feat/deleted-${deleted}`], { env });
    fs.rmSync(path.join(repo, deleted));
    if (deleted === 'a.txt') fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror fixed\n');
    else fs.writeFileSync(path.join(repo, 'a.txt'), 'source fixed\n');
    fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_a.json`), JSON.stringify({
      status: 'ok', edited: true, groupId: 'correctness:a', files: ['a.txt', 'b.txt'],
    }));
    assert.strictEqual(JSON.parse(run(['commit-fix', `feat/deleted-${deleted}`, 'correctness:a'], { env })).committed, true);
    const out = JSON.parse(run(['record', `feat/deleted-${deleted}`], { env }));
    const findings = review.readLedger(dir, review.targetSlug(`feat/deleted-${deleted}`)).findings;
    assert.strictEqual(findings.find((f) => f.id === 'correctness:a').status, 'fixed');
    assert.strictEqual(findings.find((f) => f.id === 'correctness:b').status, 'fixed');
    assert.strictEqual(out.decision.parked, false);
  }
});

test('record: treats a deleted certified group member as fixed', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror span\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add mirrored file'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/deleted-counterpart',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'source mirror' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'mirror span', summary: 'companion mirror' },
    ] },
    { status: 'ok', rejected: [], groups: [{ findingIds: ['correctness:a', 'correctness:b'], rootCause: 'one mirror contract', invariants: ['both views agree'], changeClass: 'local', action: 'fix' }] });
  run(['plan-fixes', 'feat/deleted-counterpart'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'source fixed\n');
  fs.rmSync(path.join(repo, 'b.txt'));
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_a.json`), JSON.stringify({
    status: 'ok', edited: true, groupId: 'correctness:a', files: ['a.txt', 'b.txt'],
  }));
  assert.strictEqual(JSON.parse(run(['commit-fix', 'feat/deleted-counterpart', 'correctness:a'], { env })).committed, true);
  const out = JSON.parse(run(['record', 'feat/deleted-counterpart'], { env }));
  const finding = review.readLedger(dir, review.targetSlug('feat/deleted-counterpart')).findings.find((f) => f.id === 'correctness:b');
  assert.strictEqual(finding.status, 'fixed');
  assert.strictEqual(out.decision.parked, false);
});

test('commit-fix: certification may prove an additive group fix while the primary span remains', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'source span\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror span\n');
  execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add mirrored files'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/mirror-claim-primary-live',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'source mirror' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'mirror span', summary: 'companion mirror' },
    ] },
    { status: 'ok', rejected: [], groups: [{ findingIds: ['correctness:a', 'correctness:b'], rootCause: 'one mirror contract', invariants: ['both views agree'], changeClass: 'local', action: 'fix' }] });
  run(['plan-fixes', 'feat/mirror-claim-primary-live'], { env });

  fs.appendFileSync(path.join(repo, 'a.txt'), 'unrelated dirty change\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_a.json`), JSON.stringify({
    status: 'ok', edited: true, groupId: 'correctness:a', files: ['a.txt', 'b.txt'],
  }));
  assert.strictEqual(JSON.parse(run(['commit-fix', 'feat/mirror-claim-primary-live', 'correctness:a'], { env })).committed, true);
});

test('commit-fix: certification may prove a group fix when a reported span was absent at HEAD', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'source span\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'mirror already absent\n');
  execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add mirrored files'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/mirror-claim-preexisting-absence',
    { status: 'ok', examined: ['a.txt', 'b.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'source mirror' },
      { id: 'correctness:b', gate: 'correctness', file: 'b.txt', span: 'mirror span', summary: 'companion mirror' },
    ] },
    { status: 'ok', rejected: [], groups: [{ findingIds: ['correctness:a', 'correctness:b'], rootCause: 'one mirror contract', invariants: ['both views agree'], changeClass: 'local', action: 'fix' }] });
  run(['plan-fixes', 'feat/mirror-claim-preexisting-absence'], { env });

  fs.writeFileSync(path.join(repo, 'a.txt'), 'source fixed\n');
  fs.appendFileSync(path.join(repo, 'b.txt'), 'unrelated dirty change\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_a.json`), JSON.stringify({
    status: 'ok', edited: true, groupId: 'correctness:a', files: ['a.txt', 'b.txt'],
  }));
  assert.strictEqual(JSON.parse(run(['commit-fix', 'feat/mirror-claim-preexisting-absence', 'correctness:a'], { env })).committed, true);
});

test('commit-fix: rejects a certificate that claims an unknown finding', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/mirror-claim-invalid',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:a', gate: 'correctness', file: 'a.txt', span: 'one', summary: 'source mirror' },
    ] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/mirror-claim-invalid'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_a.json`), JSON.stringify({
    status: 'ok', edited: true, groupId: 'correctness:a', files: ['a.txt'],
  }));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'a.txt'))).digest('hex');
  fs.writeFileSync(path.join(dir, `round-${n}-certify-correctness_a.json`), JSON.stringify({
    status: 'ok', groupId: 'correctness:a', resolvedFindingIds: ['correctness:a', 'correctness:unknown'],
    invariants: ['the reported behavior is corrected'], files: ['a.txt'], fileHashes: { 'a.txt': hash }, evidence: ['test'],
  }));
  assert.throws(
    () => run(['commit-fix', 'feat/mirror-claim-invalid', 'correctness:a'], { env }),
    /complete group certification/,
  );
  assert.strictEqual(execFileSync('git', ['status', '--porcelain', '--', 'a.txt'], { cwd: repo, encoding: 'utf8' }).trim(), 'M a.txt');
});

test('commit-fix: ignores a redundant self-resolution claim and commits the primary fix', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/self-resolution',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:self', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'primary finding' },
    ] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/self-resolution'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_self.json`), JSON.stringify({
    status: 'ok', edited: true, files: ['a.txt'], resolvedFindingIds: ['correctness:self'],
  }));
  const out = JSON.parse(run(['commit-fix', 'feat/self-resolution', 'correctness:self'], { env }));
  assert.strictEqual(out.committed, true);
  assert.deepStrictEqual(out.resolvedFindingIds, ['correctness:self']);
});

test('commit-fix: commits one fix and journals it', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true }));
  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, true);
  assert.match(out.sha, /^[0-9a-f]{7,40}$/);
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(l.journal.length, 1);
  assert.strictEqual(l.journal[0].id, 'correctness:real');
});

test('commit-fix: two findings in the same file get two separate commits', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:one', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
      { id: 'correctness:two', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' } ] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const before = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());

  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed-one\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_one.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:one'], { env });
  const afterFirst = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
  assert.strictEqual(afterFirst, before + 1);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed-two\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_two.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:two'], { env });
  const afterSecond = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
  assert.strictEqual(afterSecond, afterFirst + 1);

  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(l.journal.map((j) => j.id), ['correctness:one', 'correctness:two']);
});

test('commit-fix: scopes staging to the finding\'s file -- an unrelated dirty file is never swept into the commit', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });

  // The actual fix, to file A.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true }));
  // Unrelated dirty content in the working tree -- an untracked file, standing
  // in for a stray non-gitignored dir or a crash-recovery leftover.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'unrelated\n');

  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, true);

  const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', out.sha], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.deepStrictEqual(committedFiles, ['a.txt']);
  // b.txt was never staged or committed -- it is still dirty/untracked.
  const status = execFileSync('git', ['status', '--porcelain', '--', 'b.txt'], { cwd: repo, encoding: 'utf8' });
  assert.ok(status.trim().length > 0, 'b.txt should remain dirty/untracked after commit-fix');
});

// DEFECT: gitCommitFix staged only finding.file. If a fix subagent legitimately
// edited a second file (e.g. a caller/import that needed updating to make the
// fix correct), that companion edit was left uncommitted -- and record()'s
// gitCheckoutTree discards any leftover uncommitted edit at the end of the
// round, silently wiping the companion change even though the finding is
// reported fixed with a valid commit sha. The fix subagent now declares every
// file it touched via a `files` array on the fix artifact; commit-fix must
// stage and commit all of them (still never `-A`).
test('commit-fix: a fix that declares multiple files (finding.file + companion) commits all of them, still scoped', () => {
  const repo = initRepo(); const dir = tmpDir();
  // A second tracked file standing in for the companion edit (e.g. a caller
  // that needed updating alongside the finding's own file).
  fs.writeFileSync(path.join(repo, 'c.txt'), 'orig\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add c.txt'], { cwd: repo });

  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });

  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'companion-edit\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true, files: ['a.txt', 'c.txt'] }));
  // Unrelated dirty content that must still never be swept in.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'unrelated\n');

  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, true);
  const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', out.sha], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepStrictEqual(committedFiles, ['a.txt', 'c.txt']);
  const status = execFileSync('git', ['status', '--porcelain', '--', 'b.txt'], { cwd: repo, encoding: 'utf8' });
  assert.ok(status.trim().length > 0, 'b.txt should remain dirty/untracked -- companion staging must still be scoped, not -A');
});

test('commit-fix: rejects an outside-repository path declared by a fix artifact before git add', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true, files: ['a.txt', '/tmp/not-a-repo-file'] }));

  assert.throws(
    () => run(['commit-fix', 'feat/x', 'correctness:real'], { env }),
    /harness-failure: commit-fix: declared file "\/tmp\/not-a-repo-file" is outside the repository/,
  );
  assert.strictEqual(execFileSync('git', ['status', '--porcelain', '--', 'a.txt'], { cwd: repo, encoding: 'utf8' }).trim(), 'M a.txt');
});

test('commit-fix: rejects a stateDir artifact even when stateDir is inside the repository', () => {
  const repo = initRepo(); const dir = path.join(repo, '.review-state');
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  const artifact = `.review-state/round-${n}-fix-correctness_real.json`;
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true, files: ['a.txt', artifact] }));

  assert.throws(
    () => run(['commit-fix', 'feat/x', 'correctness:real'], { env }),
    /harness-failure: commit-fix: declared file ".*" is a stateDir artifact/,
  );
});

test('commit-fix: idempotent -- a second call for an already-journaled id commits nothing new', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env });
  const shaCount1 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const out = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(out.committed, false);
  const shaCount2 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.strictEqual(shaCount1, shaCount2);
});

test('record: a missing correctness artifact is a harness-failure (never a spurious clean decision)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.unlinkSync(path.join(dir, `round-${n}-correctness.json`)); // simulate a broken/missing gate artifact before record runs
  assert.throws(() => run(['record', 'feat/x'], { env }), /harness-failure/);
});

test('record: a corrupt (non-JSON) verify artifact is a harness-failure too', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), 'not json{{{');
  assert.throws(() => run(['record', 'feat/x'], { env }), /harness-failure/);
});

test('record: a verify artifact older than its correctness artifact is a harness-failure (spawn-ordering race)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env }); // succeeds -- correctly ordered artifacts at this point
  const cPath = path.join(dir, `round-${n}-correctness.json`);
  const vPath = path.join(dir, `round-${n}-verify.json`);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(vPath, past, past); // simulate the verify artifact turning out to predate correctness's by the time record reads them
  assert.throws(() => run(['record', 'feat/x'], { env }), /harness-failure.*predates/);
});

test('record: a journaled fix is reported fixed, and the fix-round never converges (stable-round)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env }); // driver calls this right after the fix subagent
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, true);     // fix-round never converges
  assert.strictEqual(out.decision.converged, false);
  const l = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(l.phase, 'done');
  assert.strictEqual(l.journal.length, 1);
  assert.strictEqual(l.budget.spent, 1);               // charged because continue:true
  assert.strictEqual(l.last_recorded_round, n);
});

test('record: idempotent -- a second record for the same round re-prints and does not double-commit or double-charge', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env });
  run(['record', 'feat/x'], { env });
  const shaCount1 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const spent1 = review.readLedger(dir, review.targetSlug('feat/x')).budget.spent;
  run(['record', 'feat/x'], { env }); // second call, same round, phase already 'done'
  const shaCount2 = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const spent2 = review.readLedger(dir, review.targetSlug('feat/x')).budget.spent;
  assert.strictEqual(shaCount1, shaCount2); // no new commit
  assert.strictEqual(spent1, spent2);       // no double charge
});

test('record: an idempotent abandoned terminus deletes every telemetry artifact', () => {
  const dir = tmpDir(); const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, {
    ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }),
    status: 'abandoned', phase: 'done', last_recorded_round: 0,
    _lastDecision: { continue: false, abandoned: true },
  });
  const files = [
    path.join(dir, `review-telemetry-${'a'.repeat(64)}.json`),
    path.join(dir, `review-agent-telemetry-${'b'.repeat(64)}.json`),
    path.join(dir, `telemetry-${slug}.json`),
  ];
  fs.writeFileSync(files[0], JSON.stringify({ targetRef: 'feat/x', agentId: 'agent-1', parentTranscriptPath: '/parent' }));
  fs.writeFileSync(files[1], JSON.stringify({ agentId: 'agent-1', parentTranscriptPath: '/parent' }));
  fs.writeFileSync(files[2], '{}');

  run(['record', 'feat/x'], { env });

  assert.deepStrictEqual(files.map(fs.existsSync), [false, false, false]);
});

test('record: tripping the park budget forces status parked and continue false, without charging a round', () => {
  const { REVIEW_PARK_BUDGET_DEFAULT } = require('../../core/config');
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:new', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  // Seed REVIEW_PARK_BUDGET_DEFAULT pre-existing needs-decision parks so this
  // round's one additional park (correctness:new, never fixed) trips the breaker.
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  const priorParks = [];
  for (let i = 0; i < REVIEW_PARK_BUDGET_DEFAULT; i += 1) {
    priorParks.push({ id: `correctness:old-${i}`, gate: 'correctness', file: 'a.txt', span: '', summary: 'x', status: 'parked', park_reason: { kind: 'needs-decision', text: 'prior' } });
  }
  ledger = { ...ledger, findings: priorParks };
  review.writeLedger(dir, slug, ledger);
  const telemetryFile = path.join(dir, `review-telemetry-${'c'.repeat(64)}.json`);
  fs.writeFileSync(telemetryFile, JSON.stringify({
    engine: 'claude-code', provider: 'anthropic', targetRef: 'feat/x', role: 'correctness', round: n,
    artifactPath: path.join(dir, `round-${n}-correctness.json`), attempt: 1, invocationId: 'parked-tool', usagePartial: true,
  }));
  // no fix artifact and no commit-fix call for correctness:new -> it parks too
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, false);
  assert.strictEqual(out.decision.converged, false); // must not read as a stale/spurious clean
  assert.strictEqual(out.decision.parked, true);
  const l = review.readLedger(dir, slug);
  assert.strictEqual(l.status, 'parked');
  assert.strictEqual(l.budget.spent, 0); // park-budget-forced terminus does not consume a round
  assert.strictEqual(fs.existsSync(telemetryFile), false);
});

// --- Phantom-fix false-green regression lock (3 tests) ---
// Prior to the fix, plan-fixes used only spanPresent() to split confirmed
// findings: absent span -> resolvedAbsent, and record() blindly stamped every
// resolvedAbsent id as 'fixed' with a sentinel commit string. An additive or
// absence finding (span never in the file) or a finding with reviewer span that
// drifted from the actual text was silently marked fixed with no patch.
// The fix: absent span is an idempotent replay ONLY when this run's journal
// proves a commit for it. Without that evidence, route it to the fixer.

test('plan-fixes routes an absent-span finding with no journal evidence to the fixer, not resolved_absent', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/absent-no-journal',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:additive', gate: 'correctness', file: 'a.txt', span: 'MISSING_FUNC_XYZ', summary: 'required function is absent' }
    ]},
    { status: 'ok', rejected: [] });
  // a.txt contains 'two\n' from seedGatesRound -- confirm the span is not present.
  assert.ok(!fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').includes('MISSING_FUNC_XYZ'));

  const planOut = JSON.parse(run(['plan-fixes', 'feat/absent-no-journal'], { env }));
  // No journal evidence: absent span must go to the fixer (fixes), NOT resolved_absent.
  assert.deepStrictEqual(planOut.fixes.map((f) => f.id), ['correctness:additive']);

  const l = review.readLedger(dir, review.targetSlug('feat/absent-no-journal'));
  assert.deepStrictEqual(l.planned, ['correctness:additive']);
  assert.deepStrictEqual(l.resolved_absent, []);
});

test('absent-span finding with no journal and no fix is parked needs-decision, never marked fixed or converged', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/absent-parked',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:additive', gate: 'correctness', file: 'a.txt', span: 'MISSING_FUNC_XYZ', summary: 'required function is absent' }
    ]},
    { status: 'ok', rejected: [] });
  // plan-fixes with no journal evidence routes the absent-span finding to planned.
  run(['plan-fixes', 'feat/absent-parked'], { env });
  const afterPlan = review.readLedger(dir, review.targetSlug('feat/absent-parked'));
  assert.deepStrictEqual(afterPlan.planned, ['correctness:additive']);
  assert.deepStrictEqual(afterPlan.resolved_absent, []);

  // No fix artifact and no commit-fix -- the bug was that record silently marked
  // this fixed even though no patch ever landed.
  const out = JSON.parse(run(['record', 'feat/absent-parked'], { env }));
  const l = review.readLedger(dir, review.targetSlug('feat/absent-parked'));
  const f = l.findings.find((x) => x.id === 'correctness:additive');
  assert.strictEqual(f.status, 'parked'); // must NOT be 'fixed' -- no patch landed
  assert.notStrictEqual(out.decision.converged, true); // must not converge green with a live bug
});

test('journal-proven absent-span finding is stamped fixed with the real commit sha, not a sentinel string', () => {
  const repo = initRepo(); const dir = tmpDir();
  const slug = review.targetSlug('feat/absent-journaled');
  const { env } = seedGatesRound(repo, dir, 'feat/absent-journaled',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:absent', gate: 'correctness', file: 'a.txt', span: 'MISSING_FUNC_XYZ', summary: 'code was missing; prior run fixed it' }
    ]},
    { status: 'ok', rejected: [] });
  // Seed the journal with a commit that proves the fix already landed in a prior
  // crashed run -- this is the legitimate idempotent-replay path.
  const realSha = 'abc123def456abc123def456abc123def456abc123';
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, journal: [{ id: 'correctness:absent', sha: realSha }] };
  review.writeLedger(dir, slug, ledger);

  // plan-fixes: absent + journal-proven -> idempotent replay -> resolvedAbsent, not fixes.
  const planOut = JSON.parse(run(['plan-fixes', 'feat/absent-journaled'], { env }));
  assert.deepStrictEqual(planOut.fixes, []);
  const afterPlan = review.readLedger(dir, slug);
  assert.deepStrictEqual(afterPlan.resolved_absent, ['correctness:absent']);
  assert.deepStrictEqual(afterPlan.planned, []);

  // record: replay is stamped fixed with the REAL journal sha, not the old sentinel string.
  run(['record', 'feat/absent-journaled'], { env });
  const l = review.readLedger(dir, slug);
  const f = l.findings.find((x) => x.id === 'correctness:absent');
  assert.strictEqual(f.status, 'fixed');
  assert.strictEqual(f.fix_commit, realSha); // must be the real sha, not 'span already absent ...'
});

// --- end phantom-fix regression lock ---

function initRepoWithIntent(intentCmd) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-intent-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], intent: { command: intentCmd } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

test('round-start: intent configured -> fetches intent-<slug>.md, sets intentHash, intentApplied:true', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.intentApplied, true);
  const slug = review.targetSlug('feat/x');
  assert.ok(fs.existsSync(path.join(dir, `intent-${slug}.md`)));
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${slug}.md`), 'utf8'), 'REQ: retry three times');
  const ledger = review.readLedger(dir, slug);
  assert.strictEqual(typeof ledger.intentHash, 'string');
  assert.ok(ledger.intentBytes > 0);
});

test('round-start: no intent config -> intentApplied:false, no artifact', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.intentApplied, false);
  assert.ok(!fs.existsSync(path.join(dir, `intent-${review.targetSlug('feat/x')}.md`)));
});

test('round-start: intent fetch that exits non-zero -> harness-failure abort', () => {
  const repo = initRepoWithIntent('exit 7');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  assert.throws(() => run(['round-start', 'feat/x', 'HEAD~1'], { env }), /harness-failure/);
});

test('round-start: intent-review re-entry re-fetches and advances a round', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const slug = review.targetSlug('feat/x');
  // simulate a prior intent-review terminus
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, status: 'intent-review', phase: 'done', intent_parked: [{ id: 'intent:x', file: 'a.txt', span: 'two', requirement: 'REQ', summary: 's' }] };
  review.writeLedger(dir, slug, ledger);
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work'); // re-entered, not "terminal"
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.intent_parked, []); // reset
  assert.ok(fs.existsSync(path.join(dir, `intent-${slug}.md`))); // re-fetched
});

// Intent source that lives OUTSIDE the repo (the repo tree must stay clean) and
// counts its own invocations, so the drift tests can both mutate the source and
// assert the per-round fetch cost.
function intentSource(text) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-src-'));
  const file = path.join(d, 'intent.md');
  const counter = path.join(d, 'count');
  fs.writeFileSync(file, text);
  fs.writeFileSync(counter, '');
  return {
    command: `printf . >> ${counter}; cat ${file}`,
    set: (t) => fs.writeFileSync(file, t),
    remove: () => fs.unlinkSync(file),
    fetches: () => fs.readFileSync(counter, 'utf8').length,
  };
}

test('round-start: intent source unchanged -> re-fetches once to compare, round proceeds', () => {
  const src = intentSource('REQ: retry three times');
  const repo = initRepoWithIntent(src.command);
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.intentApplied, true);
  assert.strictEqual(src.fetches(), 2); // one per round, no more
  const slug = review.targetSlug('feat/x');
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${slug}.md`), 'utf8'), 'REQ: retry three times');
});

test('round-start: intent source changed mid-run -> requires reconciliation and rerun, cache untouched', () => {
  const src = intentSource('REQ: retry three times');
  const repo = initRepoWithIntent(src.command);
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  src.set('REQ: retry twice'); // the human corrected the design source mid-run
  const r = runCapture(['round-start', 'feat/x', 'HEAD~1'], { env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /intent source changed since this run began/);
  assert.match(r.stderr, /reconcile the changed source.*rerun feat\/x.*original initiative flags/);
  const slug = review.targetSlug('feat/x');
  // neither silently stale-and-quiet nor silently adopted: the artifact is the original
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${slug}.md`), 'utf8'), 'REQ: retry three times');
});

test('round-start: drift-check fetch failure reads differently from a changed source', () => {
  const src = intentSource('REQ');
  const repo = initRepoWithIntent(src.command);
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  src.remove(); // source unreachable -> cat exits non-zero
  const r = runCapture(['round-start', 'feat/x', 'HEAD~1'], { env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /drift-check fetch failed/);
  assert.doesNotMatch(r.stderr, /intent source changed/);
});

test('round-start: gate-pending re-entry adopts a changed intent source instead of failing on drift', () => {
  const src = intentSource('REQ: retry three times');
  const repo = initRepoWithIntent(src.command);
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const slug = review.targetSlug('feat/x');
  // simulate a prior gate-pending terminus, whose documented remedy is
  // "fix the code or the design source and re-run"
  const ledger = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...ledger, status: 'gate-pending', phase: 'done', gate_open: [{ id: 'gate:x' }] });
  src.set('REQ: retry twice'); // the human took the documented remedy
  const r = runCapture(['round-start', 'feat/x', 'HEAD~1'], { env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).decision, 'work');
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${slug}.md`), 'utf8'), 'REQ: retry twice'); // NEW intent
});

test('unpark: a parked run carrying an intent finding adopts a changed intent source on re-run', () => {
  const src = intentSource('REQ: retry three times');
  const repo = initRepoWithIntent(src.command);
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const slug = review.targetSlug('feat/x');
  // A parked terminus that still carries an intent finding: applyRoundOutcome
  // gives 'parked' precedence over 'intent-review', so the handoff prints the
  // intent remedy ("fix the code or the design source, then re-run") while the
  // ledger status is 'parked'.
  const ledger = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, {
    ...ledger,
    status: 'parked',
    phase: 'done',
    findings: [{ id: 'c:stuck', status: 'parked', park_reason: 'no progress' }],
    intent_parked: [{ id: 'intent:retry-count', file: 'a.txt', span: 'two', requirement: 'REQ', summary: 's' }],
  });
  // The human takes the documented remedy: corrects the design source AND the code.
  src.set('REQ: retry twice');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  execFileSync('git', ['commit', '-aqm', 'remedy'], { cwd: repo });
  run(['unpark', 'feat/x', 'c:stuck'], { env });
  const r = runCapture(['round-start', 'feat/x', 'HEAD~2'], { env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).decision, 'work');
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${slug}.md`), 'utf8'), 'REQ: retry twice'); // NEW intent
  // the repeated objection keeps its id across the re-entry
  assert.deepStrictEqual(JSON.parse(r.stdout).priorIntentIds, ['intent:retry-count']);
});

test('round-start: reports the prior round\'s open intent ids so the detector reuses them', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.deepStrictEqual(first.priorIntentIds, []);
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, status: 'intent-review', phase: 'done', intent_parked: [{ id: 'intent:scope-not-a-key-listing', file: 'a.txt', span: 'two', requirement: 'REQ', summary: 's' }] };
  review.writeLedger(dir, slug, ledger);
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.deepStrictEqual(out.priorIntentIds, ['intent:scope-not-a-key-listing']);
});

test('review-driver: the intent-detector prompt demands id reuse across rounds', () => {
  // The composed command file is what a run actually consumes; the core source is its input.
  for (const rel of [['commands', 'review-and-fix.md'], ['core', 'review-driver.md']]) {
    const md = fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8');
    const prompt = md.slice(md.indexOf('You are a design-conformance detector'), md.indexOf('If there are no contradictions'));
    assert.match(prompt, /priorIntentIds/, rel.join('/'));
    assert.match(prompt, /REUSE that `id` verbatim/, rel.join('/'));
  }
});

test('manual review drivers restore pending retry prompts and skip completed artifacts', () => {
  for (const rel of [['commands', 'review-and-fix.md'], ['core', 'review-driver.md']]) {
    const md = fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8');
    assert.match(md, /skip every role named by `completedArtifacts`/i, rel.join('/'));
    assert.match(md, /`retryArtifacts`.*persisted corrective prompt/i, rel.join('/'));
  }
});

test('manual repair instructions stage only the packet and immutable snapshot', () => {
  const root = path.join(__dirname, '..', '..');
  for (const rel of [
    ['core', 'review-driver.md'],
    ['commands', 'review-and-fix.md'],
    ['..', 'concord-copilot', 'skills', 'review-and-fix', 'references', 'review-driver.md'],
  ]) {
    const md = fs.readFileSync(path.join(root, ...rel), 'utf8');
    assert.match(md, /artifact-repair-dispatch <ref> <role>.*one-attempt durable state/i, rel.join('/'));
    assert.match(md, /mktemp -d/, rel.join('/'));
    assert.match(md, /packet\.json/, rel.join('/'));
    assert.match(md, /original\.json/, rel.join('/'));
    assert.match(md, /Never pass a state-directory path to the repair launch/i, rel.join('/'));
  }
});

test('manual review drivers allocate telemetry only when the selected adapter exposes it', () => {
  const command = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'review-and-fix.md'), 'utf8');
  const driver = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'review-driver.md'), 'utf8');
  assert.match(command, /telemetry-slot <ref> <exact-output-artifact-path>/);
  assert.match(command, /--engine claude-code/);
  assert.match(command, /only for native Claude roles/i);
  assert.match(driver, /authenticated telemetry/i);
  assert.match(driver, /Do not allocate synthetic slots/i);
});

test('review-and-fix owns provider routing without a separate Codex review skill', () => {
  const root = path.join(__dirname, '..', '..');
  const md = fs.readFileSync(path.join(root, 'commands', 'review-and-fix.md'), 'utf8');
  assert.strictEqual(fs.existsSync(path.join(root, 'skills', 'concord-codex-review')), false);
  assert.match(md, /--reviewer <claude\|codex\|copilot>/);
  assert.match(md, /--fixer <claude\|codex\|copilot>/);
});

test('driver prose names carry for budget-exhausted recovery, never a run-key change', () => {
  for (const rel of [['commands', 'review-and-fix.md'], ['core', 'review-driver.md']]) {
    const md = fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8');
    assert.match(md, /carry <ref> --from-run-key <old-key>/, rel.join('/'));
    assert.match(md, /never (?:increase budgets|change the run key yourself)/i, rel.join('/'));
    assert.doesNotMatch(md, /never change the run key, increase budgets/i, rel.join('/'));
  }
});

test('the initiative skill and handoff contract name carry for a genuine budget block, never to refresh context', () => {
  const root = path.join(__dirname, '..', '..', 'skills', 'initiative-to-prs');
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const handoff = fs.readFileSync(path.join(root, 'references', 'handoff-contract.md'), 'utf8');
  assert.match(skill, /carry <ref> --from-run-key <old-key>/);
  assert.match(skill, /never use `carry` to refresh context/i);
  assert.match(handoff, /`carry` the blocked target/);
  assert.match(handoff, /never as a substitute for resuming the existing key/);
});

function writeArtifact(dir, n, name, obj) {
  const artifactName = name.startsWith('fix-') ? `fix-${safeIdForFilename(name.slice(4))}` : name;
  fs.writeFileSync(path.join(dir, `round-${n}-${artifactName}.json`), JSON.stringify(obj));
}

test('plan-fixes: intent finding on a changed file -> ledger.intent_parked with requirement', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const rs = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  const n = rs.round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.intent_parked.length, 1);
  assert.strictEqual(ledger.intent_parked[0].id, 'intent:retry-count');
  assert.strictEqual(ledger.intent_parked[0].requirement, 'retry three times');
});

test('plan-fixes: no-key runs suppress correctness fixes for reconciliation-required intent findings', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:fix-me', file: 'a.txt', span: 'two', summary: 'fix it' }] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [{ id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' }] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes, []);
  assert.strictEqual(out.avoidedLaunches, 1);
  assert.deepStrictEqual(out.reconciliation.findings, { intent: 1 });
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(ledger.planned, []);
  assert.deepStrictEqual(ledger.reconciliation, { avoidedLaunches: 1 });
});

test('record: material design gate terminates reconciliation even while the DoD failed', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['false'], gate: {} }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'configure failing gate'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x', { status: 'ok', examined: ['a.txt'], findings: [] }, { status: 'ok', rejected: [] }, { armBroad: true });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [{ id: 'gate:design-conformance:missing', file: 'a.txt', span: 'one', requirement: 'REQ', summary: 'missing requirement' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, false);
  assert.strictEqual(out.decision.gatePending, true);
  assert.strictEqual(out.decision.reconciliation, true);
  assert.deepStrictEqual(out.reconciliation.findings, { 'design-conformance': 1 });
});

test('plan-fixes: intent finding on an UNCHANGED file -> dropped', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:elsewhere', file: 'other.txt', span: 'x', summary: 's', requirement: 'r' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  assert.strictEqual(review.readLedger(dir, review.targetSlug('feat/x')).intent_parked.length, 0);
});

test('plan-fixes: intentHash set but intent artifact missing -> harness-failure', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  // NO round-n-intent.json written -> detector was skipped
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: an intent: id in the CORRECTNESS artifact -> harness-failure (symmetric guard)', () => {
  const repo = initRepoWithIntent('printf "REQ"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [
    { id: 'intent:sneaky', file: 'a.txt', summary: 'should not auto-fix' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: a gate: id in the CORRECTNESS artifact -> harness-failure (symmetric guard)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [
    { id: 'gate:cross-context:leak', file: 'a.txt', summary: 'should not auto-fix' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('record: an intent finding terminates intent-review and the handoff shows it', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, false);
  assert.strictEqual(out.decision.intentReview, true);
  assert.match(out.handoff, /status: intent-review/);
  assert.match(out.handoff, /intent: applied/);
  assert.match(out.handoff, /retry three times/);
  assert.match(out.handoff, /intent:retry-count/);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.status, 'intent-review');
  assert.strictEqual(ledger.budget.spent, 1);
});

test('record: park-budget override on an intent-review round clears intentReview, leaving only parked', () => {
  // A round whose OWN decision would be intent-review (an intent finding, no
  // this-round needs-decision parks) must still get force-terminated to
  // "parked" once REVIEW_PARK_BUDGET_DEFAULT prior parks are on the books --
  // and the override must not leave a stale intentReview:true riding along
  // with parked:true, or the command prompt would print "resolve and re-run"
  // intent guidance while the ledger truthfully refuses to resume until `unpark`.
  const { REVIEW_PARK_BUDGET_DEFAULT } = require('../../core/config');
  const repo = initRepoWithIntent('printf "REQ: retry three times"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'two', summary: 'retries once', requirement: 'retry three times' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });

  // Seed REVIEW_PARK_BUDGET_DEFAULT pre-existing needs-decision parks so the
  // breaker trips on this record call, same technique as the plain park-budget test.
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  const priorParks = [];
  for (let i = 0; i < REVIEW_PARK_BUDGET_DEFAULT; i += 1) {
    priorParks.push({ id: `correctness:old-${i}`, gate: 'correctness', file: 'a.txt', span: '', summary: 'x', status: 'parked', park_reason: { kind: 'needs-decision', text: 'prior' } });
  }
  ledger = { ...ledger, findings: priorParks };
  review.writeLedger(dir, slug, ledger);

  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.parked, true);
  assert.ok(!out.decision.intentReview); // must be cleared, not left riding along with parked:true
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.status, 'parked'); // not the stale 'intent-review'
});

test('renderHandoff: no intent config -> "intent: not configured"', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /intent: not configured/);
});

test('renderHandoff: a FAILED DoD surfaces the failing command, exit code, and output tail', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  // A DoD command that fails deterministically with identifiable output on stderr.
  // Commit the config change on its own so it is not part of the reviewed diff
  // (else the coverage gate flags review.config.json as an unexamined change).
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['echo OUTPUT_NEEDLE 1>&2; exit 3'] }));
  execFileSync('git', ['commit', '-aqm', 'set failing dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /DoD: FAILED/);
  // the failing command + its exit code, on the line right after "DoD: FAILED"
  assert.match(out.handoff, /DoD: FAILED\n {2}\$ echo OUTPUT_NEEDLE 1>&2; exit 3 {2}\(exit 3\)/);
  // a tail of the runner's captured output, rendered as an indented line
  assert.match(out.handoff, /\n {4}OUTPUT_NEEDLE/);
});

function dodHandoff(dodCmd) {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: [dodCmd] }));
  execFileSync('git', ['commit', '-aqm', 'set dod'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  return JSON.parse(run(['record', 'feat/x'], { env })).handoff;
}

test('renderDodFailure: exit 78 is labeled a DoD environment error, not a test failure', () => {
  const handoff = dodHandoff('exit 78');
  assert.match(handoff, /DoD: FAILED\n {2}\$ exit 78 {2}\(exit 78\)\n {2}DoD environment\/setup error \(exit 78\): the gate could not be prepared; this is not a test failure of the reviewed change\./);
});

test('renderDodFailure: a normal failure carries no environment label', () => {
  assert.doesNotMatch(dodHandoff('exit 3'), /environment/i);
});

test('e2e: intent contradiction -> intent-review; fix code + re-run -> clean', () => {
  const repo = initRepoWithIntent('printf "REQ: the retry count must be three"');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const slug = review.targetSlug('feat/x');

  // A change that contradicts the requirement (retries once).
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry(1)\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  // --- drive 1: detector raises the contradiction ---
  let n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:retry-count', file: 'a.txt', span: 'retry(1)', summary: 'retries once', requirement: 'the retry count must be three' },
  ] });
  run(['plan-fixes', 'feat/x'], { env });
  let out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.intentReview, true);
  assert.strictEqual(review.readLedger(dir, slug).status, 'intent-review');

  // --- human fixes the code, re-runs ---
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry(3)\n');
  execFileSync('git', ['commit', '-aqm', 'fix retry count'], { cwd: repo });
  n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~2'], { env })).round; // now two commits past base
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [] }); // contradiction gone
  run(['plan-fixes', 'feat/x'], { env });
  out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.converged, true);
  assert.strictEqual(review.readLedger(dir, slug).status, 'clean');
});

test('e2e: no intent config -> the same diff does NOT surface an intent finding (behaves as v0.5.0)', () => {
  const repo = initRepo(); // no intent in config
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry(1)\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env }); // no intent artifact needed; intentHash is null
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.converged, true);
  assert.match(out.handoff, /intent: not configured/);
});

// --- stale-base footgun warning ---
// When the base is a LOCAL branch that is behind its upstream, git diff
// base...HEAD sweeps in every commit merged upstream since the branch point --
// a phantom diff of unrelated files. round-start must emit a non-fatal warning
// to stderr so the user knows to pass the remote ref instead.

test('round-start warns when the base branch is behind its upstream', () => {
  // Set up a repo where local branch `stalebase` is 1 commit behind its
  // upstream `up`, without a real remote (simpler + deterministic).
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-stale-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  // stalebase: anchored at the initial commit.
  execFileSync('git', ['checkout', '-qb', 'stalebase'], { cwd: repo });
  // up: one extra commit ahead of stalebase.
  execFileSync('git', ['checkout', '-qb', 'up'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'extra\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'extra on up'], { cwd: repo });
  // Return to stalebase and declare up as its upstream.
  execFileSync('git', ['checkout', '-q', 'stalebase'], { cwd: repo });
  execFileSync('git', ['branch', '--set-upstream-to=up', 'stalebase'], { cwd: repo });
  // The head under review is a commit on top of stalebase.
  execFileSync('git', ['checkout', '-qb', 'work'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'c.txt'), 'work\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'work on stalebase'], { cwd: repo });
  // stalebase@{upstream} = up; stalebase is now 1 commit behind up.

  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const r = runCapture(['round-start', 'feat/x', 'stalebase'], { env });

  // Warning is non-fatal: round-start must still exit 0.
  assert.strictEqual(r.status, 0, `round-start must not abort on a stale-base warning; stderr: ${r.stderr}`);
  // Warning text must identify the branch, the commit count, and the root cause.
  assert.match(r.stderr, /behind its upstream/);
  assert.match(r.stderr, /stalebase/);
  assert.match(r.stderr, /\b1\b/); // 1 commit behind

  // Companion: a base ref with NO configured upstream (e.g. HEAD~1) must produce
  // no warning and must not throw (exercises the try/catch in the warning block).
  const repo2 = initRepo();
  fs.writeFileSync(path.join(repo2, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo2 });
  const dir2 = tmpDir();
  const r2 = runCapture(['round-start', 'feat/x', 'HEAD~1'], {
    env: { ...process.env, REVIEW_STATE_DIR: dir2, REVIEW_REPO_ROOT: repo2 },
  });
  assert.strictEqual(r2.status, 0);
  assert.ok(!r2.stderr.includes('behind its upstream'), 'no stale-base warning for a ref without a configured upstream');
  // The upstream lookup fails for a no-upstream base (git prints "fatal: ..." to
  // its own stderr); the warning block must SWALLOW that noise, not leak it. The
  // default base is origin/<main>, which has no upstream, so this path runs every
  // round -- a leaked "fatal:" reads as an error though the run is fine.
  assert.ok(!/fatal|no such branch|no upstream/i.test(r2.stderr), `a no-upstream base must not leak git's stderr; got: ${r2.stderr}`);
});

// ---- dod:null deferred opt-out integration ----

test('a review.config.json with "dod": null converges with the DoD reported DEFERRED, never passed', () => {
  // Infra/VTL/CDK repos have no honest executable DoD (validated only by
  // post-deploy e2e). dod:null is the explicit opt-out: the review gates still
  // run; the executable DoD is skipped and labeled deferred, never faked.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-dod-defer-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: null }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };

  // Commit a change so there is a real diff.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  // round-start: before the fix this throws because loadDodConfig throws on dod:null.
  const rsOut = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(rsOut.decision, 'work');

  const n = rsOut.round;

  // Write gate artifacts: zero correctness findings, zero rejections.
  fs.writeFileSync(
    path.join(dir, `round-${n}-correctness.json`),
    JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }),
  );
  fs.writeFileSync(
    path.join(dir, `round-${n}-verify.json`),
    JSON.stringify({ status: 'ok', rejected: [] }),
  );

  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));

  // A deferred DoD must not block convergence: zero open findings -> converged.
  assert.strictEqual(out.decision.converged, true, 'dod:null should allow convergence when no findings remain');
  // The handoff must clearly label the DoD deferred, never fake it as "passed".
  // The wording is the CONFIG opt-out's own: something was in fact declared here
  // (`"dod": null`), unlike the per-run --no-dod flag, which has its own line.
  assert.match(out.handoff, /DoD: DEFERRED \(no executable gate declared; validate out-of-band, e\.g\. post-deploy e2e\)/);
  assert.ok(!out.handoff.includes('DoD: passed'), 'deferred DoD must never be reported as "DoD: passed"');
});

test('round-start: the front pass fires with NO gate block in review.config.json -- arming is not config-derived', () => {
  const repo = initRepo(); // NOTE: initRepo's review.config.json has no "gate" block
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true }));
  assert.strictEqual(out.gateApplied, true);
});

test('round-start: --broad flag applies gate without a review.config.json gate block', () => {
  const repo = initRepo(); // NOTE: initRepo's review.config.json has no "gate" block
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.gateApplied, true);
});

test('round-start: --broad flag works before the base token too (order-independent)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', '--broad', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.gateApplied, true);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.target.base, 'HEAD~1'); // the flag must not get mistaken for base
});

test('round-start: --gate is accepted as an alias for --broad', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--gate'], { env }));
  assert.strictEqual(out.gateApplied, true);
});

test('round-start: --broad and --gate together are idempotent, not an unknown-flag error', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad', '--gate'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.gateApplied, true);
});

test('round-start: an unrecognized "--" flag is a clear usage error, not silently treated as base', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  assert.throws(() => run(['round-start', 'feat/x', '--typo'], { env }), /unknown flag "--typo"/);
});

test('round-start: provider and model routing is persisted and restored on resume', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const routing = {
    reviewer: 'claude', reviewerModel: 'claude-opus-4-1',
    fixer: 'copilot', fixerModel: 'gpt-5.2',
  };
  const first = JSON.parse(run([
    'round-start', 'feat/x', 'HEAD~1',
    '--reviewer', routing.reviewer, '--reviewer-model', routing.reviewerModel,
    '--fixer', routing.fixer, '--fixer-model', routing.fixerModel,
  ], { env }));
  assert.deepStrictEqual(first.reviewRouting, routing);
  assert.deepStrictEqual(review.readLedger(dir, review.targetSlug('feat/x')).reviewRouting, routing);

  const resumed = JSON.parse(run(['round-start', 'feat/x'], { env }));
  assert.deepStrictEqual(resumed.reviewRouting, routing);
});

test('round-start: resume rejects a routing change', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1', '--reviewer', 'claude', '--fixer', 'copilot'], { env });
  assert.throws(
    () => run(['round-start', 'feat/x', '--reviewer', 'codex'], { env }),
    /routing differs from the active run/,
  );
});

test('round-start: a mid-round resume keeps gateApplied true for the round that already fired', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad'], { env }));
  assert.strictEqual(first.gateApplied, true);
  const slug = review.targetSlug('feat/x');
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_rounds, [1]);

  // round-start is called again with no --broad token. Phase is already 'gates'
  // from round 1 (round-start never advances it to 'fixes'), so this naturally
  // re-drives the SAME round via the existing "resumed" path. The pair is still
  // this round's work -- plan-fixes requires its artifact -- so gateApplied must
  // stay true, and the round must not be double-recorded in gate_rounds.
  const second = JSON.parse(run(['round-start', 'feat/x'], { env, broadDefault: true }));
  assert.strictEqual(second.gateApplied, true);
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_rounds, [1]);
});

test('round-start: the gate pair is a FRONT pass -- it fires once, not every round', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const slug = review.targetSlug('feat/x');
  const first = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true }));
  assert.strictEqual(first.gateApplied, true); // armed by default, no flag needed
  assert.strictEqual(first.round, 1);

  // Round 1 completes; round 2 starts on a new diff. The tree the pair reads has
  // not changed in a way a second full repo sweep would pay for -- the tail is
  // the panel's job -- so the pair must NOT fire again.
  const l = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...l, phase: 'idle', last_recorded_round: 1, diff_content_hash: null });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  execFileSync('git', ['commit', '-aqm', 'more'], { cwd: repo });
  const second = JSON.parse(run(['round-start', 'feat/x'], { env, broadDefault: true }));
  assert.strictEqual(second.round, 2);
  assert.strictEqual(second.gateApplied, false);
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_rounds, [1]);
});

test('round-start: --no-broad disarms the front pass, and the opt-out is sticky', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const first = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { env, broadDefault: true }));
  assert.strictEqual(first.gateApplied, false);
  const second = JSON.parse(run(['round-start', 'feat/x'], { env, broadDefault: true }));
  assert.strictEqual(second.gateApplied, false); // sticky: round 2 need not repeat the flag
  assert.deepStrictEqual(review.readLedger(dir, review.targetSlug('feat/x')).gate_rounds, []);
});


test('round-start file: a file target is broad-disarmed by default, and --broad still forces the sweep', () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-broad-')); // NOT a git repo
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# note\n\nsome prose.\n');
  // The gate pair's prompt is written against a git diff and sweeps the repo,
  // which a doc review -- possibly outside a git repo entirely -- cannot use.
  const out = JSON.parse(run(['round-start', 'file:note.md'], { env, broadDefault: true }));
  assert.strictEqual(out.targetType, 'file');
  assert.strictEqual(out.gateApplied, false);
  // ...but it stays available for someone who does want the tree swept against a spec.
  const forced = JSON.parse(run(['round-start', 'file:note.md', '--broad'], { env }));
  assert.strictEqual(forced.gateApplied, true);
  // ...and that arming is STICKY, like the git path's: a re-drive without the
  // flag must not silently re-disarm and drop the round's gate findings.
  const redriven = JSON.parse(run(['round-start', 'file:note.md'], { env, broadDefault: true }));
  assert.strictEqual(redriven.gateApplied, true);
});

test('renderHandoff file: a disarmed file target does not blame --no-broad for a flag nobody passed', () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-handoff-'));
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# note\n\nsome prose.\n');
  const n = JSON.parse(run(['round-start', 'file:note.md'], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['note.md'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'file:note.md'], { env });
  const out = JSON.parse(run(['record', 'file:note.md'], { env }));
  assert.doesNotMatch(out.handoff, /skipped \(--no-broad\)/);
  assert.match(out.handoff, /not applicable to a file target/);
});


test('renderHandoff: legacy panel config does not appear in a --no-broad handoff', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['commit', '-aqm', 'enable panel'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { env })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.converged, true);
  assert.doesNotMatch(out.handoff, /panel/i);
});

test('round-start: --broad re-arms a ledger that opted out earlier', () => {
  const repo = initRepo(); // NOTE: no "gate" block in review.config.json
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  assert.strictEqual(JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { env })).gateApplied, false);
  const rearmed = JSON.parse(run(['round-start', 'feat/x', '--broad'], { env }));
  assert.strictEqual(rearmed.gateApplied, true); // the front pass has not run yet, so it still gets one
});

// ---- --no-dod: explicit per-run deferral of the executable gate ----

// A repo that never declared a DoD gate. round-start defers on its own here
// (deferredBy: 'no-config') rather than faking a pass -- a silent default gate
// would manufacture a false clean. The --no-dod tests below cover the explicit
// opt-out flag on top of that.
function initRepoWithoutDodConfig() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-no-dod-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  return repo;
}

test('round-start: a repo with no review.config.json runs, deferring the DoD instead of blocking', () => {
  // The whole point: a repo that never declared a gate is still reviewable.
  // Nothing is faked to a pass -- dodDeferred is what tells callers apart.
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.dodDeferred, true);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.dod.deferredBy, 'no-config');
});

test('record: the handoff names the absent config as the reason, and never says passed', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  fs.writeFileSync(
    path.join(dir, `round-${n}-correctness.json`),
    JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }),
  );
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /DoD: DEFERRED \(no review\.config\.json/);
  assert.ok(!out.handoff.includes('DoD: passed'), 'a deferred DoD must never be reported as "DoD: passed"');
  // Nothing was declared here, so the dod:null wording would be a lie.
  assert.ok(!out.handoff.includes('no executable gate declared'), 'absent config must not borrow the dod:null wording');
});

test('record returns persisted Claude review telemetry in JSON and the human handoff', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const n = JSON.parse(run(['round-start', 'feat/telemetry', 'HEAD~1'], { env })).round;
  const artifact = path.join(dir, `round-${n}-correctness.json`);
  const parentTranscriptPath = path.join(dir, 'parent.jsonl');
  const toolTelemetry = path.join(dir, `review-telemetry-${'a'.repeat(64)}.json`);
  const agentTelemetry = path.join(dir, `review-agent-telemetry-${'b'.repeat(64)}.json`);
  const malformedTelemetry = path.join(dir, `review-telemetry-${'c'.repeat(64)}.json`);
  run(['telemetry-slot', 'feat/telemetry', artifact, '--engine', 'claude-code'], { env });
  fs.writeFileSync(toolTelemetry, JSON.stringify({
    kind: 'tool-use',
    engine: 'claude-code', provider: 'anthropic', targetRef: 'feat/telemetry', role: 'correctness', round: n,
    artifactPath: artifact, attempt: 1, invocationId: 'toolu-telemetry', agentId: 'agent-telemetry', parentTranscriptPath, startedAtMs: 1,
    usagePartial: true, hookUsagePartial: false, elapsedMs: 12,
    inputTokens: 10, cacheWriteInputTokens: 2, cachedInputTokens: 3,
    reasoningOutputTokens: null, outputTokens: 4, totalTokens: 19,
    providerUsage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 },
  }));
  fs.writeFileSync(agentTelemetry, JSON.stringify({
    kind: 'agent-usage', engine: 'claude-code', agentId: 'agent-telemetry', provider: 'anthropic',
    parentTranscriptPath, stoppedAtMs: 13,
    providerSchema: 'claude-subagent-transcript-2.1.268-v1', status: 'stopped', resolvedModel: 'claude-sonnet-4-5-20250929',
    inputTokens: 10, cacheWriteInputTokens: 2, cachedInputTokens: 3, reasoningOutputTokens: null,
    outputTokens: 4, totalTokens: 19, usagePartial: false,
    providerUsage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 },
  }));
  fs.writeFileSync(malformedTelemetry, 'not json');
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/telemetry'], { env });

  const out = JSON.parse(run(['record', 'feat/telemetry'], { env }));

  assert.strictEqual(out.telemetry.calls, 1);
  assert.strictEqual(out.telemetry.malformedCalls, 1);
  assert.strictEqual(out.telemetry.totalTokens, 19);
  assert.match(out.handoff, /review usage: 19 tokens across 1 call\(s\), 0 partial, 1 malformed/);
  assert.deepStrictEqual([fs.existsSync(toolTelemetry), fs.existsSync(agentTelemetry)], [false, false]);
  const shown = JSON.parse(run(['show', 'feat/telemetry'], { env }));
  assert.deepStrictEqual(shown.telemetry.entries.map(({ status, invocationId, totalTokens, usagePartial }) => ({ status, invocationId, totalTokens, usagePartial })), [
    { status: 'malformed', invocationId: null, totalTokens: null, usagePartial: true },
    { status: undefined, invocationId: 'toolu-telemetry', totalTokens: 19, usagePartial: false },
  ]);
});

test('telemetry-slot persists monotonically numbered attempts for one exact destination', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const started = JSON.parse(run(['round-start', 'feat/slots', 'HEAD~1'], { env }));
  const artifact = path.join(dir, `round-${started.round}-correctness.json`);

  assert.throws(() => run(['telemetry-slot', 'feat/slots', artifact], { env }), /requires --engine claude-code\|codex/);
  const first = JSON.parse(run(['telemetry-slot', 'feat/slots', artifact, '--engine', 'claude-code'], { env }));
  const second = JSON.parse(run(['telemetry-slot', 'feat/slots', artifact, '--engine', 'claude-code'], { env }));

  assert.deepStrictEqual([first.attempt, second.attempt], [1, 2]);
  assert.deepStrictEqual([first.engine, first.provider], ['claude-code', 'anthropic']);
  const ledger = review.readLedger(dir, review.targetSlug('feat/slots'));
  assert.deepStrictEqual(ledger.telemetrySlots.map(({ artifactPath, attempt, role, round, engine, provider }) => ({ artifactPath, attempt, role, round, engine, provider })), [
    { artifactPath: artifact, attempt: 1, role: 'correctness', round: started.round, engine: 'claude-code', provider: 'anthropic' },
    { artifactPath: artifact, attempt: 2, role: 'correctness', round: started.round, engine: 'claude-code', provider: 'anthropic' },
  ]);
});

test('a Codex-owned slot without runner evidence stays visible but is not counted as a call', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const started = JSON.parse(run(['round-start', 'feat/codex-slots', 'HEAD~1'], { env }));
  const artifact = path.join(dir, `round-${started.round}-correctness.json`);

  const slot = JSON.parse(run(['telemetry-slot', 'feat/codex-slots', artifact, '--engine', 'codex'], { env }));
  const ledger = review.readLedger(dir, review.targetSlug('feat/codex-slots'));

  assert.deepStrictEqual({ engine: slot.engine, provider: slot.provider }, { engine: 'codex', provider: 'openai' });
  const out = JSON.parse(run(['show', 'feat/codex-slots'], { env }));
  assert.deepStrictEqual({ calls: out.telemetry.calls, partialCalls: out.telemetry.partialCalls, missingCalls: out.telemetry.missingCalls }, { calls: 0, partialCalls: 0, missingCalls: 1 });
  assert.deepStrictEqual(out.telemetry.entries.map(({ engine, provider, role, status }) => ({ engine, provider, role, status })), [
    { engine: 'codex', provider: 'openai', role: 'correctness', status: 'missing' },
  ]);
  assert.strictEqual(ledger.telemetry, undefined);
  fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${started.round}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/codex-slots'], { env });
  const recorded = JSON.parse(run(['record', 'feat/codex-slots'], { env }));
  assert.match(recorded.handoff, /review usage: unknown tokens across 0 call\(s\), 0 partial, 1 missing/);
});

test('round-start: --no-dod starts a run in a repo with no review.config.json at all', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-dod'], { env }));
  assert.strictEqual(out.decision, 'work');
  // dodPassed stays true (existing callers depend on the field), so the new
  // dodDeferred boolean is the only thing that tells a caller this was a
  // deferral rather than a gate that actually ran and passed.
  assert.strictEqual(out.dodPassed, true);
  assert.strictEqual(out.dodDeferred, true);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.dod.deferred, true);
  assert.strictEqual(ledger.dod.deferredBy, '--no-dod');
  assert.strictEqual(ledger.dodDeferred, true);
});

test('round-start: --no-dod works before the base token too (order-independent)', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const out = JSON.parse(run(['round-start', 'feat/x', '--no-dod', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.target.base, 'HEAD~1'); // the flag must not get mistaken for base
});

test('round-start: --no-dod alongside --broad is not an unknown-flag error', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad', '--no-dod'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.gateApplied, true);
  assert.strictEqual(out.dodDeferred, true);
});

test('round-start: dodDeferred is sticky -- a later round-start omitting --no-dod keeps the gate deferred', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const first = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-dod'], { env }));
  assert.strictEqual(first.dodDeferred, true);

  // Same re-drive path the gateApplied stickiness test uses: phase is already
  // 'gates', so this round-start re-drives the round with no flag. This repo has
  // no review.config.json, so dodDeferred alone would stay true even with the
  // stickiness broken -- runDod would defer with deferredBy 'no-config'. Only
  // deferredBy still naming the flag proves the sticky ledger field carried over.
  const second = JSON.parse(run(['round-start', 'feat/x'], { env }));
  assert.strictEqual(second.decision, 'work');
  assert.strictEqual(second.dodDeferred, true);
  assert.strictEqual(review.readLedger(dir, review.targetSlug('feat/x')).dod.deferredBy, '--no-dod');
});

test('round-start: dodDeferred is false on a normal run whose repo declares a real gate', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.dodDeferred, false);
  assert.ok(!review.readLedger(dir, review.targetSlug('feat/x')).dodDeferred);
});

test('renderHandoff: a --no-dod deferral names the flag, and does not claim a gate was declared', () => {
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-dod'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /DoD: DEFERRED \(--no-dod: no executable gate ran this run\)/);
  // Nothing was "declared" here -- the config-level opt-out's wording would be a lie.
  assert.ok(!out.handoff.includes('no executable gate declared'), '--no-dod must not borrow the dod:null wording');
  assert.ok(!out.handoff.includes('DoD: passed'), 'a deferred DoD must never be reported as "DoD: passed"');
});

test('record: a --no-dod round with a committed fix reaches its terminal decision without re-running the DoD', () => {
  // A terminal needs-decision stop must preserve the explicit deferral even
  // when one fix committed; only review convergence may trigger final DoD.
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-dod'], { env })).round;
  fs.writeFileSync(
    path.join(dir, `round-${n}-correctness.json`),
    JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
      { id: 'correctness:unfixable', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' } ] }),
  );
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });

  // One finding is genuinely fixed and committed; the other's fixer never wrote
  // an artifact, so it parks -- a terminal decision that still carries a fix.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_real.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/x', 'correctness:real'], { env });

  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, false);
  assert.strictEqual(out.decision.parked, true);
  assert.match(out.handoff, /DoD: DEFERRED \(--no-dod/);
});

test('record: a converged --no-dod run does not report that the DoD ran and passed', () => {
  // The handoff says "DoD: DEFERRED" while the machine-readable decision.reason
  // used to say "DoD-exec ran and passed" -- the exact false-clean claim the
  // deferral path exists to avoid. The two must agree.
  const repo = initRepoWithoutDodConfig();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-dod'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });

  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.converged, true);
  assert.ok(!/ran and passed/.test(out.decision.reason), `converged reason claims the gate ran: ${out.decision.reason}`);
  assert.match(out.handoff, /DoD: DEFERRED \(--no-dod/);
});

test('round-start: a gate-pending ledger is a re-runnable stop (resets to converging, keeps dismissed)', () => {
  const dir = tmpDir();
  const repo = initRepo();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  let l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  l = { ...l, status: 'gate-pending', gate_open: [{ id: 'gate:cross-context:x', file: 'a.txt', summary: 's' }], gate_dismissed: [{ id: 'gate:ac-coverage:y', file: 'a.txt', span: '', summary: 's', dismissedBy: 'someone', dismissedAt: '2026-10-09T00:00:00.000Z' }], diff_content_hash: 'stale' };
  review.writeLedger(dir, slug, l);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work'); // NOT terminal
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.status, 'converging');
  assert.deepStrictEqual(after.gate_open, []);            // cleared for a fresh evaluation
  assert.deepStrictEqual(after.gate_dismissed.map((d) => d.id), ['gate:ac-coverage:y']); // preserved
});

test('round-start: gate-pending re-entry on an IDENTICAL diff still yields work, not no-op', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  // A real round-start against base HEAD~1 seeds a genuine diff_content_hash in the ledger.
  run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true });
  const slug = review.targetSlug('feat/x');
  // Simulate a prior gate-pending terminus WITHOUT touching the working tree or adding
  // commits -- unlike the "keeps dismissed" test above, the diff on re-run is byte-identical
  // to the one that seeded diff_content_hash. This is the "dismiss a gate finding, then
  // re-run without further code changes" path.
  let ledger = review.readLedger(dir, slug);
  ledger = { ...ledger, status: 'gate-pending', phase: 'done', gate_open: [{ id: 'gate:cross-context:x', file: 'a.txt', summary: 's' }] };
  review.writeLedger(dir, slug, ledger);
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true }));
  assert.strictEqual(out.decision, 'work'); // re-entered on the SAME diff, not "no-op"
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.status, 'converging');
  assert.deepStrictEqual(after.gate_open, []); // cleared for a fresh evaluation
});

test('plan-fixes: a verify-added finding (distrust-green) is routed to the fixer, not silently dropped', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [], findings: [
      { id: 'correctness:verify-caught-it', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'the second lens caught what the first missed' },
    ] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:verify-caught-it']);
});

test('commit-fix + record: a verify-added finding is committed and ledgered like a correctness one', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [], findings: [
      { id: 'correctness:verify-caught-it', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'the second lens caught it' },
    ] });
  run(['plan-fixes', 'feat/x'], { env });
  // The fixer edits and declares its files, exactly as for a correctness finding.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two-fixed\n');
  writeArtifact(dir, n, 'fix-correctness:verify-caught-it', { status: 'ok', edited: true, files: ['a.txt'] });
  const cf = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:verify-caught-it'], { env }));
  // Looking the finding up in the correctness artifact alone resolves it to
  // {file: null}, the file guard short-circuits, and record's tree checkout
  // then reverts the fixer's work -- a silent drop one stage later.
  assert.strictEqual(cf.committed, true);
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(ledger.findings.map((f) => [f.id, f.status]), [['correctness:verify-caught-it', 'fixed']]);
  assert.ok(ledger.seen.some((sn) => sn.id === 'correctness:verify-caught-it'), 'a seen entry is what lets the next round dedupe or reopen it');
  assert.match(out.handoff, /1 fixed/);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'two-fixed\n');
});

test('plan-fixes: a verify finding sharing an id with a correctness finding does not duplicate', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:same', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'from the first pass' },
    ] },
    { status: 'ok', rejected: [], findings: [
      { id: 'correctness:same', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'restated by the second pass' },
    ] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes.map((f) => f.id), ['correctness:same']);
  assert.match(out.fixes[0].summary, /from the first pass/); // correctness wins the collision
});

test('plan-fixes: a verify-added finding that verify also rejects is dropped, not surfaced', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [{ id: 'correctness:self-rejected', reason: 'read the surrounding code; the guard is already there' }], findings: [
      { id: 'correctness:self-rejected', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'raised then retracted' },
    ] });
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes, []);
});

test('plan-fixes: a gate-prefixed id in the verify findings is a harness-failure (symmetric guard)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [], findings: [
      { id: 'gate:cross-context:x', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'wrong namespace' },
    ] });
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: folds gate + gate-verify artifacts into gate_open, honoring dismissed, never into fixes', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  // pre-dismiss one finding
  const slug = review.targetSlug('feat/x');
  let l = review.readLedger(dir, slug); l = { ...l, gate_dismissed: [{ id: 'gate:ac-coverage:dismissed-one', file: 'a.txt', span: '', summary: 's', dismissedBy: 'someone', dismissedAt: '2026-10-09T00:00:00.000Z' }] }; review.writeLedger(dir, slug, l);
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:keep', file: 'other.js', span: 'x', summary: 'unchanged sibling issue' },
    { id: 'gate:silent-gap:reject', file: 'a.txt', span: '', summary: 'fp', requirement: 'r' },
    { id: 'gate:ac-coverage:dismissed-one', file: 'a.txt', span: '', summary: 'accepted', requirement: 'r' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [{ id: 'gate:silent-gap:reject', reason: 'the requirement is already implemented' }] }));
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes, []); // gate findings NEVER become fixes
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.gate_open.length, 1);
  assert.strictEqual(after.gate_open[0].id, 'gate:cross-context:keep'); // reject + dismiss removed; unchanged-file finding kept
});

test('plan-fixes: reads ledger.gateApplied (not review.config.json) -- a --broad-enabled round still requires the gate artifact', () => {
  const repo = initRepo(); // NOTE: no "gate" block in review.config.json
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const rsOut = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad'], { env }));
  assert.strictEqual(rsOut.gateApplied, true);
  const n = rsOut.round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  // No round-N-gate.json written. Before the fix, plan-fixes re-read
  // review.config.json (no "gate" block there since the round was enabled via
  // --broad, not config), computed a falsy gate signal, and silently skipped
  // requiring/reading the gate artifact. After the fix it reads
  // ledger.gateApplied (true, from --broad) and must fail closed on the
  // missing artifact instead of silently proceeding.
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: a --broad-enabled round folds gate findings into gate_open exactly like a config-enabled round', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const rsOut = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--broad'], { env }));
  const n = rsOut.round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:flagged', file: 'other.js', span: 'x', summary: 'unchanged sibling issue' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const after = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(after.gate_open.length, 1);
  assert.strictEqual(after.gate_open[0].id, 'gate:cross-context:flagged');
});

test('plan-fixes: a gate-verify artifact that DECLARES blocked is a harness-failure, not lenient zero-rejections', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [], blocked: ['grep: denied by sandbox'] }));
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure[\s\S]*could not run/);
});

test('plan-fixes: a gate-verify-added finding (distrust-green) merges into gate_open', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  // gate-review found nothing this round, but gate-verify's different lens caught a gap.
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [
    { id: 'gate:cross-context:verify-found', file: 'other.js', span: 'x', summary: 'gate-verify caught a gap the first pass missed', requirement: 'r' },
  ] }));
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes, []); // still never routed to auto-fix
  const after = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.ok(after.gate_open.some((f) => f.id === 'gate:cross-context:verify-found'));
});

test('plan-fixes: a verify finding sharing an id with a gate-review finding does not duplicate (gate-review wins)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:dup', file: 'a.txt', span: 'gate-review-span', summary: 'gate-review summary', requirement: 'r1' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [
    { id: 'gate:cross-context:dup', file: 'a.txt', span: 'verify-span', summary: 'verify summary', requirement: 'r2' },
  ] }));
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes, []);
  const after = review.readLedger(dir, review.targetSlug('feat/x'));
  const dups = after.gate_open.filter((f) => f.id === 'gate:cross-context:dup');
  assert.strictEqual(dups.length, 1); // no duplicate
  assert.strictEqual(dups[0].evidence, 'gate-review-span'); // gate-review entry wins on id collision
  assert.strictEqual(dups[0].summary, 'gate-review summary');
});

test('plan-fixes: a verify-added finding that verify also rejects (in its own "rejected" list) is dropped, not surfaced', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [{ id: 'gate:cross-context:self-reject', reason: 'the surrounding code disproves the finding' }], findings: [
    { id: 'gate:cross-context:self-reject', file: 'other.js', span: 'x', summary: 'flagged then immediately retracted', requirement: 'r' },
  ] }));
  run(['plan-fixes', 'feat/x'], { env });
  const after = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.ok(!after.gate_open.some((f) => f.id === 'gate:cross-context:self-reject'));
});

test('plan-fixes: a non-gate id in the gate-verify findings is a harness-failure (symmetric guard)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [
    { id: 'correctness:not-a-gate-id', file: 'a.txt', span: 'x', summary: 'wrong namespace' },
  ] }));
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: normalization canonicalizes a missing gate-verify "findings" field to empty', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  // legacy-shaped gate-verify artifact, no "findings" key at all.
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const out = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(out.fixes, []);
  const after = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(after.gate_open, []);
});

test('plan-fixes: a non-gate id in the gate artifact is a harness-failure', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'correctness:not-a-gate-id', file: 'a.txt', span: 'x', summary: 'wrong namespace' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: a shape-invalid gate artifact finding (missing "file") throws with the harness-failure prefix', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:x', summary: 's' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure/);
});

test('plan-fixes: a shape-invalid gate-verify artifact finding is a harness-failure', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:valid', file: 'other.js', span: 'x', summary: 'valid gate-review finding' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  // gate-verify artifact is valid JSON, but its findings entry is shape-broken (missing "file").
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [
    { id: 'gate:silent-gap:x', summary: 's' },
  ] }));
  assert.throws(() => run(['plan-fixes', 'feat/x'], { env }), /harness-failure: gate-verify finding\[0\] is missing "file"/);
});

test('record: diff-local clean with an open gate finding -> gate-pending, not clean', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:sibling', file: 'other.js', span: 'x', summary: 'unchanged sibling reopens invariant' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.gatePending, true);
  assert.strictEqual(out.decision.converged, false);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.status, 'gate-pending');
  assert.strictEqual(ledger.budget.spent, 1);
  assert.deepStrictEqual(ledger.finalChecks, [{ name: 'definition-of-done', status: 'not-run' }]);
});

test('record: a reconciliation retry at the round limit parks instead of allowing another full review', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  const slug = review.targetSlug('feat/x');
  const started = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...started, budget: { ...started.budget, max_rounds: 1 } });
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:limit', file: 'other.js', span: 'x', summary: 'still unresolved' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.parked, true);
  assert.strictEqual(out.decision.gatePending, false);
  assert.match(out.decision.reason, /round budget exhausted/);
  assert.strictEqual(review.readLedger(dir, slug).status, 'parked');
});

test('record: legacy gate.panel config does not arm an automatic final panel', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] }, { armBroad: true });
  const planOut = JSON.parse(run(['plan-fixes', 'feat/x'], { env }));
  assert.deepStrictEqual(planOut.fixes, []);
  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec.decision.panelPending, undefined);
  assert.strictEqual(rec.decision.converged, true);
});


test('record: gate.panel enabled but NOT configured (absent gate.panel) -> converges clean as before (no behavior change)', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(rec.decision.converged, true);
  assert.strictEqual(rec.decision.panelPending, undefined);
});


test('renderHandoff: gate-pending surfaces the advisory broad review findings section', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:silent-gap:missing-check', file: 'verify.js', span: 'if (!target) return;', summary: 'design requires a target-exists check' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /status: gate-pending/);
  assert.match(out.handoff, /Broad review findings \(advisory/);
  assert.match(out.handoff, /gate:silent-gap:missing-check/);
  assert.match(out.handoff, /anchor: if \(!target\) return;/); // evidence/span surfaces as the anchor
});

test('round-start: a gate-pending re-run re-arms the front pass, it does not erase the broad findings and converge clean', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const slug = review.targetSlug('feat/x');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  // Round 1: the front pass raises a broad finding -> gate-pending.
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:x', file: 'unchanged.js', span: '', summary: 'a real gap', requirement: 'r' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  assert.strictEqual(JSON.parse(run(['record', 'feat/x'], { env })).decision.gatePending, true);

  // The documented remedy for gate-pending is "fix it and re-run -- a fresh run
  // re-evaluates broad review". The reset clears gate_open, so unless it also
  // re-arms the front pass the standing finding is erased with nothing to
  // re-derive it, and the next round converges clean over a gap nobody resolved.
  const rerun = JSON.parse(run(['round-start', 'feat/x'], { env, broadDefault: true }));
  assert.strictEqual(rerun.decision, 'work');
  assert.strictEqual(rerun.gateApplied, true, 'the new convergence attempt must re-run the front pass');
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_rounds, [rerun.round]);
});

test('rerun reuses a completed front pass and reviews only the changed diff', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/broad-once';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  const n = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:x', file: 'a.txt', span: 'two', summary: 'a real gap', requirement: 'r' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.gatePending, true);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  execFileSync('git', ['commit', '-aqm', 'fix broad finding'], { cwd: repo });
  run(['rerun', ref], { env });
  const next = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(next.gateApplied, false, 'the completed front pass remains valid for the descendant head');
  const incremental = fs.readFileSync(path.join(dir, `round-${next.round}-diff.txt`), 'utf8');
  assert.match(incremental, /-two/);
  assert.match(incremental, /\+three/);
  assert.doesNotMatch(incremental, /-one/);

  writeArtifact(dir, next.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, next.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.converged, true);
});

test('same-head rerun reuses the front pass without discarding the original diff', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/same-head';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  const n = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.converged, true);

  run(['rerun', ref], { env });
  const next = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(next.gateApplied, false, 'the completed front pass remains reusable at the same head');
  const reviewed = fs.readFileSync(path.join(dir, `round-${next.round}-diff.txt`), 'utf8');
  assert.match(reviewed, /-one/);
  assert.match(reviewed, /\+two/);
});

test('rerun scopes reused broad evidence from the head the broad pass inspected', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/broad-fix-head';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  const first = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true }));
  writeArtifact(dir, first.round, 'correctness', { status: 'findings', examined: ['a.txt'], findings: [
    { id: 'correctness:fix-after-broad', file: 'a.txt', span: 'two', summary: 'fix after broad review' },
  ] });
  writeArtifact(dir, first.round, 'gate', { status: 'ok', findings: [] });
  writeArtifact(dir, first.round, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, first.round, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two-fixed\n');
  writeArtifact(dir, first.round, 'fix-correctness:fix-after-broad', { status: 'ok', edited: true, files: ['a.txt'] });
  assert.strictEqual(JSON.parse(run(['commit-fix', ref, 'correctness:fix-after-broad'], { env })).committed, true);
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.continue, true);

  const confirmation = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  writeArtifact(dir, confirmation.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, confirmation.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.converged, true);

  run(['rerun', ref], { env });
  const rerun = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(rerun.gateApplied, false, 'the completed broad pass remains reusable');
  const reviewed = fs.readFileSync(path.join(dir, `round-${rerun.round}-diff.txt`), 'utf8');
  assert.match(reviewed, /-two/);
  assert.match(reviewed, /\+two-fixed/);
});

test('rerun carries unresolved broad findings on unchanged files', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/carry-broad';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  const n = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:unchanged', file: 'unchanged.js', span: 'old invariant', summary: 'a real unresolved gap', requirement: 'r' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.gatePending, true);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  execFileSync('git', ['commit', '-aqm', 'unrelated fix'], { cwd: repo });
  run(['rerun', ref], { env });
  const next = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(next.gateApplied, false, 'the completed front pass is still reused');
  writeArtifact(dir, next.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, next.round, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  const recorded = JSON.parse(run(['record', ref], { env }));
  assert.strictEqual(recorded.decision.gatePending, true, 'an unchanged unresolved broad finding must still block clean');
  assert.deepStrictEqual(review.readLedger(dir, review.targetSlug(ref)).gate_open.map((finding) => finding.id), ['gate:cross-context:unchanged']);
});

test('rerun at the same HEAD retains a broad finding on a PR-changed file', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/carry-same-head';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [{ id: 'gate:design-conformance:standing', file: 'a.txt', span: 'two', summary: 'standing gap', requirement: 'r' }] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.gatePending, true);
  run(['rerun', ref], { env });
  const next = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(next.gateApplied, false);
  assert.deepStrictEqual(review.readLedger(dir, review.targetSlug(ref)).gate_open.map((finding) => finding.id), ['gate:design-conformance:standing']);
});

test('rerun does not reuse an interrupted front pass', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/interrupted-broad';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  const started = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true }));
  assert.strictEqual(started.gateApplied, true);
  run(['rerun', ref], { env });

  const restarted = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(restarted.gateApplied, true, 'a gate launch without a recorded round is not reusable evidence');
});

test('rerun invalidates broad reuse when intent is newly configured', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/new-intent';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });

  const n = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.strictEqual(JSON.parse(run(['record', ref], { env })).decision.converged, true);

  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], intent: { command: 'printf "REQ: preserve compatibility"' } }));
  execFileSync('git', ['commit', '-aqm', 'add intent'], { cwd: repo });
  run(['rerun', ref], { env });
  const next = JSON.parse(run(['round-start', ref], { env, broadDefault: true }));
  assert.strictEqual(next.intentApplied, true);
  assert.strictEqual(next.gateApplied, true, 'new intent must invalidate the prior front pass');
});



test('renderHandoff: --no-broad is reported, never left to read as "broad review found nothing"', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1', '--no-broad'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(out.handoff, /Broad review \(front pass\): skipped \(--no-broad\)/);
  assert.doesNotMatch(out.handoff, /Broad-review panel/); // nothing ran; do not imply a panel verdict
});

test('record: park-budget override on a gate-pending round clears gatePending, leaving only parked', () => {
  // A round whose OWN decision would be gate-pending (an open gate finding,
  // diff-local otherwise clean) must still get force-terminated to "parked"
  // once REVIEW_PARK_BUDGET_DEFAULT prior parks are on the books -- and the
  // override must not leave a stale gatePending:true riding along with
  // parked:true, mirroring the existing intentReview override above.
  const { REVIEW_PARK_BUDGET_DEFAULT } = require('../../core/config');
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [
    { id: 'gate:cross-context:sibling', file: 'other.js', span: 'x', summary: 'unchanged sibling reopens invariant' },
  ] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });

  // Seed REVIEW_PARK_BUDGET_DEFAULT pre-existing needs-decision parks so the
  // breaker trips on this record call, same technique as the plain park-budget test.
  const slug = review.targetSlug('feat/x');
  let ledger = review.readLedger(dir, slug);
  const priorParks = [];
  for (let i = 0; i < REVIEW_PARK_BUDGET_DEFAULT; i += 1) {
    priorParks.push({ id: `correctness:old-${i}`, gate: 'correctness', file: 'a.txt', span: '', summary: 'x', status: 'parked', park_reason: { kind: 'needs-decision', text: 'prior' } });
  }
  ledger = { ...ledger, findings: priorParks };
  review.writeLedger(dir, slug, ledger);

  const out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.parked, true);
  assert.ok(!out.decision.gatePending); // must be cleared, not left riding along with parked:true
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.status, 'parked'); // not the stale 'gate-pending'
});

// --- gate_open cross-round persistence (spec decision 4) ---
//
// The gate subagent is nondeterministic: a round can silently fail to
// re-report a real standing finding. Without carry-forward, plan-fixes
// OVERWRITES gate_open fresh from only that round's artifacts every time --
// a single flaky round erases a standing finding and the run converges
// clean with a real design gap unresolved. These tests drive a real
// multi-round run (round-start -> plan-fixes -> commit-fix -> record, twice)
// to prove a finding on a file the diff never touched survives a silent
// round, while a finding on a file the diff DID touch is dropped (a fix
// plausibly addressed it).

test('e2e: a round with no gate verdict does not erase a standing finding on an UNCHANGED file -- must not converge clean', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'unchanged.txt'), 'stable\n'); // never touched by the branch
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add unchanged.txt, enable gate'], { cwd: repo });
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const slug = review.targetSlug('feat/x');

  // --- round 1: a real correctness finding (so the round makes progress) +
  // a gate finding G on the unchanged file.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  let n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [
    { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'fix me' },
  ] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:g', file: 'unchanged.txt', span: '', summary: 'a real design gap', requirement: 'r' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });

  // Simulate the correctness fix landing: the fixer edits a.txt and commit-fix journals it.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two-fixed\n');
  writeArtifact(dir, n, 'fix-correctness:real', { status: 'ok', edited: true, files: ['a.txt'] });
  const cf = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(cf.committed, true);

  let out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, true); // progress -- the round is not terminal
  let ledger = review.readLedger(dir, slug);
  assert.ok(ledger.gate_open.some((f) => f.id === 'gate:cross-context:g'), 'G must be recorded after round 1');

  // --- round 2: correctness is clean and the pair does NOT fire (the front pass
  // already ran in round 1), so this round produces no gate verdict at all. It
  // must carry G rather than read the absent artifact as "the gate found
  // nothing". The carry-forward DROP rules are not what this covers -- they need
  // a firing round (the sibling test below) and are unit-tested in gate.test.js.
  n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~2'], { env, broadDefault: true })).round; // base + change + fix commits
  assert.strictEqual(review.readLedger(dir, slug).gateApplied, false, 'the front pass fired in round 1; round 2 must have no gate verdict');
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  out = JSON.parse(run(['record', 'feat/x'], { env }));

  // The verdict-less round must NOT be allowed to erase G nor converge clean.
  assert.strictEqual(out.decision.converged, false, 'a round with no gate verdict must not converge clean with a standing unchanged-file finding erased');
  assert.strictEqual(out.decision.gatePending, true);
  ledger = review.readLedger(dir, slug);
  assert.ok(ledger.gate_open.some((f) => f.id === 'gate:cross-context:g'), 'G must survive a round that produced no gate verdict');
  assert.strictEqual(ledger.status, 'gate-pending');
});

test('e2e: a carried finding whose file DID change since base is dropped when the gate goes silent on it', () => {
  // Same continuous-run shape as the unchanged-file test above (round 1 makes
  // progress via a real correctness fix, so the run never crosses a
  // gate-pending terminus -- round-start's gate-pending reset intentionally
  // clears gate_open for a FRESH evaluation after a human decision, which
  // would be indistinguishable from carry-forward here; persistence is only
  // WITHIN one continuous run). The only difference: G2's file IS the file
  // the correctness fix touches, so by round 2 it is in the diff since base.
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const slug = review.targetSlug('feat/x');

  // --- round 1: a real correctness finding (so the round makes progress) +
  // a gate finding G2 on a.txt -- the SAME file the correctness fix will touch.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  let n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [
    { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'fix me' },
  ] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:g2', file: 'a.txt', span: '', summary: 'a gap on the changed file', requirement: 'r' },
  ] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two-fixed\n');
  writeArtifact(dir, n, 'fix-correctness:real', { status: 'ok', edited: true, files: ['a.txt'] });
  const cf = JSON.parse(run(['commit-fix', 'feat/x', 'correctness:real'], { env }));
  assert.strictEqual(cf.committed, true);

  let out = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.strictEqual(out.decision.continue, true); // progress -- the round is not terminal
  let ledger = review.readLedger(dir, slug);
  assert.ok(ledger.gate_open.some((f) => f.id === 'gate:cross-context:g2'));

  // --- round 2: correctness is clean, and the gate goes silent on G2. Its
  // file (a.txt) is now in the diff since base (the fix touched it) -- a fix
  // plausibly addressed it -- so it must be dropped, not carried.
  //
  // The pair fires once (front pass), so a LATER round only re-runs it on a new
  // convergence attempt -- the gate-pending/intent-review re-run paths clear
  // gate_rounds, which is what re-arms the front pass (see the re-fire test
  // above). Writing gate_rounds directly is the short way to reach that state
  // without driving a full stop-and-re-run here. A round with no gate verdict
  // at all carries the standing set instead (the unchanged-file test above).
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), gate_rounds: [] });
  n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~2'], { env, broadDefault: true })).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [] }); // silent this round
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  out = JSON.parse(run(['record', 'feat/x'], { env }));

  assert.strictEqual(out.decision.converged, true, 'a carried finding on a changed file must be dropped, allowing convergence');
  ledger = review.readLedger(dir, slug);
  assert.deepStrictEqual(ledger.gate_open, []);
});

test('review-cli dismiss: records the id in gate_dismissed and drops it from gate_open', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  let l = review.emptyLedger({ kind: 'local', ref: 'feat/x' });
  l = { ...l, status: 'gate-pending', gate_open: [{ id: 'gate:ac-coverage:defer', file: 'a.js', summary: 's' }] };
  review.writeLedger(dir, slug, l);
  const out = run(['dismiss', 'feat/x', 'gate:ac-coverage:defer', '--by', 'someone'], { env });
  assert.match(out, /dismissed gate:ac-coverage:defer/);
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.gate_dismissed.map((d) => d.id), ['gate:ac-coverage:defer']);
  assert.deepStrictEqual(after.gate_open, []);
});

test('review-cli dismiss: idempotent (no duplicate in gate_dismissed)', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), gate_dismissed: [{ id: 'gate:x:y', file: 'a.txt', span: '', summary: 's', dismissedBy: 'someone', dismissedAt: '2026-10-09T00:00:00.000Z' }] });
  run(['dismiss', 'feat/x', 'gate:x:y', '--by', 'someone'], { env });
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_dismissed.map((d) => d.id), ['gate:x:y']);
});

test('review-cli dismiss: rejects a gateId that is not in the gate: namespace', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, review.emptyLedger({ kind: 'local', ref: 'feat/x' }));
  assert.throws(() => run(['dismiss', 'feat/x', 'not-a-gate-id', '--by', 'someone'], { env }), /must be a gate: id/);
  // must not have mutated the ledger on the rejected call
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_dismissed, []);
});

test('gate-panel-round-start: gate.panel not configured -> harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  assert.throws(() => run(['gate-panel-round-start', 'feat/x'], { env }), /harness-failure/);
});

test('gate-panel-round-start: first call -> round 1, empty rejectedIds', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] }, { armBroad: true });
  const out = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(out.round, 1);
  assert.deepStrictEqual(out.rejectedIds, []);
  assert.strictEqual(out.stateDir, dir);
});

test('gate-panel-round-start: reports the NEXT round number and the accumulated rejectedIds from ledger.gate_panel', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] }, { armBroad: true });
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = { ...ledger, gate_panel: { status: 'running', round: 2, dryStreak: 1, confirmed: [], rejectedIds: ['gate:threat-model:false-lead'] } };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);
  const out = JSON.parse(run(['gate-panel-round-start', 'feat/x'], { env }));
  assert.strictEqual(out.round, 3);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:false-lead']);
});

test('gate-panel-round-start: panel already "done" -> harness-failure (call record, not another panel round)', () => {
  const repo = initRepo(); const dir = tmpDir();
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] }, { armBroad: true });
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = { ...ledger, gate_panel: { status: 'done', round: 2, dryStreak: 2, confirmed: [], rejectedIds: [] } };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);
  assert.throws(() => run(['gate-panel-round-start', 'feat/x'], { env }), /harness-failure/);
});

function seedPanelRoundConfig(repo) {
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: { panel: true } }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'add config'], { cwd: repo });
}

test('gate-panel-round-record: gate.panel not configured -> harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure/);
});

test('gate-panel-round-record: a lens finding that survives verify is confirmed; status stays "running" (only 1 round in)', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:sk-exposure', file: 'a.txt', span: '', requirement: '', summary: 'a real gap' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-ac-coverage.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-design-conformance.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-cross-context.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-silent-gap.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.status, 'running');
  assert.strictEqual(out.round, 1);
  assert.strictEqual(out.newlyConfirmedCount, 1);
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(ledger.gate_panel.confirmed.map((f) => f.id), ['gate:threat-model:sk-exposure']);
});

test('gate-panel-round-record: a lens finding rejected by verify is NOT confirmed and appears in rejectedIds', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:false-lead', file: 'a.txt', summary: 'not actually real' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: ['gate:threat-model:false-lead'] }));
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:false-lead']);
});

test('gate-panel-round-record: missing verify artifact -> nothing survives (fail-closed toward not-confirming)', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:unverified', file: 'a.txt', summary: 'no verify ran' }] }));
  // no round-<n>-gate-panel-1-verify.json written at all
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:unverified']);
});

test('gate-panel-round-record: verify artifact is valid JSON but wrong shape (no rejected array) -> nothing survives, not everything', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:unverified-shape', file: 'a.txt', summary: 'verify crashed before writing a real verdict' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'error', error: 'subagent timed out' })); // valid JSON, no "rejected" array
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  assert.deepStrictEqual(out.rejectedIds, ['gate:threat-model:unverified-shape']);
});

test('gate-panel-round-record: a missing/malformed lens file contributes zero findings, not a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  // No lens files at all, no verify file.
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.status, 'running'); // 1st dry round -- not an error
  assert.strictEqual(out.newlyConfirmedCount, 0);
});

test('gate-panel-round-record: a lens that DECLARES blocked is a harness-failure, not a zero-findings dry round', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  // Schema-valid, zero findings -- but the lens says its assigned check never ran.
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [], blocked: ['grep: denied by sandbox'] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure[\s\S]*could not run/);
});

test('gate-panel-round-record: a panel verify that DECLARES blocked is a harness-failure, not a silent nothing-survives', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`),
    JSON.stringify({ status: 'ok', rejected: [], blocked: ['git: not on PATH'] }));
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure[\s\S]*could not run/);
});

test('gate-panel-round-record: a lens whose blocked is a non-array is still a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  // Same declaration, written as a bare string -- must not read as zero findings.
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [], blocked: 'playwright: denied' }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure[\s\S]*playwright: denied/);
});

test('gate-panel-round-record: a finding whose id class does not match its lens filename is a harness-failure', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:ac-coverage:mislabeled', file: 'a.txt', summary: 'wrong lens' }] }));
  assert.throws(() => run(['gate-panel-round-record', 'feat/x'], { env }), /harness-failure/);
});

test('gate-panel-round-record: a finding whose id was already human-dismissed is dropped before verify, never confirmed', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  let ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  ledger = { ...ledger, gate_dismissed: [{ id: 'gate:threat-model:already-dismissed', file: 'a.txt', span: '', summary: 's', dismissedBy: 'someone', dismissedAt: '2026-10-09T00:00:00.000Z' }] };
  review.writeLedger(dir, review.targetSlug('feat/x'), ledger);
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-threat-model.json`),
    JSON.stringify({ status: 'ok', findings: [{ id: 'gate:threat-model:already-dismissed', file: 'a.txt', summary: 'a human already dismissed this' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-panel-1-verify.json`), JSON.stringify({ status: 'ok', rejected: [] })); // would survive verify if it reached it
  const out = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env }));
  assert.strictEqual(out.newlyConfirmedCount, 0);
  const finalLedger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.deepStrictEqual(finalLedger.gate_panel.confirmed, []);
});

test('gate-panel-round-record: two consecutive dry rounds -> status "done" and ledger.phase reverts to "fixes"', () => {
  const repo = initRepo(); const dir = tmpDir();
  seedPanelRoundConfig(repo);
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  run(['record', 'feat/x'], { env }); // -> panelPending, phase flips to 'done'

  run(['gate-panel-round-start', 'feat/x'], { env }); // round 1
  const out1 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env })); // no findings -- dry round 1
  assert.strictEqual(out1.status, 'running');

  run(['gate-panel-round-start', 'feat/x'], { env }); // round 2
  const out2 = JSON.parse(run(['gate-panel-round-record', 'feat/x'], { env })); // dry round 2 -- done
  assert.strictEqual(out2.status, 'done');

  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.phase, 'fixes');
  assert.strictEqual(ledger.gate_panel.status, 'done');
});



test('review-cli: unknown verb error message lists the two new gate-panel verbs', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const { stderr, status } = runCapture(['bogus-verb'], { env });
  assert.notStrictEqual(status, 0);
  assert.match(stderr, /gate-panel-round-start/);
  assert.match(stderr, /gate-panel-round-record/);
});


test('round-start file: file:<path> target produces decision work, targetType file, writes file content as diff', () => {
  const dir = tmpDir();
  // Use a temp directory with NO git init (the whole point of a file target).
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# Design\nclaim without evidence\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const out = JSON.parse(run(['round-start', 'file:note.md'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.targetType, 'file');
  const ledger = review.readLedger(dir, review.targetSlug('file:note.md'));
  assert.strictEqual(ledger.phase, 'gates');
  assert.strictEqual(ledger.target.type, 'file');
  assert.strictEqual(ledger.target.hasDoD, false);
  assert.strictEqual(ledger.target.head_sha, out.head);
  // The diff file must contain the file content (not a git diff).
  const diffText = fs.readFileSync(path.join(dir, `round-${ledger.round}-diff.txt`), 'utf8');
  assert.ok(diffText.includes('claim without evidence'), 'diff file must contain the note content');
  assert.ok(diffText.includes('===== note.md ====='), 'diff file must contain the section header');
  assert.ok(!diffText.includes('diff --git'), 'diff file must not be a git diff');
  // No .git directory must have been created.
  assert.ok(!fs.existsSync(path.join(fileDir, '.git')), 'file target must not create a .git directory');
});

test('round-start terminal returns the persisted target head_sha', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# Design\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const first = JSON.parse(run(['round-start', 'file:note.md'], { env }));
  const ledger = review.readLedger(dir, review.targetSlug('file:note.md'));
  review.writeLedger(dir, review.targetSlug('file:note.md'), { ...ledger, phase: 'done', status: 'clean' });
  const terminal = JSON.parse(run(['round-start', 'file:note.md'], { env }));
  assert.strictEqual(terminal.decision, 'terminal');
  assert.strictEqual(terminal.head, first.head);
});

// finding #1: `file:<arg>` is the SINGLE file-target surface; <arg> may be a
// literal path OR a simple single-'*' glob, routed through the same resolveGlob.
// (The old `--files` flag was dropped -- it only worked when a positional ref
// preceded it and crashed as a bare selector, and the test that "covered" it
// passed BOTH file:note.md AND --files note.md so --files was inert.)
test('round-start file:<glob> resolves ALL matching files (sorted) into the review text', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  // Two .md files (write z before a to prove sort, not FS order) + a non-match.
  fs.writeFileSync(path.join(fileDir, 'zeta.md'), 'ZETA doc body\n');
  fs.writeFileSync(path.join(fileDir, 'alpha.md'), 'ALPHA doc body\n');
  fs.writeFileSync(path.join(fileDir, 'readme.txt'), 'not markdown\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const out = JSON.parse(run(['round-start', 'file:*.md'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.targetType, 'file');
  const ledger = review.readLedger(dir, review.targetSlug('file:*.md'));
  const diffText = fs.readFileSync(path.join(dir, `round-${ledger.round}-diff.txt`), 'utf8');
  // BOTH .md files present, the .txt absent.
  assert.ok(diffText.includes('ALPHA doc body'), 'glob must pull in alpha.md');
  assert.ok(diffText.includes('ZETA doc body'), 'glob must pull in zeta.md');
  assert.ok(!diffText.includes('not markdown'), 'glob must not pull in readme.txt');
  // Sorted: alpha.md header precedes zeta.md header.
  const aIdx = diffText.indexOf('===== alpha.md =====');
  const zIdx = diffText.indexOf('===== zeta.md =====');
  assert.ok(aIdx !== -1 && zIdx !== -1, 'both section headers must be present');
  assert.ok(aIdx < zIdx, 'alpha.md must precede zeta.md (sorted order)');
  // No .git touched in the non-git dir.
  assert.ok(!fs.existsSync(path.join(fileDir, '.git')), 'file:<glob> target must not create .git');
});

test('round-start file:<literal> resolves a single literal path into the review text', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  fs.writeFileSync(path.join(fileDir, 'note.md'), 'literal path body\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const out = JSON.parse(run(['round-start', 'file:note.md'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.targetType, 'file');
  const ledger = review.readLedger(dir, review.targetSlug('file:note.md'));
  const diffText = fs.readFileSync(path.join(dir, `round-${ledger.round}-diff.txt`), 'utf8');
  assert.ok(diffText.includes('literal path body'), 'literal file: path must be read into the review text');
});

test('round-start file:<glob> that matches nothing errors clearly (never silently converges on empty)', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  fs.writeFileSync(path.join(fileDir, 'note.txt'), 'only a txt here\n'); // no .md to match
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const { stderr, status } = runCapture(['round-start', 'file:*.md'], { env });
  assert.strictEqual(status, 1, 'a no-match file glob must exit non-zero');
  assert.match(stderr, /matched no files/, 'error must clearly state the glob matched no files');
  assert.match(stderr, /^review-cli: /, 'must use the graceful operator-facing error line');
});

// finding #2: the plan-fixes coverage check greps `+++ b/<path>` diff headers.
// For a file target, round-<n>-diff.txt holds raw document content, so a doc
// that QUOTES a unified diff (a line starting `+++ b/...`) would otherwise mint
// a phantom "changed file" the doc reviewer never examined and throw a spurious
// coverage harness-failure -- defeating the exact spec/design-doc review the
// feature exists for. The coverage check must be skipped for a file target.
test('plan-fixes file target: doc content quoting a `+++ b/` diff line does NOT trigger a coverage harness-failure', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  // A design doc that legitimately quotes a unified diff -- the `+++ b/...`
  // line is the trap: a git target would read it as a changed file.
  const noteBody = [
    '# Design Note',
    'The patch below illustrates the change:',
    '```',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '```',
    '',
  ].join('\n');
  const notePath = path.join(fileDir, 'note.md');
  fs.writeFileSync(notePath, noteBody + '\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const ref = 'file:note.md';

  const rs = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs.targetType, 'file');
  const n = rs.round;
  // Sanity: the trap line IS present in the review text.
  const diffText = fs.readFileSync(path.join(dir, `round-${n}-diff.txt`), 'utf8');
  assert.ok(diffText.includes('+++ b/src/foo.js'), 'the doc must contain the quoted +++ b/ diff line');

  // Reviewer examines note.md only (it never "examined" src/foo.js, which does
  // not exist) and finds nothing.
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['note.md'], findings: [] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });

  // Before the fix this threw `harness-failure: coverage -- changed file(s)
  // never examined: src/foo.js`. It must now succeed cleanly.
  const out = JSON.parse(run(['plan-fixes', ref], { env }));
  assert.deepStrictEqual(out.fixes, [], 'plan-fixes must run without a coverage harness-failure for a file target');
});

test('round-start file: persists target.type, target.hasDoD, target.spec in the ledger', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  fs.writeFileSync(path.join(fileDir, 'doc.md'), 'hello\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  run(['round-start', 'file:doc.md'], { env });
  const ledger = review.readLedger(dir, review.targetSlug('file:doc.md'));
  assert.strictEqual(ledger.target.type, 'file');
  assert.strictEqual(ledger.target.hasDoD, false);
  assert.deepStrictEqual(ledger.target.spec, { files: ['doc.md'] });
});

test('round-start file: a git target still produces targetType git in the work decision', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const out = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  assert.strictEqual(out.decision, 'work');
  assert.strictEqual(out.targetType, 'git');
  const ledger = review.readLedger(dir, review.targetSlug('feat/x'));
  assert.strictEqual(ledger.target.type, 'git');
  assert.strictEqual(ledger.target.hasDoD, true);
});

// ---------------------------------------------------------------------------
// Task 4: record non-git fixed-signal
// ---------------------------------------------------------------------------

function seedFileTargetFixesRound(dir, ref, fileRef, correctness, verify) {
  const slug = review.targetSlug(ref);
  let ledger = review.emptyLedger({ kind: 'file', ref, type: 'file', hasDoD: false, spec: { files: [fileRef] } });
  ledger = review.beginRound(ledger, 'hash1').ledger;
  ledger = { ...ledger, phase: 'fixes', planned: correctness.findings.map((f) => f.id), dod: { passed: true, deferred: true, results: [] }, gateApplied: false };
  review.writeLedger(dir, slug, ledger);
  const n = ledger.round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify(correctness));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify(verify));
  return { n, slug };
}

test('record file target: fix artifact with edited:true marks finding fixed with file-edit sentinel', () => {
  const dir = tmpDir();
  const repo = tmpDir();
  fs.writeFileSync(path.join(repo, 'note.md'), 'fixed claim\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const ref = 'file:note.md';
  const { n, slug } = seedFileTargetFixesRound(dir, ref, 'note.md',
    { status: 'ok', examined: ['note.md'], findings: [
      { id: 'docreview:unsupported-claim', gate: 'correctness', file: 'note.md', span: 'claim without evidence', summary: 'Claim lacks citation.' },
    ]},
    { status: 'ok', rejected: [] }
  );
  const groupId = 'docreview:unsupported-claim';
  const ledger = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...ledger, fix_plan: { protocolVersion: 2, planId: 'file-plan', transactionScope: 'group', expectedHead: null, groups: [{
    groupId, findingIds: [groupId], rootCause: 'claim lacks citation', invariants: ['claim is supported'], changeClass: 'local', structuralEffects: [], action: 'fix',
  }] } });
  fs.writeFileSync(path.join(dir, `round-${n}-fix-docreview_unsupported-claim.json`), JSON.stringify({ status: 'ok', edited: true, groupId, files: ['note.md'] }));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'note.md'))).digest('hex');
  fs.writeFileSync(path.join(dir, `round-${n}-certify-docreview_unsupported-claim.json`), JSON.stringify({
    status: 'ok', groupId, resolvedFindingIds: [groupId], invariants: ['claim is supported'], files: ['note.md'], fileHashes: { 'note.md': hash }, evidence: ['citation check passed'],
  }));
  const out = JSON.parse(run(['record', ref], { env }));
  const l = review.readLedger(dir, slug);
  const f = l.findings.find((x) => x.id === 'docreview:unsupported-claim');
  assert.strictEqual(f.status, 'fixed');
  assert.strictEqual(f.fix_commit, 'file-edit');
  assert.strictEqual(out.decision.continue, true);
  assert.strictEqual(out.decision.converged, false);
});

test('record file target: fix artifact with edited:false parks needs-decision, no fix_commit', () => {
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  const ref = 'file:note.md';
  const { n, slug } = seedFileTargetFixesRound(dir, ref, 'note.md',
    { status: 'ok', examined: ['note.md'], findings: [
      { id: 'docreview:unfixed', gate: 'correctness', file: 'note.md', span: 'bad claim', summary: 'Still wrong.' },
    ]},
    { status: 'ok', rejected: [] }
  );
  fs.writeFileSync(path.join(dir, `round-${n}-fix-docreview_unfixed.json`), JSON.stringify({ status: 'ok', edited: false }));
  run(['record', ref], { env });
  const l = review.readLedger(dir, slug);
  const f = l.findings.find((x) => x.id === 'docreview:unfixed');
  assert.strictEqual(f.status, 'parked');
  assert.ok(!f.fix_commit, 'parked finding must not carry fix_commit');
});

test('record file target: missing fix artifact parks needs-decision', () => {
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  const ref = 'file:note.md';
  const { n, slug } = seedFileTargetFixesRound(dir, ref, 'note.md',
    { status: 'ok', examined: ['note.md'], findings: [
      { id: 'docreview:no-artifact', gate: 'correctness', file: 'note.md', span: 'claim', summary: 'Missing fix.' },
    ]},
    { status: 'ok', rejected: [] }
  );
  void n;
  run(['record', ref], { env });
  const l = review.readLedger(dir, slug);
  const f = l.findings.find((x) => x.id === 'docreview:no-artifact');
  assert.strictEqual(f.status, 'parked');
});

// finding #3: a RESUMED file target must run the same target-agnostic resume
// housekeeping git resume does -- purge the interrupted round's artifacts and
// reset planned[] -- otherwise a stale `round-N-fix-<safe-id>.json {edited:true}`
// left by the interrupted attempt false-signals in record (a file target's ONLY
// fixed-signal is that artifact -- there is no git journal to override it),
// letting dryStreak convergence declare clean off stale bookkeeping. This drives
// the real resume path: round-start force-sets phase='gates' on a fresh run, so
// a second `round-start file:X` after an interruption sees resumed=true.
test('round-start file target resume: a stale fix artifact from the interrupted round is purged (cannot false-signal)', () => {
  const dir = tmpDir();
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-'));
  const notePath = path.join(fileDir, 'note.md');
  fs.writeFileSync(notePath, '# Note\nan unsupported claim\n');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  const ref = 'file:note.md';
  const slug = review.targetSlug(ref);

  // Fresh round-start -> phase 'gates', round N.
  const rs1 = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs1.targetType, 'file');
  const n = rs1.round;

  // Simulate an interrupted fix attempt: the ledger is mid-round at phase
  // 'fixes' with a planned finding, and a stale edited:true fix artifact sits on
  // disk from the fixer that ran before the crash.
  let l = review.readLedger(dir, slug);
  l = { ...l, phase: 'fixes', planned: ['docreview:stale'] };
  review.writeLedger(dir, slug, l);
  const staleFix = path.join(dir, `round-${n}-fix-docreview_stale.json`);
  fs.writeFileSync(staleFix, JSON.stringify({ status: 'ok', edited: true, files: ['note.md'] }));
  assert.ok(fs.existsSync(staleFix), 'precondition: stale fix artifact is present before resume');

  // Resume: a second round-start for the same ref re-drives round N. It must run
  // deleteRoundArtifacts(N) and reset planned[] even though this is a file target.
  const rs2 = JSON.parse(run(['round-start', ref], { env }));
  assert.strictEqual(rs2.decision, 'work', 'resume must re-drive the round');
  assert.strictEqual(rs2.round, n, 'resume re-drives the SAME round, not a new one');

  // The stale fix artifact is gone -> it can no longer false-mark the finding
  // fixed in record.
  assert.ok(!fs.existsSync(staleFix), 'stale fix artifact must be purged on a file-target resume');
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.planned, [], 'planned[] must be reset on a file-target resume');
});

test('round-start resume invalidates completed artifacts after a committed fix changes the diff', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'first change'], { cwd: repo });
  const started = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env }));
  const artifact = path.join(dir, `round-${started.round}-correctness.json`);
  fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  run(['artifact-normalize', 'feat/x', 'correctness'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  execFileSync('git', ['commit', '-aqm', 'fix changes reviewed diff'], { cwd: repo });

  const resumed = JSON.parse(run(['round-start', 'feat/x'], { env }));
  assert.deepStrictEqual(resumed.completedArtifacts, []);
  assert.ok(!fs.existsSync(artifact), 'a completed artifact for the old diff must not be reused');
});

test('record git target: fixed-signal comes from the journal sha, not the fix artifact (regression lock)', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/git-record-regression',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:y', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
    ]},
    { status: 'ok', rejected: [] }
  );
  run(['plan-fixes', 'feat/git-record-regression'], { env });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed\n');
  fs.writeFileSync(path.join(dir, `round-${n}-fix-correctness_y.json`), JSON.stringify({ status: 'ok', edited: true }));
  run(['commit-fix', 'feat/git-record-regression', 'correctness:y'], { env });
  run(['record', 'feat/git-record-regression'], { env });
  const slug = review.targetSlug('feat/git-record-regression');
  const l = review.readLedger(dir, slug);
  const f = l.findings.find((x) => x.id === 'correctness:y');
  assert.strictEqual(f.status, 'fixed');
  assert.match(f.fix_commit, /^[0-9a-f]{7,40}$/, 'git fix_commit must be a real sha');
  assert.notStrictEqual(f.fix_commit, 'file-edit');
});

test('artifact-normalize accepts the on-disk file name as well as the role', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).round;
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  assert.strictEqual(JSON.parse(run(['artifact-normalize', 'feat/x', `round-${n}-correctness.json`], { env })).artifact, 'correctness');
  const bad = runCapture(['artifact-normalize', 'feat/x', 'nonsense'], { env });
  assert.match(bad.stderr, /unknown artifact "nonsense"/);
});

test('a stale/absent ledger error names the state dir it resolved', () => {
  const dir = tmpDir();
  const r = runCapture(['artifact-normalize', 'feat/x', 'correctness'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  assert.match(r.stderr, new RegExp(`state dir ${dir.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
});

test('a blocked reviewer fails the round rather than shipping a verdict', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' }] },
    { status: 'ok', rejected: [], blocked: ['playwright: browser launch denied by sandbox'] });
  const r = runCapture(['artifact-normalize', 'feat/x', 'verify'], { env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /harness-failure.*browser launch denied/);
  // Fatal, not retry: a second attempt in the same environment stays a failure.
  assert.notStrictEqual(runCapture(['artifact-normalize', 'feat/x', 'verify'], { env }).status, 0);
  assert.ok(fs.existsSync(path.join(dir, `round-${n}-verify.json`)));
});

test('record surfaces each kill with the basis the reviewer gave', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:fp', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' }] },
    { status: 'ok', rejected: [{ id: 'correctness:fp', reason: 'measured the rendered box at 320px; no overflow' }] });
  run(['plan-fixes', 'feat/x'], { env });
  const rec = JSON.parse(run(['record', 'feat/x'], { env }));
  assert.match(rec.handoff, /Killed \(rejected as false-positive\)/);
  assert.match(rec.handoff, /measured the rendered box at 320px/);
});

test('rerun re-arms a converged ledger while keeping the finished run in runs[]', () => {
  const repo = initRepo(); const dir = tmpDir(); const slug = review.targetSlug('feat/x');
  const { env, n } = seedGatesRound(repo, dir, 'feat/x',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', 'feat/x'], { env });
  assert.strictEqual(JSON.parse(run(['record', 'feat/x'], { env })).decision.continue, false);
  assert.strictEqual(review.readLedger(dir, slug).status, 'clean');
  assert.strictEqual(JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).decision, 'terminal');
  fs.writeFileSync(path.join(dir, `review-telemetry-${'b'.repeat(64)}.json`), JSON.stringify({
    engine: 'claude-code', provider: 'anthropic', targetRef: 'feat/x', role: 'correctness', round: n,
    invocationId: 'old-run', usagePartial: false, totalTokens: 10,
  }));
  const codexTelemetry = path.join(dir, `telemetry-${slug}.json`);
  fs.writeFileSync(codexTelemetry, '{}');

  const out = JSON.parse(run(['rerun', 'feat/x', '--engine', 'codex'], { env }));
  assert.strictEqual(out.run, 2);
  assert.strictEqual(out.archived.status, 'clean');
  const l = review.readLedger(dir, slug);
  assert.strictEqual(l.status, 'converging');
  assert.strictEqual(l.engine, 'codex');
  assert.strictEqual(l.runs.length, 1);
  assert.strictEqual(l.runs[0].rounds, n);
  assert.strictEqual(l.runs[0].telemetry.calls, 1);
  assert.strictEqual(l.telemetry, undefined);
  assert.ok(!fs.existsSync(codexTelemetry), 'prior Codex telemetry must be swept');
  assert.deepStrictEqual(l.findings, []); // blind: the second engine sees no prior conclusions
  assert.ok(!fs.existsSync(path.join(dir, `round-${n}-correctness.json`)), 'prior round artifacts are swept');
  assert.strictEqual(JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env })).decision, 'work');
});

test('rerun without a prior ledger says so instead of silently starting one', () => {
  const dir = tmpDir();
  const r = runCapture(['rerun', 'feat/nope'], { env: { ...process.env, REVIEW_STATE_DIR: dir } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /no ledger for ref "feat\/nope"/);
});

test('rerun stops at the cumulative run budget without changing the ledger', () => {
  const { REVIEW_MAX_RUNS_DEFAULT } = require('../../core/config');
  const dir = tmpDir(); const ref = 'feat/bounded-reruns'; const slug = review.targetSlug(ref);
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref }), status: 'clean', phase: 'done' });

  for (let runNumber = 2; runNumber <= REVIEW_MAX_RUNS_DEFAULT; runNumber += 1) {
    assert.strictEqual(JSON.parse(run(['rerun', ref], { env })).run, runNumber);
    const ledger = review.readLedger(dir, slug);
    review.writeLedger(dir, slug, { ...ledger, status: 'clean', phase: 'done' });
  }

  const before = fs.readFileSync(review.ledgerPath(dir, slug));
  const evidenceBefore = fs.readdirSync(dir, { recursive: true }).sort();
  const denied = runCapture(['rerun', ref], { env });
  assert.notStrictEqual(denied.status, 0);
  assert.match(denied.stderr, new RegExp(`cumulative run budget exhausted.*${REVIEW_MAX_RUNS_DEFAULT}`));
  assert.deepStrictEqual(fs.readFileSync(review.ledgerPath(dir, slug)), before);
  assert.deepStrictEqual(fs.readdirSync(dir, { recursive: true }).sort(), evidenceBefore);

  const reset = runCapture(['reset', ref], { env });
  assert.notStrictEqual(reset.status, 0);
  assert.match(reset.stderr, /cannot discard cumulative run history/);
  assert.deepStrictEqual(fs.readFileSync(review.ledgerPath(dir, slug)), before);
});

test('rerun archives persisted Codex runner telemetry before deleting its file', () => {
  const dir = tmpDir(); const slug = review.targetSlug('feat/codex-run');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  const oldEntry = { engine: 'codex', provider: 'openai', role: 'correctness', invocationId: 'codex-old', usagePartial: false, inputTokens: 1, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 2, elapsedMs: 3 };
  const ledger = {
    ...review.emptyLedger({ kind: 'local', ref: 'feat/codex-run' }), status: 'clean', phase: 'done', engine: 'codex',
    telemetry: { engine: 'codex', calls: 1, partialCalls: 0, inputTokens: 1, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, outputTokens: 1, totalTokens: 2, elapsedMs: 3, byRole: {}, entries: [oldEntry] },
  };
  review.writeLedger(dir, slug, ledger);
  fs.writeFileSync(path.join(dir, `telemetry-${slug}.json`), JSON.stringify({
    total: { calls: 1, partialCalls: 0, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 15, elapsedMs: 20 },
    byRole: { correctness: { calls: 1, partialCalls: 0, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 15, elapsedMs: 20 } },
    invocations: [{ engine: 'codex', provider: 'openai', role: 'correctness', invocationId: 'codex-1', usagePartial: false, inputTokens: 10, cacheWriteInputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 15, elapsedMs: 20 }],
  }));

  const out = JSON.parse(run(['rerun', 'feat/codex-run', '--engine', 'claude-code'], { env }));

  assert.strictEqual(out.archived.telemetry.totalTokens, 17);
  assert.deepStrictEqual(out.archived.telemetry.entries.map((entry) => entry.invocationId).sort(), ['codex-1', 'codex-old']);
  assert.ok(!fs.existsSync(path.join(dir, `telemetry-${slug}.json`)));
});

test('reset and rerun delete telemetry by the ledger target ref when called with its slug', () => {
  const dir = tmpDir(); const slug = 'feat-x';
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  const telemetryFile = path.join(dir, `review-telemetry-${'a'.repeat(64)}.json`);
  const resetLedger = { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'parked' };
  const rerunLedger = { ...resetLedger, status: 'clean' };

  review.writeLedger(dir, slug, resetLedger);
  fs.writeFileSync(telemetryFile, JSON.stringify({ targetRef: 'feat/x' }));
  run(['reset', slug], { env });
  assert.strictEqual(fs.existsSync(telemetryFile), false);

  review.writeLedger(dir, slug, rerunLedger);
  fs.writeFileSync(telemetryFile, JSON.stringify({ targetRef: 'feat/x' }));
  run(['rerun', slug, '--engine', 'codex'], { env });
  assert.strictEqual(fs.existsSync(telemetryFile), false);
});

// ---- round budget enforcement ----

// Drives one round of a `file:<path>` target whose only finding survives
// verification and is fixed, so it counts as new and the dry-round streak never
// advances. Returns the round-start and record output.
function newFindingRound(ref, env, dir, extra, i) {
  const rs = JSON.parse(run(['round-start', ref, ...extra], { env }));
  if (rs.decision !== 'work') return { rs };
  const file = ref.slice('file:'.length);
  const id = `correctness:f${i}`;
  writeArtifact(dir, rs.round, 'correctness', { status: 'ok', examined: [file], findings: [{ id, gate: 'correctness', file, summary: `finding ${i}` }] });
  writeArtifact(dir, rs.round, 'verify', { status: 'ok', rejected: [], findings: [] });
  run(['plan-fixes', ref], { env });
  writeArtifact(dir, rs.round, `fix-${id}`, { status: 'ok', edited: true, files: [file] });
  return { rs, out: JSON.parse(run(['record', ref], { env })) };
}

test('no-DoD target converges clean after one round in which verification rejects every candidate', () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-allkilled-'));
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# note\n');
  const rs = JSON.parse(run(['round-start', 'file:note.md'], { env }));
  assert.strictEqual(rs.decision, 'work');
  const id = 'docreview:false-positive';
  writeArtifact(dir, rs.round, 'correctness', { status: 'ok', examined: ['note.md'], findings: [{ id, gate: 'correctness', file: 'note.md', summary: 'candidate finding' }] });
  writeArtifact(dir, rs.round, 'verify', { status: 'ok', rejected: [{ id, reason: 'read note.md: the claim does not hold' }], findings: [] });
  run(['plan-fixes', 'file:note.md'], { env });
  const last = JSON.parse(run(['record', 'file:note.md'], { env }));
  assert.strictEqual(last.decision.converged, true);
  const ledger = review.readLedger(dir, review.targetSlug('file:note.md'));
  assert.strictEqual(ledger.status, 'clean');
  assert.deepStrictEqual(ledger.history.map((h) => h.new), [0]);
});

test('no-DoD target changed after round-start cannot converge from stale clean evidence', () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-race-'));
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# reviewed\n');
  const ref = 'file:note.md';
  const rs = JSON.parse(run(['round-start', ref], { env }));
  writeArtifact(dir, rs.round, 'correctness', { status: 'ok', examined: ['note.md'], findings: [] });
  writeArtifact(dir, rs.round, 'verify', { status: 'ok', rejected: [], findings: [] });
  run(['plan-fixes', ref], { env });
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# changed after review\n');
  const out = JSON.parse(run(['record', ref], { env }));
  assert.strictEqual(out.decision.converged, false);
  assert.strictEqual(out.decision.continue, true);
});

test('no-DoD target rechecks identity when every reported candidate was previously killed', () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-suppressed-race-'));
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# reviewed\n');
  const ref = 'file:note.md';
  const slug = review.targetSlug(ref);
  const rs = JSON.parse(run(['round-start', ref], { env }));
  const finding = { id: 'docreview:already-killed', gate: 'correctness', file: 'note.md', span: 'reviewed', summary: 'old false positive' };
  const ledger = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, {
    ...ledger,
    findings: [{ ...finding, status: 'killed' }],
    seen: [{ id: finding.id, hash: review.seenHash(finding), status: 'killed' }],
  });
  writeArtifact(dir, rs.round, 'correctness', { status: 'ok', examined: ['note.md'], findings: [finding] });
  writeArtifact(dir, rs.round, 'verify', { status: 'ok', rejected: [], findings: [] });
  assert.deepStrictEqual(JSON.parse(run(['plan-fixes', ref], { env })).fixes, []);
  fs.writeFileSync(path.join(fileDir, 'note.md'), '# changed after review\n');
  const out = JSON.parse(run(['record', ref], { env }));
  assert.strictEqual(out.decision.converged, false);
  assert.strictEqual(out.decision.continue, true);
});

test('no-DoD target parks when the round budget is spent and round-start never opens a round past it', () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruit-file-budget-'));
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: fileDir };
  let last;
  const slug = review.targetSlug('file:note.md');
  let max = Infinity;
  for (let i = 1; i <= max; i++) {
    fs.writeFileSync(path.join(fileDir, 'note.md'), `# note\nedit ${i}\n`);
    last = newFindingRound('file:note.md', env, dir, [], i);
    assert.strictEqual(last.rs.round, i);
    if (i === 1) max = review.readLedger(dir, slug).budget.max_rounds;
  }
  assert.strictEqual(last.out.decision.parked, true);
  assert.strictEqual(last.out.decision.continue, false);
  assert.match(last.out.decision.reason, /round budget exhausted/);
  const again = JSON.parse(run(['round-start', 'file:note.md'], { env }));
  assert.strictEqual(again.decision, 'terminal');
  const ledger = review.readLedger(dir, slug);
  assert.strictEqual(ledger.round, max);
  // The parking round is uncharged.
  assert.strictEqual(ledger.budget.spent, max - 1);
});

test('git target: repeated failed final DoD attempts consume and stop at the round budget', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['false'] }));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'config'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const ref = 'feat/final-dod-budget';
  const slug = review.targetSlug(ref);
  const max = review.readLedger(dir, slug)?.budget.max_rounds || require('../../core/config').REVIEW_MAX_ROUNDS_DEFAULT;
  for (let attempt = 1; attempt <= max; attempt++) {
    const started = JSON.parse(run(['round-start', ref, attempt === 1 ? 'HEAD~1' : undefined].filter(Boolean), { env }));
    writeArtifact(dir, started.round, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
    writeArtifact(dir, started.round, 'verify', { status: 'ok', rejected: [], findings: [] });
    run(['plan-fixes', ref], { env });
    const decision = JSON.parse(run(['record', ref], { env })).decision;
    if (attempt < max) assert.strictEqual(decision.dodFailed, true);
    else assert.strictEqual(decision.parked, true);
    assert.strictEqual(review.readLedger(dir, slug).budget.spent, attempt);
  }
  assert.strictEqual(JSON.parse(run(['round-start', ref], { env })).decision, 'terminal');
});

test('target lock never offers to remove a live owner after its wait expires', () => {
  const dir = tmpDir(), file = path.join(dir, 'review.json'), lock = `${file}.lock`;
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);
  let offered = 0, entered = false;
  try {
    assert.throws(() => cli.withTargetLock(file, () => { entered = true; }, { waitMs: -1, confirm: () => { offered++; return true; } }), /still running/);
    assert.equal(offered, 0); assert.equal(entered, false);
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), `${process.pid}\n`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// `findings` is the review-only exit: the same verified fold plan-fixes routes
// into fixes, reported without a plan artifact and without touching the ledger.
test('findings: reports verified correctness findings with their line, drops rejected ones, and leaves the ledger in gates', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env } = seedGatesRound(repo, dir, 'feat/ro',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'x' },
      { id: 'correctness:fp', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'y' } ] },
    { status: 'ok', rejected: [{ id: 'correctness:fp', reason: 'the span is inside a comment' }] });
  const slug = review.targetSlug('feat/ro');
  const before = fs.readFileSync(review.ledgerPath(dir, slug), 'utf8');
  const out = JSON.parse(run(['findings', 'feat/ro'], { env, skipPlanSeed: true }));
  assert.deepStrictEqual(out.findings, [{ id: 'correctness:real', category: 'correctness', file: 'a.txt', line: 1, span: 'two', summary: 'x', requirement: '' }]);
  assert.strictEqual(fs.readFileSync(review.ledgerPath(dir, slug), 'utf8'), before);
});

test('findings: includes gate findings gate-verify did not reject, categorised by their class', () => {
  const repo = initRepo(); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/ro-broad',
    { status: 'ok', examined: ['a.txt'], findings: [] },
    { status: 'ok', rejected: [] }, { armBroad: true });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [
    { id: 'gate:cross-context:kept', file: 'review.config.json', span: 'dod', summary: 'an unchanged file breaks' },
    { id: 'gate:silent-gap:dropped', file: 'a.txt', summary: 'not real' } ] });
  // This fixture replaces the front-pass artifact after seeding verify. Keep
  // the verifier newer than that gate, as the real sequential review does.
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [{ id: 'gate:silent-gap:dropped', reason: 'covered' }], findings: [] });
  const out = JSON.parse(run(['findings', 'feat/ro-broad'], { env, skipPlanSeed: true }));
  assert.deepStrictEqual(out.findings.map((f) => [f.id, f.category, f.line]), [['gate:cross-context:kept', 'cross-context', 1]]);
});

test('round-start: --intent-file supplies the intent and takes precedence over a configured intent command', () => {
  const repo = initRepoWithIntent('exit 7'); // would fail the round if it ran
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const intentFile = path.join(tmpDir(), 'pr.md');
  fs.writeFileSync(intentFile, 'REQ: the PR body says retry three times');
  const out = JSON.parse(run(['round-start', 'feat/intent-file', 'HEAD~1', '--intent-file', intentFile], { env }));
  assert.strictEqual(out.intentApplied, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, `intent-${review.targetSlug('feat/intent-file')}.md`), 'utf8'), 'REQ: the PR body says retry three times');
  assert.strictEqual(out.intentHash, crypto.createHash('sha256').update('REQ: the PR body says retry three times').digest('hex'));
});

test('round-start: an empty --intent-file fails closed', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const intentFile = path.join(tmpDir(), 'empty.md');
  fs.writeFileSync(intentFile, '  \n');
  const { status, stderr } = runCapture(['round-start', 'feat/empty-intent', 'HEAD~1', '--no-broad', '--intent-file', intentFile], { env });
  assert.strictEqual(status, 1);
  assert.match(stderr, /intent file .* is empty/);
});

test('round-start: --no-intent-command skips the repository intent command but still takes --intent-file', () => {
  const repo = initRepoWithIntent('exit 7');
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const without = JSON.parse(run(['round-start', 'feat/no-intent', 'HEAD~1', '--no-intent-command'], { env }));
  assert.strictEqual(without.intentApplied, false);
  const intentFile = path.join(tmpDir(), 'pr.md');
  fs.writeFileSync(intentFile, 'REQ: from the PR');
  const withFile = JSON.parse(run(['round-start', 'feat/no-intent-file', 'HEAD~1', '--no-intent-command', '--intent-file', intentFile], { env }));
  assert.strictEqual(withFile.intentApplied, true);
});

test('findings: reports an intent finding on a changed file with its requirement', () => {
  const repo = initRepoWithIntent('printf "REQ: retry three times"'); const dir = tmpDir();
  const { env, n } = seedGatesRound(repo, dir, 'feat/ro-intent',
    { status: 'ok', examined: ['a.txt'], findings: [] }, { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'intent', { status: 'ok', findings: [
    { id: 'intent:no-retry', file: 'a.txt', span: 'two', requirement: 'REQ: retry three times', summary: 'does not retry' } ] });
  const out = JSON.parse(run(['findings', 'feat/ro-intent'], { env, skipPlanSeed: true }));
  assert.deepStrictEqual(out.findings, [{ id: 'intent:no-retry', category: 'intent', file: 'a.txt', line: 1, span: 'two', summary: 'does not retry', requirement: 'REQ: retry three times' }]);
});

test('findings: a gate duplicate is dropped only while the correctness finding it restates survives', () => {
  for (const [label, killed, expected] of [['kept', false, ['correctness:bug']], ['killed', true, ['gate:design-conformance:bug']]]) {
    const repo = initRepo(); const dir = tmpDir();
    const ref = `feat/dup-${label}`;
    const { env, n } = seedGatesRound(repo, dir, ref,
      { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:bug', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'bug' }] },
      { status: 'ok', rejected: killed ? [{ id: 'correctness:bug', reason: 'read a.txt: not a bug' }] : [] }, { armBroad: true });
    writeArtifact(dir, n, 'gate', { status: 'ok', findings: [{ id: 'gate:design-conformance:bug', file: 'a.txt', span: 'two', summary: 'same bug' }] });
    // Verifiers run after both finders, so their artifacts are written last.
    writeArtifact(dir, n, 'verify', { status: 'ok', rejected: killed ? [{ id: 'correctness:bug', reason: 'read a.txt: not a bug' }] : [] });
    writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [], findings: [], duplicates: [{ id: 'gate:design-conformance:bug', of: 'correctness:bug' }] });
    const out = JSON.parse(run(['findings', ref], { env, skipPlanSeed: true }));
    assert.deepStrictEqual(out.findings.map((f) => f.id), expected, label);
  }
});

test('findings: a span that occurs more than once in its file gets no line rather than a guessed one', () => {
  const repo = initRepo(); const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'retry()\nother\nretry()\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/twice', 'HEAD~1'], { env });
  const n = review.readLedger(dir, review.targetSlug('feat/twice')).round;
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:twice', gate: 'correctness', file: 'a.txt', span: 'retry()', summary: 'x' }] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  const out = JSON.parse(run(['findings', 'feat/twice'], { env, skipPlanSeed: true }));
  assert.strictEqual(out.findings[0].line, null);
});

test('findings: a finding whose file resolves outside the checkout is not read', () => {
  const repo = initRepo(); const dir = tmpDir();
  const outside = path.join(tmpDir(), 'secret.txt');
  fs.writeFileSync(outside, 'TOKEN=abc\n');
  fs.symlinkSync(outside, path.join(repo, 'link.txt'));
  execFileSync('git', ['add', 'link.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'link'], { cwd: repo });
  const { env } = seedGatesRound(repo, dir, 'feat/escape',
    { status: 'ok', examined: ['a.txt'], findings: [
      { id: 'correctness:traversal', gate: 'correctness', file: path.relative(repo, outside), span: 'TOKEN=abc', summary: 'x' },
      { id: 'correctness:symlink', gate: 'correctness', file: 'link.txt', span: 'TOKEN=abc', summary: 'y' } ] },
    { status: 'ok', rejected: [] });
  const out = JSON.parse(run(['findings', 'feat/escape'], { env, skipPlanSeed: true }));
  assert.deepStrictEqual(out.findings.map((f) => [f.id, f.line]), [['correctness:traversal', null], ['correctness:symlink', null]]);
});

test('plan-fixes: unsafe or oversized reviewer paths cannot become journal-proven replays', () => {
  for (const kind of ['traversal', 'symlink', 'fifo', 'oversized']) {
    const repo = initRepo(); const dir = tmpDir(); const outside = path.join(tmpDir(), 'outside.txt');
    fs.writeFileSync(outside, 'different text\n');
    const file = kind === 'traversal' ? path.relative(repo, outside) : `${kind}.txt`;
    const ref = `feat/safe-read-${kind}`;
    const { env } = seedGatesRound(repo, dir, ref,
      { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:unsafe', gate: 'correctness', file, span: 'outside span', summary: 'x' }] },
      { status: 'ok', rejected: [] });
    if (kind === 'symlink') fs.symlinkSync(outside, path.join(repo, file));
    if (kind === 'fifo') execFileSync('mkfifo', [path.join(repo, file)]);
    if (kind === 'oversized') { fs.writeFileSync(path.join(repo, file), ''); fs.truncateSync(path.join(repo, file), 21 * 1024 * 1024); }
    const slug = review.targetSlug(ref);
    review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), journal: [{ id: 'correctness:unsafe', sha: 'prior' }] });
    seedV2Plan(ref, env);
    const result = runCapture(['plan-fixes', ref], { env, timeout: 10000 });
    assert.strictEqual(result.status, 0, `${kind}: ${result.stderr}`);
    assert.deepStrictEqual(JSON.parse(result.stdout).fixes.map((f) => f.id), ['correctness:unsafe'], kind);
    assert.deepStrictEqual(review.readLedger(dir, slug).resolved_absent, [], kind);
  }
});

// A journaled fix that deleted the file and crashed before recording convergence
// leaves a path that is safely missing inside the checkout: that is a replay.
// Any other unavailable evidence stays with the fixer.
function planFixesWithJournal(kind, setup, afterSeed = () => {}) {
  const repo = initRepo(); const dir = tmpDir(); const outside = path.join(tmpDir(), 'gone.txt');
  const ref = `feat/missing-${kind}`;
  const file = setup({ repo, outside });
  const { env } = seedGatesRound(repo, dir, ref,
    { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:gone', gate: 'correctness', file, span: 'removed span', summary: 'x' }] },
    { status: 'ok', rejected: [] });
  afterSeed({ repo, outside });
  const slug = review.targetSlug(ref);
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), journal: [{ id: 'correctness:gone', sha: 'prior' }] });
  seedV2Plan(ref, env);
  const result = runCapture(['plan-fixes', ref], { env, timeout: 10000 });
  assert.strictEqual(result.status, 0, `${kind}: ${result.stderr}`);
  return { fixes: JSON.parse(result.stdout).fixes.map((f) => f.id), resolved: review.readLedger(dir, slug).resolved_absent };
}

test('plan-fixes: a journaled finding whose file was deleted inside the checkout is a replay', () => {
  for (const kind of ['file', 'directory']) {
    const { fixes, resolved } = planFixesWithJournal(`deleted-${kind}`, ({ repo }) => {
      const file = kind === 'file' ? 'gone.txt' : 'pkg/gone.txt';
      fs.mkdirSync(path.join(repo, 'pkg'));
      fs.writeFileSync(path.join(repo, file), 'removed span\n');
      execFileSync('git', ['add', file], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'add'], { cwd: repo });
      execFileSync('git', ['rm', '-rqf', kind === 'file' ? file : 'pkg'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'delete'], { cwd: repo });
      return file;
    });
    assert.deepStrictEqual(fixes, [], kind);
    assert.deepStrictEqual(resolved, ['correctness:gone'], kind);
  }
});

test('record: a missing journaled file replaced before record is parked, not stamped fixed', () => {
  for (const kind of ['symlink', 'fifo']) {
    const repo = initRepo(); const dir = tmpDir(); const ref = `feat/replaced-${kind}`;
    const slug = review.targetSlug(ref);
    const outside = path.join(tmpDir(), 'other.txt'); fs.writeFileSync(outside, 'no such span here\n');
    const { env } = seedGatesRound(repo, dir, ref,
      { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:gone', gate: 'correctness', file: 'gone.txt', span: 'removed span', summary: 'x' }] },
      { status: 'ok', rejected: [] });
    review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), journal: [{ id: 'correctness:gone', sha: 'prior' }] });
    seedV2Plan(ref, env);
    run(['plan-fixes', ref], { env });
    assert.deepStrictEqual(review.readLedger(dir, slug).resolved_absent, ['correctness:gone'], kind);
    if (kind === 'symlink') fs.symlinkSync(outside, path.join(repo, 'gone.txt'));
    else execFileSync('mkfifo', [path.join(repo, 'gone.txt')]);
    const result = runCapture(['record', ref], { env, timeout: 10000 });
    assert.strictEqual(result.status, 0, `${kind}: ${result.stderr}`);
    const finding = review.readLedger(dir, slug).findings.find((f) => f.id === 'correctness:gone');
    assert.strictEqual(finding.status, 'parked', kind);
  }
});

test('record: a reopened finding sent to the fixer is parked without a fresh journal entry, not fixed by its old one', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/reopened-record';
  const slug = review.targetSlug(ref);
  const finding = { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'recurred span', summary: 'x' };
  let ledger = review.emptyLedger({ kind: 'local', ref });
  ledger.findings = [{ id: finding.id, status: 'fixed' }];
  ledger.seen = [{ id: finding.id, status: 'fixed', hash: review.seenHash(finding) }];
  ledger.journal = [{ id: finding.id, sha: 'earlier-fix' }];
  review.writeLedger(dir, slug, ledger);
  const { env } = seedGatesRound(repo, dir, ref,
    { status: 'ok', examined: ['a.txt'], findings: [finding] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  assert.deepStrictEqual(review.readLedger(dir, slug).planned, ['correctness:real']);
  run(['record', ref], { env });
  const recorded = review.readLedger(dir, slug).findings.find((f) => f.id === 'correctness:real');
  assert.strictEqual(recorded.status, 'parked');
});

test('plan-fixes: an unparked reopened finding with only pre-floor journal evidence reaches the fixer, not resolved_absent', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/reopened-unparked';
  const slug = review.targetSlug(ref);
  const finding = { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'span absent from the file', summary: 'x' };
  let ledger = review.emptyLedger({ kind: 'local', ref });
  // State after park + unpark: the seen entry is gone (so the finding is no longer `reopened`), the floor from the reopened round stays.
  ledger.findings = [{ id: finding.id, status: 'open', park_reason: null }];
  ledger.seen = [];
  ledger.journal = [{ id: finding.id, sha: 'earlier-fix' }];
  ledger.journal_floor = { [finding.id]: { at: 1, round: 1 } };
  review.writeLedger(dir, slug, ledger);
  const { env } = seedGatesRound(repo, dir, ref,
    { status: 'ok', examined: ['a.txt'], findings: [finding] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  const planned = review.readLedger(dir, slug);
  assert.deepStrictEqual(planned.resolved_absent, []);
  assert.deepStrictEqual(planned.planned, [finding.id]);
});

test('plan-fixes: replanning a round keeps the journal floor, so the interrupted attempt\'s own commit still counts', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/reopened-resume';
  const slug = review.targetSlug(ref);
  const finding = { id: 'correctness:real', gate: 'correctness', file: 'a.txt', span: 'recurred span', summary: 'x' };
  let ledger = review.emptyLedger({ kind: 'local', ref });
  ledger.findings = [{ id: finding.id, status: 'fixed' }];
  ledger.seen = [{ id: finding.id, status: 'fixed', hash: review.seenHash(finding) }];
  ledger.journal = [{ id: finding.id, sha: 'earlier-fix' }];
  review.writeLedger(dir, slug, ledger);
  const { env } = seedGatesRound(repo, dir, ref,
    { status: 'ok', examined: ['a.txt'], findings: [finding] },
    { status: 'ok', rejected: [] });
  run(['plan-fixes', ref], { env });
  // The fixer committed, then the process died before record; the round is planned again.
  const planned = review.readLedger(dir, slug);
  review.writeLedger(dir, slug, { ...planned, phase: 'gates', planned: [], resolved_absent: [], journal: [...planned.journal, { id: finding.id, sha: 'current-fix' }] });
  run(['plan-fixes', ref], { env });
  run(['record', ref], { env });
  const recorded = review.readLedger(dir, slug).findings.find((f) => f.id === finding.id);
  assert.strictEqual(recorded.fix_commit, 'current-fix');
});

test('plan-fixes: a missing path outside the checkout or behind a symlink is not a replay', () => {
  for (const kind of ['outside', 'dangling-symlink', 'symlinked-directory', 'file-as-directory', 'internal-symlink']) {
    const { fixes, resolved } = planFixesWithJournal(kind, ({ repo, outside }) => {
      if (kind === 'outside') return path.relative(repo, outside);
      return { 'dangling-symlink': 'dangling.txt', 'symlinked-directory': 'linked/gone.txt', 'file-as-directory': 'a.txt/gone.txt', 'internal-symlink': 'inside.txt' }[kind];
    }, ({ repo, outside }) => {
      if (kind === 'dangling-symlink') fs.symlinkSync(outside, path.join(repo, 'dangling.txt'));
      if (kind === 'symlinked-directory') fs.symlinkSync(path.dirname(outside), path.join(repo, 'linked'));
      if (kind === 'internal-symlink') { fs.writeFileSync(path.join(repo, 'real.txt'), 'no such span\n'); fs.symlinkSync('real.txt', path.join(repo, 'inside.txt')); }
    });
    assert.deepStrictEqual(fixes, ['correctness:gone'], kind);
    assert.deepStrictEqual(resolved, [], kind);
  }
});

test('findings: nonregular and oversized reviewer paths have no source line', () => {
  for (const kind of ['fifo', 'oversized']) {
    const repo = initRepo(); const dir = tmpDir(); const file = `${kind}.txt`;
    const ref = `feat/no-line-${kind}`;
    const { env } = seedGatesRound(repo, dir, ref,
      { status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:unsafe', gate: 'correctness', file, span: 'needle', summary: 'x' }] },
      { status: 'ok', rejected: [] });
    if (kind === 'fifo') execFileSync('mkfifo', [path.join(repo, file)]);
    else { fs.writeFileSync(path.join(repo, file), 'needle\n'); fs.truncateSync(path.join(repo, file), 21 * 1024 * 1024); }
    const result = runCapture(['findings', ref], { env, timeout: 10000 });
    assert.strictEqual(result.status, 0, `${kind}: ${result.stderr}`);
    assert.strictEqual(JSON.parse(result.stdout).findings[0].line, null, kind);
  }
});

const followUp = (id, extra = {}) => ({ id, file: 'a.js', span: 'old invariant', summary: `summary of ${id}`, requirement: 'r', releaseBlocking: [], rationale: `${id} leaves the outcome correct`, ...extra });

test('review-cli dismiss: keeps the finding evidence and the dismissing human', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'gate-pending', gate_open: [followUp('gate:silent-gap:a'), followUp('gate:silent-gap:b')] });
  run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', 'someone'], { env });
  run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', 'someone-else'], { env });
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.gate_dismissed.map((d) => d.id), ['gate:silent-gap:a'], 'a repeated dismiss keeps the first record');
  const [kept] = after.gate_dismissed;
  assert.deepStrictEqual({ id: kept.id, file: kept.file, summary: kept.summary, rationale: kept.rationale, dismissedBy: kept.dismissedBy }, { id: 'gate:silent-gap:a', file: 'a.js', summary: 'summary of gate:silent-gap:a', rationale: 'gate:silent-gap:a leaves the outcome correct', dismissedBy: 'someone' });
});

test('review-cli dismiss: requires the dismissing human and changes nothing without one', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), gate_open: [followUp('gate:silent-gap:a')] });
  assert.throws(() => run(['dismiss', 'feat/x', 'gate:silent-gap:a'], { env }), /--by/);
  assert.throws(() => run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', '  '], { env }), /--by/);
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.gate_dismissed, []);
  assert.deepStrictEqual(after.gate_open.map((f) => f.id), ['gate:silent-gap:a']);
});

test('rerun archives each open follow-up candidate with its evidence and carries dismissals', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'clean', gate_open: [followUp('gate:silent-gap:a'), followUp('gate:cross-context:b', { releaseBlocking: ['security'] })] });
  run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', 'someone'], { env });
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), gate_open: [followUp('gate:cross-context:b', { releaseBlocking: ['security'] }), followUp('gate:silent-gap:c')] });
  const out = JSON.parse(run(['rerun', 'feat/x'], { env }));
  assert.deepStrictEqual(out.archived.gate_open.map((f) => f.id), ['gate:cross-context:b', 'gate:silent-gap:c']);
  const [b, c] = out.archived.gate_open;
  assert.deepStrictEqual({ file: c.file, summary: c.summary, rationale: c.rationale, releaseBlocking: c.releaseBlocking }, { file: 'a.js', summary: 'summary of gate:silent-gap:c', rationale: 'gate:silent-gap:c leaves the outcome correct', releaseBlocking: [] });
  assert.deepStrictEqual(b.releaseBlocking, ['security']);
  const next = review.readLedger(dir, slug);
  assert.deepStrictEqual(next.gate_dismissed.map((f) => f.id), ['gate:silent-gap:a']);
  const handoff = cli.renderHandoff({ ledger: next });
  assert.match(handoff, /\[gate:cross-context:b\] a\.js: summary of gate:cross-context:b/);
  assert.match(handoff, /\[gate:silent-gap:c\] a\.js: summary of gate:silent-gap:c/);
});

test('gate-verify findings keep their own classification and never overwrite the finder on a collided id', () => {
  const repo = initRepo(); const dir = tmpDir(); const ref = 'feat/verifier-added';
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', ref, base], { env, broadDefault: true })).round;
  const classified = (id, extra = {}) => ({ id, file: 'a.txt', span: 'two', summary: `s ${id}`, requirement: 'r', releaseBlocking: [], rationale: `${id} stays correct`, ...extra });
  writeArtifact(dir, n, 'correctness', { status: 'ok', examined: ['a.txt'], findings: [] });
  writeArtifact(dir, n, 'gate', { status: 'ok', findings: [classified('gate:silent-gap:found')] });
  writeArtifact(dir, n, 'verify', { status: 'ok', rejected: [] });
  writeArtifact(dir, n, 'gate-verify', { status: 'ok', rejected: [], findings: [
    classified('gate:silent-gap:found', { releaseBlocking: ['security'], rationale: 'verifier copy' }),
    classified('gate:cross-context:added'),
    { id: 'gate:threat-model:bare', file: 'a.txt', span: 'two', summary: 'unclassified', requirement: 'r' },
  ] });
  run(['plan-fixes', ref], { env });
  const decision = JSON.parse(run(['record', ref], { env })).decision;
  assert.strictEqual(decision.gatePending, true, 'the unclassified verifier-added finding stays release-blocking');
  const open = Object.fromEntries(review.readLedger(dir, review.targetSlug(ref)).gate_open.map((f) => [f.id, f]));
  assert.deepStrictEqual(open['gate:silent-gap:found'].releaseBlocking, []);
  assert.strictEqual(open['gate:silent-gap:found'].rationale, 'gate:silent-gap:found stays correct');
  assert.deepStrictEqual(open['gate:cross-context:added'].releaseBlocking, []);
  assert.strictEqual(open['gate:threat-model:bare'].releaseBlocking, undefined);
});

test('review-cli dismiss: refuses an id that is neither open nor already dismissed', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), gate_open: [followUp('gate:silent-gap:a')] });
  assert.throws(() => run(['dismiss', 'feat/x', 'gate:silent-gap:missing', '--by', 'someone'], { env }), /is not an open gate finding/);
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_dismissed, []);
});

test('dismiss and rerun keep the span of a finding that went through foldGateFindings', () => {
  const gateLib = require('../../core/gate');
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  const folded = (id) => gateLib.foldGateFindings({ gateFindings: [followUp(id)], verifyRejectedIds: [], dismissedIds: [] })[0];
  assert.strictEqual(folded('gate:silent-gap:a').span, undefined, 'the folded shape stores the anchor as evidence');
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'clean', gate_open: [folded('gate:silent-gap:a'), folded('gate:silent-gap:b')] });
  run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', 'someone'], { env });
  assert.strictEqual(review.readLedger(dir, slug).gate_dismissed[0].span, 'old invariant');
  const out = JSON.parse(run(['rerun', 'feat/x'], { env }));
  assert.strictEqual(out.archived.gate_open[0].span, 'old invariant');
});

test('the rerun handoff renders a malformed releaseBlocking value instead of crashing', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'clean', gate_open: [followUp('gate:silent-gap:a', { releaseBlocking: 'security' })] });
  run(['rerun', 'feat/x'], { env });
  const handoff = cli.renderHandoff({ ledger: review.readLedger(dir, slug) });
  assert.match(handoff, /\[gate:silent-gap:a\] a\.js: summary of gate:silent-gap:a/);
  assert.match(handoff, /release-blocking: security/);
});

test('the handoff names every dismissed finding with its evidence, the dismissing human and the verifier judgement', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'gate-pending', gate_open: [followUp('gate:silent-gap:a', { blockingReason: 'touches the auth path' }), followUp('gate:silent-gap:b')] });
  run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', 'someone'], { env });
  const handoff = cli.renderHandoff({ ledger: review.readLedger(dir, slug) });
  assert.match(handoff, /dismissed by someone: \[gate:silent-gap:a\] a\.js: summary of gate:silent-gap:a -- rationale: gate:silent-gap:a leaves the outcome correct -- release-blocking: none -- verifier: touches the auth path/);
  assert.doesNotMatch(handoff, /dismissed by .*gate:silent-gap:b/);
});

test('the evidence line carries the span, so a local reference can be built from the handoff', () => {
  const dir = tmpDir();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'gate-pending', gate_open: [followUp('gate:silent-gap:a', { span: 'exact anchor text' })] });
  run(['dismiss', 'feat/x', 'gate:silent-gap:a', '--by', 'someone'], { env });
  assert.match(cli.renderHandoff({ ledger: review.readLedger(dir, slug) }), /dismissed by someone: \[gate:silent-gap:a\].* -- span: exact anchor text/);
});

test('the evidence line tells an empty release classification from a missing one', () => {
  const line = (f) => cli.renderHandoff({ ledger: { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), runs: [{ run: 1, status: 'clean', rounds: 1, gate_open: [f] }] } });
  const eligible = line({ id: 'gate:silent-gap:a', file: 'a.js', summary: 's', rationale: 'r', releaseBlocking: [] });
  const missing = line({ id: 'gate:silent-gap:b', file: 'a.js', summary: 's', rationale: 'r' });
  assert.match(eligible, /release-blocking: none/);
  assert.match(missing, /release-blocking: unclassified/);
  assert.match(line({ id: 'gate:silent-gap:c', file: 'a.js', summary: 's', releaseBlocking: ['security'] }), /release-blocking: security/);
});

const fixedLoopFinding = { id: 'correctness:f1', file: 'a.txt', evidence: 'const a = 1;', summary: 'off by one', status: 'fixed', fix_commit: 'abc1234' };

test('rerun archives a fixed finding with its file and anchor, and the handoffs show them next to the commit', () => {
  const dir = tmpDir();
  const repo = initRepo();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'clean', findings: [fixedLoopFinding] });
  const live = cli.renderHandoff({ ledger: review.readLedger(dir, slug) });
  assert.match(live, /- \[correctness:f1\] a\.txt: off by one .*span: const a = 1; -> commit abc1234/);
  run(['rerun', 'feat/x'], { env });
  const archived = review.readLedger(dir, slug).runs[0].fixed;
  assert.deepStrictEqual(archived.map(({ id, file, span, summary, fix_commit }) => ({ id, file, span, summary, fix_commit })), [{ id: 'correctness:f1', file: 'a.txt', span: 'const a = 1;', summary: 'off by one', fix_commit: 'abc1234' }]);
  assert.match(cli.renderHandoff({ ledger: review.readLedger(dir, slug) }), /fixed in prior run #1: \[correctness:f1\] a\.txt: off by one .*span: const a = 1; -> commit abc1234/);
});

test('a gate-pending restart keeps the cleared open finding as evidence, outside gate_open, and the handoff names it', () => {
  const dir = tmpDir();
  const repo = initRepo();
  const slug = review.targetSlug('feat/x');
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  const open = { id: 'gate:cross-context:x', file: 'a.txt', span: 'two', summary: 'a real gap', rationale: 'r', releaseBlocking: ['serious-bug'] };
  review.writeLedger(dir, slug, { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), status: 'gate-pending', gate_open: [open], diff_content_hash: 'stale' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  run(['round-start', 'feat/x', 'HEAD~1'], { env });
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.gate_open, [], 'a cleared finding is not put back into gate_open');
  assert.deepStrictEqual(after.gate_cleared.map(({ id, file, span, summary, rationale, releaseBlocking }) => ({ id, file, span, summary, rationale, releaseBlocking })), [{ id: 'gate:cross-context:x', file: 'a.txt', span: 'two', summary: 'a real gap', rationale: 'r', releaseBlocking: ['serious-bug'] }]);
  assert.match(after.gate_cleared[0].clearedAt, /^\d{4}-\d\d-\d\dT/);
  const gateRan = { ...after, gate_rounds: [after.round], history: [{ round: after.round }] };
  assert.match(cli.renderHandoff({ ledger: gateRan }), /cleared at restart, not re-raised: \[gate:cross-context:x\] a\.txt: a real gap .*release-blocking: serious-bug/);
  const raisedAgain = { ...gateRan, gate_open: [open] };
  assert.doesNotMatch(cli.renderHandoff({ ledger: raisedAgain }), /cleared at restart/);
  const dismissedAfter = { ...gateRan, gate_dismissed: [{ ...open, dismissedBy: 'someone', dismissedAt: '2026-10-09T00:00:00.000Z' }] };
  assert.doesNotMatch(cli.renderHandoff({ ledger: dismissedAfter }), /cleared at restart/, 'a dismissed finding is reported once, as dismissed');
  // No recorded gate verdict (a --no-broad restart, or a gate scheduled but crashed before round-record): the finding is not known to be fixed.
  for (const unverified of [after, { ...after, gate_rounds: [after.round] }]) {
    const text = cli.renderHandoff({ ledger: unverified });
    assert.match(text, /cleared at restart, gate verdict not recorded: \[gate:cross-context:x\]/);
    assert.doesNotMatch(text, /not re-raised/);
  }
  run(['rerun', 'feat/x'], { env });
  assert.deepStrictEqual(review.readLedger(dir, slug).gate_cleared.map((f) => f.id), ['gate:cross-context:x'], 'rerun carries the cleared evidence forward');
});

test('a finding fixed in a prior run and parked again is reported once, as parked', () => {
  const prior = { id: 'correctness:f1', file: 'a.txt', span: 's', summary: 'off by one', releaseBlocking: ['serious-bug'], fix_commit: 'abc1234' };
  const other = { ...prior, id: 'correctness:f2', summary: 'other' };
  const ledger = { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), runs: [{ run: 1, status: 'clean', rounds: 1, fixed: [prior, other], parked: [], killed: [], gate_open: [] }], findings: [{ id: 'correctness:f1', file: 'a.txt', summary: 'off by one', status: 'parked', park_reason: { kind: 'unknown', text: 'reopened' } }] };
  const text = cli.renderHandoff({ ledger });
  assert.doesNotMatch(text, /fixed in prior run #1: \[correctness:f1\]/);
  assert.match(text, /fixed in prior run #1: \[correctness:f2\]/);
  assert.match(text, /- \[correctness:f1\] a\.txt: off by one/);
});

test('plan-fixes stamps the round on a cleared finding the gate did not raise again, and the handoff keeps the verdict after a rerun', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  const slug = review.targetSlug('feat/x');
  const cleared = { id: 'gate:cross-context:gone', file: 'a.txt', span: 'two', summary: 'a real gap', rationale: 'r', releaseBlocking: ['serious-bug'], clearedAt: '2026-10-09T00:00:00.000Z' };
  const raised = { ...cleared, id: 'gate:cross-context:again' };
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), gate_cleared: [cleared, raised] });
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [{ id: raised.id, file: 'a.txt', span: 'two', summary: 'a real gap' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  run(['plan-fixes', 'feat/x'], { env });
  const after = review.readLedger(dir, slug);
  assert.deepStrictEqual(after.gate_cleared.map((f) => [f.id, f.notRaisedRound ?? null]), [[cleared.id, n], [raised.id, null]]);
  run(['rerun', 'feat/x'], { env });
  const text = cli.renderHandoff({ ledger: review.readLedger(dir, slug) });
  assert.match(text, new RegExp(`cleared at restart, not re-raised \\(round ${n}\\): \\[gate:cross-context:gone\\]`));
  assert.doesNotMatch(text, /gate verdict not recorded: \[gate:cross-context:gone\]/);
});

test('a finding fixed in a prior run and killed in the current run is not also reported as fixed', () => {
  const prior = { id: 'correctness:f1', file: 'a.txt', span: 's', summary: 'off by one', releaseBlocking: ['serious-bug'], fix_commit: 'abc1234' };
  const other = { ...prior, id: 'correctness:f2', summary: 'other' };
  const ledger = { ...review.emptyLedger({ kind: 'local', ref: 'feat/x' }), runs: [{ run: 1, status: 'clean', rounds: 1, fixed: [prior, other], parked: [], killed: [], gate_open: [] }], killed_digest: [{ id: 'correctness:f1', round: 1, reason: 'false positive' }] };
  const text = cli.renderHandoff({ ledger });
  assert.doesNotMatch(text, /fixed in prior run #1: \[correctness:f1\]/);
  assert.match(text, /fixed in prior run #1: \[correctness:f2\]/);
  assert.match(text, /\[correctness:f1\] false positive/);
});

test('plan-fixes does not stamp a cleared finding the gate raised again and gate-verify rejected as not re-raised', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  const slug = review.targetSlug('feat/x');
  const cleared = { id: 'gate:cross-context:rejected', file: 'a.txt', span: 'two', summary: 'a real gap', rationale: 'r', releaseBlocking: ['serious-bug'], clearedAt: '2026-10-09T00:00:00.000Z' };
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), gate_cleared: [cleared] });
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [{ id: cleared.id, file: 'a.txt', span: 'two', summary: 'a real gap' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [{ id: cleared.id, reason: 'not a defect' }] }));
  run(['plan-fixes', 'feat/x'], { env });
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.gate_cleared[0].notRaisedRound ?? null, null);
  run(['rerun', 'feat/x'], { env });
  const text = cli.renderHandoff({ ledger: review.readLedger(dir, slug) });
  assert.match(text, new RegExp(`cleared at restart, raised again and rejected by gate-verify \\(round ${n}\\): \\[gate:cross-context:rejected\\]`));
  assert.doesNotMatch(text, /not re-raised/);
});

test('plan-fixes does not read a cleared finding dropped as a duplicate of a correctness finding as rejected by gate-verify', () => {
  const repo = initRepo();
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_STATE_DIR: dir, REVIEW_REPO_ROOT: repo };
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'], gate: {} }));
  execFileSync('git', ['commit', '-aqm', 'enable gate'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-aqm', 'change'], { cwd: repo });
  const n = JSON.parse(run(['round-start', 'feat/x', 'HEAD~1'], { env, broadDefault: true })).round;
  const slug = review.targetSlug('feat/x');
  const cleared = { id: 'gate:cross-context:dup', file: 'a.txt', span: 'two', summary: 'a real gap', rationale: 'r', releaseBlocking: ['serious-bug'], clearedAt: '2026-10-09T00:00:00.000Z' };
  review.writeLedger(dir, slug, { ...review.readLedger(dir, slug), gate_cleared: [cleared] });
  fs.writeFileSync(path.join(dir, `round-${n}-correctness.json`), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:bug', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'bug' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [{ id: cleared.id, file: 'a.txt', span: 'two', summary: 'a real gap' }] }));
  fs.writeFileSync(path.join(dir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
  fs.writeFileSync(path.join(dir, `round-${n}-gate-verify.json`), JSON.stringify({ status: 'ok', rejected: [], findings: [], duplicates: [{ id: cleared.id, of: 'correctness:bug' }] }));
  run(['plan-fixes', 'feat/x'], { env });
  const after = review.readLedger(dir, slug);
  assert.strictEqual(after.gate_cleared[0].notRaisedRound ?? null, null);
  run(['rerun', 'feat/x'], { env });
  const text = cli.renderHandoff({ ledger: review.readLedger(dir, slug) });
  assert.match(text, new RegExp(`cleared at restart, raised again and dropped as a duplicate of a correctness finding \\(round ${n}\\): \\[gate:cross-context:dup\\]`));
  assert.doesNotMatch(text, /rejected by gate-verify|not re-raised/);
});
