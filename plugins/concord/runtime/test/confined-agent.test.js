'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../hooks/test/temp-dir');
const { runConfined } = require('../confined-agent');

const GUARD = path.join(__dirname, '..', '..', 'hooks', 'read-only-guard.js');
const HOOK_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(GUARD)}`;

function fake(behavior) {
  const dir = tempDir('ca-bin-');
  const bin = path.join(dir, 'fake-cli.js');
  fs.copyFileSync(path.join(__dirname, 'fake-cli.js'), bin);
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ output: '{"ok":true}', ...behavior }));
  // macOS sets __CF_USER_TEXT_ENCODING in every process it starts.
  const calls = () => {
    try {
      return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        .map((c) => ({ ...c, env: c.env.filter((k) => k !== '__CF_USER_TEXT_ENCODING') }));
    } catch { return []; }
  };
  return { bin, calls };
}

// A parent environment with variables no agent may see.
function parentEnv(extra) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret', CLAUDE_CODE_SESSION_ID: 'parent', CODEX_THREAD_ID: 't', FOO: 'bar', ...extra };
}

function claudeSetup(behavior) {
  const base = fs.realpathSync(tempDir('ca-claude-'));
  const round = path.join(base, 'concord', 'explain-pr', 'prs', 'o__r__1__abc');
  fs.mkdirSync(path.join(round, 'head'), { recursive: true });
  const env = parentEnv({ CLAUDE_CONFIG_DIR: base, ANTHROPIC_API_KEY: 'sk-test' });
  const f = fake(behavior);
  const opts = { harness: 'claude', kind: 'agent', dir: round, outputDir: path.join(round, 'out-reviewer'), outputName: 'result.json', prompt: 'Review.', model: 'opus', effort: 'high', env, bin: f.bin };
  return { base, round, env, opts, ...f };
}

function codexSetup(behavior, config = '') {
  const home = fs.realpathSync(tempDir('ca-codex-'));
  const round = path.join(home, 'concord', 'explain-pr', 'prs', 'o__r__1__abc');
  fs.mkdirSync(path.join(round, 'head'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), config);
  const outputDir = path.join(round, 'out-reviewer');
  const env = parentEnv({ CODEX_HOME: home, OPENAI_API_KEY: 'sk-test' });
  const f = fake({ outputPath: path.join(outputDir, 'result.json'), ...behavior });
  const opts = { harness: 'codex', kind: 'agent', dir: round, outputDir, outputName: 'result.json', prompt: 'Review.', model: 'gpt-x', effort: 'high', env, bin: f.bin };
  return { home, round, outputDir, env, opts, ...f };
}

const modeFiles = (base) => {
  try { return fs.readdirSync(path.join(base, 'concord', 'explain-pr', 'modes')); } catch { return []; }
};

test('claude: the argv is exactly the designed one and the child gets only the allowlisted variables', { skip: process.platform === 'win32' }, async () => {
  const { base, round, opts, calls } = claudeSetup({});
  const r = await runConfined(opts);
  assert.deepEqual(r, { status: 'ok', output: '{"ok":true}' });
  const [call] = calls();
  const sid = call.args[call.args.indexOf('--session-id') + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  const canary = path.join(round, `.canary-${sid}`);
  assert.deepEqual(call.args, ['-p', '--session-id', sid, '--setting-sources', '',
    '--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Grep,Glob,Write',
    '--strict-mcp-config', '--no-session-persistence', '--model', 'opus', '--effort', 'high',
    '--', `Your first tool call must be a Read of ${canary}; it is denied, and that denial turns on your tools.\n\nReview.`]);
  assert.deepEqual(call.mode, { kind: 'agent', dir: round, output: path.join(round, 'out-reviewer', 'result.json'), canary, log: path.join(base, 'concord', 'explain-pr', 'modes', `${sid}.log`) });
  // An empty working directory outside the round directory.
  assert.ok(!call.cwd.startsWith(round));
  assert.ok(!fs.existsSync(call.cwd));
  assert.deepEqual(call.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'EXPLAIN_PR_DIR', 'HOME', 'LANG', 'PATH']);
  assert.equal(fs.statSync(path.join(round, 'out-reviewer')).mode & 0o777, 0o700);
});

test('claude writable worktree: tools include Edit, the working directory is the worktree', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(tempDir('ca-wt-'));
  const worktree = path.join(base, 'w');
  const session = path.join(base, 's');
  for (const d of [worktree, session]) fs.mkdirSync(d);
  const f = fake({});
  const r = await runConfined({ harness: 'claude', kind: 'worktree', worktree, session, outputName: 'result.json', prompt: 'Fix.', env: parentEnv({ CLAUDE_CONFIG_DIR: base }), bin: f.bin });
  assert.deepEqual(r, { status: 'ok', output: '{"ok":true}' });
  const [call] = f.calls();
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write');
  assert.equal(call.cwd, worktree);
  assert.deepEqual({ ...call.mode, canary: undefined, log: undefined }, { kind: 'worktree', worktree, session, canary: undefined, log: undefined });
  assert.deepEqual(modeFiles(base), []);
});

test('claude: a run whose hook log lacks the canary denial is "hook did not run" and its output is not read', { skip: process.platform === 'win32' }, async () => {
  const { base, round, opts } = claudeSetup({ agent: 'nohook' });
  assert.deepEqual(await runConfined(opts), { status: 'hook did not run' });
  assert.ok(fs.existsSync(path.join(round, 'out-reviewer', 'result.json')));
  assert.deepEqual(modeFiles(base), []);
});

test('claude: the mode file and its log are gone after the agent ends, on success and on failure', { skip: process.platform === 'win32' }, async () => {
  for (const agent of [undefined, 'fail']) {
    const { base, opts, calls } = claudeSetup({ agent });
    const r = await runConfined(opts);
    assert.equal(r.status, agent ? 'malformed output' : 'ok');
    assert.equal(calls().length, 1);
    assert.deepEqual(modeFiles(base), []);
  }
});

test('an agent past the time limit or the size limit is stopped and reported as malformed output', { skip: process.platform === 'win32' }, async () => {
  const late = claudeSetup({ agent: 'slow' });
  const t0 = Date.now();
  assert.deepEqual(await runConfined({ ...late.opts, timeoutMs: 3000 }), { status: 'malformed output', reason: 'late' });
  assert.ok(Date.now() - t0 < 20000);
  assert.deepEqual(modeFiles(late.base), []);
  const big = codexSetup({ agent: 'big', bytes: 4096 });
  const t1 = Date.now();
  assert.deepEqual(await runConfined({ ...big.opts, maxBytes: 1024 }), { status: 'malformed output', reason: 'too large' });
  assert.ok(Date.now() - t1 < 20000);
  // Written after the end but over the limit: still malformed.
  const after = codexSetup({ output: 'x'.repeat(2048) });
  assert.deepEqual(await runConfined({ ...after.opts, maxBytes: 1024 }), { status: 'malformed output', reason: 'too large' });
  const missing = codexSetup({ agent: 'fail' });
  assert.deepEqual(await runConfined(missing.opts), { status: 'malformed output', reason: 'missing' });
});

test('codex: the argv is exactly the designed one, every configured MCP server is switched off, and the environment is allowlisted', { skip: process.platform === 'win32' }, async () => {
  const config = '[mcp_servers.github]\ncommand = "x"\n\n[mcp_servers.atlassian.env]\nTOKEN = "y"\n\n[mcp_servers."quoted id"]\n';
  const bad = codexSetup({}, config);
  assert.deepEqual(await runConfined(bad.opts), { status: 'cannot start' });
  assert.deepEqual(bad.calls(), []);

  const { round, outputDir, opts, calls } = codexSetup({}, '[mcp_servers.github]\ncommand = "x"\n\n[mcp_servers.atlassian.env]\nTOKEN = "y"\n');
  assert.deepEqual(await runConfined(opts), { status: 'ok', output: '{"ok":true}' });
  const all = calls();
  const profile = ['-c', 'default_permissions="concord"', '-c', `permissions.concord.filesystem={":minimal"="read",${JSON.stringify(round)}="read",${JSON.stringify(outputDir)}="write","/tmp"="none","/var/tmp"="none"}`];
  assert.deepEqual(all.filter((c) => c.sandbox).map((c) => c.args), [
    ['sandbox', ...profile, '--', '/bin/ls', round],
    ['sandbox', ...profile, '--', '/bin/ls', require('node:os').homedir()],
  ]);
  assert.deepEqual(all.filter((c) => c.sandbox).map((c) => c.cwd), [round, round]);
  const exec = all.find((c) => c.args[0] === 'exec');
  assert.deepEqual(exec.args, ['exec', '--ephemeral', '--skip-git-repo-check', '-C', round, ...profile,
    '-c', 'web_search="disabled"', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'multi_agent', '--disable', 'image_generation', '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'mcp_servers.github.enabled=false', '-c', 'mcp_servers.atlassian.enabled=false',
    '-m', 'gpt-x', '-c', 'model_reasoning_effort="high"', 'Review.']);
  assert.equal(exec.cwd, round);
  assert.equal(exec.marker, true);
  assert.ok(!fs.existsSync(path.join(round, '.concord-confined-agent')), 'the marker is removed when the agent ends');
  assert.deepEqual(exec.env, ['CODEX_HOME', 'HOME', 'LANG', 'OPENAI_API_KEY', 'PATH']);
});

test('codex: a pre-flight the fake lets succeed starts no agent', { skip: process.platform === 'win32' }, async () => {
  for (const [behavior, reason] of [[{ home: 'open' }, 'home readable'], [{ sandbox: 'broken' }, 'sandbox did not run']]) {
    const { opts, calls, round } = codexSetup(behavior);
    assert.deepEqual(await runConfined(opts), { status: 'preflight failed', reason });
    assert.ok(!calls().some((c) => c.args[0] === 'exec'));
    assert.ok(!fs.existsSync(path.join(round, '.concord-confined-agent')));
  }
});

test('codex writable session: the pre-flight also needs the network refused; the session runs in the worktree', { skip: process.platform === 'win32' }, async () => {
  const setup = (behavior) => {
    const home = fs.realpathSync(tempDir('ca-cwt-'));
    const root = path.join(home, 'concord', 'pr-to-merge', 'sessions', 's1');
    const worktree = path.join(root, 'worktree');
    const session = path.join(root, 'session');
    for (const d of [worktree, session]) fs.mkdirSync(d, { recursive: true });
    const f = fake({ outputPath: path.join(session, 'result.json'), ...behavior });
    return { worktree, session, ...f, opts: { harness: 'codex', kind: 'worktree', worktree, session, outputName: 'result.json', prompt: 'Fix.', env: parentEnv({ CODEX_HOME: home }), bin: f.bin } };
  };
  const open = setup({ network: 'open' });
  assert.deepEqual(await runConfined(open.opts), { status: 'preflight failed', reason: 'network reachable' });
  assert.ok(!open.calls().some((c) => c.args[0] === 'exec'));

  const ok = setup({});
  assert.deepEqual(await runConfined(ok.opts), { status: 'ok', output: '{"ok":true}' });
  const exec = ok.calls().find((c) => c.args[0] === 'exec');
  assert.equal(exec.cwd, ok.worktree);
  assert.ok(exec.args.includes(`permissions.concord.filesystem={":minimal"="read",${JSON.stringify(ok.worktree)}="write",${JSON.stringify(ok.session)}="write","/tmp"="none","/var/tmp"="none"}`));
  assert.ok(ok.calls().some((c) => c.sandbox && c.sandbox.includes('curl')));

  // A worktree outside the session-worktree root, where the Codex hook would not know the session, does not start.
  const elsewhere = fs.realpathSync(tempDir('ca-cwt-out-'));
  const f = fake({});
  assert.deepEqual(await runConfined({ ...ok.opts, worktree: elsewhere, session: elsewhere, bin: f.bin }), { status: 'cannot start' });
});

test('an output directory that already exists, or a bad option, does not start', async () => {
  const { opts, calls } = claudeSetup({});
  fs.mkdirSync(opts.outputDir);
  assert.deepEqual(await runConfined(opts), { status: 'cannot start' });
  fs.rmdirSync(opts.outputDir);
  assert.deepEqual(await runConfined({ ...opts, outputName: '../x' }), { status: 'cannot start' });
  assert.deepEqual(await runConfined({ ...opts, kind: 'other' }), { status: 'cannot start' });
  assert.deepEqual(calls(), []);
});
