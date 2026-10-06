'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { runReviewUntilGreen } = require('../../core/codex-review-runner');
const { runPath } = require('../../core/initiative-review-run');
const review = require('../../core/review');
const cliPath = path.resolve(__dirname, '../../hooks/review-cli.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-bound-'));
const emptyPlan = { protocolVersion: 2, planId: 'empty-plan', transactionScope: 'group', fixes: [], fixGroups: [] };
function fixture({ maxLaunches = 30, mode } = {}) {
  const repoRoot = tmp(), stateDir = tmp(), initiativeStateDir = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repoRoot, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'two\n'); git('commit', '-aqm', 'change');
  const calls = [], workers = [];
  // A lite run's round-start rejects --no-broad outright (lite always runs the
  // one design-conformance gate), so lite fixtures must not send it.
  const options = { ref: 'feature/test', base, repoRoot, initiativeStateDir, initiativeRunKey: 'integration', initiativeMaxLaunches: maxLaunches, initiativeMaxRounds: 10, noBroad: mode !== 'lite', cliPath, ...(mode ? { initiativeMode: mode } : {}),
    runCli: (args) => {
      calls.push(args);
      const out = spawnSync('node', [cliPath, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: repoRoot, REVIEW_STATE_DIR: stateDir } });
      assert.equal(out.status, 0, `${args[0]}: ${out.stderr}`); return JSON.parse(out.stdout);
    },
    spawn: async ({ role, prompt }) => {
      workers.push(role);
      const destination = /Write ONLY .*? to ([^\n]+?\.json)/.exec(prompt)?.[1];
      assert.ok(destination, `no destination for ${role}`);
      const artifact = role === 'plan'
        ? { status: 'ok', protocolVersion: 2, groups: [] }
        : { status: 'ok', examined: ['a.txt'], rejected: [], findings: [] };
      fs.writeFileSync(destination, JSON.stringify(artifact));
      return { status: 0 };
    } };
  return { options, calls, workers, stateDir, git, ledger: () => JSON.parse(fs.readFileSync(runPath(initiativeStateDir, 'integration'))) };
}
test('keyed runner propagates complete options, reserves every review role and delivers only the CLI disposition', async () => {
  const f = fixture(); const result = await runReviewUntilGreen(f.options);
  assert.deepEqual(f.workers, ['correctness', 'verify', 'plan']);
  for (const args of f.calls) for (const flag of ['--initiative-run-key', '--initiative-state-dir', '--initiative-max-launches', '--initiative-max-rounds']) assert.equal(args.filter(x => x === flag).length, 1);
  assert.equal(f.ledger().launches.length, 3); assert.equal(f.ledger().dispositions.length, 1);
  assert.equal(result.continuationPacket.delivery.claim, f.ledger().dispositions[0].packet.delivery.claim);
  assert.equal(review.readLedger(f.stateDir, review.targetSlug(f.options.ref)).initiative_reservations.length, 3);
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
    if (args[0] === 'plan-fixes') return emptyPlan;
    if (args[0] === 'telemetry-slot') return {};
    return original(args);
  };
  const result = await runReviewUntilGreen({ ...f.options, runCli, getInputContextTokens: () => 128000, onSessionHandoff: h => suggestions.push(h) });
  assert.equal(starts, 3); assert.equal(suggestions.length, 1);
  assert.equal(calls.filter(x => x[0] === 'session-checkpoint').length, 1);
  assert.equal(result.sessionHandoff.promptPath, suggestions[0].promptPath);
  const checkpoint = JSON.parse(fs.readFileSync(result.sessionHandoff.checkpointPath));
  assert.equal(checkpoint.observations.toolCalls, 15);
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
    let data = { status: 'ok', examined: ['a.txt'], rejected: [], findings: role === 'correctness' && round === 1 ? [bug] : [] };
    if (role === 'plan') data = { status: 'ok', protocolVersion: 2, groups: round === 1 ? [{ groupId: bug.id, findingIds: [bug.id], rootCause: bug.summary, invariants: ['two is replaced'], changeClass: 'local', structuralEffects: [], action: 'fix' }] : [] };
    if (role === 'fix') { fs.writeFileSync(path.join(f.options.repoRoot, 'a.txt'), 'three\n'); data = { status: 'ok', edited: true, groupId: bug.id, files: ['a.txt'] }; }
    if (role === 'certify') data = { status: 'ok', groupId: bug.id, resolvedFindingIds: [bug.id], invariants: ['two is replaced'], files: ['a.txt'], fileHashes: { 'a.txt': crypto.createHash('sha256').update(fs.readFileSync(path.join(f.options.repoRoot, 'a.txt'))).digest('hex') }, evidence: ['replacement checked'] };
    fs.writeFileSync(artifact, JSON.stringify(data)); return { status: 0 };
  };
}
test('missing correctness coverage fails closed without a second reviewer launch', async () => {
  const f = fixture(); let correctness = 0;
  await assert.rejects(runReviewUntilGreen({ ...f.options, spawn: async ({ role, prompt }) => {
    f.workers.push(role); if (role === 'correctness') correctness++;
    const artifact = role === 'plan'
      ? { status: 'ok', protocolVersion: 2, groups: [] }
      : { status: 'ok', examined: correctness === 1 && role === 'correctness' ? [] : ['a.txt'], findings: [], rejected: [] };
    fs.writeFileSync(destination(prompt, f.stateDir), JSON.stringify(artifact)); return { status: 0 };
  } }), /coverage is incomplete/);
  assert.deepEqual(f.workers, ['correctness']);
  assert.equal(f.ledger().launches.length, 1);
  const reservations = review.readLedger(f.stateDir, review.targetSlug(f.options.ref)).initiative_reservations;
  assert.equal(reservations.filter(x => x.role === 'correctness').length, 1);
});
test('stop-at-checkpoint stops after the committed fix and resume preserves the same budget and completed round', async () => {
  const f = fixture(); const spawn = fixingWorker(f);
  const stopped = await runReviewUntilGreen({ ...f.options, spawn, sessionHandoff: 'stop-at-checkpoint', getInputContextTokens: () => 128000 });
  assert.equal(stopped.decision, 'session-handoff'); assert.equal(stopped.reviewDecision.continue, true);
  assert.equal(f.calls.filter(x => x[0] === 'round-start').length, 1);
  assert.deepEqual(f.workers, ['correctness', 'verify', 'plan', 'fix', 'certify']);
  assert.equal(f.ledger().launches.length, 5); assert.equal(f.ledger().dispositions.length, 0);
  const next = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(stopped.sessionHandoff.checkpointPath)).sources.state.path)).nextStep;
  assert.equal(next.args[0], 'round-start'); assert.equal(next.args[1], f.options.ref);
  const resumed = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, spawn, sessionHandoff: 'off' });
  assert.equal(resumed.decision.converged, true); assert.equal(f.ledger().launches.length, 8);
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
    if (args[0] === 'plan-fixes') return emptyPlan;
    if (args[0] === 'record') return { decision: starts < 6 ? { continue: true } : { converged: true } };
    return original(args);
  } });
  const checkpoint = JSON.parse(fs.readFileSync(result.sessionHandoff.checkpointPath));
  assert.equal(checkpoint.observations.inputTokens, null); assert.equal(checkpoint.observations.toolCalls, 60);
  assert.equal(checkpoint.observations.noProgressCalls, 2);
  assert.deepEqual(checkpoint.triggers, ['toolCalls']);
});
test('resume reuses accepted correctness evidence and charges only the interrupted verifier again', async () => {
  const f = fixture(); const original = f.options.spawn;
  await assert.rejects(runReviewUntilGreen({ ...f.options, sessionHandoff: 'off', spawn: input => {
    if (input.role === 'verify') { f.workers.push('verify-failed'); throw new Error('verifier interrupted'); }
    return original(input);
  } }), /verifier interrupted/);
  const result = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, sessionHandoff: 'off' });
  assert.equal(result.decision.converged, true);
  assert.deepEqual(f.workers, ['correctness', 'verify-failed', 'verify', 'plan']);
  assert.equal(f.ledger().launches.length, 4); assert.equal(f.ledger().rounds.length, 1);
});
test('fresh contexts each suggest once while resuming the same durable review budget', async () => {
  const f = fixture(), first = [], second = [];
  const worker = fixingWorker(f);
  await assert.rejects(runReviewUntilGreen({ ...f.options, getInputContextTokens: () => 128000, onSessionHandoff: h => first.push(h), spawn: input => {
    if (input.role === 'verify' && input.prompt.includes('round-2-verify.json')) { f.workers.push('verify-failed'); throw new Error('replace context after round-one suggestion'); }
    return worker(input);
  } }), /replace context/);
  const before = f.ledger(); assert.equal(first.length, 1);
  assert.equal(before.launches.length, 7); assert.equal(before.rounds.length, 2);
  const result = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, getInputContextTokens: () => 128000, onSessionHandoff: h => second.push(h), spawn: worker });
  assert.equal(second.length, 1); assert.equal(result.sessionHandoff.promptPath, second[0].promptPath);
  assert.equal(f.ledger().launches.length, 9); assert.equal(f.ledger().rounds.length, 2);
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
      assert.deepEqual(f.workers, ['correctness', 'verify', 'plan']);
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

test('a budget-exhausted block names the carry command, and after a CLI carry the runner resumes under the new key without relaunching correctness (AC7)', async () => {
  const f = fixture({ maxLaunches: 1 });
  const blocked = await runReviewUntilGreen(f.options);
  assert.equal(blocked.decision, 'blocked');
  assert.equal(blocked.reason, 'budget-exhausted');
  assert.deepEqual(f.workers, ['correctness']);
  // Safe to paste into any shell from any directory: quoted values, a `cd` into
  // the repo this run used, and REVIEW_REPO_ROOT restated so a bare `node`
  // invocation from elsewhere resolves the same repo and state dir the blocked
  // run did. Carries the old run's own mode (base here) explicitly.
  assert.match(blocked.carryCommand, /^cd '.*' && REVIEW_REPO_ROOT='.*'(?: REVIEW_STATE_DIR='.*')? node '.*' carry 'feature\/test' --from-run-key 'integration' --initiative-run-key <new-run-key> --initiative-id 'integration' --initiative-state-dir '.*' --initiative-max-launches \d+ --initiative-max-rounds \d+ --initiative-mode base$/);
  assert.equal(f.ledger().launches.length, 1);

  const carried = spawnSync('node', [cliPath, 'carry', f.options.ref, '--from-run-key', 'integration',
    '--initiative-run-key', 'integration-2', '--initiative-state-dir', f.options.initiativeStateDir,
    '--initiative-max-launches', '10', '--initiative-max-rounds', '10'],
    { cwd: f.options.repoRoot, encoding: 'utf8', env: { ...process.env, REVIEW_REPO_ROOT: f.options.repoRoot, REVIEW_STATE_DIR: f.stateDir } });
  assert.equal(carried.status, 0, carried.stderr);
  assert.equal(JSON.parse(carried.stdout).status, 'carried');

  const carriedOptions = { ...f.options, initiativeRunKey: 'integration-2', initiativeMaxLaunches: 10, initiativeMaxRounds: 10, base: undefined, resume: true, sessionHandoff: 'off' };
  const resumed = await runReviewUntilGreen(carriedOptions);
  assert.equal(resumed.decision.converged, true);
  // Correctness was not relaunched: round-start under the new key reused the
  // hash-verified artifact; only verify and the sealed-verdict planner launch.
  assert.deepEqual(f.workers, ['correctness', 'verify', 'plan']);
  assert.equal(f.ledger().launches.length, 1, "A's launches changed");
  const newLedger = JSON.parse(fs.readFileSync(runPath(f.options.initiativeStateDir, 'integration-2')));
  assert.equal(newLedger.launches.length, 2, 'B must be charged exactly for its verify and plan launches');

  // An old-key invocation now returns terminal with nextAction: carried.
  const oldKeyRetry = await runReviewUntilGreen({ ...f.options, base: undefined, resume: true, sessionHandoff: 'off' });
  assert.equal(oldKeyRetry.decision, 'terminal');
  assert.equal(oldKeyRetry.continuationPacket.nextAction, 'carried');
  assert.equal(oldKeyRetry.continuationPacket.carriedTo.key, 'integration-2');
  assert.equal(f.ledger().launches.length, 1, 'retrying under the old key charged it again');
});

test('a lite run\'s budget-exhausted block names --initiative-mode lite, and pasting the carry command (with a new key) carries successfully (P2-1)', async () => {
  const f = fixture({ maxLaunches: 1, mode: 'lite' });
  // The printed command restates REVIEW_STATE_DIR only when the runner's own
  // process has one -- set it here so the pasted command resolves the SAME
  // target-ledger directory this fixture's runCli uses, then restore it.
  const previousStateDir = process.env.REVIEW_STATE_DIR;
  process.env.REVIEW_STATE_DIR = f.stateDir;
  try {
    const blocked = await runReviewUntilGreen(f.options);
    assert.equal(blocked.decision, 'blocked');
    assert.equal(blocked.reason, 'budget-exhausted');
    assert.match(blocked.carryCommand, /--initiative-mode lite$/);
    assert.equal(f.ledger().mode, 'lite');

    // Paste the printed command verbatim (substituting the new key) into a
    // shell: without --initiative-mode lite carried through, openKeyedRun
    // would default the new ledger to 'base' before carry's own mode check
    // ever ran, permanently binding the new key to the wrong mode.
    const command = blocked.carryCommand.replace('<new-run-key>', 'integration-2');
    const pasted = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(JSON.parse(pasted).status, 'carried');
    const newLedger = JSON.parse(fs.readFileSync(runPath(f.options.initiativeStateDir, 'integration-2')));
    assert.equal(newLedger.mode, 'lite');
  } finally {
    if (previousStateDir === undefined) delete process.env.REVIEW_STATE_DIR; else process.env.REVIEW_STATE_DIR = previousStateDir;
  }
});

test('native launcher keeps exit 0 for a clean review with a failed stop checkpoint', () => {
  const dir = tmp(), preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(request){if(request==='../engine/codex-review-runner')return{runReviewUntilGreen:async()=>({decision:{continue:false,converged:true},sessionHandoff:{action:'failed',mode:'stop-at-checkpoint',error:'checkpoint failed'}})};return load.apply(this,arguments);};`);
  const out = spawnSync('node', ['--require', preload, path.resolve(__dirname, '../../../concord-codex/bin/review-until-green.js'), 'branch'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /converged/);
  assert.match(out.stdout, /checkpoint failed/);
});
