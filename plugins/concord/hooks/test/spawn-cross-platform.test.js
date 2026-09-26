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

// quoteArgumentForWindows: known input/output pairs from the documented
// CommandLineToArgvW quoting rule (see e.g. Microsoft's own C runtime
// startup docs, and the widely-cited "everyone quotes command line
// arguments the wrong way" reference algorithm). These are checked as pure
// string transforms -- verifiable without a live Windows host, unlike
// cmd.exe's own separate metacharacter parsing (disclosed, not attempted
// here).
test('win32: quoteArgumentForWindows leaves a plain argument unquoted', () => {
  const { quoteArgumentForWindows } = loadWithPlatform('win32');
  assert.strictEqual(quoteArgumentForWindows('--json'), '--json');
  assert.strictEqual(quoteArgumentForWindows('abc123'), 'abc123');
});

test('win32: quoteArgumentForWindows quotes an argument containing a space (the common Windows-path case)', () => {
  const { quoteArgumentForWindows } = loadWithPlatform('win32');
  assert.strictEqual(quoteArgumentForWindows('C:\\Users\\Jane Doe\\project'), '"C:\\Users\\Jane Doe\\project"');
});

test('win32: quoteArgumentForWindows escapes an embedded double quote', () => {
  const { quoteArgumentForWindows } = loadWithPlatform('win32');
  // literal string:  he said "hi"
  assert.strictEqual(quoteArgumentForWindows('he said "hi"'), '"he said \\"hi\\""');
});

test('win32: quoteArgumentForWindows doubles backslashes immediately before a quote', () => {
  const { quoteArgumentForWindows } = loadWithPlatform('win32');
  // literal string:  a\"b  (one backslash then a quote then b)
  assert.strictEqual(quoteArgumentForWindows('a\\"b'), '"a\\\\\\"b"');
});

test('win32: quoteArgumentForWindows doubles a trailing backslash run so the closing quote is never escaped', () => {
  const { quoteArgumentForWindows } = loadWithPlatform('win32');
  // literal string:  C:\path\   (trailing backslash, needs quoting for the space earlier in the string)
  assert.strictEqual(quoteArgumentForWindows('C:\\a b\\'), '"C:\\a b\\\\"');
});

test('win32: quoteArgumentForWindows quotes an empty argument as two double quotes', () => {
  const { quoteArgumentForWindows } = loadWithPlatform('win32');
  assert.strictEqual(quoteArgumentForWindows(''), '""');
});

test('win32: crossPlatformArgs quotes every element that needs it, passes through the rest', () => {
  const { crossPlatformArgs } = loadWithPlatform('win32');
  assert.deepStrictEqual(
    crossPlatformArgs(['exec', '--cd', 'C:\\Users\\Jane Doe\\repo', '--json', 'plain']),
    ['exec', '--cd', '"C:\\Users\\Jane Doe\\repo"', '--json', 'plain'],
  );
});

test('darwin: crossPlatformArgs is a no-op passthrough', () => {
  const { crossPlatformArgs } = loadWithPlatform('darwin');
  const args = ['--cd', '/Users/Jane Doe/repo'];
  assert.deepStrictEqual(crossPlatformArgs(args), args);
});
