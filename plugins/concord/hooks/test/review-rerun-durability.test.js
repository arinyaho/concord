'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const review = require('../../core/review');
const { runPath } = require('../../core/initiative-review-run');
const providers = { canonical: path.resolve(__dirname, '../../hooks/review-cli.js'), copilot: path.resolve(__dirname, '../../../concord-copilot/bin/review-cli.js') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-durable-'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(provider) {
  const repo = tmp(), dir = tmp(), initDir = tmp(), slug = review.targetSlug('feat/rerun');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base'); fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  const keyed = ['--initiative-run-key', 'durability', '--initiative-state-dir', initDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5'];
  const call = (args, { key = true, preload } = {}) => spawnSync('node', [...(preload ? ['--require', preload] : []), providers[provider], ...args, ...(key ? keyed : [])], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: dir } });
  const ok = args => { const out = call(args); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); };
  ok(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad']); ok(['reserve', 'feat/rerun', 'correctness']);
  const ledger = review.readLedger(dir, slug);
  const finding = { id: 'gate:cross-context:anchor', file: 'a.txt', span: 'two', requirement: 'Original approved requirement anchor', summary: 'Original evidence' };
  review.writeLedger(dir, slug, { ...ledger, gate_open: [finding], journal: [{ id: 'correctness:old', sha: 'original-commit' }] });
  fs.writeFileSync(path.join(dir, 'round-1-correctness.json'), JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
  fs.writeFileSync(path.join(dir, 'round-1-gate.json'), JSON.stringify({ status: 'ok', findings: [finding] }));
  fs.writeFileSync(path.join(dir, 'round-1-provider-output.log'), 'original round evidence\n');
  fs.writeFileSync(path.join(dir, `intent-${slug}.md`), 'Original approved requirement anchor\n');
  const otherSlug = review.targetSlug('feat/other'); review.writeLedger(dir, otherSlug, { ...review.emptyLedger({ ref: 'feat/other' }), runs: [{ untouched: true }] });
  const original = fs.readFileSync(review.ledgerPath(dir, slug));
  const artifacts = new Map(fs.readdirSync(dir).filter(name => name.startsWith('round-1-') || name === `intent-${slug}.md`).map(name => [name, fs.readFileSync(path.join(dir, name))]));
  const initiativeBytes = fs.readFileSync(runPath(initDir, 'durability'));
  const preload = mode => {
    const file = path.join(tmp(), 'fault.cjs');
    fs.writeFileSync(file, `const Module=require('node:module'),load=Module._load;Module._load=function(request,parent){const resolved=Module._resolveFilename(request,parent);const value=load.apply(this,arguments);if(resolved.endsWith('/review.js'))return{...value,writeLedger:(dir,slug,ledger)=>{if((${JSON.stringify(mode)}==='first'&&ledger.phase==='gates')||(ledger.round===0&&ledger.runs?.length&&${JSON.stringify(mode)}!=='archive')){${['after', 'first'].includes(mode) ? 'value.writeLedger(dir,slug,ledger);process.exit(72);' : "throw new Error('controlled fresh-ledger write failure');"}}return value.writeLedger(dir,slug,ledger);}};if(resolved.endsWith('/atomic-write.js')&&${JSON.stringify(mode)}==='archive')return{...value,writeFileAtomic:(file,...args)=>{if(file.includes('review-archives')&&file.endsWith('manifest.json'))throw new Error('controlled archive write failure');return value.writeFileAtomic(file,...args);}};return value;};`);
    return file;
  };
  return { dir, slug, call, ok, original, artifacts, initiativeBytes, initDir, preload, otherPath: review.ledgerPath(dir, otherSlug), otherBytes: fs.readFileSync(review.ledgerPath(dir, otherSlug)) };
}
function validateArchive(t, pointer) {
  assert.ok(pointer?.manifestPath, 'fresh run retains a durable archive pointer');
  const manifestBytes = fs.readFileSync(pointer.manifestPath); assert.equal(hash(manifestBytes), pointer.sha256);
  const manifest = JSON.parse(manifestBytes), prior = JSON.parse(fs.readFileSync(manifest.ledger.path));
  assert.equal(prior.gate_open[0].requirement, 'Original approved requirement anchor');
  assert.equal(prior.journal[0].sha, 'original-commit'); assert.equal(prior.initiative_reservations.length, 1);
  assert.deepEqual(fs.readFileSync(manifest.storedLedger.path), t.original);
  for (const [name, bytes] of t.artifacts) {
    const saved = manifest.artifacts.find(item => path.basename(item.originalPath) === name);
    assert.ok(saved, `archive omitted ${name}`); assert.deepEqual(fs.readFileSync(saved.path), bytes); assert.equal(saved.sha256, hash(bytes));
    assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(path.dirname(pointer.manifestPath)).mode & 0o777, 0o700);
  return manifest;
}
for (const provider of Object.keys(providers)) {
  test(`${provider}: the first keyed round-start write remains bound across a crash before dispatch returns`, () => {
    const t = fixture(provider), ref = 'feat/first', slug = review.targetSlug(ref);
    const out = t.call(['round-start', ref, 'HEAD~1', '--no-broad'], { preload: t.preload('first') });
    assert.equal(out.status, 72);
    const ledger = review.readLedger(t.dir, slug);
    assert.deepEqual(ledger.initiative_binding, { key: 'durability', stateDir: fs.realpathSync(t.initDir) });
    const recordedBudget = fs.readFileSync(runPath(t.initDir, 'durability'));
    fs.rmSync(`${review.ledgerPath(t.dir, slug)}.lock`, { recursive: true, force: true });
    const denied = t.call(['reserve', ref, 'correctness'], { key: false });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /complete initiative run flags/);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), recordedBudget);
    assert.deepEqual(fs.readFileSync(review.ledgerPath(t.dir, t.slug)), t.original);
  });
  test(`${provider}: a first keyed reserve publishes its binding before a crash and charges its launch once`, () => {
    const t = fixture(provider), ref = 'feat/reserve-first', slug = review.targetSlug(ref);
    const start = t.call(['round-start', ref, 'HEAD~1', '--no-broad'], { key: false });
    assert.equal(start.status, 0, start.stderr);
    assert.equal(review.readLedger(t.dir, slug).initiative_binding, undefined);
    const out = t.call(['reserve', ref, 'correctness'], { preload: t.preload('first') });
    assert.equal(out.status, 72);
    const ledger = review.readLedger(t.dir, slug);
    assert.deepEqual(ledger.initiative_binding, { key: 'durability', stateDir: fs.realpathSync(t.initDir) });
    assert.equal(ledger.initiative_reservations.length, 1);
    const recorded = fs.readFileSync(runPath(t.initDir, 'durability'));
    assert.equal(JSON.parse(recorded).launches.length, 2);
    fs.rmSync(`${review.ledgerPath(t.dir, slug)}.lock`, { recursive: true, force: true });
    const denied = t.call(['reserve', ref, 'verify'], { key: false });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /complete initiative run flags/);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), recorded);
  });
  test(`${provider}: rerun archives full prior findings and artifacts before replacing the active ledger`, () => {
    const t = fixture(provider), out = t.ok(['rerun', 'feat/rerun']);
    const fresh = review.readLedger(t.dir, t.slug); validateArchive(t, fresh.runs[0].archive);
    assert.deepEqual(fresh.findings, []); assert.deepEqual(fresh.gate_open, []);
    assert.deepEqual(fresh.initiative_binding, JSON.parse(t.original).initiative_binding);
    assert.equal(out.archived.archive.manifestPath, fresh.runs[0].archive.manifestPath);
    assert.equal(fs.existsSync(path.join(t.dir, 'round-1-gate.json')), false);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), t.initiativeBytes);
    assert.deepEqual(fs.readFileSync(t.otherPath), t.otherBytes);
  });
  test(`${provider}: crash after fresh-ledger write retains binding and already-published evidence`, () => {
    const t = fixture(provider), out = t.call(['rerun', 'feat/rerun'], { preload: t.preload('after') });
    assert.equal(out.status, 72); const fresh = review.readLedger(t.dir, t.slug);
    assert.deepEqual(fresh.initiative_binding, JSON.parse(t.original).initiative_binding); validateArchive(t, fresh.runs[0].archive);
    fs.rmSync(`${review.ledgerPath(t.dir, t.slug)}.lock`, { recursive: true, force: true });
    const unkeyed = t.call(['reserve', 'feat/rerun', 'correctness'], { key: false });
    assert.equal(unkeyed.status, 1); assert.match(unkeyed.stderr, /complete initiative run flags/);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), t.initiativeBytes);
  });
  test(`${provider}: repeated fresh-ledger publication failures preserve originals and completed archive`, () => {
    const t = fixture(provider), fault = t.preload('before');
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = t.call(['rerun', 'feat/rerun'], { preload: fault }); assert.equal(out.status, 1); assert.match(out.stderr, /controlled fresh-ledger/);
      assert.deepEqual(fs.readFileSync(review.ledgerPath(t.dir, t.slug)), t.original);
      for (const [name, bytes] of t.artifacts) assert.deepEqual(fs.readFileSync(path.join(t.dir, name)), bytes);
      assert.deepEqual(fs.readFileSync(t.otherPath), t.otherBytes);
    }
    const out = t.ok(['rerun', 'feat/rerun']); validateArchive(t, out.archived.archive);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), t.initiativeBytes);
  });
  test(`${provider}: interrupted archive publication leaves the original bound ledger and evidence readable`, () => {
    const t = fixture(provider), out = t.call(['rerun', 'feat/rerun'], { preload: t.preload('archive') });
    assert.equal(out.status, 1); assert.match(out.stderr, /controlled archive/);
    assert.deepEqual(fs.readFileSync(review.ledgerPath(t.dir, t.slug)), t.original);
    for (const [name, bytes] of t.artifacts) assert.deepEqual(fs.readFileSync(path.join(t.dir, name)), bytes);
    assert.deepEqual(fs.readFileSync(t.otherPath), t.otherBytes);
  });
}
