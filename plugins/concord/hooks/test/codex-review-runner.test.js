'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeArtifact } = require('../../core/artifact-contract');

// The runner owns all sequencing. Its subprocess seam makes this a no-network
// integration test while exercising the real artifact contract at the boundary.
const { runReviewUntilGreen, reviewerPrompt, codexExec, resolveDefaultBase } = require('../../core/codex-review-runner');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-')); }

test('codexExec starts subprocesses asynchronously so panel work can overlap', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 1000);\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const started = Date.now();
    const first = codexExec({ role: 'panel', prompt: 'first', repoRoot: binDir, stateDir: binDir });
    const second = codexExec({ role: 'panel', prompt: 'second', repoRoot: binDir, stateDir: binDir });
    assert.strictEqual(typeof first?.then, 'function');
    await Promise.all([first, second]);
    // The full suite runs files concurrently, so leave scheduler headroom while
    // keeping this comfortably below the 2s serial execution time.
    assert.ok(Date.now() - started < 1800, 'subprocesses should overlap rather than run serially');
  } finally {
    process.env.PATH = previousPath;
  }
});

function harness({ targetType = 'git', rounds = 1, malformed = false, retry = false, retryForever = false, correctnessArtifact, gateApplied = false, failingRole, promptDrivenFix = false } = {}) {
  const stateDir = temp();
  const calls = []; let round = 0; let retried = false;
  const cli = (args) => {
    calls.push(['cli', ...args]);
    const [verb, ref, role] = args;
    if (verb === 'round-start') {
      round++;
      return { decision: 'work', round, stateDir, targetType, dodPassed: true, intentApplied: false, gateApplied };
    }
    if (verb === 'artifact-normalize') {
      if (correctnessArtifact && role === 'correctness') {
        const artifact = path.join(stateDir, `round-${round}-correctness.json`);
        try {
          const canonical = normalizeArtifact(role, fs.readFileSync(artifact, 'utf8'));
          fs.writeFileSync(artifact, JSON.stringify(canonical) + '\n');
          return { status: 'ok' };
        } catch (error) { throw new Error(`harness-failure: ${error.message}`); }
      }
      if (malformed && role === 'correctness') throw new Error('harness-failure: correctness artifact is not JSON');
      if (retry && role === 'correctness' && (!retried || retryForever)) { retried = true; return { status: 'retry', prompt: 'REWRITE ARTIFACT' }; }
      return { status: 'ok' };
    }
    if (verb === 'plan-fixes') return { fixes: round === 1 ? [{ id: 'correctness:bug', file: 'a.txt', span: 'bad', summary: 'fix it' }] : [] };
    if (verb === 'commit-fix') {
      if (promptDrivenFix && !fs.existsSync(path.join(stateDir, `round-${round}-fix-${role}.json`))) throw new Error('commit-fix did not receive its declared artifact');
      return { committed: true, sha: 'abc' };
    }
    if (verb === 'record') return round < rounds ? { decision: { continue: true }, handoff: 'continue' } : { decision: { continue: false, converged: true }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb} ${ref}`);
  };
  const spawn = ({ role, prompt }) => {
    calls.push(['spawn', role, prompt]);
    if (role === failingRole) return { status: 1 };
    const n = round;
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, `round-${n}-correctness.json`), correctnessArtifact || JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, `round-${n}-verify.json`), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'gate') fs.writeFileSync(path.join(stateDir, `round-${n}-gate.json`), JSON.stringify({ status: 'ok', findings: [] }));
    if (role === 'fix') {
      const target = promptDrivenFix ? prompt.match(/write ONLY to (.+\.json): either/)?.[1] : path.join(stateDir, `round-${n}-fix-correctness:bug.json`);
      if (!target) throw new Error('fix prompt did not name an artifact path');
      fs.writeFileSync(target, JSON.stringify({ status: 'ok', edited: true, files: ['a.txt'] }));
    }
    return { status: 0 };
  };
  return { stateDir, calls, cli, spawn };
}

test('runner automatically executes a clean round in correctness then verify order and returns terminal handoff', async () => {
  const h = harness();
  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(out.handoff, 'LGTM');
  assert.deepStrictEqual(h.calls.map((c) => c[0] === 'spawn' ? c.slice(0, 2) : c.slice(0, 2)), [
    ['cli', 'round-start'], ['spawn', 'correctness'], ['cli', 'artifact-normalize'], ['spawn', 'verify'], ['cli', 'artifact-normalize'], ['cli', 'plan-fixes'], ['spawn', 'fix'], ['cli', 'commit-fix'], ['cli', 'record'],
  ]);
});

test('fix prompt writes the commit-fix artifact and requires a truthful files declaration', () => {
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, finding: { id: 'correctness:bug', file: 'src/parser.js', span: 'lines 41-43', summary: 'repair it' } });
  assert.match(prompt, /\/state\/round-7-fix-correctness:bug\.json/);
  assert.match(prompt, /src\/parser\.js/);
  assert.match(prompt, /lines 41-43/);
  assert.match(prompt, /EVERY file/i);
  assert.match(prompt, /"edited":false/);
});

test('correctness prompt requires every changed file in examined', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'git', dodPassed: true });
  assert.match(prompt, /every changed file.*examined/i);
});

test('file-target correctness prompt requires every reviewed target in examined and docreview JSON IDs', () => {
  const prompt = reviewerPrompt('correctness', { stateDir: '/state', round: 7, targetType: 'file', dodPassed: true });
  assert.match(prompt, /EVERY reviewed target.*examined/i);
  assert.match(prompt, /docreview:<stable-slug>/);
  assert.match(prompt, /"examined"/);
  assert.match(prompt, /"findings"/);
});

test('fix prompt forbids declaring state artifacts or paths outside the repository', () => {
  const prompt = reviewerPrompt('fix', { stateDir: '/state', round: 7, finding: { id: 'correctness:bug', file: 'src/parser.js', span: 'lines 41-43', summary: 'repair it' } });
  assert.match(prompt, /repository-relative/i);
  assert.match(prompt, /must not include.*artifact/i);
  assert.match(prompt, /outside.*repository/i);
});

test('fresh runner resolves a remote default base once, while resume preserves the ledger base by omitting it', async () => {
  const fresh = harness();
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: fresh.cli, spawn: fresh.spawn, resolveDefaultBase: () => 'upstream/main' });
  assert.deepStrictEqual(fresh.calls[0], ['cli', 'round-start', 'feature/x', 'upstream/main']);

  const resumed = harness();
  await runReviewUntilGreen({ ref: 'feature/x', base: 'must-not-override-ledger-base', resume: true, repoRoot: '/repo', runCli: resumed.cli, spawn: resumed.spawn, resolveDefaultBase: () => { throw new Error('must not resolve resume base'); } });
  assert.deepStrictEqual(resumed.calls[0], ['cli', 'round-start', 'feature/x']);
});

test('default base resolution uses an available remote HEAD without assuming origin', () => {
  const calls = [];
  const base = resolveDefaultBase('/repo', (bin, args) => {
    calls.push([bin, ...args]);
    return 'refs/remotes/upstream/main\nrefs/remotes/origin/HEAD\n';
  });
  assert.strictEqual(base, 'upstream/main');
  assert.deepStrictEqual(calls, [['git', 'for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD']]);
});

test('default base resolution fails clearly when no remote default is advertised', () => {
  assert.throws(
    () => resolveDefaultBase('/repo', () => ''),
    /cannot determine a remote default base; pass an explicit base/,
  );
});

test('fix subprocess writes the prompt-declared artifact consumed by commit-fix', async () => {
  const h = harness({ promptDrivenFix: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.ok(h.calls.some((call) => call[0] === 'cli' && call[1] === 'commit-fix'));
});

test('gate-verify subprocess failure stays lenient and lets the CLI decide', async () => {
  const h = harness({ gateApplied: true, failingRole: 'gate-verify' });
  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(out.handoff, 'LGTM');
  assert.ok(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'gate-verify'));
});

test('intent and gate review chains fan out alongside the correctness-to-verify chain', async () => {
  const stateDir = temp();
  const pending = new Map();
  const calls = [];
  const cli = (args) => {
    const [verb, , role] = args;
    if (verb === 'round-start') return { decision: 'work', round: 1, stateDir, targetType: 'git', dodPassed: true, intentApplied: true, gateApplied: true };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'plan-fixes') return { fixes: [] };
    if (verb === 'record') return { decision: { continue: false }, handoff: 'LGTM' };
    throw new Error(`unexpected CLI ${verb} ${role}`);
  };
  const spawn = ({ role }) => {
    calls.push(role);
    return new Promise((resolve) => pending.set(role, resolve));
  };
  const complete = (role) => {
    const artifact = path.join(stateDir, `round-1-${role}.json`);
    if (role === 'correctness') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'intent' || role === 'gate') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', findings: [] }));
    if (role === 'gate-verify') fs.writeFileSync(artifact, JSON.stringify({ status: 'ok', rejected: [], findings: [] }));
    pending.get(role)({ status: 0 });
  };

  const running = runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  await new Promise(setImmediate);
  assert.deepStrictEqual(calls, ['correctness', 'intent', 'gate']);
  complete('correctness');
  complete('intent');
  complete('gate');
  await new Promise(setImmediate);
  assert.deepStrictEqual(calls, ['correctness', 'intent', 'gate', 'verify', 'gate-verify']);
  complete('verify');
  complete('gate-verify');
  await running;
});

test('intent and gate prompts preserve their full role contracts', () => {
  const base = { stateDir: '/state', round: 2, slug: 'feature-x' };
  const intent = reviewerPrompt('intent', base);
  const gate = reviewerPrompt('gate', base);
  const verify = reviewerPrompt('gate-verify', base);
  assert.match(intent, /exact changed line/i);
  assert.match(intent, /verbatim requirement/i);
  assert.match(intent, /intent:/);
  assert.match(gate, /cross-context.*silent-gap.*ac-coverage.*design-conformance/i);
  assert.match(gate, /Read\/Grep.*repository/i);
  assert.match(gate, /intent-feature-x\.md/);
  assert.match(gate, /requirement/);
  assert.match(verify, /Reject false positives/i);
  assert.match(verify, /new.*gate:/i);
  assert.match(verify, /rejected/);
});

test('panel lens prompts identify the reviewed diff and require the intent source', async () => {
  const stateDir = temp();
  const prompts = [];
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'plan-fixes') return { fixes: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role, prompt }) => {
    prompts.push({ role, prompt });
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings: [] }));
    }
    return { status: 0 };
  };

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });

  const lensPrompts = prompts.filter(({ role }) => role.startsWith('gate-panel-') && role !== 'gate-panel-verify');
  assert.strictEqual(lensPrompts.length, 5);
  for (const { prompt } of lensPrompts) {
    assert.match(prompt, /round-4-diff\.txt/);
    assert.match(prompt, /MUST read.*intent-feature-x\.md/i);
  }
});

test('a failed panel lens is treated as zero findings while the remaining lenses continue', async () => {
  const stateDir = temp();
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'plan-fixes') return { fixes: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role === 'gate-panel-ac-coverage') return { status: 1 };
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings: [] }));
    }
    return { status: 0 };
  };

  const out = await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });

  assert.strictEqual(out.handoff, 'LGTM');
});

test('panel lenses and each finding\'s adversarial votes fan out concurrently', async () => {
  const stateDir = temp();
  const pendingLenses = [];
  const pendingVotes = [];
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'plan-fixes') return { fixes: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      return new Promise((resolve) => pendingLenses.push({ role, resolve }));
    }
    if (role === 'gate-panel-verify') return new Promise((resolve) => pendingVotes.push(resolve));
    return { status: 0 };
  };

  const running = runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  await new Promise(setImmediate);
  assert.strictEqual(pendingLenses.length, 5);
  for (const { role, resolve } of pendingLenses) {
    const lens = role.slice('gate-panel-'.length);
    const findings = lens === 'ac-coverage' ? [{ id: 'gate:ac-coverage:gap' }] : [];
    fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    resolve({ status: 0 });
  }
  await new Promise(setImmediate);
  assert.strictEqual(pendingVotes.length, 3);
  for (const resolve of pendingVotes) {
    fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-vote-gate:ac-coverage:gap-${pendingVotes.indexOf(resolve)}.json`), JSON.stringify({ status: 'ok', survives: false }));
    resolve({ status: 0 });
  }
  await running;
});

test('panel candidates with unsafe IDs never reach an interpolated verdict path', async () => {
  const stateDir = temp();
  const escaped = path.join(path.dirname(stateDir), 'escaped.json');
  let recorded = 0;
  const cli = (args) => {
    const [verb] = args;
    if (verb === 'round-start') return { decision: 'work', round: 4, stateDir, targetType: 'git', dodPassed: true, intentApplied: false, gateApplied: false };
    if (verb === 'artifact-normalize') return { status: 'ok' };
    if (verb === 'plan-fixes') return { fixes: [] };
    if (verb === 'record') return recorded++ === 0 ? { decision: { panelPending: true } } : { decision: { continue: false }, handoff: 'LGTM' };
    if (verb === 'gate-panel-round-start') return { round: 1, rejectedIds: [] };
    if (verb === 'gate-panel-round-record') return { status: 'done' };
    throw new Error(`unexpected CLI ${verb}`);
  };
  const spawn = ({ role }) => {
    if (role === 'correctness') fs.writeFileSync(path.join(stateDir, 'round-4-correctness.json'), JSON.stringify({ status: 'ok', examined: [], findings: [] }));
    if (role === 'verify') fs.writeFileSync(path.join(stateDir, 'round-4-verify.json'), JSON.stringify({ status: 'ok', rejected: [] }));
    if (role.startsWith('gate-panel-') && role !== 'gate-panel-verify') {
      const lens = role.slice('gate-panel-'.length);
      const findings = lens === 'ac-coverage' ? [{ id: '../../escaped', file: 'a.txt', summary: 'unsafe' }] : [];
      fs.writeFileSync(path.join(stateDir, `round-4-gate-panel-1-${lens}.json`), JSON.stringify({ status: 'ok', findings }));
    }
    if (role === 'gate-panel-verify') throw new Error('unsafe candidate must not be verified');
    return { status: 0 };
  };

  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: cli, spawn });
  assert.strictEqual(fs.existsSync(escaped), false);
});

test('runner canonicalizes a findings artifact without changing its finding and continues to verify', async () => {
  const finding = { id: 'correctness:kept', file: 'a.txt', summary: 'keep this exact finding', span: 'bad' };
  const h = harness({ correctnessArtifact: JSON.stringify({ status: 'findings', examined: ['a.txt'], findings: [finding], ignored: true }) });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const artifact = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'round-1-correctness.json'), 'utf8'));
  assert.deepStrictEqual(artifact, { status: 'ok', examined: ['a.txt'], findings: [finding] });
  assert.ok(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'verify'));
});

for (const [label, raw] of [
  ['malformed JSON', '{not json'],
  ['semantically missing finding summary', JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [{ id: 'correctness:missing', file: 'a.txt' }] })],
]) {
  test(`runner fail-closes ${label} before verify at the artifact contract boundary`, async () => {
    const h = harness({ correctnessArtifact: raw });
    await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /harness-failure/);
    assert.strictEqual(h.calls.some((call) => call[0] === 'spawn' && call[1] === 'verify'), false);
  });
}

test('real review-cli keeps the correctness-to-verify mtime guard active', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mtime-repo-'));
  const stateDir = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'runner@test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'runner'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ dod: ['true'] }));
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '-am', 'change'], { cwd: repo });
  const cli = path.join(__dirname, '..', 'review-cli.js');
  const env = { ...process.env, REVIEW_REPO_ROOT: repo, REVIEW_STATE_DIR: stateDir };
  const started = JSON.parse(execFileSync('node', [cli, 'round-start', 'feature/x', 'HEAD~1'], { cwd: repo, env, encoding: 'utf8' }));
  const correctness = path.join(stateDir, `round-${started.round}-correctness.json`);
  const verify = path.join(stateDir, `round-${started.round}-verify.json`);
  fs.writeFileSync(correctness, JSON.stringify({ status: 'ok', examined: ['a.txt'], findings: [] }) + '\n');
  fs.writeFileSync(verify, JSON.stringify({ status: 'ok', rejected: [] }) + '\n');
  const now = Date.now() / 1000;
  fs.utimesSync(correctness, now, now);
  fs.utimesSync(verify, now - 5, now - 5);
  assert.throws(() => execFileSync('node', [cli, 'plan-fixes', 'feature/x'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }), /predates round/);
});

test('runner appends retry prompt and retries precisely once', async () => {
  const h = harness({ retry: true });
  await runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  const correctness = h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'correctness');
  assert.strictEqual(correctness.length, 2);
  assert.match(correctness[1][2], /REWRITE ARTIFACT/);
});

test('runner fail-closes a malformed reviewer artifact before verify', async () => {
  const h = harness({ malformed: true });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /harness-failure/);
  assert.strictEqual(h.calls.some((c) => c[0] === 'spawn' && c[1] === 'verify'), false);
});

test('runner fails closed when the retry artifact is still invalid', async () => {
  const h = harness({ retry: true, retryForever: true });
  await assert.rejects(runReviewUntilGreen({ ref: 'feature/x', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn }), /retry exhausted/);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'spawn' && c[1] === 'correctness').length, 2);
});

test('runner loops through record continuation and file targets never commit', async () => {
  const h = harness({ rounds: 2, targetType: 'file' });
  await runReviewUntilGreen({ ref: 'file:note.md', repoRoot: '/repo', runCli: h.cli, spawn: h.spawn });
  assert.strictEqual(h.calls.filter((c) => c[1] === 'round-start').length, 2);
  assert.strictEqual(h.calls.some((c) => c[1] === 'commit-fix'), false);
});

test('Codex launcher recognizes documented broad-review phrases without consuming them as target arguments', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') {
        return { runReviewUntilGreen: async (options) => {
          fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
          return { handoff: 'ok' };
        } };
      }
      return load.apply(this, arguments);
    };
  `);
  for (const args of [['feature/x', 'broad', 'review'], ['feature/x', '게이트']]) {
    fs.rmSync(capture, { force: true });
    execFileSync('node', ['--require', preload, bin, ...args], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
    const options = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.strictEqual(options.ref, 'feature/x');
    assert.strictEqual(options.base, undefined);
    assert.strictEqual(options.broad, true);
  }
});

test('Codex launcher marks resume so the runner preserves the ledger base', () => {
  const dir = temp();
  const capture = path.join(dir, 'options.json');
  const preload = path.join(dir, 'capture-runner.js');
  const bin = path.join(__dirname, '..', '..', '..', 'concord-codex', 'bin', 'review-until-green.js');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../engine/codex-review-runner') return { runReviewUntilGreen: async (options) => {
        fs.writeFileSync(process.env.CAPTURE, JSON.stringify(options));
        return { handoff: 'ok' };
      } };
      return load.apply(this, arguments);
    };
  `);
  execFileSync('node', ['--require', preload, bin, 'resume', 'feature/x'], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  const options = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.strictEqual(options.resume, true);
  assert.strictEqual(options.base, undefined);
});
