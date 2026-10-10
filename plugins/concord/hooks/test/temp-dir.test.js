'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');

// #288 moves these three files to temp-dir.js after #285 merges, because #285 edits them at the same time, and deletes this list.
const NOT_YET_CONVERTED = new Set(['review-cli.test.js', 'lgtm-state.test.js', 'delivery-disposition.test.js']);

const DIRECT_CALL = /\bmkdtemp(Sync)?\s*\(/;

function filesCallingMkdtemp(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => DIRECT_CALL.test(fs.readFileSync(path.join(dir, name), 'utf8')));
}

// native-driver-initiative.test.js left the most directories in #280 (native-init-*); its run takes about two minutes.
test('a run of native-driver-initiative.test.js leaves no directory behind in the temp directory', () => {
  const tmp = tempDir('temp-dir-run-');
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  delete env.NODE_TEST_CONTEXT; // set by an enclosing `node --test`; it would make the child report to the parent instead of running the files
  const run = spawnSync(process.execPath, ['--test', 'native-driver-initiative.test.js'], { cwd: __dirname, env, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
});

test('the check flags a test file that calls mkdtemp directly', () => {
  const dir = tempDir('temp-dir-check-');
  // The call is assembled at run time so that this file does not match the check itself.
  fs.writeFileSync(path.join(dir, 'direct.test.js'), `fs.${'mkdtemp'}Sync(path.join(os.tmpdir(), 'x-'));\n`);
  fs.writeFileSync(path.join(dir, 'helper.test.js'), "tempDir('x-');\n");
  assert.deepStrictEqual(filesCallingMkdtemp(dir), ['direct.test.js']);
});

test('no test file calls mkdtemp outside temp-dir.js', () => {
  const offenders = filesCallingMkdtemp(__dirname).filter((name) => !NOT_YET_CONVERTED.has(name));
  assert.deepStrictEqual(offenders, [], 'create temporary directories with tempDir() from ./temp-dir.js');
});
