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
function fixture(provider, mode = 'base') {
  const repo = tmp(), dir = tmp(), initDir = tmp(), slug = review.targetSlug('feat/rerun');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base'); fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  const keyed = ['--initiative-run-key', 'durability', '--initiative-state-dir', initDir, '--initiative-max-launches', '20', '--initiative-max-rounds', '5', ...(mode === 'lite' ? ['--initiative-mode', 'lite'] : [])];
  const call = (args, { key = true, preload, flags = keyed, repository = repo } = {}) => spawnSync('node', [...(preload ? ['--require', preload] : []), providers[provider], ...args, ...(key ? flags : [])], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repository, REVIEW_STATE_DIR: dir } });
  const ok = args => { const out = call(args); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); };
  ok(['round-start', 'feat/rerun', 'HEAD~1', ...(mode === 'base' ? ['--no-broad'] : [])]); ok(['reserve', 'feat/rerun', 'correctness']);
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
  return { dir, slug, call, ok, original, artifacts, initiativeBytes, initDir, keyed, preload, otherPath: review.ledgerPath(dir, otherSlug), otherBytes: fs.readFileSync(review.ledgerPath(dir, otherSlug)) };
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
function addPriorTelemetry(t) {
  const tool = { kind: 'tool-use', engine: 'claude-code', provider: 'anthropic', targetRef: 'feat/rerun',
    role: 'correctness', round: 1, artifactPath: path.join(t.dir, 'round-1-correctness.json'),
    attempt: 1, invocationId: 'old-native-invocation', agentId: 'old-agent', parentTranscriptPath: 'old-session',
    startedAtMs: 1, status: 'completed', elapsedMs: 10, hookUsagePartial: true, providerUsage: {} };
  const records = {
    [`review-telemetry-${'a'.repeat(64)}.json`]: tool,
    [`review-agent-telemetry-${'b'.repeat(64)}.json`]: { kind: 'agent-usage', engine: 'claude-code', provider: 'anthropic',
      agentId: tool.agentId, parentTranscriptPath: tool.parentTranscriptPath, stoppedAtMs: 11, totalTokens: 17, providerUsage: {} },
    [`telemetry-${t.slug}.json`]: { invocations: [{ engine: 'codex', provider: 'openai', role: 'verify', round: 1,
      invocationId: 'old-runner-invocation', attempt: 1, artifactPath: path.join(t.dir, 'round-1-verify.json'), totalTokens: 23 }] },
  };
  for (const [name, record] of Object.entries(records)) {
    fs.writeFileSync(path.join(t.dir, name), JSON.stringify(record));
    t.artifacts.set(name, fs.readFileSync(path.join(t.dir, name)));
  }
  return Object.keys(records);
}
function interruptRerun(t) {
  const preload = path.join(tmp(), 'interrupt-rerun.cjs');
  fs.writeFileSync(preload, "const Module=require('node:module'),load=Module._load;Module._load=function(request,parent){const resolved=Module._resolveFilename(request,parent),value=load.apply(this,arguments);if(resolved.endsWith('/review.js'))return{...value,writeLedger:(dir,slug,ledger)=>{value.writeLedger(dir,slug,ledger);if(ledger.rerun_cleanup&&ledger.round===0)process.kill(process.pid,'SIGKILL');}};return value;};");
  const interrupted = t.call(['rerun', 'feat/rerun'], { preload });
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  const pending = review.readLedger(t.dir, t.slug); validateArchive(t, pending.rerun_cleanup);
  fs.rmSync(`${review.ledgerPath(t.dir, t.slug)}.lock`, { recursive: true, force: true });
}
const snapshot = directory => fs.readdirSync(directory, { recursive: true }).sort()
  .filter(name => fs.statSync(path.join(directory, name)).isFile())
  .map(name => [name, fs.readFileSync(path.join(directory, name))]);
for (const provider of Object.keys(providers)) {
  test(`${provider}: interrupted rerun rejects changed initiative options before any cleanup`, () => {
    const t = fixture(provider); addPriorTelemetry(t);
    interruptRerun(t);
    const stateBefore = snapshot(t.dir), budgetBefore = snapshot(t.initDir);
    const readonly = t.call(['show', 'feat/rerun'], { key: false });
    assert.equal(readonly.status, 0, readonly.stderr);
    assert.deepEqual(snapshot(t.dir), stateBefore); assert.deepEqual(snapshot(t.initDir), budgetBefore);
    for (const [flag, value, message] of [
      ['--initiative-max-launches', '21', /immutable configured budgets/],
      ['--initiative-max-rounds', '6', /immutable configured budgets/],
      ['--initiative-mode', 'lite', /disagrees with the run ledger/],
      ['--initiative-run-key', 'foreign-run', /different initiative binding/],
      ['--initiative-state-dir', tmp(), /different initiative binding/],
    ]) {
      const flags = [...t.keyed], index = flags.indexOf(flag);
      if (index === -1) flags.push(flag, value); else flags[index + 1] = value;
      const denied = t.call(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad'], { flags });
      assert.equal(denied.status, 1); assert.match(denied.stderr, message);
      assert.deepEqual(snapshot(t.dir), stateBefore, `${flag} changed pending evidence`);
      assert.deepEqual(snapshot(t.initDir), budgetBefore, `${flag} changed the initiative state`);
      if (flag === '--initiative-state-dir') assert.deepEqual(fs.readdirSync(value), []);
    }
    const foreignRepository = t.call(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad'], { repository: tmp() });
    assert.equal(foreignRepository.status, 1); assert.match(foreignRepository.stderr, /different repository/);
    assert.deepEqual(snapshot(t.dir), stateBefore); assert.deepEqual(snapshot(t.initDir), budgetBefore);
    const partial = t.call(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad'], { flags: t.keyed.slice(0, -2) });
    assert.equal(partial.status, 1); assert.match(partial.stderr, /must be used together/);
    assert.deepEqual(snapshot(t.dir), stateBefore); assert.deepEqual(snapshot(t.initDir), budgetBefore);
    for (const [args, message] of [
      [['unknown-verb', 'feat/rerun'], /unknown verb "unknown-verb"/],
      [['reserve', 'feat/rerun', 'unknown-role'], /reserve: role must be one of/],
      [['reserve', 'feat/rerun', 'vote', '--count', '4'], /reserve: invalid --count 4/],
    ]) {
      const denied = t.call(args);
      assert.equal(denied.status, 1); assert.match(denied.stderr, message);
      assert.deepEqual(snapshot(t.dir), stateBefore); assert.deepEqual(snapshot(t.initDir), budgetBefore);
    }
    t.ok(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad']);
    const resumed = review.readLedger(t.dir, t.slug);
    assert.equal(resumed.rerun_cleanup, undefined); assert.equal(resumed.round, 1);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), t.initiativeBytes);
    for (const [name] of t.artifacts) if (!name.startsWith('intent-') && name !== 'round-1-diff.txt') assert.equal(fs.existsSync(path.join(t.dir, name)), false);
    assert.deepEqual(fs.readFileSync(t.otherPath), t.otherBytes);
    validateArchive(t, resumed.runs[0].archive);
  });
  test(`${provider}: interrupted lite rerun rejects conflicting round policy before cleanup`, () => {
    const t = fixture(provider, 'lite'); addPriorTelemetry(t); interruptRerun(t);
    const stateBefore = snapshot(t.dir), budgetBefore = snapshot(t.initDir);
    for (const flag of ['--broad', '--gate', '--no-broad']) {
      const denied = t.call(['round-start', 'feat/rerun', 'HEAD~1', flag]);
      assert.equal(denied.status, 1); assert.match(denied.stderr, /a lite initiative run takes no/);
      assert.deepEqual(snapshot(t.dir), stateBefore); assert.deepEqual(snapshot(t.initDir), budgetBefore);
    }
    t.ok(['round-start', 'feat/rerun', 'HEAD~1']);
    assert.equal(review.readLedger(t.dir, t.slug).rerun_cleanup, undefined);
    assert.deepEqual(snapshot(t.initDir), budgetBefore);
  });
  for (const resume of ['show', 'round-start']) {
    test(`${provider}: interrupted rerun excludes archived telemetry and round artifacts on ${resume}`, () => {
      const t = fixture(provider), telemetryNames = addPriorTelemetry(t);
      const out = t.call(['rerun', 'feat/rerun'], { preload: t.preload('after') });
      assert.equal(out.status, 72);
      const fresh = review.readLedger(t.dir, t.slug), manifest = validateArchive(t, fresh.runs[0].archive);
      const archived = JSON.parse(fs.readFileSync(manifest.ledger.path));
      assert.equal(archived.telemetry.calls, 2); assert.equal(archived.telemetry.totalTokens, 40);
      fs.rmSync(`${review.ledgerPath(t.dir, t.slug)}.lock`, { recursive: true, force: true });
      const published = fs.readFileSync(review.ledgerPath(t.dir, t.slug));
      const readonly = t.call(['show', 'feat/rerun'], { key: false });
      assert.equal(readonly.status, 0, readonly.stderr);
      assert.equal(JSON.parse(readonly.stdout).telemetry?.calls || 0, 0);
      assert.deepEqual(fs.readFileSync(review.ledgerPath(t.dir, t.slug)), published, 'show must remain read-only');
      for (const [name, bytes] of t.artifacts) assert.deepEqual(fs.readFileSync(path.join(t.dir, name)), bytes);
      const denied = t.call(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad'], { key: false });
      assert.equal(denied.status, 1); assert.match(denied.stderr, /complete initiative run flags/);
      assert.deepEqual(fs.readFileSync(review.ledgerPath(t.dir, t.slug)), published);
      for (const [name, bytes] of t.artifacts) assert.deepEqual(fs.readFileSync(path.join(t.dir, name)), bytes);
      if (resume === 'round-start') t.ok(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad']);
      const shown = t.ok(['show', 'feat/rerun']);
      assert.equal(shown.telemetry?.calls || 0, 0, 'archived invocations must not become active again');
      assert.equal(shown.round, resume === 'show' ? 0 : 1);
      if (resume === 'show') t.ok(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad']);
      for (const name of [...telemetryNames, 'round-1-correctness.json', 'round-1-gate.json', 'round-1-provider-output.log']) {
        assert.equal(fs.existsSync(path.join(t.dir, name)), false, `stale evidence survived recovery: ${name}`);
      }
      assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), t.initiativeBytes);
      assert.deepEqual(fs.readFileSync(t.otherPath), t.otherBytes);
      assert.equal(review.readLedger(t.dir, t.slug).rerun_cleanup, undefined);
      fs.writeFileSync(path.join(t.dir, `telemetry-${t.slug}.json`), JSON.stringify({ invocations: [{
        engine: 'codex', provider: 'openai', role: 'correctness', round: 1, invocationId: 'new-run-invocation',
        artifactPath: path.join(t.dir, 'round-1-correctness.json'), attempt: 1, totalTokens: 5,
      }] }));
      const current = t.ok(['show', 'feat/rerun']);
      assert.equal(current.telemetry.calls, 1); assert.equal(current.telemetry.totalTokens, 5);
      assert.equal(current.telemetry.entries[0].invocationId, 'new-run-invocation');
    });
  }
  test(`${provider}: rerun cleanup resumes after deleting a tool without losing its untagged agent archive`, () => {
    const t = fixture(provider), telemetryNames = addPriorTelemetry(t), preload = path.join(tmp(), 'cleanup-fault.cjs');
    fs.writeFileSync(preload, "const fs=require('node:fs'),unlink=fs.unlinkSync;fs.unlinkSync=function(file){const result=unlink.apply(this,arguments);if(/review-telemetry-[a-f0-9]{64}\\.json$/.test(file))process.exit(73);return result;};");
    const out = t.call(['rerun', 'feat/rerun'], { preload }); assert.equal(out.status, 73);
    const fresh = review.readLedger(t.dir, t.slug); validateArchive(t, fresh.runs[0].archive);
    fs.rmSync(`${review.ledgerPath(t.dir, t.slug)}.lock`, { recursive: true, force: true });
    const shown = t.ok(['show', 'feat/rerun']); assert.equal(shown.telemetry?.calls || 0, 0);
    t.ok(['round-start', 'feat/rerun', 'HEAD~1', '--no-broad']);
    for (const name of telemetryNames) assert.equal(fs.existsSync(path.join(t.dir, name)), false, `cleanup missed ${name}`);
    assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), t.initiativeBytes);
  });
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
  test(`${provider}: a first keyed reserve interrupted before charging stays bound and charges exactly once on resume`, () => {
    const t = fixture(provider), ref = 'feat/reserve-first', slug = review.targetSlug(ref);
    const start = t.call(['round-start', ref, 'HEAD~1', '--no-broad'], { key: false });
    assert.equal(start.status, 0, start.stderr);
    assert.equal(review.readLedger(t.dir, slug).initiative_binding, undefined);
    const out = t.call(['reserve', ref, 'correctness'], { preload: t.preload('first') });
    assert.equal(out.status, 72);
    const ledger = review.readLedger(t.dir, slug);
    assert.deepEqual(ledger.initiative_binding, { key: 'durability', stateDir: fs.realpathSync(t.initDir) });
    assert.deepEqual(ledger.initiative_reservations || [], []);
    const recorded = fs.readFileSync(runPath(t.initDir, 'durability'));
    assert.deepEqual(recorded, t.initiativeBytes, 'publishing the binding must precede the launch charge');
    const launchesBefore = JSON.parse(recorded).launches;
    assert.equal(launchesBefore.length, 1);
    const boundBytes = fs.readFileSync(review.ledgerPath(t.dir, slug));
    fs.rmSync(`${review.ledgerPath(t.dir, slug)}.lock`, { recursive: true, force: true });
    for (const args of [['reserve', ref, 'verify'], ['reset', ref]]) {
      const denied = t.call(args, { key: false });
      assert.equal(denied.status, 1); assert.match(denied.stderr, /complete initiative run flags/);
      assert.deepEqual(fs.readFileSync(runPath(t.initDir, 'durability')), recorded);
      assert.deepEqual(fs.readFileSync(review.ledgerPath(t.dir, slug)), boundBytes);
    }
    const resumed = t.ok(['reserve', ref, 'correctness']);
    assert.equal(resumed.status, 'granted'); assert.equal(resumed.count, 1);
    const reservations = review.readLedger(t.dir, slug).initiative_reservations;
    assert.equal(reservations.length, 1); assert.equal(reservations[0].token, resumed.token);
    assert.equal(reservations[0].role, 'correctness'); assert.equal(reservations[0].count, 1);
    const launchesAfter = JSON.parse(fs.readFileSync(runPath(t.initDir, 'durability'))).launches;
    assert.equal(launchesAfter.length, launchesBefore.length + 1);
    assert.deepEqual(launchesAfter.slice(0, launchesBefore.length), launchesBefore);
    assert.equal(launchesAfter.at(-1).target, ref); assert.equal(launchesAfter.at(-1).role, 'correctness');
  });
  test(`${provider}: rerun archives an untagged native agent observation associated with a target tool`, () => {
    const t = fixture(provider), adapter = require('../../adapters/claude-code/review-telemetry');
    const parentTranscriptPath = path.join(t.dir, 'session.jsonl');
    const tool = { kind: 'tool-use', engine: 'claude-code', provider: 'anthropic', providerSchema: 'claude-post-tool-use-v1',
      targetRef: 'feat/rerun', role: 'correctness', round: 1, artifactPath: path.join(t.dir, 'round-1-correctness.json'),
      attempt: 1, invocationId: 'tool-for-archive', agentId: 'agent-for-archive', parentTranscriptPath,
      startedAtMs: 1, status: 'completed', elapsedMs: null, hookUsagePartial: true, providerUsage: {} };
    const targetTool = `review-telemetry-${'a'.repeat(64)}.json`, targetAgent = `review-agent-telemetry-${'b'.repeat(64)}.json`;
    fs.writeFileSync(path.join(t.dir, targetTool), JSON.stringify(tool));
    const agent = adapter.recordForEvent({ hook_event_name: 'SubagentStop', agent_id: tool.agentId, transcript_path: parentTranscriptPath }, t.dir);
    assert.equal(agent.kind, 'agent-usage'); assert.equal(agent.targetRef, undefined); assert.equal(agent.pendingTargetRef, undefined);
    fs.writeFileSync(path.join(t.dir, targetAgent), JSON.stringify(agent));
    for (const name of [targetTool, targetAgent]) t.artifacts.set(name, fs.readFileSync(path.join(t.dir, name)));
    const untouched = new Map([
      [`review-telemetry-${'c'.repeat(64)}.json`, JSON.stringify({ ...tool, targetRef: 'feat/other', invocationId: 'foreign-tool', parentTranscriptPath: path.join(t.dir, 'foreign.jsonl') })],
      [`review-agent-telemetry-${'d'.repeat(64)}.json`, JSON.stringify({ ...agent, parentTranscriptPath: path.join(t.dir, 'foreign.jsonl') })],
      [`review-telemetry-${'e'.repeat(64)}.json`, '{malformed tool'],
      [`review-agent-telemetry-${'f'.repeat(64)}.json`, '{malformed agent'],
    ]);
    for (const [name, bytes] of untouched) fs.writeFileSync(path.join(t.dir, name), bytes);
    const out = t.ok(['rerun', 'feat/rerun']), manifest = validateArchive(t, out.archived.archive);
    for (const name of [targetTool, targetAgent]) assert.equal(fs.existsSync(path.join(t.dir, name)), false, `cleanup omitted ${name}`);
    for (const [name, bytes] of untouched) {
      assert.equal(fs.readFileSync(path.join(t.dir, name), 'utf8'), bytes);
      assert.equal(manifest.artifacts.some(item => path.basename(item.originalPath) === name), false, `unrelated or malformed telemetry archived: ${name}`);
    }
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
