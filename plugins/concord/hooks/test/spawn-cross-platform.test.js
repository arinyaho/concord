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
// MIT). Expected outputs below are hardcoded literals computed once from
// that reference source, NOT a second copy of its regex living in this
// test file: an earlier version of this test inlined the same regex as the
// implementation, both mistranscribed identically (missing the `?` that
// makes cross-spawn's backslash-count group optional, i.e. zero-or-more
// instead of one-or-more), so the test passed while a real bug shipped --
// a naked embedded quote with no preceding backslash (`he said "hi"`, one
// of these exact cases) skipped the backslash-doubling step entirely. A
// hardcoded expected string cannot silently share a bug with the code
// under test the way a second copy of the same algorithm can. The %/&/|/^
// cases are the exact class of gap a GitHub Codex review on PR #113 caught
// first: the very first version of this file only quoted on space/tab/",
// so a git ref like `foo&whoami` passed through unescaped and cmd.exe
// would run `whoami` as a second command.
const ESCAPING_CASES = [
  ['--json', '^"--json^"'],
  ['abc123', '^"abc123^"'],
  ['', '^"^"'],
  ['C:\\Users\\Jane Doe\\project', '^"C:\\Users\\Jane^ Doe\\project^"'],
  ['he said "hi"', '^"he^ said^ \\^"hi\\^"^"'],
  ['a\\"b', '^"a\\\\\\^"b^"'],
  ['C:\\a b\\', '^"C:\\a^ b\\\\^"'],
  ['foo&whoami', '^"foo^&whoami^"'],
  ['%NAME%', '^"^%NAME^%^"'],
  ['a|b', '^"a^|b^"'],
  ['a^b', '^"a^^b^"'],
  ['a<b>c', '^"a^<b^>c^"'],
  ['a(b)c', '^"a^(b^)c^"'],
  ['50% done', '^"50^%^ done^"'],
  ['line1\nline2', '^"line1\nline2^"'],
  ['tab\there', '^"tab\there^"'],
  ['a;b', '^"a^;b^"'],
  ['a,b', '^"a^,b^"'],
  ['a`b', '^"a^`b^"'],
  ['a[b]c', '^"a^[b^]c^"'],
  ['a*b?c', '^"a^*b^?c^"'],
];

for (const [input, expected] of ESCAPING_CASES) {
  test(`win32: quoteArgumentForWindows matches cross-spawn's reference for ${JSON.stringify(input)}`, () => {
    const { quoteArgumentForWindows } = loadWithPlatform('win32');
    assert.strictEqual(quoteArgumentForWindows(input), expected);
  });
}

test('win32: crossPlatformArgs applies the escape to every element', () => {
  const { crossPlatformArgs } = loadWithPlatform('win32');
  assert.deepStrictEqual(
    crossPlatformArgs(['exec', 'foo&whoami', 'plain']),
    ['^"exec^"', '^"foo^&whoami^"', '^"plain^"'],
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

test('win32: crossPlatformCommand resolves via PATH, then escapes', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const pathDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cross-platform-command-'));
  const target = pathMod.join(pathDir, 'codex.CMD');
  fs.writeFileSync(target, '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = pathDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { crossPlatformCommand } = loadWithPlatform('win32');
    assert.strictEqual(crossPlatformCommand('codex'), target);
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});

// The most severe finding of this whole PR (P1, GitHub Codex review round
// 3): an earlier version of resolveOnPath fell back to the bare name when
// nothing was found on PATH, reasoning that "the eventual ENOENT is the
// honest failure" -- but the bare name still goes back into a shell:true
// spawn, so cmd.exe performs its OWN cwd-first search on exactly that
// fallback value for an uninstalled/misconfigured provider, recreating the
// vulnerability the fix exists to close. crossPlatformCommand must throw,
// not spawn anyway.
test('win32: crossPlatformCommand throws rather than falling back to an unresolved bare name', () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const { crossPlatformCommand } = loadWithPlatform('win32');
    assert.throws(() => crossPlatformCommand('definitely-not-a-real-tool'), /not found on a trusted PATH entry/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('darwin: crossPlatformCommand is a no-op passthrough', () => {
  const { crossPlatformCommand } = loadWithPlatform('darwin');
  assert.strictEqual(crossPlatformCommand('a&b'), 'a&b');
});

// resolveOnPath: closes the P1 finding from a GitHub Codex review on PR
// #113 -- with shell:true, cmd.exe's own bare-name resolution searches the
// child process' cwd before PATH, and every call site behind this helper
// sets cwd to the repository under review (review-until-green's whole job
// is reviewing an arbitrary, untrusted checkout). These tests use a real
// temp directory tree and a real (mocked) PATH/PATHEXT/cwd, not just
// string assertions, so the "never finds it in cwd" guarantee is checked
// against actual filesystem behavior.
test('win32: resolveOnPath finds a binary on PATH, trying each PATHEXT extension', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const pathDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'resolve-on-path-'));
  const target = pathMod.join(pathDir, 'mytool.CMD');
  fs.writeFileSync(target, '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = pathDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    assert.strictEqual(resolveOnPath('mytool'), target);
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});

test('win32: resolveOnPath never resolves from the current working directory, only PATH', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  // Simulate "an untrusted checkout, cwd, contains a planted binary" --
  // resolveOnPath must not find this, even though a naive PATH-unaware
  // resolver (or cmd.exe's own default search) would.
  const cwdDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'untrusted-cwd-'));
  fs.writeFileSync(pathMod.join(cwdDir, 'planted.CMD'), '');
  const pathDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'resolve-on-path-empty-'));
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  const originalCwd = process.cwd();
  process.env.PATH = pathDir; // deliberately does NOT include cwdDir
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  process.chdir(cwdDir);
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    assert.strictEqual(resolveOnPath('planted'), null, 'a binary present only in cwd must resolve to null, never be silently found there');
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});

test('win32: resolveOnPath returns null (not the bare name) when nothing on PATH matches', () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    assert.strictEqual(resolveOnPath('definitely-not-a-real-tool'), null);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('win32: resolveOnPath passes through a name that already contains a path separator', () => {
  const { resolveOnPath } = loadWithPlatform('win32');
  assert.strictEqual(resolveOnPath('C:\\tools\\mytool.exe'), 'C:\\tools\\mytool.exe');
});

test('darwin: crossPlatformCommand does not attempt PATH resolution at all', () => {
  const { crossPlatformCommand } = loadWithPlatform('darwin');
  assert.strictEqual(crossPlatformCommand('codex'), 'codex');
});

// isCmdShim/needsDoubleEscape/quoteArgumentForWindows(arg, doubleEscapeMetaChars):
// a fourth GitHub Codex review round on PR #113 pointed out that once
// resolveOnPath exposes the resolved filename, the earlier "can't detect a
// node_modules/.bin/*.cmd shim" limitation no longer applies -- cross-spawn's
// own resolveCommand+isCmdShimRegExp detects exactly this shape and doubles
// the metacharacter-escape pass, because the shim's own cmd.exe invocation
// consumes one pass before re-expanding %* to forward the real arguments.
test('win32: isCmdShim detects a local npm-bin .cmd shim path, not a global install', () => {
  const { isCmdShim } = loadWithPlatform('win32');
  assert.strictEqual(isCmdShim('C:\\repo\\node_modules\\.bin\\codex.cmd'), true);
  assert.strictEqual(isCmdShim('C:\\repo\\node_modules/.bin/codex.cmd'), true);
  assert.strictEqual(isCmdShim('C:\\Program Files\\nodejs\\codex.cmd'), false);
  assert.strictEqual(isCmdShim(null), false);
});

test('win32: needsDoubleEscape resolves the binary and checks the shim pattern', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const repoDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'needs-double-escape-'));
  const binDir = pathMod.join(repoDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(pathMod.join(binDir, 'codex.CMD'), '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = binDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { needsDoubleEscape } = loadWithPlatform('win32');
    assert.strictEqual(needsDoubleEscape('codex'), true);
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('win32: needsDoubleEscape is false for a global (non-shim) install', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const pathDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'needs-double-escape-global-'));
  fs.writeFileSync(pathMod.join(pathDir, 'codex.CMD'), '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = pathDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { needsDoubleEscape } = loadWithPlatform('win32');
    assert.strictEqual(needsDoubleEscape('codex'), false);
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});

test('darwin: needsDoubleEscape is always false', () => {
  const { needsDoubleEscape } = loadWithPlatform('darwin');
  assert.strictEqual(needsDoubleEscape('codex'), false);
});

// quoteArgumentForWindows(arg, doubleEscapeMetaChars): expected outputs
// hardcoded from cross-spawn's own reference (same discipline as the
// single-escape cases above -- no duplicated algorithm in this test file).
const DOUBLE_ESCAPE_CASES = [
  ['foo&whoami', '^^^"foo^^^&whoami^^^"'],
  ['plain', '^^^"plain^^^"'],
  ['he said "hi"', '^^^"he^^^ said^^^ \\^^^"hi\\^^^"^^^"'],
  ['%NAME%', '^^^"^^^%NAME^^^%^^^"'],
];

for (const [input, expected] of DOUBLE_ESCAPE_CASES) {
  test(`win32: quoteArgumentForWindows(doubleEscapeMetaChars=true) matches cross-spawn for ${JSON.stringify(input)}`, () => {
    const { quoteArgumentForWindows } = loadWithPlatform('win32');
    assert.strictEqual(quoteArgumentForWindows(input, true), expected);
  });
}

test('win32: crossPlatformArgs threads doubleEscapeMetaChars through to every element', () => {
  const { crossPlatformArgs, quoteArgumentForWindows } = loadWithPlatform('win32');
  assert.deepStrictEqual(
    crossPlatformArgs(['foo&whoami'], true),
    [quoteArgumentForWindows('foo&whoami', true)],
  );
  assert.notStrictEqual(quoteArgumentForWindows('foo&whoami', true), quoteArgumentForWindows('foo&whoami', false));
});

// excludeDir: closes a fifth-round GitHub Codex finding (P1) on PR #113.
// PATH itself, not just cwd, can be contaminated by the repository under
// review: launching Concord through an npm/pnpm script inside that repo
// conventionally prepends its own node_modules/.bin to PATH for the child
// process, so a naive PATH-only search (the fourth round's fix) would
// still find and trust a repository-controlled git.cmd/codex.cmd there.
test('win32: resolveOnPath skips a candidate inside excludeDir even though it is on PATH', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  // Simulate: Concord launched via an npm/pnpm script inside the reviewed
  // repo, which prepended that repo's own node_modules/.bin to PATH ahead
  // of a legitimate, separate global install.
  const repoDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'reviewed-repo-'));
  const repoBinDir = pathMod.join(repoDir, 'node_modules', '.bin');
  fs.mkdirSync(repoBinDir, { recursive: true });
  fs.writeFileSync(pathMod.join(repoBinDir, 'git.CMD'), '');
  const globalBinDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'global-bin-'));
  const trustedTarget = pathMod.join(globalBinDir, 'git.CMD');
  fs.writeFileSync(trustedTarget, '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = [repoBinDir, globalBinDir].join(pathMod.delimiter); // repo-controlled entry listed FIRST
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    assert.strictEqual(resolveOnPath('git', repoDir), trustedTarget, 'must skip the repo-controlled PATH entry and resolve to the trusted global one');
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(globalBinDir, { recursive: true, force: true });
  }
});

test('win32: resolveOnPath returns null when the ONLY match is inside excludeDir', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const repoDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'reviewed-repo-onlymatch-'));
  const repoBinDir = pathMod.join(repoDir, 'node_modules', '.bin');
  fs.mkdirSync(repoBinDir, { recursive: true });
  fs.writeFileSync(pathMod.join(repoBinDir, 'claude.CMD'), '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = repoBinDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    assert.strictEqual(resolveOnPath('claude', repoDir), null, 'an uninstalled provider must not silently resolve to a repo-controlled shim');
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('win32: crossPlatformCommand and needsDoubleEscape thread excludeDir through to resolveOnPath', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const repoDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'reviewed-repo-thread-'));
  const repoBinDir = pathMod.join(repoDir, 'node_modules', '.bin');
  fs.mkdirSync(repoBinDir, { recursive: true });
  fs.writeFileSync(pathMod.join(repoBinDir, 'codex.CMD'), '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = repoBinDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { crossPlatformCommand, needsDoubleEscape } = loadWithPlatform('win32');
    assert.throws(() => crossPlatformCommand('codex', repoDir), /not found on a trusted PATH entry/);
    assert.strictEqual(needsDoubleEscape('codex', repoDir), false, 'a resolution that fails closed is not a shim either -- there is nothing to double-escape');
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// unquotePathEntry (via resolveOnPath): a Windows PATH component
// containing a space is conventionally wrapped in quotes
// (`"C:\Program Files\Git\cmd"`); a sixth-round GitHub Codex finding (P2)
// caught that an unstripped pair left path.join building a literal,
// nonexistent path.
// resolveOnPath must always return an ABSOLUTE path, even when a PATH
// entry is itself relative -- a seventh-round GitHub Codex finding (P1)
// caught that a relative candidate was probed relative to THIS process'
// cwd but returned unresolved, so a child process spawned with a
// different `cwd` (repoRoot) would not necessarily run the file that was
// actually validated. Exercised with a relative PATH entry and cwd
// temporarily pointed elsewhere.
test('win32: resolveOnPath returns an absolute path even from a relative PATH entry', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const parentDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'relative-path-entry-'));
  const binDirName = 'bin';
  fs.mkdirSync(pathMod.join(parentDir, binDirName));
  const target = pathMod.join(parentDir, binDirName, 'mytool.CMD');
  fs.writeFileSync(target, '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  const originalCwd = process.cwd();
  process.chdir(parentDir);
  process.env.PATH = binDirName; // a relative PATH entry, resolved against this process' cwd
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    const resolved = resolveOnPath('mytool');
    // Compare realpaths, not raw strings: on macOS, `os.tmpdir()` and
    // `process.cwd()` can disagree on `/var` vs. its `/private/var`
    // symlink target -- a platform quirk of this test environment, not
    // something resolveOnPath itself needs to normalize.
    assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(target));
    assert.ok(pathMod.isAbsolute(resolved), 'resolveOnPath must never return a relative path');
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});

test('win32: resolveOnPath strips a matching quote pair from a PATH entry before probing it', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const pathDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'quoted path entry '));
  const target = pathMod.join(pathDir, 'git.EXE');
  fs.writeFileSync(target, '');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = `"${pathDir}"`; // quoted, as Windows conventionally represents a spaced entry
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const { resolveOnPath } = loadWithPlatform('win32');
    assert.strictEqual(resolveOnPath('git'), target);
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});
