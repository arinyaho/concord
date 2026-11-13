'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

const DIRECT_CALL = /\bmkdtemp(Sync)?\s*\(/;

const PLUGINS = path.join(__dirname, '..', '..', '..');

// Every *.test.js below `root` inside a `test` directory, as CI selects them (`find plugins -path '*/test/*.test.js'`), relative to `root`.
function testFiles(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((file) => file.split(path.sep).slice(0, -1).includes('test'))
    .sort();
}

function filesCallingMkdtemp(root) {
  return testFiles(root).filter((file) => DIRECT_CALL.test(fs.readFileSync(path.join(root, file), 'utf8')));
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
  for (const sub of ['a/test', 'b/test/nested', 'c']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a/test/direct.test.js'), `fs.${'mkdtemp'}Sync(path.join(os.tmpdir(), 'x-'));\n`);
  fs.writeFileSync(path.join(dir, 'b/test/nested/deep.test.js'), `fs.${'mkdtemp'}(path.join(os.tmpdir(), 'x-'), cb);\n`);
  fs.writeFileSync(path.join(dir, 'a/test/helper.test.js'), "tempDir('x-');\n");
  fs.writeFileSync(path.join(dir, 'c/outside.test.js'), `fs.${'mkdtemp'}Sync('x-');\n`);
  assert.deepStrictEqual(filesCallingMkdtemp(dir), [path.join('a', 'test', 'direct.test.js'), path.join('b', 'test', 'nested', 'deep.test.js')]);
});

test('no plugin test file that CI runs calls mkdtemp outside temp-dir.js', () => {
  const files = testFiles(PLUGINS);
  assert.ok(files.includes(path.join('concord', 'hooks', 'test', 'temp-dir.test.js')));
  assert.ok(files.includes(path.join('concord', 'skills', 'review-until-approve', 'test', 'review.test.js')));
  assert.deepStrictEqual(filesCallingMkdtemp(PLUGINS), [], 'create temporary directories with tempDir() from plugins/concord/hooks/test/temp-dir.js');
});
