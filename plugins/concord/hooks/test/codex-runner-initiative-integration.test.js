'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { runPath } = require('../../core/initiative-review-run');
const review = require('../../core/review');
const cliPath = path.resolve(__dirname, '../../hooks/review-cli.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-bound-'));
function fixture({ panel = false, maxLaunches = 30 } = {}) {
  const repoRoot = tmp(), stateDir = tmp(), initiativeStateDir = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ dod: ['true'], ...(panel ? { gate: { panel: true } } : {}) }));
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  const calls = [], workers = [];
  const options = { ref: 'feature/test', base, repoRoot, initiativeStateDir, initiativeRunKey: 'integration', initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: 10, noBroad: !panel,
    runCli: (args) => {
      calls.push(args);
      const out = spawnSync('node', [cliPath, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repoRoot, REVIEW_STATE_DIR: stateDir } });
      assert.equal(out.status, 0, `${args[0]}: ${out.stderr}`); return JSON.parse(out.stdout);
    },
    spawn: async ({ role, prompt }) => {
      workers.push(role);
      const destination = /Write ONLY .*? to ([^\n]+?\.json)/.exec(prompt)?.[1];
      assert.ok(destination, `no destination for ${role}`);
      fs.writeFileSync(destination, JSON.stringify({ status: 'ok', examined: ['a.txt'], rejected: [], findings: [] }));
      return { status: 0 };
    } };
  return { options, calls, workers, stateDir, git, ledger: () => JSON.parse(fs.readFileSync(runPath(initiativeStateDir, 'integration'))) };
}
test('keyed runner propagates complete options, reserves both roles and delivers only the CLI disposition', async () => {
  const f = fixture(); const result = await runReviewUntilGreen(f.options);
  assert.deepEqual(f.workers, ['correctness', 'verify']);
  for (const args of f.calls) for (const flag of ['--initiative-run-key', '--initiative-state-dir', '--initiative-max-launches', '--initiative-max-rounds']) assert.equal(args.filter(x => x === flag).length, 1);
  assert.equal(f.ledger().launches.length, 2); assert.equal(f.ledger().dispositions.length, 1);
  assert.equal(result.continuationPacket.delivery.claim, f.ledger().dispositions[0].packet.delivery.claim);
  assert.equal(review.readLedger(f.stateDir, review.targetSlug(f.options.ref)).initiative_reservations.length, 2);
});
test('keyed panel denial reserves the entire lens batch before launching any lens', async () => {
  const f = fixture({ panel: true, maxLaunches: 6 });
  const result = await runReviewUntilGreen(f.options);
  assert.equal(result.decision, 'blocked');
  assert.equal(f.workers.some(x => x.startsWith('gate-panel-')), false);
  assert.equal(f.ledger().launches.length, 4);
});
test('keyed panel completes all lens rounds before one safe checkpoint and preserves terminal decision', async () => {
  const f = fixture({ panel: true });
  const suggestions = [];
  const result = await runReviewUntilGreen({ ...f.options, sessionHandoff: 'stop-at-checkpoint', getInputContextTokens: () => 128000, onSessionHandoff: h => suggestions.push(h) });
  assert.equal(f.workers.filter(x => x.startsWith('gate-panel-')).length, 10);
  assert.equal(f.calls.filter(x => x[0] === 'record').length, 2);
  assert.equal(f.calls.filter(x => x[0] === 'session-checkpoint').length, 1);
  assert.equal(result.sessionHandoff.action, 'stop');
  assert.equal(result.decision.converged, true);
  assert.equal(result.continuationPacket.delivery.claim, f.ledger().dispositions[0].packet.delivery.claim);
  assert.equal(f.ledger().dispositions.length, 1);
  const checkpoint = JSON.parse(fs.readFileSync(result.sessionHandoff.checkpointPath));
  assert.equal(checkpoint.observations.inputTokens, 128000);
  assert.equal(checkpoint.boundary, 'round-complete');
  const state = JSON.parse(fs.readFileSync(checkpoint.sources.state.path));
  assert.ok(state.authoritativeSources.every(s => s.path && s.sha256));
  assert.ok(!fs.readFileSync(checkpoint.sources.state.path, 'utf8').includes('invocations'));
});
test('launcher parses session policy anywhere and rejects missing, duplicate and invalid policies', () => {
  const dir = tmp(), capture = path.join(dir, 'options.json'), preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),Module=require('node:module'),load=Module._load;Module._load=function(request){if(request==='../engine/codex-review-runner')return{runReviewUntilGreen:async o=>{fs.writeFileSync(process.env.CAPTURE,JSON.stringify(o));return{handoff:'ok'};}};return load.apply(this,arguments);};`);
  const bin = path.resolve(__dirname, '../../../concord-codex/bin/review-until-green.js');
  for (const args of [['--session-handoff', 'off', 'branch', 'main'], ['branch', '--session-handoff', 'suggest', 'main'], ['resume', 'branch', '--session-handoff', 'stop-at-checkpoint']]) {
    const out = spawnSync('node', ['--require', preload, bin, ...args], { encoding: 'utf8', env: { ...process.env, CAPTURE: capture } });
    assert.equal(out.status, 0, out.stderr); const options = JSON.parse(fs.readFileSync(capture));
    assert.equal(options.ref, 'branch'); assert.equal(options.base, args.includes('main') ? 'main' : undefined);
    assert.equal(options.sessionHandoff, args[args.indexOf('--session-handoff') + 1]);
  }
  for (const args of [['branch', '--session-handoff'], ['branch', '--session-handoff', 'bad'], ['branch', '--session-handoff', 'off', '--session-handoff', 'suggest']]) {
    assert.equal(spawnSync('node', ['--require', preload, bin, ...args], { encoding: 'utf8' }).status, 1);
  }
});
test('default suggestions publish once while later progress continues to terminal output', async () => {
  const f = fixture(); let starts = 0; const calls = []; const suggestions = [];
  const original = f.options.runCli;
  const runCli = (args) => {
    calls.push(args);
    if (args[0] === 'round-start') { starts++; return { decision: 'work', stateDir: f.stateDir, round: starts, head: f.git('rev-parse', 'HEAD'), base: f.options.base, targetType: 'git', dodPassed: true }; }
    if (args[0] === 'record') return { decision: starts < 3 ? { continue: true, rawLog: 'RAW_TRANSCRIPT_NEVER_COPY' } : { converged: true } };
    if (args[0] === 'reserve') return { status: 'granted' };
    if (args[0] === 'artifact-normalize') return { status: 'ok' };
    if (args[0] === 'plan-fixes') return { fixes: [] };
    if (args[0] === 'telemetry-slot') return {};
    return original(args);
  };
  const result = await runReviewUntilGreen({ ...f.options, runCli, getInputContextTokens: () => 128000, onSessionHandoff: h => suggestions.push(h) });
  assert.equal(starts, 3); assert.equal(suggestions.length, 1);
  assert.equal(calls.filter(x => x[0] === 'session-checkpoint').length, 1);
  assert.equal(result.sessionHandoff.promptPath, suggestions[0].promptPath);
  const checkpoint = JSON.parse(fs.readFileSync(result.sessionHandoff.checkpointPath));
  assert.equal(checkpoint.observations.toolCalls, 11);
  assert.equal(checkpoint.observations.noProgressCalls, 2);
  assert.equal(fs.readFileSync(checkpoint.sources.state.path, 'utf8').includes('RAW_TRANSCRIPT_NEVER_COPY'), false);
  assert.equal(fs.readFileSync(checkpoint.sources.handoff.path, 'utf8').includes('RAW_TRANSCRIPT_NEVER_COPY'), false);
});
test('native launcher prints a checkpoint even with a continuation packet, exactly once', () => {
  const dir = tmp(), preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(request){if(request==='../engine/codex-review-runner')return{runReviewUntilGreen:async o=>{const h={promptPath:'/private/resume.md',prompt:'CONTINUE'};await o.onSessionHandoff(h);return{decision:{converged:true},sessionHandoff:h,continuationPacket:{packet:'terminal'}};}};return load.apply(this,arguments);};`);
  const bin = path.resolve(__dirname, '../../../concord-codex/bin/review-until-green.js');
  const out = spawnSync('node', ['--require', preload, bin, 'branch'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.match(/CONTINUE/g).length, 1); assert.match(out.stdout, /terminal/);
});
const destination = (prompt, stateDir) => require('../../core/review-artifact').artifactDestinationFromPrompt(prompt, stateDir);
const bug = { id: 'correctness:two', gate: 'correctness', file: 'a.txt', span: 'two', summary: 'replace two' };
function fixingWorker(f) {
  return async ({ role, prompt }) => {
    f.workers.push(role);
    const artifact = destination(prompt, f.stateDir), round = Number(/round-(\d+)/.exec(artifact)[1]);
    const data = { status: 'ok', examined: ['a.txt'], rejected: [], findings: role === 'correctness' && round === 1 ? [bug] : [] };
    if (role === 'fix') { fs.writeFileSync(path.join(f.options.repoRoot, 'a.txt'), 'three\n'); Object.assign(data, { edited: true, files: ['a.txt'] }); }
    fs.writeFileSync(artifact, JSON.stringify(data)); return { status: 0 };
  };
}
test('real keyed artifact retry reserves another launch before accepting rewritten evidence', async () => {
  const f = fixture(); let correctness = 0;
  const result = await runReviewUntilGreen({ ...f.options, spawn: async ({ role, prompt }) => {
    f.workers.push(role); if (role === 'correctness') correctness++;
    fs.writeFileSync(destination(prompt, f.stateDir), JSON.stringify({ status: 'ok', examined: correctness === 1 && role === 'correctness' ? [] : ['a.txt'], findings: [], rejected: [] })); return { status: 0 };
  } });
  assert.equal(result.decision.converged, true);
  assert.deepEqual(f.workers, ['correctness', 'correctness', 'verify']);
  assert.equal(f.ledger().launches.length, 3);
  const reservations = review.readLedger(f.stateDir, review.targetSlug(f.options.ref)).initiative_reservations;
  assert.equal(reservations.filter(x => x.role === 'correctness').length, 2);
});
test('stop-at-checkpoint stops after the committed fix and resume preserves the same budget and completed round', async () => {
  const f = fixture(); const spawn = fixingWorker(f);
  const stopped = await runReviewUntilGreen({ ...f.options, spawn, sessionHandoff: 'stop-at-checkpoint', getInputContextTokens: () => 128000 });
  assert.equal(stopped.decision, 'session-handoff'); assert.equal(stopped.reviewDecision.continue, true);
  assert.equal(f.calls.filter(x => x[0] === 'round-start').length, 1);
  assert.deepEqual(f.workers, ['correctness', 'verify', 'fix']);
  assert.equal(f.ledger().launches.length, 3); assert.equal(f.ledger().dispositions.length, 0);
  const next = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(stopped.sessionHandoff.checkpointPath)).sources.state.path)).nextStep;
  assert.equal(next.args[0], 'round-start'); assert.equal(next.args[1], f.options.ref);
  const resumed = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, spawn, sessionHandoff: 'off' });
  assert.equal(resumed.decision.converged, true); assert.equal(f.ledger().launches.length, 5);
  assert.equal(f.ledger().rounds.length, 2); assert.equal(f.workers.filter(x => x === 'fix').length, 1);
  assert.equal(f.ledger().dispositions.length, 1);
  assert.equal(f.calls[ f.calls.findIndex(x => x[0] === 'show') ][0], 'show');
});
test('a terminal record immediately after a fix delivers the CLI pre-fix disposition without recording the post-fix head twice', async () => {
  const f = fixture(); const original = f.options.runCli; const before = f.git('rev-parse', 'HEAD');
  const result = await runReviewUntilGreen({ ...f.options, spawn: fixingWorker(f), runCli: args => {
    const out = original(args);
    if (args[0] === 'round-start') {
      const slug = review.targetSlug(f.options.ref), ledger = review.readLedger(f.stateDir, slug);
      review.writeLedger(f.stateDir, slug, { ...ledger, budget: { ...ledger.budget, max_rounds: 1, spent: 1 } });
    }
    return out;
  } });
  assert.equal(result.decision.parked, true); assert.notEqual(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.ledger().dispositions.length, 1); assert.equal(f.ledger().dispositions[0].revision.head_sha, before);
  assert.equal(result.continuationPacket.delivery.claim, f.ledger().dispositions[0].packet.delivery.claim);
});
test('unmeasured input context stays null and the runner tool-call threshold triggers without provider usage', async () => {
  const f = fixture({ maxLaunches: 100 }); let starts = 0; const original = f.options.runCli;
  const result = await runReviewUntilGreen({ ...f.options, runCli: args => {
    if (args[0] === 'round-start') return { decision: 'work', round: ++starts, stateDir: f.stateDir, head: f.git('rev-parse', 'HEAD'), base: f.options.base, targetType: 'git', dodPassed: true };
    if (args[0] === 'reserve') return { status: 'granted' };
    if (args[0] === 'telemetry-slot') return {};
    if (args[0] === 'artifact-normalize') return { status: 'ok' };
    if (args[0] === 'plan-fixes') return { fixes: [] };
    if (args[0] === 'record') return { decision: starts < 6 ? { continue: true } : { converged: true } };
    return original(args);
  } });
  const checkpoint = JSON.parse(fs.readFileSync(result.sessionHandoff.checkpointPath));
  assert.equal(checkpoint.observations.inputTokens, null); assert.equal(checkpoint.observations.toolCalls, 55);
  assert.equal(checkpoint.observations.noProgressCalls, 2);
  assert.deepEqual(checkpoint.triggers, ['toolCalls']);
});
test('keyed vote denial launches zero voters after reserving all lens workers', async () => {
  const f = fixture({ panel: true, maxLaunches: 9 });
  const result = await runReviewUntilGreen({ ...f.options, spawn: async ({ role, prompt }) => {
    f.workers.push(role);
    fs.writeFileSync(destination(prompt, f.stateDir), JSON.stringify({ status: 'ok', examined: ['a.txt'], rejected: [], findings: role === 'gate-panel-ac-coverage' ? [{ ...bug, id: 'gate:ac-coverage:two', requirement: 'two' }] : [] })); return { status: 0 };
  } });
  assert.equal(result.decision, 'blocked'); assert.equal(f.ledger().launches.length, 9);
  assert.equal(f.workers.filter(x => x === 'gate-panel-verify').length, 0);
  const reserve = f.calls.find(x => x[0] === 'reserve' && x[2] === 'vote');
  assert.equal(reserve[reserve.indexOf('--count') + 1], '3');
});
test('all parallel siblings drain before a stop checkpoint can be emitted', async () => {
  const f = fixture({ panel: true }); let release; let entered;
  const enteredLens = new Promise(resolve => { entered = resolve; });
  const pendingLens = new Promise(resolve => { release = resolve; });
  const running = runReviewUntilGreen({ ...f.options, sessionHandoff: 'stop-at-checkpoint', getInputContextTokens: () => 128000, spawn: async input => {
    if (input.role === 'gate-panel-threat-model' && input.prompt.includes('round-1-gate-panel-1-')) { entered(); await pendingLens; }
    return f.options.spawn(input);
  } });
  await enteredLens;
  assert.equal(f.calls.some(x => x[0] === 'session-checkpoint'), false);
  assert.equal(f.calls.filter(x => x[0] === 'record').length, 1);
  release(); const result = await running;
  assert.equal(result.sessionHandoff.action, 'stop'); assert.equal(f.calls.filter(x => x[0] === 'session-checkpoint').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'record').length, 2);
});
test('resume reuses accepted correctness evidence and charges only the interrupted verifier again', async () => {
  const f = fixture(); const original = f.options.spawn;
  await assert.rejects(runReviewUntilGreen({ ...f.options, sessionHandoff: 'off', spawn: input => {
    if (input.role === 'verify') { f.workers.push('verify-failed'); throw new Error('verifier interrupted'); }
    return original(input);
  } }), /verifier interrupted/);
  const result = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, sessionHandoff: 'off' });
  assert.equal(result.decision.converged, true);
  assert.deepEqual(f.workers, ['correctness', 'verify-failed', 'verify']);
  assert.equal(f.ledger().launches.length, 3); assert.equal(f.ledger().rounds.length, 1);
});
test('stop checkpoints attach to the original gate-pending decision without converting it to convergence', async () => {
  const f = fixture({ panel: true });
  const result = await runReviewUntilGreen({ ...f.options, sessionHandoff: 'stop-at-checkpoint', getInputContextTokens: () => 128000, spawn: async input => {
    f.workers.push(input.role);
    fs.writeFileSync(destination(input.prompt, f.stateDir), JSON.stringify({ status: 'ok', examined: ['a.txt'], rejected: [], findings: input.role === 'gate' ? [{ id: 'gate:cross-context:two', file: 'a.txt', span: 'two', requirement: 'approved requirement', summary: 'gate concern' }] : [] })); return { status: 0 };
  } });
  assert.equal(result.decision.gatePending, true); assert.equal(result.decision.converged, false);
  assert.equal(result.sessionHandoff.action, 'stop');
  assert.equal(result.continuationPacket.delivery.claim, f.ledger().dispositions[0].packet.delivery.claim);
  assert.equal(f.workers.some(role => role.startsWith('gate-panel-')), false);
});
test('successful panel votes reserve all candidates as one six-worker batch without double charging', async () => {
  const f = fixture({ panel: true });
  const result = await runReviewUntilGreen({ ...f.options, spawn: async input => {
    f.workers.push(input.role);
    const artifact = destination(input.prompt, f.stateDir);
    const findings = input.role === 'gate-panel-ac-coverage' && artifact.includes('-gate-panel-1-') ? [{ ...bug, id: 'gate:ac-coverage:two', requirement: 'two' }, { ...bug, id: 'gate:ac-coverage:other', requirement: 'other' }] : [];
    fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], rejected: [], findings, survives: false })); return { status: 0 };
  } });
  assert.equal(result.decision.converged, true);
  assert.equal(f.workers.filter(role => role === 'gate-panel-verify').length, 6);
  assert.equal(f.ledger().launches.length, 20);
  const reservations = review.readLedger(f.stateDir, review.targetSlug(f.options.ref)).initiative_reservations;
  assert.equal(reservations.filter(r => r.role === 'vote').length, 1);
  assert.equal(reservations.find(r => r.role === 'vote').count, 6);
});
test('two-candidate vote batch denial consumes no vote budget and launches zero voters', async () => {
  const f = fixture({ panel: true, maxLaunches: 12 });
  const result = await runReviewUntilGreen({ ...f.options, spawn: async input => {
    f.workers.push(input.role);
    const artifact = destination(input.prompt, f.stateDir);
    const findings = input.role === 'gate-panel-ac-coverage' ? [
      { ...bug, id: 'gate:ac-coverage:first', requirement: 'first' },
      { ...bug, id: 'gate:ac-coverage:second', requirement: 'second' },
    ] : [];
    fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: ['a.txt'], rejected: [], findings, survives: false })); return { status: 0 };
  } });
  assert.equal(result.decision, 'blocked');
  assert.equal(f.workers.filter(role => role === 'gate-panel-verify').length, 0);
  assert.equal(f.ledger().launches.length, 9);
  const votes = f.calls.filter(args => args[0] === 'reserve' && args[2] === 'vote');
  assert.equal(votes.length, 1); assert.equal(votes[0][votes[0].indexOf('--count') + 1], '6');
});
test('fresh contexts each suggest once while resuming the same durable review budget', async () => {
  const f = fixture(), first = [], second = [];
  const worker = fixingWorker(f);
  await assert.rejects(runReviewUntilGreen({ ...f.options, getInputContextTokens: () => 128000, onSessionHandoff: h => first.push(h), spawn: input => {
    if (input.role === 'verify' && input.prompt.includes('round-2-verify.json')) { f.workers.push('verify-failed'); throw new Error('replace context after round-one suggestion'); }
    return worker(input);
  } }), /replace context/);
  const before = f.ledger(); assert.equal(first.length, 1);
  assert.equal(before.launches.length, 5); assert.equal(before.rounds.length, 2);
  const result = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, getInputContextTokens: () => 128000, onSessionHandoff: h => second.push(h), spawn: worker });
  assert.equal(second.length, 1); assert.equal(result.sessionHandoff.promptPath, second[0].promptPath);
  assert.equal(f.ledger().launches.length, 6); assert.equal(f.ledger().rounds.length, 2);
  assert.deepEqual(f.ledger().budget, before.budget);
  assert.equal(f.workers.filter(role => role === 'fix').length, 1);
  assert.equal(f.workers.filter(role => role === 'correctness').length, 2);
});

for (const mode of ['suggest', 'stop-at-checkpoint']) {
  for (const failure of ['cli', 'read', 'write', 'prompt']) {
    test(`${mode}: ${failure} checkpoint failure preserves recorded clean result and sole disposition`, async () => {
      const f = fixture(), original = f.options.runCli;
      const result = await runReviewUntilGreen({ ...f.options, sessionHandoff: mode, getInputContextTokens: () => 128000, runCli: args => {
        if (args[0] === 'session-checkpoint' && failure === 'cli') throw new Error('checkpoint CLI failed');
        const out = original(args);
        if (args[0] === 'record' && failure === 'read') fs.writeFileSync(review.ledgerPath(f.stateDir, review.targetSlug(f.options.ref)), '{');
        if (args[0] === 'record' && failure === 'write') fs.mkdirSync(path.join(f.stateDir, `session-review-${review.targetSlug(f.options.ref)}-state.json`));
        if (args[0] === 'session-checkpoint' && failure === 'prompt') fs.unlinkSync(out.promptPath);
        return out;
      } });
      assert.equal(result.decision.converged, true);
      assert.ok(result.sessionHandoff.error);
      assert.equal(result.sessionHandoff.mode, mode);
      assert.equal(f.ledger().dispositions.length, 1);
      assert.equal(result.continuationPacket.delivery.claim, f.ledger().dispositions[0].packet.delivery.claim);
      assert.deepEqual(f.workers, ['correctness', 'verify']);
    });
  }
}
test('suggest callback failure preserves the recorded review result', async () => {
  const f = fixture();
  const result = await runReviewUntilGreen({ ...f.options, getInputContextTokens: () => 128000, onSessionHandoff: () => { throw new Error('handoff output failed'); } });
  assert.equal(result.decision.converged, true);
  assert.match(result.sessionHandoff.error, /handoff output failed/);
  assert.equal(f.ledger().dispositions.length, 1);
});
test('failed stop checkpoint preserves a continuing decision and launches no next round', async () => {
  const f = fixture(), original = f.options.runCli;
  const result = await runReviewUntilGreen({ ...f.options, spawn: fixingWorker(f), sessionHandoff: 'stop-at-checkpoint', getInputContextTokens: () => 128000, runCli: args => {
    if (args[0] === 'session-checkpoint') throw new Error('checkpoint failed');
    return original(args);
  } });
  assert.equal(result.decision, 'session-handoff');
  assert.equal(result.reviewDecision.continue, true);
  assert.match(result.sessionHandoff.error, /checkpoint failed/);
  assert.equal(f.ledger().rounds.length, 1);
  assert.equal(f.ledger().dispositions.length, 0);
});
test('native launcher signals an incomplete session handoff with exit code 1', () => {
  const dir = tmp(), preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(request){if(request==='../engine/codex-review-runner')return{runReviewUntilGreen:async()=>({decision:'session-handoff',reviewDecision:{continue:true},sessionHandoff:{action:'stop',promptPath:'/private/resume.md',prompt:'CONTINUE'}})};return load.apply(this,arguments);};`);
  const out = spawnSync('node', ['--require', preload, path.resolve(__dirname, '../../../concord-codex/bin/review-until-green.js'), 'branch'], { encoding: 'utf8' });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /session-handoff/);
  assert.match(out.stdout, /CONTINUE/);
});
