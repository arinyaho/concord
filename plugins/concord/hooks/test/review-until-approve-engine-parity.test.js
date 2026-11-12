'use strict';
// The runner review-until-approve owns against the review engine, on the same inputs: same Codex confinement, same launch,
// same prompts apart from the clause that names the review CLI, same result object.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const SKILL = path.join(__dirname, '../../skills/review-until-approve/scripts/runner');
const CLI = path.join(__dirname, '..', 'review-cli.js');
const engine = require('../../core/codex-review-runner');
const enginePlan = require('../../core/round-plan');
const engineAnchors = require('../../core/review-anchors');
const { artifactDestinationFromPrompt } = require('../../core/review-artifact');
const own = require(path.join(SKILL, 'review'));
const ownLaunch = require(path.join(SKILL, 'launch'));
const ownPlan = require(path.join(SKILL, 'round-plan'));
const ownAnchors = require(path.join(SKILL, 'review-anchors'));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

// A checkout as approve.js makes it: a base commit and a head commit on branch concord-pr-5.
// The head edits src/a.js, adds src/new.js, renames src/old.js to src/moved.js and deletes src/gone.js; src/same.js is untouched.
function checkout() {
  const repo = fs.realpathSync(tempDir('rua-parity-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const one = 1;\nconst two = 2;\nmodule.exports = { one, two };\n');
  fs.writeFileSync(path.join(repo, 'src/same.js'), 'exports.same = () => "same";\n');
  fs.writeFileSync(path.join(repo, 'src/old.js'), 'exports.old = () => "a rather long body so the rename is detected as one";\n');
  fs.writeFileSync(path.join(repo, 'src/gone.js'), 'exports.gone = 1;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'concord-pr-5');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const one = 1;\nconst two = 3;\nconst twice = two * 2;\nconst again = two * 2;\nmodule.exports = { one, two, twice, again };\n');
  fs.writeFileSync(path.join(repo, 'src/new.js'), 'exports.fresh = (value) => value.trim();\n');
  git(repo, 'mv', 'src/old.js', 'src/moved.js');
  git(repo, 'rm', '-q', 'src/gone.js');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'head');
  return { repo, base };
}
const CHANGED = ['src/a.js', 'src/gone.js', 'src/moved.js', 'src/new.js', 'src/old.js'];

// Answers each launch with the scripted artifact for its role (an array is one answer per launch of that role), and records what it was asked.
function scripted(script, { before } = {}) {
  const calls = [];
  const counts = {};
  const spawn = async (input) => {
    calls.push({ role: input.role, prompt: input.prompt, stateDir: input.stateDir, provider: input.provider, untrustedCheckout: input.untrustedCheckout, model: input.requestedModel, effort: input.reasoningEffort });
    const n = counts[input.role] = (counts[input.role] || 0) + 1;
    const scriptedFor = script[input.role];
    const answer = Array.isArray(scriptedFor) ? scriptedFor[Math.min(n, scriptedFor.length) - 1] : scriptedFor;
    if (before) before(input);
    const artifact = input.role === 'anchors' ? input.prompt.match(/Write ONLY JSON to (\S+)\.$/)[1].replace(/\.$/, '') : artifactDestinationFromPrompt(input.prompt, input.stateDir);
    if (answer !== undefined && answer !== null) fs.writeFileSync(artifact, typeof answer === 'string' ? answer : JSON.stringify(answer));
    return { status: 0 };
  };
  return { spawn, calls };
}

// Temporary paths differ between two runs; the review CLI clause is the one intended difference of a prompt.
function comparable(calls) {
  return calls.map((c) => ({ ...c, stateDir: '<state>', prompt: c.prompt.split(c.stateDir).join('<state>').replace(enginePlan.cliClause(CLI), '') }));
}
async function outcome(run) {
  try { return { result: await run() }; } catch (error) { return { error: String(error.message) }; }
}
async function both(script, options = {}, hooks = {}) {
  const runs = {};
  for (const [name, run] of [['engine', (o) => engine.runReviewUntilGreen({ ...o, reviewOnly: true, repairFindingAnchors: true, cliPath: CLI })], ['own', (o) => own.runReview(o)]]) {
    const { repo, base } = checkout();
    const fake = scripted(typeof script === 'function' ? script(repo) : script, hooks);
    const intentFile = options.intent ? path.join(tempDir('rua-parity-intent-'), 'intent.md') : undefined;
    if (intentFile) fs.writeFileSync(intentFile, options.intent);
    const { intent, ...rest } = options;
    const out = await outcome(() => run({ ref: 'concord-pr-5', base, reviewer: 'claude', broad: false, noBroad: true, ...rest, ...(intentFile && { intentFile }), repoRoot: repo, spawn: fake.spawn }));
    runs[name] = { ...out, calls: comparable(fake.calls), repo };
  }
  return runs;
}
// Both sides asked the same roles the same prompts, and returned the same result or both failed.
function assertSame(runs) {
  assert.deepEqual(runs.own.calls.map((c) => c.role), runs.engine.calls.map((c) => c.role));
  assert.deepEqual(runs.own.calls, runs.engine.calls);
  assert.deepEqual(runs.own.result, runs.engine.result);
  assert.equal(!!runs.own.error, !!runs.engine.error, `engine: ${runs.engine.error}; own: ${runs.own.error}`);
  return runs.own;
}

const clean = { correctness: { status: 'ok', examined: CHANGED, findings: [] }, verify: { status: 'ok', rejected: [], findings: [] }, intent: { status: 'ok', findings: [] }, gate: { status: 'ok', findings: [] }, 'gate-verify': { status: 'ok', rejected: [], findings: [] } };
const finding = (id, file, span, extra = {}) => ({ id, file, span, summary: `summary of ${id}`, ...extra });

test('the Codex configuration text is identical for the same inputs', () => {
  const home = fs.realpathSync(tempDir('rua-parity-home-'));
  for (const name of ['.ssh', '.config', '.codex', 'work']) fs.mkdirSync(path.join(home, name));
  fs.writeFileSync(path.join(home, '.ssh', 'id'), 'key');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  fs.symlinkSync(fs.realpathSync(tempDir('rua-parity-linked-')), path.join(home, 'linked'));
  const checkoutDir = path.join(home, 'work', 'checkout');
  fs.mkdirSync(checkoutDir);
  const reviewHome = path.join(home, '.concord-review-codex-home-fixture');
  fs.mkdirSync(reviewHome);
  fs.writeFileSync(path.join(reviewHome, 'auth.json'), '{}');
  const stateDir = fs.realpathSync(tempDir('rua-parity-state-'));
  const outside = fs.realpathSync(tempDir('rua-parity-claude-'));
  const args = { home: reviewHome, sourceAuth: path.join(home, '.codex', 'auth.json'), checkout: checkoutDir, stateDir, denyRead: [outside], realHome: home };
  const text = ownLaunch.reviewCodexConfig(args);
  assert.equal(text, engine.reviewCodexConfig(args));
  assert.match(text, /\[permissions\.concord-review\.network\]\nenabled = false/);
  assert.ok(text.includes(`${JSON.stringify(path.join(home, '.ssh'))} = "deny"`));
  assert.ok(text.includes(`${JSON.stringify(outside)} = "deny"`));
  // The engine also grants its own snapshot directory for reading; with no review CLI to call, the runner grants nothing in its place.
  const runtime = fs.realpathSync(tempDir('rua-parity-runtime-'));
  const withRuntime = engine.reviewCodexConfig({ ...args, runtimeDir: runtime });
  assert.equal(withRuntime.replace(`${JSON.stringify(runtime)} = "read"\n`, ''), text);
  assert.equal(text.match(/= "read"/g).length, 1);
});

// A stand-in codex that records how it was started, then writes a clean artifact where its prompt says.
function fakeCodex() {
  const dir = fs.realpathSync(tempDir('rua-parity-codex-'));
  const record = path.join(dir, 'launches.jsonl');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.154.0'); process.exit(0); }
const prompt = argv[argv.length - 1];
let config = null;
try { config = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8'); } catch (_) {}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, env: process.env, cwd: process.cwd(), config, homeFiles: config === null ? null : fs.readdirSync(process.env.CODEX_HOME).sort() }) + '\\n');
const m = /ONLY[\\s\\S]*? to (\\S+round-\\d+-[a-z-]+\\.json)/.exec(prompt);
if (m) fs.writeFileSync(m[1].replace(/[.:]$/, ''), JSON.stringify(/correctness/.test(m[1]) ? { status: 'ok', examined: ${JSON.stringify(CHANGED)}, findings: [] } : { status: 'ok', rejected: [], findings: [] }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`, { mode: 0o755 });
  return { bin, launches: () => fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

test('codex exec is started with the same arguments and environment', async () => {
  const codex = fakeCodex();
  const { repo } = checkout();
  const stateDir = fs.realpathSync(tempDir('rua-parity-state-'));
  const env = { ...process.env, CONCORD_CODEX_BIN: codex.bin, CODEX_HOME: '/nonexistent-codex-home', GH_TOKEN: 'ghp_x', OPENAI_API_KEY: 'sk-x', MY_SECRET: 's', SOME_KEY_NAME: 'k', PLAIN: 'kept' };
  const input = { role: 'correctness', prompt: 'review this', repoRoot: repo, stateDir, requestedModel: 'gpt-x', reasoningEffort: 'high', env, untrustedCheckout: true };
  await engine.codexExec({ ...input, cliPath: CLI });
  await ownLaunch.codexExec(input);
  const [a, b] = codex.launches();
  assert.deepEqual(b.argv, a.argv);
  assert.equal(a.env.CONCORD_REVIEW_CLI, CLI);
  delete a.env.CONCORD_REVIEW_CLI;
  assert.deepEqual(b.env, a.env);
  assert.equal(b.cwd, a.cwd);
  for (const flag of ['--strict-config', '--ignore-rules', 'project_doc_max_bytes=0']) assert.ok(b.argv.includes(flag), flag);
  for (const name of ['GH_TOKEN', 'OPENAI_API_KEY', 'MY_SECRET', 'SOME_KEY_NAME']) assert.equal(name in b.env, false, name);
  assert.equal(b.env.PLAIN, 'kept');
});

test('a whole Codex round launches every role the same way, from a CODEX_HOME that holds the same configuration and login copy', async () => {
  const seen = {};
  for (const [name, run] of [['engine', (o) => engine.runReviewUntilGreen({ ...o, reviewOnly: true, repairFindingAnchors: true, cliPath: CLI })], ['own', (o) => own.runReview(o)]]) {
    const codex = fakeCodex();
    const { repo, base } = checkout();
    const home = fs.realpathSync(tempDir('rua-parity-home-'));
    fs.mkdirSync(path.join(home, '.ssh'));
    const account = path.join(home, '.codex');
    fs.mkdirSync(account);
    fs.writeFileSync(path.join(account, 'auth.json'), '{"token":"t"}');
    const realClaude = fs.realpathSync(tempDir('rua-parity-claude-'));
    const saved = { bin: process.env.CONCORD_CODEX_BIN, home: process.env.CODEX_HOME };
    process.env.CONCORD_CODEX_BIN = codex.bin;
    process.env.CODEX_HOME = account;
    let result;
    try { result = await run({ ref: 'concord-pr-5', base, reviewer: 'codex', broad: true, noBroad: false, reviewerModel: 'gpt-x', reasoningEffort: 'low', reviewDenyRead: [realClaude], reviewRealHome: home, repoRoot: repo }); } finally {
      for (const [key, value] of [['CONCORD_CODEX_BIN', saved.bin], ['CODEX_HOME', saved.home]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    const launches = codex.launches();
    const stateDir = launches[0].argv[launches[0].argv.indexOf('--add-dir') + 1];
    const reviewHome = launches[0].env.CODEX_HOME;
    assert.equal(path.dirname(reviewHome), home);
    // Nothing of the review is left in the account's home afterwards.
    assert.deepEqual(fs.readdirSync(home).sort(), ['.codex', '.ssh']);
    assert.equal(fs.existsSync(stateDir), false);
    const neutral = (text) => text.split(stateDir).join('<state>').split(reviewHome).join('<codex-home>').split(repo).join('<repo>').split(home).join('<home>').split(realClaude).join('<claude>').split(codex.bin).join('<codex>').split(path.dirname(codex.bin)).join('<codex-dir>').split(JSON.stringify(enginePlan.cliClause(CLI)).slice(1, -1)).join('');
    seen[name] = { result, launches: launches.map((l) => { const { CONCORD_REVIEW_CLI, ...env } = l.env; return JSON.parse(neutral(JSON.stringify({ argv: l.argv, env, cwd: l.cwd, config: l.config, homeFiles: l.homeFiles }))); }) };
  }
  assert.deepEqual(seen.own.result, seen.engine.result);
  assert.deepEqual(seen.own.launches.map((l) => l.argv), seen.engine.launches.map((l) => l.argv));
  assert.deepEqual(seen.own.launches, seen.engine.launches);
  assert.equal(seen.own.launches.length, 3);
  assert.deepEqual(seen.own.launches[0].homeFiles, ['auth.json', 'config.toml']);
  assert.ok(seen.own.launches[0].config.includes('"<home>/.ssh" = "deny"'));
});

test('a claude -p reviewer is started with the same arguments and environment', async () => {
  const dir = fs.realpathSync(tempDir('rua-parity-claude-bin-'));
  const record = path.join(dir, 'launches.jsonl');
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\\n');\n`, { mode: 0o755 });
  const { repo } = checkout();
  const stateDir = fs.realpathSync(tempDir('rua-parity-state-'));
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  try {
    const input = { provider: 'claude', role: 'verify', prompt: 'verify this', repoRoot: repo, stateDir, requestedModel: 'opus', reasoningEffort: 'high', env: { ...process.env, CLAUDE_CONFIG_DIR: '/nowhere' }, untrustedCheckout: true };
    await engine.providerExec({ ...input, cliPath: CLI });
    await ownLaunch.providerExec(input);
  } finally { process.env.PATH = saved; }
  const [a, b] = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(b.argv, a.argv);
  delete a.env.CONCORD_REVIEW_CLI;
  assert.deepEqual(b.env, a.env);
  assert.equal(b.cwd, a.cwd);
  assert.ok(b.argv.join(' ').includes('--setting-sources user'));
});

test('each role prompt is identical apart from the review CLI clause', () => {
  const prior = [finding('correctness:old-bug', 'src/a.js', 'const two = 3;'), finding('gate:cross-context:old-gap', 'src/same.js', 'same'), finding('intent:old-objection', 'src/a.js', 'x')];
  const addressable = [{ id: 'correctness:old-bug', file: 'src/a.js', class: 'blocker', summary: 'uses a/b', requirement: '', span: 'const two = 3;', authorReply: 'see src/a.js', threadResolved: { resolved: true, by: 'author' } }, { id: 'intent:old-objection', file: '/pr-description', class: 'blocker', summary: 's', requirement: 'r', span: 'the title' }];
  const base = { stateDir: '/tmp/state', round: 1, targetType: 'git', dodDeferred: true, dodPending: false, priorIntentIds: [], slug: 'concord-pr-5', gateMode: 'pair', intentHash: 'abc', reviewerGuidance: null, classify: true };
  const variants = [
    { gateApplied: true, priorFindings: [], addressable: [], description: '', reviewLanguage: null },
    { gateApplied: false, priorFindings: [], addressable: [], description: '', reviewLanguage: null },
    { gateApplied: true, priorFindings: prior, addressable, description: '# the title\n\nthe body with a/path', reviewLanguage: 'ko' },
    { gateApplied: false, priorFindings: prior, addressable, description: '', reviewLanguage: 'zh-TW', examined: ['src/a.js'] },
  ];
  for (const variant of variants) for (const role of ['intent', 'correctness', 'gate', 'verify', 'gate-verify']) {
    const context = { ...base, ...variant };
    const withCli = enginePlan.reviewerPrompt(role, { ...context, cliPath: CLI });
    assert.equal(ownPlan.reviewerPrompt(role, context), withCli.replace(enginePlan.cliClause(CLI), ''), role);
    assert.ok(withCli.endsWith(enginePlan.cliClause(CLI)));
    assert.equal(ownPlan.reviewerPrompt(role, context).includes('review-cli'), false);
  }
});

test('a clean broad round with an intent file runs the same roles and returns the same empty result', async () => {
  const run = assertSame(await both(clean, { broad: true, noBroad: false, intent: '# Title\n\nThe change must do X.\n' }));
  assert.deepEqual(run.calls.map((c) => c.role), ['intent', 'correctness', 'gate', 'gate-verify']);
  assert.deepEqual(run.result, { decision: 'review-only', round: 1, findings: [] });
  assert.ok(run.calls.every((c) => c.provider === 'claude' && c.untrustedCheckout === true));
});

test('a delta round asks correctness and verify only, and the model, effort, language and prior findings reach the prompts the same way', async () => {
  const script = { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:doubled', 'src/a.js', 'const twice = two * 2;')] } };
  const run = assertSame(await both(script, { reviewerModel: 'opus', reasoningEffort: 'high', reviewLanguage: 'ko', priorFindings: [finding('correctness:earlier', 'src/a.js', 'x'), finding('gate:silent-gap:earlier', 'src/a.js', 'y')] }));
  assert.deepEqual(run.calls.map((c) => c.role), ['correctness', 'verify']);
  assert.ok(run.calls.every((c) => c.model === 'opus' && c.effort === 'high'));
  assert.match(run.calls[0].prompt, /correctness:earlier/);
  assert.doesNotMatch(run.calls[0].prompt, /gate:silent-gap:earlier/);
  assert.equal(run.result.findings[0].line, 3);
});

test('correctness findings with verify rejections and additions fold the same, with the same class and line', async () => {
  const run = assertSame(await both({
    correctness: { status: 'ok', examined: CHANGED, findings: [
      finding('correctness:kept-blocker', 'src/a.js', 'const two = 3;', { releaseBlocking: ['serious-bug'], rationale: 'breaks callers' }),
      finding('correctness:kept-minor', 'src/new.js', 'value.trim()', { releaseBlocking: [], rationale: 'the caller always passes a string' }),
      finding('correctness:rejected', 'src/a.js', 'const one = 1;'),
      finding('correctness:twice', 'src/a.js', 'two * 2'),
      finding('correctness:not-in-file', 'src/a.js', 'no such text'),
      finding('correctness:unclassified', 'src/moved.js', 'exports.old', { releaseBlocking: [] }),
    ] },
    verify: { status: 'ok', rejected: [{ id: 'correctness:rejected', reason: 'read the file' }, { id: 'correctness:unknown', reason: 'not a candidate' }], findings: [finding('correctness:added-by-verify', 'src/new.js', 'exports.fresh', { releaseBlocking: [], rationale: 'style only' }), finding('correctness:kept-blocker', 'src/a.js', 'another span')] },
    anchors: { anchors: [] },
  }));
  assert.deepEqual(run.result.findings.map((f) => [f.id, f.class, f.line]), [
    ['correctness:added-by-verify', 'minor', 1], ['correctness:kept-blocker', 'blocker', 2], ['correctness:kept-minor', 'minor', 1],
    ['correctness:twice', 'blocker', null], ['correctness:not-in-file', 'blocker', null], ['correctness:unclassified', 'blocker', 1],
  ]);
});

test('gate and gate-verify fold the same: rejections, additions, the blocking override, and duplicates of correctness findings', async () => {
  const run = assertSame(await both({
    intent: { status: 'ok', findings: [] },
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:survives', 'src/a.js', 'const two = 3;'), finding('correctness:dies', 'src/a.js', 'const one = 1;')] },
    verify: { status: 'ok', rejected: [{ id: 'correctness:dies', reason: 'read it' }], findings: [] },
    gate: { status: 'ok', findings: [
      finding('gate:cross-context:minor-claim', 'src/same.js', 'exports.same', { releaseBlocking: [], rationale: 'unchanged sibling stays correct' }),
      finding('gate:silent-gap:overridden', 'src/same.js', 'same', { releaseBlocking: [], rationale: 'claimed harmless', requirement: 'must not regress' }),
      finding('gate:ac-coverage:rejected', 'src/a.js', 'x'),
      finding('gate:cross-context:dup-of-survivor', 'src/a.js', 'const two = 3;'),
      finding('gate:cross-context:dup-of-dead', 'src/a.js', 'const one = 1;'),
      finding('gate:two-segments', 'src/a.js', 'module.exports'),
    ] },
    'gate-verify': { status: 'ok', rejected: [{ id: 'gate:ac-coverage:rejected', reason: 'read it' }], findings: [finding('gate:threat-model:added', 'src/new.js', 'value.trim()', { releaseBlocking: ['security'], rationale: 'input is untrusted' })],
      blocking: [{ id: 'gate:silent-gap:overridden', reason: 'it does regress' }], duplicates: [{ id: 'gate:cross-context:dup-of-survivor', of: 'correctness:survives' }, { id: 'gate:cross-context:dup-of-dead', of: 'correctness:dies' }] },
    anchors: { anchors: [] },
  }, { broad: true, noBroad: false, intent: 'intent text' }));
  assert.deepEqual(run.result.findings.map((f) => [f.id, f.category, f.class]), [
    ['correctness:survives', 'correctness', 'blocker'],
    ['gate:threat-model:added', 'threat-model', 'blocker'], ['gate:cross-context:minor-claim', 'cross-context', 'minor'], ['gate:silent-gap:overridden', 'silent-gap', 'blocker'],
    ['gate:cross-context:dup-of-dead', 'cross-context', 'blocker'], ['gate:two-segments', 'cross-context', 'blocker'],
  ]);
  assert.equal(run.result.findings.find((f) => f.id === 'gate:silent-gap:overridden').blockingReason, 'it does regress');
});

test('intent findings are kept on changed files and dropped on unchanged ones, the same way', async () => {
  const run = assertSame(await both({ ...clean, intent: { status: 'ok', findings: [finding('intent:on-changed', 'src/a.js', 'const two = 3;', { requirement: 'two must stay 2' }), finding('intent:on-unchanged', 'src/same.js', 'exports.same', { requirement: 'r' })] } }, { broad: true, noBroad: false, intent: 'two must stay 2' }));
  assert.deepEqual(run.result.findings.map((f) => [f.id, f.class, f.requirement]), [['intent:on-changed', 'blocker', 'two must stay 2']]);
  // With an intent finding only, no finder raised a candidate, so verify does not run.
  assert.equal(run.calls.some((c) => c.role === 'verify'), false);
});

test('an addressed verdict in the verify artifact is returned the same way when verify runs', async () => {
  const addressable = [{ id: 'correctness:earlier', file: 'src/a.js', class: 'blocker', summary: 's', requirement: '', span: 'const one = 1;', authorReply: 'handled by again' }];
  const verdict = { id: 'correctness:earlier', evidence: { file: 'src/a.js', span: 'const again = two * 2;', reason: 'the value is recomputed' } };
  const run = assertSame(await both({
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:new', 'src/new.js', 'value.trim()')] },
    verify: { status: 'ok', rejected: [], findings: [], addressed: [verdict] },
  }, { addressable, priorFindings: [finding('correctness:earlier', 'src/a.js', 'const one = 1;')] }));
  assert.deepEqual(run.result.addressed, [verdict]);
  assert.match(run.calls[1].prompt, /^Earlier findings of this pull request whose quoted code is still present/);
});

test('when every finder returns nothing, verify does not run and no addressed verdict is produced, even with answered earlier findings', async () => {
  const addressable = [{ id: 'correctness:earlier', file: 'src/a.js', class: 'blocker', summary: 's', requirement: '', span: 'const one = 1;', authorReply: 'handled by again' }];
  const verdict = { id: 'correctness:earlier', evidence: { file: 'src/a.js', span: 'const again = two * 2;', reason: 'the value is recomputed' } };
  const script = { ...clean, verify: { status: 'ok', rejected: [], findings: [], addressed: [verdict] } };
  for (const options of [{}, { broad: true, noBroad: false, intent: 'intent text' }]) {
    const run = assertSame(await both(script, { ...options, addressable, priorFindings: [finding('correctness:earlier', 'src/a.js', 'const one = 1;')] }));
    assert.equal(run.calls.some((c) => c.role === 'verify'), false);
    assert.deepEqual(run.result, { decision: 'review-only', round: 1, findings: [] });
  }
});

test('ids of another role in an artifact are handled the same: stripped by the one repair, or failing the round', async () => {
  // A verdict on a gate id in the verify artifact is another role's disposition: the repair drops it and keeps the rest.
  const stripped = assertSame(await both({
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;'), finding('correctness:other', 'src/a.js', 'const one = 1;')] },
    gate: { status: 'ok', findings: [finding('gate:silent-gap:real', 'src/same.js', 'exports.same'), finding('gate:silent-gap:other', 'src/same.js', 'same')] },
    verify: { status: 'ok', rejected: [{ id: 'correctness:other', reason: 'read it' }, { id: 'gate:silent-gap:real', reason: 'not mine' }], findings: [] },
    'gate-verify': { status: 'ok', rejected: [{ id: 'gate:silent-gap:other', reason: 'read it' }, { id: 'correctness:real', reason: 'not mine' }], findings: [] },
  }, { broad: true, noBroad: false }));
  assert.deepEqual(stripped.result.findings.map((f) => f.id), ['correctness:real', 'gate:silent-gap:real']);
  // A verdict on another role's ids only leaves nothing of the role's own to keep, so it is not repaired.
  assert.ok(assertSame(await both({
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;')] },
    verify: { status: 'ok', rejected: [{ id: 'gate:silent-gap:real', reason: 'not mine' }], findings: [] },
  })).error);
  for (const script of [
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('gate:silent-gap:wrong-place', 'src/a.js', 'x')] } },
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('intent:wrong-place', 'src/a.js', 'x')] } },
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:a', 'src/a.js', 'x')] }, verify: { status: 'ok', rejected: [], findings: [finding('intent:from-verify', 'src/a.js', 'x')] } },
    { ...clean, gate: { status: 'ok', findings: [finding('correctness:in-gate', 'src/a.js', 'x')] } },
    { ...clean, intent: { status: 'ok', findings: [finding('gate:silent-gap:in-intent', 'src/a.js', 'x')] } },
    { ...clean, gate: { status: 'ok', findings: [finding('gate:silent-gap:g', 'src/a.js', 'x')] }, 'gate-verify': { status: 'ok', rejected: [], findings: [], blocking: [{ id: 'gate:silent-gap:unknown', reason: 'r' }] } },
  ]) {
    const run = assertSame(await both(script, { broad: true, noBroad: false, intent: 'intent text' }));
    assert.ok(run.error, JSON.stringify(run.result));
  }
});

test('a correctness artifact that leaves out changed paths gets one re-run with the same prompt; a second miss fails the round', async () => {
  const partial = { status: 'ok', examined: ['src/a.js', 'src/moved.js'], findings: [] };
  const recovered = assertSame(await both({ ...clean, correctness: [partial, clean.correctness] }));
  assert.deepEqual(recovered.calls.map((c) => c.role), ['correctness', 'correctness']);
  assert.match(recovered.calls[1].prompt, /\nThe previous correctness artifact omitted changed path\(s\): src\/gone\.js, src\/new\.js\. Examine them/);
  assert.deepEqual(recovered.result, { decision: 'review-only', round: 1, findings: [] });
  const exhausted = assertSame(await both({ ...clean, correctness: partial }));
  assert.match(exhausted.error, /correctness coverage is incomplete; missing changed file\(s\): src\/gone\.js, src\/new\.js/);
  assert.equal(exhausted.calls.length, 2);
  // The old path of a rename is covered by the new path; a byte copy of an examined file is covered too.
  assertSame(await both({ ...clean, correctness: { status: 'ok', examined: CHANGED.filter((file) => file !== 'src/old.js'), findings: [] } }));
});

test('a representation slip is repaired once without a model, the same way; anything else fails the round', async () => {
  const candidate = finding('correctness:real', 'src/a.js', 'const two = 3;');
  const repaired = [
    { correctness: { status: 'OK', examined: CHANGED, findings: [candidate] }, verify: clean.verify },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: { status: 'Findings', rejected: [], findings: [] } },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: { status: 'ok', rejected: [], findings: [{ id: 'correctness:real' }] } },
    { correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:Bad_Slug', 'src/a.js', 'const two = 3;')] }, verify: clean.verify },
  ];
  for (const script of repaired) {
    const run = assertSame(await both(script));
    assert.equal(run.error, undefined);
    assert.equal(run.result.findings.length, 1);
    assert.deepEqual(run.calls.map((c) => c.role), ['correctness', 'verify']);
  }
  assert.equal(assertSame(await both(repaired[3])).result.findings[0].id, 'correctness:bad-slug');
  const failing = [
    { ...clean, correctness: { status: 'weird', examined: CHANGED, findings: [] } },
    { ...clean, correctness: 'not json' },
    { ...clean, correctness: null },
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [{ id: 'correctness:no-file', summary: 's' }] } },
    { ...clean, correctness: { status: 'ok', examined: CHANGED, findings: [], blocked: ['rg: denied'] } },
    { ...clean, correctness: { status: 'ok', examined: 'src/a.js', findings: [] } },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: null },
    { correctness: { status: 'ok', examined: CHANGED, findings: [candidate] }, verify: { status: 'ok', rejected: [{ id: 'correctness:real' }], findings: [] } },
  ];
  for (const script of failing) {
    const run = assertSame(await both(script));
    assert.ok(run.error, JSON.stringify(script));
    assert.equal(run.result, undefined);
  }
});

test('the anchors step asks for the same findings and applies the same spans', async () => {
  const script = {
    correctness: { status: 'ok', examined: CHANGED, findings: [finding('correctness:paraphrased', 'src/a.js', 'two is doubled twice'), finding('correctness:verbatim', 'src/new.js', 'value.trim()'), finding('correctness:ambiguous-fix', 'src/a.js', 'doubling'), finding('correctness:multiline', 'src/a.js', 'the last two lines')] },
    verify: clean.verify,
    anchors: { anchors: [{ index: 0, span: 'const twice = two * 2;' }, { index: 2, span: 'two * 2' }, { index: 3, span: 'const again = two * 2;\nmodule.exports' }, { index: 9, span: 'const one = 1;' }] },
  };
  const run = assertSame(await both(script));
  assert.deepEqual(run.calls.map((c) => c.role), ['correctness', 'verify', 'anchors']);
  assert.deepEqual(run.result.findings.map((f) => [f.id, f.span, f.line]), [
    ['correctness:paraphrased', 'const twice = two * 2;', 3], ['correctness:verbatim', 'value.trim()', 1], ['correctness:ambiguous-fix', 'doubling', null], ['correctness:multiline', 'const again = two * 2;\nmodule.exports', null],
  ]);
  for (const anchors of ['not json', null, { anchors: 'no' }]) {
    const kept = assertSame(await both({ ...script, anchors }));
    assert.equal(kept.result.findings[0].span, 'two is doubled twice');
  }
  // The two copies of the anchor module agree on what they ask and accept.
  const findings = script.correctness.findings.map((f) => ({ ...f, line: null }));
  const read = (file) => (file === 'src/a.js' ? 'const twice = two * 2;\nconst again = two * 2;\n' : null);
  assert.deepEqual(ownAnchors.prepareAnchors(findings, read).prompt, engineAnchors.prepareAnchors(findings, read).prompt);
});

test('a reviewer that changes the checkout or a sealed input fails the round the same way, and nothing is returned', async () => {
  const candidate = { status: 'ok', examined: CHANGED, findings: [finding('correctness:real', 'src/a.js', 'const two = 3;')] };
  const tamper = [
    (input) => { if (input.role === 'correctness') fs.appendFileSync(path.join(input.repoRoot, 'src/a.js'), '// edited\n'); },
    (input) => { if (input.role === 'verify') fs.writeFileSync(path.join(input.repoRoot, 'untracked.txt'), 'x'); },
    (input) => { if (input.role === 'verify') fs.writeFileSync(path.join(input.stateDir, 'round-1-diff.txt'), 'another diff'); },
    (input) => { if (input.role === 'verify') fs.writeFileSync(path.join(input.stateDir, 'round-1-correctness.json'), JSON.stringify(clean.correctness)); },
    (input) => { if (input.role === 'correctness') git(input.repoRoot, 'checkout', '-q', '--detach', 'HEAD~1'); },
  ];
  for (const before of tamper) {
    const run = assertSame(await both({ correctness: candidate, verify: clean.verify }, {}, { before }));
    assert.match(run.error, /harness-failure/);
    assert.equal(run.result, undefined);
  }
});

test('a role gets one correction: a repaired correctness artifact is not re-run for coverage, and a coverage re-run is not repaired', async () => {
  const partial = ['src/a.js', 'src/moved.js'];
  const candidate = finding('correctness:real', 'src/a.js', 'const two = 3;');
  // Repairable and incomplete at once: the repair is the one correction, so the missing paths fail the round.
  const repairedThenIncomplete = assertSame(await both({ ...clean, correctness: [{ status: 'OK', examined: partial, findings: [] }, clean.correctness] }));
  assert.match(repairedThenIncomplete.error, /correctness coverage is incomplete/);
  assert.deepEqual(repairedThenIncomplete.calls.map((c) => c.role), ['correctness']);
  // Incomplete first, then a re-run that needs a repair: the re-run was the one correction.
  for (const second of [{ status: 'OK', examined: CHANGED, findings: [] }, { status: 'ok', examined: CHANGED, findings: [finding('correctness:Bad_Slug', 'src/a.js', 'const two = 3;')] }]) {
    const rerunThenRepair = assertSame(await both({ ...clean, correctness: [{ status: 'ok', examined: partial, findings: [] }, second] }));
    assert.ok(rerunThenRepair.error);
    assert.deepEqual(rerunThenRepair.calls.map((c) => c.role), ['correctness', 'correctness']);
  }
  // The correction is counted per role: after a coverage re-run of correctness, verify may still take its repair.
  const otherRole = assertSame(await both({ correctness: [{ status: 'ok', examined: partial, findings: [candidate] }, { status: 'ok', examined: CHANGED, findings: [candidate] }], verify: { status: 'Findings', rejected: [], findings: [] } }));
  assert.equal(otherRole.error, undefined);
  assert.deepEqual(otherRole.calls.map((c) => c.role), ['correctness', 'correctness', 'verify']);
  assert.equal(otherRole.result.findings.length, 1);
  // Both correctness and verify may take a repair in one round, and one repair covers several slips of one artifact.
  const several = assertSame(await both({
    correctness: { status: 'OK', examined: CHANGED, findings: [finding('correctness:Bad_Slug', 'src/a.js', 'const two = 3;'), finding('correctness:other', 'src/a.js', 'const one = 1;')] },
    gate: { status: 'ok', findings: [finding('gate:silent-gap:real', 'src/same.js', 'exports.same')] },
    verify: { status: 'CLEAN', rejected: [{ id: 'correctness:other', reason: 'read it' }, { id: 'gate:silent-gap:real', reason: 'not mine' }], findings: [{ id: 'correctness:bad-slug' }] },
    'gate-verify': clean['gate-verify'],
  }, { broad: true, noBroad: false }));
  assert.equal(several.error, undefined, several.error);
  assert.deepEqual(several.result.findings.map((f) => f.id), ['correctness:bad-slug', 'gate:silent-gap:real']);
});

test('a launch that fails is reported with the same sanitized message, never the raw error', async () => {
  const rejected = await both(clean, {}, { before: (input) => { if (input.role === 'correctness') throw new Error('raw text from the provider: sk-secret'); } });
  assertSame(rejected);
  assert.equal(rejected.own.error, rejected.engine.error);
  assert.match(rejected.own.error, /^harness-failure: correctness provider execution failed; /);
  assert.doesNotMatch(rejected.own.error, /sk-secret/);
  // A reviewer process that exits non-zero, times out or is interrupted is classified the same way.
  for (const result of [{ status: 3 }, { status: null, timedOut: true }, { status: null, signal: 'SIGKILL' }, { status: 0, interrupted: 'SIGTERM' }]) {
    const runs = {};
    for (const [name, run] of [['engine', (o) => engine.runReviewUntilGreen({ ...o, reviewOnly: true, repairFindingAnchors: true, cliPath: CLI })], ['own', (o) => own.runReview(o)]]) {
      const { repo, base } = checkout();
      runs[name] = await outcome(() => run({ ref: 'concord-pr-5', base, reviewer: 'claude', broad: false, noBroad: true, repoRoot: repo, spawn: async () => result }));
    }
    assert.ok(runs.own.error, JSON.stringify(result));
    assert.equal(runs.own.error, runs.engine.error);
  }
});
