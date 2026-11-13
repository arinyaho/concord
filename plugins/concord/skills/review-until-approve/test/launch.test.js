'use strict';
// How the runner starts a reviewer: which Codex executable it selects, the arguments, environment and sandbox each provider gets,
// how it reports termination, and what the untrusted checkout is kept from.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { reviewCodexConfig, codexExec, providerExec, resolveCodexExecutable } = require('../scripts/runner/launch');
const { providerFailure } = require('../scripts/runner/provider-failure');
const { tempDir } = require('../../../hooks/test/temp-dir');

function temp() { return tempDir('codex-runner-'); }

const APP_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

test('Codex resolver falls back to the macOS app binary after a broken PATH command', () => {
  const calls = [];
  const resolved = resolveCodexExecutable('/repo', {
    platform: 'darwin', env: { PATH: '/broken' },
    probe: (command) => {
      calls.push(command);
      return command === 'codex' ? { error: { code: 'ENOENT' } } : { status: 0, stdout: 'codex-cli 0.163.0\n' };
    },
  });
  assert.deepStrictEqual(calls, ['codex', APP_BINARY]);
  assert.strictEqual(resolved.command, APP_BINARY);
  assert.strictEqual(resolved.source, 'macOS ChatGPT app');
});

test('Codex resolver prefers the app-exported CODEX_CLI_PATH over a PATH command that passes --version', () => {
  const versions = { codex: 'codex-cli 0.154.0\n', '/app/codex': 'codex-cli 0.163.0-alpha.11.2\n' };
  const resolved = resolveCodexExecutable('/repo', {
    platform: 'darwin', env: { PATH: '/stale', CODEX_CLI_PATH: '/app/codex' },
    probe: (command) => ({ status: 0, stdout: versions[command] }),
  });
  assert.strictEqual(resolved.command, '/app/codex');
  assert.strictEqual(resolved.source, 'CODEX_CLI_PATH');
  assert.strictEqual(resolved.version, 'codex-cli 0.163.0-alpha.11.2');
});

test('Codex resolver skips an invalid CODEX_CLI_PATH and records why', () => {
  const resolved = resolveCodexExecutable('/repo', {
    platform: 'linux', env: { PATH: '/p', CODEX_CLI_PATH: '/gone/codex' },
    probe: (command) => command === 'codex' ? { status: 0, stdout: 'codex-cli 0.154.0\n' } : { error: { code: 'ENOENT' } },
  });
  assert.strictEqual(resolved.source, 'PATH');
  assert.deepStrictEqual(resolved.skipped, ['CODEX_CLI_PATH /gone/codex: ENOENT']);
});

test('Codex resolver treats an explicit override as authoritative', () => {
  const calls = [];
  assert.throws(() => resolveCodexExecutable('/repo', {
    platform: 'darwin', env: { CONCORD_CODEX_BIN: '/broken/codex', CODEX_CLI_PATH: '/app/codex', PATH: '/p' },
    probe: (command) => { calls.push(command); return command === '/broken/codex' ? { error: { code: 'ENOENT' } } : { status: 0, stdout: 'codex-cli 0.163.0\n' }; },
  }), /no usable Codex executable/);
  assert.deepStrictEqual(calls, ['/broken/codex']);
});

test('a failed launch reports the selected executable source and version without the raw provider error', async () => {
  const binDir = temp();
  const fake = (name, version, exec) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('${version}\\n');\nelse { ${exec} }\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const stale = fake('stale', 'codex-cli 0.154.0', `console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'HTTP 400 invalid_request sk-SECRET123' } })); process.exit(1);`);
  const app = fake('app', 'codex-cli 0.163.0-alpha.11.2', `console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));`);
  const input = { role: 'verify', prompt: 'p', repoRoot: binDir, stateDir: binDir, provider: 'codex' };
  const exe = (command, source, version) => ({ codexExecutable: { command, source, version }, env: process.env });
  const failed = await codexExec({ ...input, ...exe(stale, 'CONCORD_CODEX_BIN', 'codex-cli 0.154.0') });
  const failure = providerFailure(input, failed);
  assert.deepStrictEqual(failure.diagnostic.executable, { source: 'CONCORD_CODEX_BIN', version: 'codex-cli 0.154.0' });
  assert.ok(!JSON.stringify(failure).includes('SECRET123'));
  const viaPath = await codexExec({ ...input, ...exe(stale, 'CODEX_CLI_PATH', 'codex-cli 0.154.0') });
  const advice = providerFailure(input, viaPath);
  assert.strictEqual(advice.diagnostic.executable.source, 'CODEX_CLI_PATH');
  assert.match(advice.message, /set CONCORD_CODEX_BIN=\/absolute\/path\/to\/codex/);
  const ok = await codexExec({ ...input, ...exe(app, 'PATH', 'codex-cli 0.163.0-alpha.11.2') });
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.executable.version, 'codex-cli 0.163.0-alpha.11.2');
});

test('codexExec starts subprocesses asynchronously so panel work can overlap', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const started = path.join(binDir, 'started');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse { const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(started)}, '1'); const wait = setInterval(() => { if (fs.readFileSync(${JSON.stringify(started)}, 'utf8').length === 2) { clearInterval(wait); process.exit(0); } }, 10); }\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const first = codexExec({ role: 'panel', prompt: 'first', repoRoot: binDir, stateDir: binDir, timeoutMs: 15000, codexExecutable: { command: codex, version: 'codex-cli 0.154.0' } });
    const second = codexExec({ role: 'panel', prompt: 'second', repoRoot: binDir, stateDir: binDir, timeoutMs: 15000, codexExecutable: { command: codex, version: 'codex-cli 0.154.0' } });
    assert.strictEqual(typeof first?.then, 'function');
    const results = await Promise.all([first, second]);
    assert.deepStrictEqual(results.map((result) => result.status), [0, 0]);
    assert.strictEqual(fs.readFileSync(started, 'utf8'), '11');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec probes the CLI version once for concurrent calls', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const probes = path.join(binDir, 'probes');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) { require('node:fs').appendFileSync(${JSON.stringify(probes)}, '1'); process.stdout.write('codex-cli 0.154.0\\n'); }\nelse process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n');\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await Promise.all([
      codexExec({ role: 'correctness', prompt: 'first', repoRoot: binDir, stateDir: binDir }),
      codexExec({ role: 'verify', prompt: 'second', repoRoot: binDir, stateDir: binDir }),
    ]);
    assert.strictEqual(fs.readFileSync(probes, 'utf8'), '1');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('a Codex executable that cannot be resolved fails the launch before anything starts', async () => {
  const missing = path.join(temp(), 'missing-codex');
  await assert.rejects(codexExec({ role: 'verify', prompt: 'review', repoRoot: temp(), stateDir: temp(), env: { PATH: '/no-such-path', CONCORD_CODEX_BIN: missing } }), (error) => {
    assert.strictEqual(error.code, 'CONCORD_CODEX_UNUSABLE');
    assert.match(error.message, /no usable Codex executable/);
    return true;
  });
});

test('providerExec invokes claude non-interactively with the requested model', async () => {
  const provider = 'claude';
  const expectedArgs = ['-p', '--model', 'review-model'];
  const binDir = temp();
  const executablePath = path.join(binDir, 'claude');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(executablePath, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(executablePath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await providerExec({
      provider, role: 'correctness', prompt: 'review', repoRoot: binDir,
      stateDir: binDir, requestedModel: 'review-model',
    });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    for (const expected of expectedArgs) assert.ok(args.includes(expected), `${provider} arguments omitted ${expected}`);
    assert.strictEqual(result.status, 0);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('providerExec keeps the Claude prompt separate from the variadic --add-dir option', async () => {
  const binDir = temp();
  const claude = path.join(binDir, 'claude');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(claude, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await providerExec({
      provider: 'claude', role: 'correctness', prompt: 'Reply exactly OK.', repoRoot: binDir,
      stateDir: binDir, requestedModel: 'opus',
    });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [
      '-p', '--model', 'opus', '--output-format', 'json', '--no-session-persistence',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--setting-sources', 'user', `--add-dir=${binDir}`, 'Reply exactly OK.',
    ]);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('providerExec passes the reasoning effort to claude -p as --effort', async () => {
  const binDir = temp();
  const claude = path.join(binDir, 'claude');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(claude, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await providerExec({ provider: 'claude', role: 'correctness', prompt: 'p', repoRoot: binDir, stateDir: binDir, requestedModel: 'opus', reasoningEffort: 'high' });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepStrictEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('codexExec exposes signal and timeout termination separately', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse if (process.argv.includes('signal')) process.kill(process.pid, 'SIGTERM');\nelse setTimeout(() => {}, 1000);\n`);
  fs.chmodSync(codex, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const signal = await codexExec({ role: 'correctness', prompt: 'signal', repoRoot: binDir, stateDir: binDir });
    assert.deepStrictEqual({ status: signal.status, signal: signal.signal, timedOut: signal.timedOut }, { status: null, signal: 'SIGTERM', timedOut: false });
    const timeout = await codexExec({ role: 'correctness', prompt: 'wait', repoRoot: binDir, stateDir: binDir, timeoutMs: 20 });
    assert.deepStrictEqual({ status: timeout.status, signal: timeout.signal, timedOut: timeout.timedOut }, { status: null, signal: 'SIGTERM', timedOut: true });
    const controller = new AbortController();
    const interrupted = codexExec({ role: 'correctness', prompt: 'wait', repoRoot: binDir, stateDir: binDir, abortSignal: controller.signal });
    setTimeout(() => controller.abort('SIGINT'), 20);
    assert.strictEqual((await interrupted).interrupted, 'SIGINT');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('providerExec keeps the checkout\'s project settings out of a Claude reviewer', async () => {
  const binDir = temp();
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    await providerExec({ provider: 'claude', role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.strictEqual(args[args.indexOf('--setting-sources') + 1], 'user');
  } finally {
    process.env.PATH = previousPath;
  }
});

for (const provider of ['codex', 'claude']) test(`a ${provider} reviewer cannot leave a same-group child running after its CLI exits`, async () => {
  if (process.platform === 'win32') return;
  const binDir = temp(); const marker = path.join(binDir, 'late-marker');
  const executable = path.join(binDir, provider);
  const delayed = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 450)`;
  fs.writeFileSync(executable, `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(delayed)}], { stdio: 'ignore' }).unref();\nconsole.log(${JSON.stringify(provider === 'codex' ? '{"type":"turn.completed","usage":{}}' : '{}')});\n`);
  fs.chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  try {
    if (provider === 'codex') await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, codexExecutable: { command: executable, version: 'codex-cli 0.154.0' } });
    else await providerExec({ provider, role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.strictEqual(fs.existsSync(marker), false, 'a reviewer descendant must not write after the top-level CLI exits');
  } finally { process.env.PATH = oldPath; }
});

test('codexExec keeps the checkout\'s AGENTS.md and project rules out of a Codex reviewer', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'args.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(codex, 0o755);
  await codexExec({ role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir, codexExecutable: { command: codex, version: 'codex-cli 0.154.0' } });
  const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.ok(args.includes('project_doc_max_bytes=0'), `args: ${args.join(' ')}`);
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--strict-config'));
  assert.ok(!args.includes('--sandbox'));
});

test('codexExec strips inherited credentials from the reviewer environment', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'capture.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nconst keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SAFE_VALUE']; require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(keys.map(key => [key, process.env[key] || null])) }));\n`);
  fs.chmodSync(codex, 0o755);
  const input = { role: 'correctness', prompt: 'review', repoRoot: binDir, stateDir: binDir,
    codexExecutable: { command: codex, version: 'codex-cli 0.154.0' }, env: { ...process.env, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', SAFE_VALUE: 'kept' } };
  await codexExec(input);
  const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.strictEqual(seen.env[key], null, key);
  assert.strictEqual(seen.env.SAFE_VALUE, 'kept');
  assert.deepStrictEqual(seen.args.slice(0, 6), ['exec', '--cd', binDir, '--strict-config', '--add-dir', binDir]);
});

test('a CODEX_HOME reached through a symlinked home is covered by the home entry and gets no nested deny', () => {
  const real = fs.realpathSync(temp());
  fs.mkdirSync(path.join(real, '.codex'));
  const link = path.join(fs.realpathSync(temp()), 'home-link');
  fs.symlinkSync(real, link);
  const home = fs.realpathSync(temp());
  const checkout = fs.realpathSync(temp());
  const sourceAuth = path.join(link, '.codex', 'auth.json');
  const config = reviewCodexConfig({ home, sourceAuth, checkout, denyRead: [], realHome: link });
  assert.ok(config.includes(`${JSON.stringify(path.join(real, '.codex'))} = "deny"`), config);
  assert.ok(!config.includes(JSON.stringify(sourceAuth)), 'the auth file inside a denied directory has no entry of its own');
});

test('reviewCodexConfig denies the volatile account .codex directory as a whole', () => {
  const accountHome = fs.realpathSync(temp());
  const codexHome = path.join(accountHome, '.codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'state.sqlite'), 'db');
  fs.writeFileSync(path.join(codexHome, 'state.sqlite-shm'), 'volatile');
  fs.writeFileSync(path.join(codexHome, 'state.sqlite-wal'), 'volatile');
  const fakeBin = fs.realpathSync(temp());
  const fakeCli = path.join(fakeBin, 'codex');
  fs.writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeCli, 0o755);
  const savedPath = process.env.PATH;
  const savedCodexBin = process.env.CONCORD_CODEX_BIN;
  process.env.PATH = `${fakeBin}${path.delimiter}${savedPath || ''}`;
  process.env.CONCORD_CODEX_BIN = fakeCli;
  try {
    const config = reviewCodexConfig({ home: fs.realpathSync(temp()), sourceAuth: path.join(codexHome, 'auth.json'), checkout: fs.realpathSync(temp()), denyRead: [], realHome: accountHome });
    const permissions = config.split('[permissions.concord-review.network]')[0];
    assert.ok(permissions.includes(`${JSON.stringify(codexHome)} = "deny"`), config);
    assert.ok(!permissions.includes('state.sqlite-shm'), 'volatile SQLite children are not individually enumerated');
    assert.ok(!permissions.includes(`${JSON.stringify(fakeCli)} = "deny"`), 'the installed Codex binary stays readable');
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCodexBin === undefined) delete process.env.CONCORD_CODEX_BIN; else process.env.CONCORD_CODEX_BIN = savedCodexBin;
  }
});

test('reviewCodexConfig keeps the CODEX_CLI_PATH binary readable although it is not on PATH', () => {
  const accountHome = fs.realpathSync(temp());
  const appDir = path.join(accountHome, 'appbin');
  fs.mkdirSync(appDir);
  const appCli = path.join(appDir, 'codex');
  fs.writeFileSync(appCli, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(appCli, 0o755);
  const saved = { PATH: process.env.PATH, bin: process.env.CONCORD_CODEX_BIN, app: process.env.CODEX_CLI_PATH };
  delete process.env.CONCORD_CODEX_BIN;
  process.env.CODEX_CLI_PATH = appCli;
  try {
    const config = reviewCodexConfig({ home: fs.realpathSync(temp()), sourceAuth: path.join(accountHome, '.codex', 'auth.json'), checkout: fs.realpathSync(temp()), denyRead: [], realHome: accountHome });
    assert.ok(!config.includes(`${JSON.stringify(appDir)} = "deny"`) && !config.includes(`${JSON.stringify(appCli)} = "deny"`), config);
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.bin === undefined) delete process.env.CONCORD_CODEX_BIN; else process.env.CONCORD_CODEX_BIN = saved.bin;
    if (saved.app === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = saved.app;
  }
});

test('reviewCodexConfig keeps the selected working PATH Codex readable when CODEX_CLI_PATH fails its version probe', () => {
  const accountHome = fs.realpathSync(temp());
  const appDir = path.join(accountHome, 'appbin'), skippedDir = path.join(accountHome, 'not-executable'), pathDir = path.join(accountHome, 'pathbin');
  fs.mkdirSync(appDir); fs.mkdirSync(skippedDir); fs.mkdirSync(pathDir);
  const appCli = path.join(appDir, 'codex'), skippedCli = path.join(skippedDir, 'codex'), pathCli = path.join(pathDir, 'codex');
  fs.writeFileSync(appCli, '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(skippedCli, '#!/bin/sh\necho codex-cli\n');
  fs.writeFileSync(pathCli, '#!/bin/sh\n[ "$1" = "--version" ] && { echo codex-cli; exit 0; }\nexit 1\n');
  fs.chmodSync(appCli, 0o755); fs.chmodSync(skippedCli, 0o644); fs.chmodSync(pathCli, 0o755);
  const checkout = fs.realpathSync(temp());
  const saved = { PATH: process.env.PATH, bin: process.env.CONCORD_CODEX_BIN, app: process.env.CODEX_CLI_PATH };
  delete process.env.CONCORD_CODEX_BIN;
  process.env.CODEX_CLI_PATH = appCli;
  process.env.PATH = [skippedDir, pathDir].map((dir) => path.relative(checkout, dir)).join(path.delimiter);
  try {
    const config = reviewCodexConfig({ home: fs.realpathSync(temp()), sourceAuth: path.join(accountHome, '.codex', 'auth.json'), checkout, denyRead: [], realHome: accountHome });
    assert.ok(!config.includes(`${JSON.stringify(pathCli)} = "deny"`), config);
    assert.ok(!config.includes(`${JSON.stringify(pathDir)} = "deny"`), config);
    assert.ok(config.includes(`${JSON.stringify(skippedDir)} = "deny"`), config);
    assert.ok(config.includes(`${JSON.stringify(appDir)} = "deny"`), config);
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.bin === undefined) delete process.env.CONCORD_CODEX_BIN; else process.env.CONCORD_CODEX_BIN = saved.bin;
    if (saved.app === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = saved.app;
  }
});

test('switching CONCORD_CODEX_BIN after a failed launch changes only the executable and leaves the state directory untouched', async () => {
  const dir = temp();
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  const kept = path.join(stateDir, 'round-1-correctness.json');
  fs.writeFileSync(kept, JSON.stringify({ status: 'ok', examined: [], findings: [] }));
  const before = fs.readFileSync(kept);
  const fake = (name, version, exec) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('${version}\\n');\nelse { ${exec} }\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const stale = fake('stale', 'codex-cli 0.154.0', `process.exit(1);`);
  const app = fake('app', 'codex-cli 0.163.0', `console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));`);
  const launch = (bin) => codexExec({ role: 'verify', prompt: 'p', repoRoot: dir, stateDir, env: { ...process.env, CONCORD_CODEX_BIN: bin } });
  const failed = await launch(stale);
  const resumed = await launch(app);
  assert.deepStrictEqual([failed.status, resumed.status], [1, 0]);
  assert.deepStrictEqual([failed.executable.version, resumed.executable.version], ['codex-cli 0.154.0', 'codex-cli 0.163.0']);
  assert.deepStrictEqual(fs.readFileSync(kept), before);
  assert.deepStrictEqual(fs.readdirSync(stateDir), ['round-1-correctness.json']);
});

test('a command inside the review sandbox cannot rewrite the CODEX_HOME configuration, so a later launch is still denied', (t) => {
  const probe = spawnSync('codex', ['sandbox', 'true'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('codex sandbox is not usable here');
  const accountHome = fs.realpathSync(temp());
  const decoy = path.join(accountHome, 'decoy.txt');
  fs.writeFileSync(decoy, 'DECOY');
  const home = fs.realpathSync(temp());
  const checkout = fs.realpathSync(temp());
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const sourceAuth = path.join(accountHome, '.codex', 'auth.json');
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, reviewCodexConfig({ home, sourceAuth, checkout, denyRead: [], realHome: accountHome }));
  const before = fs.readFileSync(config, 'utf8');
  const inSandbox = (command) => spawnSync('codex', ['sandbox', 'sh', '-c', command], { cwd: checkout, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' });
  assert.notStrictEqual(inSandbox(`cat ${decoy}`).status, 0, 'the profile denies the decoy');
  inSandbox(`sed -i '/deny/d' ${config}; : > ${config}; rm -f ${config}`);
  assert.strictEqual(fs.readFileSync(config, 'utf8'), before, 'the sandbox could not change the configuration');
  assert.notStrictEqual(inSandbox(`cat ${decoy}`).status, 0, 'a second launch with the same CODEX_HOME still denies the decoy');
});

test('a reviewer subprocess does not inherit the driver\'s CONCORD_CODEX_BIN override', async () => {
  const binDir = temp();
  const codex = path.join(binDir, 'codex');
  const capture = path.join(binDir, 'env.json');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 0.154.0\\n');\nelse require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ bin: process.env.CONCORD_CODEX_BIN || null }));\n`);
  fs.chmodSync(codex, 0o755);
  await codexExec({ role: 'verify', prompt: 'p', repoRoot: binDir, stateDir: binDir, env: { ...process.env, CONCORD_CODEX_BIN: codex } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { bin: null });
});
