'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Load the module fresh under a forced process.platform so both branches are
// exercised regardless of which OS actually runs this test.
function loadWithPlatform(platform) {
  const modPath = path.join(__dirname, '..', '..', 'core', 'spawn-cross-platform.js');
  delete require.cache[require.resolve(modPath)];
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return require(modPath);
  } finally {
    Object.defineProperty(process, 'platform', original);
    delete require.cache[require.resolve(modPath)];
  }
}

test('win32: crossPlatformOpts adds shell:true and preserves other opts', () => {
  const { crossPlatformOpts, isWindows } = loadWithPlatform('win32');
  assert.strictEqual(isWindows, true);
  const result = crossPlatformOpts({ cwd: '/x', encoding: 'utf8' });
  assert.strictEqual(result.shell, true);
  assert.strictEqual(result.cwd, '/x');
  assert.strictEqual(result.encoding, 'utf8');
});

test('darwin: crossPlatformOpts is a no-op passthrough', () => {
  const { crossPlatformOpts, isWindows } = loadWithPlatform('darwin');
  assert.strictEqual(isWindows, false);
  const opts = { cwd: '/x', encoding: 'utf8' };
  const result = crossPlatformOpts(opts);
  assert.strictEqual(result.shell, undefined);
  assert.deepStrictEqual(result, opts);
});

test('linux: crossPlatformOpts is a no-op passthrough with no args', () => {
  const { crossPlatformOpts, isWindows } = loadWithPlatform('linux');
  assert.strictEqual(isWindows, false);
  const result = crossPlatformOpts();
  assert.strictEqual(result.shell, undefined);
});

// quoteArgumentForWindows/escapeCommandForWindows reproduce cross-spawn's
// algorithm (github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js,
// MIT). Every case here is checked against that reference implementation
// directly (inlined below, not re-derived from memory), so this is a
// mechanical-fidelity check to the de facto standard fix, not a
// self-consistency check against this file's own logic. The %/&/|/^ cases
// are the exact class of gap a GitHub Codex review on PR #113 caught: the
// first version of this file only quoted on space/tab/", so a git ref like
// `foo&whoami` passed through unescaped and cmd.exe would run `whoami` as a
// second command.
const crossSpawnMetaCharsRe = /([()[\]%!^"`<>&|;, *?])/g;
function crossSpawnEscapeArgument(arg, doubleEscapeMetaChars) {
  let value = `${arg}`;
  value = value.replace(/(?=(\\+?))\1"/g, '$1$1\\"');
  value = value.replace(/(?=(\\+?))\1$/, '$1$1');
  value = `"${value}"`;
  value = value.replace(crossSpawnMetaCharsRe, '^$1');
  if (doubleEscapeMetaChars) value = value.replace(crossSpawnMetaCharsRe, '^$1');
  return value;
}

const ESCAPING_CASES = [
  '--json', 'abc123', '', 'C:\\Users\\Jane Doe\\project', 'he said "hi"',
  'a\\"b', 'C:\\a b\\', 'foo&whoami', '%NAME%', 'a|b', 'a^b', 'a<b>c', 'a(b)c',
  '50% done', 'line1\nline2', 'tab\there', 'a;b', 'a,b', 'a`b', 'a[b]c', 'a*b?c',
];

for (const input of ESCAPING_CASES) {
  test(`win32: quoteArgumentForWindows matches cross-spawn's reference for ${JSON.stringify(input)}`, () => {
    const { quoteArgumentForWindows } = loadWithPlatform('win32');
    assert.strictEqual(quoteArgumentForWindows(input), crossSpawnEscapeArgument(input, false));
  });
}

test('win32: crossPlatformArgs applies the escape to every element', () => {
  const { crossPlatformArgs } = loadWithPlatform('win32');
  assert.deepStrictEqual(
    crossPlatformArgs(['exec', 'foo&whoami', 'plain']),
    ['exec', 'foo&whoami', 'plain'].map((a) => crossSpawnEscapeArgument(a, false)),
  );
});

test('darwin: crossPlatformArgs is a no-op passthrough', () => {
  const { crossPlatformArgs } = loadWithPlatform('darwin');
  const args = ['--cd', '/Users/Jane Doe/repo', 'foo&whoami'];
  assert.deepStrictEqual(crossPlatformArgs(args), args);
});

test('win32: escapeCommandForWindows escapes metacharacters, no quoting', () => {
  const { escapeCommandForWindows } = loadWithPlatform('win32');
  assert.strictEqual(escapeCommandForWindows('codex'), 'codex');
  assert.strictEqual(escapeCommandForWindows('a&b'), 'a^&b');
});

test('win32: crossPlatformCommand applies escapeCommandForWindows', () => {
  const { crossPlatformCommand } = loadWithPlatform('win32');
  assert.strictEqual(crossPlatformCommand('codex'), 'codex');
});

test('darwin: crossPlatformCommand is a no-op passthrough', () => {
  const { crossPlatformCommand } = loadWithPlatform('darwin');
  assert.strictEqual(crossPlatformCommand('a&b'), 'a&b');
});
