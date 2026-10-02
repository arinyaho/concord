'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openInitiativeRun, reserveLaunch } = require('../../core/initiative-review-run');

const plugins = path.resolve(__dirname, '../../..');
const providers = {
  claude: path.join(plugins, 'concord/hooks/review-cli.js'),
  copilot: path.join(plugins, 'concord-copilot/bin/review-cli.js'),
};
function setup(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'initiative');
  const run = openInitiativeRun({ stateDir, key: 'stable-key', repository: root, maxLaunches: 2, maxRounds: 5 });
  reserveLaunch(run, { role: 'correctness', round: 1, target: 'feat/x' });
  const handoffPath = path.join(root, 'handoff.md');
  const statePath = path.join(root, 'state.md');
  fs.writeFileSync(handoffPath, 'Approved contract, exact heads and verification evidence.\n');
  fs.writeFileSync(statePath, 'Source versions and authorization envelope.\n');
  const packet = { scope: 'review', boundary: 'round-complete', liveWorkers: [], handoffPath, statePath,
    nextAction: 'Continue the recorded next CLI step using completed artifacts.', observations: { toolCalls: 50 } };
  const packetPath = path.join(root, 'packet.json');
  const flags = ['--initiative-run-key', 'stable-key', '--initiative-state-dir', stateDir,
    '--initiative-max-launches', '2', '--initiative-max-rounds', '5'];
  const call = (value = packet, mode) => {
    fs.writeFileSync(packetPath, JSON.stringify(value));
    return spawnSync(process.execPath, [providers[provider], 'session-checkpoint', packetPath, ...flags,
      ...(mode === undefined ? [] : ['--session-handoff', mode])], {
      cwd: root, env: { ...process.env, REVIEW_REPO_ROOT: root, REVIEW_STATE_DIR: path.join(root, 'target') }, encoding: 'utf8',
    });
  };
  const ok = (value, mode) => { const r = call(value, mode); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  return { root, run, stateDir, packet, call, ok };
}

for (const provider of Object.keys(providers)) {
  test(`${provider}: default suggests a durable short continuation without changing budgets`, (t) => {
    const s = setup(t, provider); const before = fs.readFileSync(s.run.path, 'utf8');
    const result = s.ok({ ...s.packet, transcript: 'RAW_TRANSCRIPT_MARKER', cachedInputTokens: 999999999 });
    assert.equal(result.action, 'suggest');
    assert.ok(path.isAbsolute(result.promptPath));
    const prompt = fs.readFileSync(result.promptPath, 'utf8');
    assert.ok(prompt.includes('stable-key'));
    assert.ok(prompt.includes(s.packet.handoffPath));
    assert.ok(prompt.includes('Verify'));
    assert.ok(prompt.length < 4000);
    assert.ok(!prompt.includes('RAW_TRANSCRIPT_MARKER'));
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
    assert.equal(checkpoint.observationSource, 'caller-reported');
    assert.equal(checkpoint.observations.inputTokens, null);
    assert.equal(checkpoint.budget.usedLaunches, 1);
    assert.equal(checkpoint.budget.maxLaunches, 2);
    assert.equal(checkpoint.transcript, undefined);
    assert.equal(path.extname(checkpoint.sources.state.path), '.md');
    assert.equal(fs.readFileSync(s.run.path, 'utf8'), before);
    if (process.platform !== 'win32') assert.equal(fs.statSync(result.promptPath).mode & 0o777, 0o600);
  });

  test(`${provider}: suggested snapshots survive later progress in original handoffs`, (t) => {
    const s = setup(t, provider);
    const result = s.ok(s.packet);
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
    const prior = fs.readFileSync(s.packet.handoffPath, 'utf8');
    fs.writeFileSync(s.packet.handoffPath, 'Review finished; proceed to the next approved stage.');
    fs.writeFileSync(s.packet.statePath, 'Current execution has advanced.');
    assert.equal(fs.readFileSync(checkpoint.sources.handoff.path, 'utf8'), prior);
    assert.equal(checkpoint.sources.handoff.originalPath, fs.realpathSync(s.packet.handoffPath));
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(checkpoint.sources.handoff.path)).digest('hex'), checkpoint.sources.handoff.sha256);
    const prompt = fs.readFileSync(result.promptPath, 'utf8');
    assert.match(prompt, /Ordinary subsequent execution progress is not authoritative source drift/);
    assert.match(prompt, /skip completed steps/);
    assert.match(prompt, /Keep session handoff policy suggest/);
  });

  test(`${provider}: opt-in stopping requires a safe boundary and no live children`, (t) => {
    const s = setup(t, provider);
    assert.equal(s.ok({ ...s.packet, boundary: null }, 'stop-at-checkpoint').action, 'defer');
    assert.equal(s.ok({ ...s.packet, liveWorkers: ['live-child'] }, 'stop-at-checkpoint').action, 'defer');
    assert.equal(fs.readdirSync(s.stateDir).filter((name) => name.startsWith('session-handoff-')).length, 0);
    const result = s.ok(s.packet, 'stop-at-checkpoint');
    assert.equal(result.action, 'stop');
    assert.ok(fs.existsSync(result.promptPath));
    assert.ok(fs.existsSync(result.checkpointPath));
  });

  test(`${provider}: off and efficient sessions create no continuation artifacts`, (t) => {
    const s = setup(t, provider);
    assert.equal(s.ok({}, 'off').action, 'continue');
    assert.equal(s.ok({ ...s.packet, observations: { toolCalls: 49, inputTokens: 127999, noProgressCalls: 9 } }).action, 'continue');
    assert.equal(s.ok({ ...s.packet, observations: { cachedInputTokens: 999999999 } }).action, 'continue');
    assert.equal(fs.readdirSync(s.stateDir).filter((name) => name.startsWith('session-handoff-')).length, 0);
  });

  test(`${provider}: each inefficiency trigger independently suggests a handoff`, (t) => {
    const s = setup(t, provider);
    for (const observations of [{ inputTokens: 128000 }, { toolCalls: 50 }, { noProgressCalls: 10 }]) {
      assert.equal(s.ok({ ...s.packet, observations }).action, 'suggest');
    }
  });

  test(`${provider}: unreadable or incomplete handoffs fail instead of pretending to stop`, (t) => {
    const s = setup(t, provider);
    for (const packet of [{ ...s.packet, handoffPath: path.join(s.root, 'missing.md') },
      { ...s.packet, statePath: s.packet.handoffPath }, { ...s.packet, nextAction: '' },
      { ...s.packet, observations: { toolCalls: -1 } }, { ...s.packet, nextAction: 'x'.repeat(1001) }]) {
      const result = s.call(packet, 'stop-at-checkpoint');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /session handoff:/);
    }
    assert.equal(fs.readdirSync(s.stateDir).filter((name) => name.startsWith('session-handoff-')).length, 0);
  });

  test(`${provider}: a continuation records exhausted budget without restoring it`, (t) => {
    const s = setup(t, provider);
    reserveLaunch(s.run, { role: 'verify', round: 1, target: 'feat/x' });
    const before = fs.readFileSync(s.run.path, 'utf8');
    const result = s.ok(s.packet, 'stop-at-checkpoint');
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
    assert.equal(checkpoint.budget.usedLaunches, 2);
    assert.equal(fs.readFileSync(s.run.path, 'utf8'), before);
    assert.equal(reserveLaunch(s.run, { role: 'fix', round: 1, target: 'feat/x' }), false);
    assert.match(fs.readFileSync(result.promptPath, 'utf8'), /exhausted|exhaustion/);
  });
}

for (const provider of Object.keys(providers)) {
  test(`${provider}: JSON source snapshots retain their JSON extension and exact content`, (t) => {
    const s = setup(t, provider);
    const statePath = path.join(s.root, 'state.json'), handoffPath = path.join(s.root, 'handoff.json');
    fs.writeFileSync(statePath, JSON.stringify({ scope: 'review' }));
    fs.writeFileSync(handoffPath, JSON.stringify({ nextStep: 'show' }));
    const result = s.ok({ ...s.packet, statePath, handoffPath });
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
    for (const name of ['state', 'handoff']) {
      assert.equal(path.extname(checkpoint.sources[name].path), '.json');
      assert.equal(fs.readFileSync(checkpoint.sources[name].path, 'utf8'), fs.readFileSync(checkpoint.sources[name].originalPath, 'utf8'));
    }
  });
}
