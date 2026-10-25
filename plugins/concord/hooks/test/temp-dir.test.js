'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const DIRECT_CALL = /\bmkdtemp(Sync)?\s*\(/;

function filesCallingMkdtemp(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => DIRECT_CALL.test(fs.readFileSync(path.join(dir, name), 'utf8')));
}

// Exercise the exit handler in a real test process without rerunning an entire
// integration suite. The source check below ensures every suite uses this helper.
for (const fails of [false, true]) {
  test(`tempDir removes all directories after a ${fails ? 'failing' : 'passing'} test process exits`, () => {
    const dir = tempDir('temp-dir-run-');
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const marker = path.join(dir, 'created.json');
    const fixture = path.join(dir, 'cleanup.test.cjs');
    fs.writeFileSync(fixture, `
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require(${JSON.stringify(require.resolve('./temp-dir'))});
test('creates temporary directories', () => {
  const dirs = [tempDir('native-init-'), tempDir('another-prefix-')];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'artifact.json'), '{}');
  }
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(dirs));
  ${fails ? "throw new Error('expected fixture failure');" : ''}
});
`);
    const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    delete env.NODE_TEST_CONTEXT; // let the child run its own test runner
    const run = spawnSync(process.execPath, ['--test', fixture], { env, encoding: 'utf8' });
    assert.strictEqual(run.status, fails ? 1 : 0, run.stdout + run.stderr);
    const created = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.strictEqual(created.length, 2);
    for (const createdDir of created) {
      assert.strictEqual(fs.realpathSync(path.dirname(createdDir)), fs.realpathSync(tmp));
      assert.strictEqual(fs.existsSync(createdDir), false);
    }
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
  });
}

test('the check flags a test file that calls mkdtemp directly', () => {
  const dir = tempDir('temp-dir-check-');
  // The call is assembled at run time so that this file does not match the check itself.
  fs.writeFileSync(path.join(dir, 'direct.test.js'), `fs.${'mkdtemp'}Sync(path.join(os.tmpdir(), 'x-'));\n`);
  fs.writeFileSync(path.join(dir, 'helper.test.js'), "tempDir('x-');\n");
  assert.deepStrictEqual(filesCallingMkdtemp(dir), ['direct.test.js']);
});

test('no test file calls mkdtemp outside temp-dir.js', () => {
  const offenders = filesCallingMkdtemp(__dirname);
  assert.deepStrictEqual(offenders, [], 'create temporary directories with tempDir() from ./temp-dir.js');
});
