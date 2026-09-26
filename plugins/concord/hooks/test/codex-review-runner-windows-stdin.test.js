'use strict';
// Windows-only behavior: codexExec/providerExec route the (potentially
// multi-line) reviewer/fixer prompt through stdin instead of argv, because
// on win32 `crossPlatformOpts` sets `shell: true`, and cmd.exe's own
// command-line reader treats an embedded newline as a command boundary
// before the argument ever reaches the CommandLineToArgvW-level quoting
// `crossPlatformArgs` applies -- a GitHub Codex review on this exact code
// (PR #113) flagged it concretely.
//
// This machine is not Windows, and forcing `process.platform` while
// letting a real subprocess spawn would apply cmd.exe-style caret
// escaping to arguments that then actually run through a real POSIX
// shell (crossPlatformOpts' `shell: true` on THIS platform means
// `/bin/sh -c`, not cmd.exe) -- a mismatch that tests nothing real. So
// child_process.spawn is mocked here: no real subprocess exists, and the
// assertion is purely "what args/stdin did codexExec/providerExec hand to
// spawn", which is real, spawn-independent code we can safely force
// win32 for.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

function loadRunnerWithPlatform(platform) {
  const runnerPath = require.resolve('../../core/codex-review-runner.js');
  const spawnHelperPath = require.resolve('../../core/spawn-cross-platform.js');
  delete require.cache[runnerPath];
  delete require.cache[spawnHelperPath];
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return require(runnerPath);
  } finally {
    Object.defineProperty(process, 'platform', original);
    delete require.cache[runnerPath];
    delete require.cache[spawnHelperPath];
  }
}

// A minimal fake ChildProcess: real EventEmitter (so .once('close'/'error')
// behave exactly like the real thing), fake stdout/stderr streams (also
// EventEmitters, since that's all codexExec/providerExec's listeners need),
// and a stdin sink that records what was written.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  let stdinContent = '';
  child.stdin = { end: (data) => { if (data) stdinContent += data; } };
  Object.defineProperty(child, 'capturedStdin', { get: () => stdinContent });
  return child;
}

test('win32: codexExec sends the prompt via stdin, not argv, so a multi-line prompt cannot be read as a cmd.exe command boundary', async (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('no real codex binary in this test'); });
  t.mock.method(childProcess, 'spawn', (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })}\n`);
      child.emit('close', 0);
    });
    return child;
  });
  const { codexExec } = loadRunnerWithPlatform('win32');
  const multilinePrompt = 'line one\nline two: & whoami\nline three';
  await codexExec({ role: 'correctness', prompt: multilinePrompt, repoRoot: '/tmp/fake-repo', stateDir: '/tmp/fake-state' });

  assert.strictEqual(calls.length, 1);
  const { args } = calls[0];
  // crossPlatformArgs quotes/escapes every argument on win32 (^"-^" for a
  // bare "-"), so check for the quoted form, not the raw literal.
  assert.ok(!args.some((a) => a.includes('line one')), 'the multi-line prompt must not appear anywhere in argv on win32');
  assert.ok(args.includes('^"-^"'), 'codex exec must be given the (quoted) stdin sentinel "-" as its prompt argument on win32');
  assert.strictEqual(calls[0].bin, 'codex');
});

// claude keeps its unconditional `-p` flag (that flag alone means
// "non-interactive"; omitting only the trailing positional prompt makes it
// read stdin). copilot's docs say piped stdin is ignored whenever `-p`/
// `--prompt` is present, so on win32 that flag must be dropped entirely,
// not just its value.
for (const [provider, expectDashP] of [['claude', true], ['copilot', false]]) {
  test(`win32: providerExec (${provider}) sends the prompt via stdin, not argv`, async (t) => {
    const calls = [];
    t.mock.method(childProcess, 'spawn', (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ ok: true }));
        child.emit('close', 0);
      });
      return child;
    });
    const { providerExec } = loadRunnerWithPlatform('win32');
    const multilinePrompt = 'first line\nsecond line: | dir';
    await providerExec({ provider, role: 'correctness', prompt: multilinePrompt, repoRoot: '/tmp/fake-repo', stateDir: '/tmp/fake-state' });

    assert.strictEqual(calls.length, 1);
    const { args } = calls[0];
    // crossPlatformArgs quotes/escapes every argument on win32 (^"-p^" for
    // a bare "-p"), so check for the quoted form, not the raw literal.
    assert.ok(!args.some((a) => a.includes('first line')), `the multi-line prompt must not appear anywhere in ${provider}'s argv on win32`);
    assert.strictEqual(args.includes('^"-p^"'), expectDashP, `${provider}'s -p flag presence on win32 should be ${expectDashP}`);
  });
}
