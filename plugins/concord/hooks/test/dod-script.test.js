'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../../..');

const PASS = { status: 0, stdout: '# pass 2\n# skipped 0\n', stderr: '' };

async function runDod(results = { node: PASS }, platform) {
  const { main } = await import(path.join(REPO, 'scripts/dod.mjs'));
  const calls = [];
  const logs = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return results[cmd] || { status: 0, stdout: '', stderr: '' };
  };
  const code = main({ root: '/repo', run, env: { PATH: 'x' }, platform, log: (s) => logs.push(s) });
  return { code, calls, logs };
}

test('dod: probes each CLI, then runs only the plugin-install e2e with the e2e flag', async () => {
  const r = await runDod();
  assert.deepStrictEqual(r.calls.map((c) => [c.cmd, ...c.args]).slice(0, 3), [
    ['claude', '--version'],
    ['codex', '--version'],
    ['copilot', '--version'],
  ]);
  assert.strictEqual(r.calls.length, 4);
  const { E2E_FILES, E2E_NAME } = await import(path.join(REPO, 'scripts/dod.mjs'));
  const test = r.calls[3];
  assert.strictEqual(test.cmd, 'node');
  assert.deepStrictEqual(test.args, ['--test', '--test-reporter=tap', `--test-name-pattern=${E2E_NAME}`, ...E2E_FILES]);
  assert.strictEqual(test.opts.cwd, '/repo');
  assert.strictEqual(test.opts.env.CONCORD_RUN_PLUGIN_INSTALL_E2E, '1');
  assert.strictEqual(r.code, 0);
});

test('dod: never installs dependencies or runs the suite CI already runs', async () => {
  const r = await runDod();
  assert.ok(!r.calls.some((c) => c.cmd === 'npm'));
  const { E2E_NAME } = await import(path.join(REPO, 'scripts/dod.mjs'));
  assert.ok(r.calls.filter((c) => c.cmd === 'node').every((c) => c.args.includes(`--test-name-pattern=${E2E_NAME}`)));
});

test('dod: every pluginInstallE2ETest in any test file is selected by the DoD', async () => {
  const { E2E_FILES, E2E_NAME } = await import(path.join(REPO, 'scripts/dod.mjs'));
  const re = new RegExp(E2E_NAME);
  const found = new Set();
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of src.matchAll(/^pluginInstallE2ETest\(\s*(['"`])(.+?)\1/gm)) {
      assert.match(m[2], re, `${f}: e2e title "${m[2]}" is not selected by the DoD name pattern`);
      assert.ok(E2E_FILES.includes(`plugins/concord/hooks/test/${f}`), `${f} has an e2e test but is missing from the DoD E2E_FILES`);
      found.add(f);
    }
  }
  for (const f of E2E_FILES) assert.ok(found.has(path.basename(f)), `${f} in E2E_FILES has no e2e test`);
});

test('dod: a run where no e2e test passed fails even though node exits 0', async () => {
  for (const stdout of ['', '# pass 0\n# skipped 2\n']) {
    const r = await runDod({ node: { status: 0, stdout, stderr: '' } });
    assert.strictEqual(r.code, 1);
    assert.match(r.logs[r.logs.length - 1], /no plugin-install e2e test passed/);
  }
});

test('dod: a missing CLI exits 78 with the environment-error line and never runs tests', async () => {
  const r = await runDod({ codex: { status: null, stdout: '', stderr: '', error: new Error('spawn codex ENOENT') } });
  assert.strictEqual(r.code, 78);
  assert.deepStrictEqual(r.calls.map((c) => c.cmd), ['claude', 'codex']);
  assert.match(r.logs.join('\n'), /spawn codex ENOENT/);
  assert.match(r.logs[r.logs.length - 1], /^DoD environment error: codex CLI is not usable\. This is not an implementation failure\.$/);
});

test('dod: a CLI exiting non-zero is an environment error too', async () => {
  const r = await runDod({ claude: { status: 1, stdout: '', stderr: '' } });
  assert.strictEqual(r.code, 78);
  assert.deepStrictEqual(r.calls.map((c) => c.cmd), ['claude']);
});

test('dod: a long probe error keeps the closing sentence short and intact', async () => {
  const r = await runDod({ claude: { status: null, stdout: '', stderr: '', error: new Error('x'.repeat(500)) } });
  const last = r.logs[r.logs.length - 1];
  assert.ok(last.length < 200, `last line is ${last.length} chars`);
  assert.match(last, /This is not an implementation failure\.$/);
  assert.ok(r.logs[0].length < 200);
});

test('dod: CLIs run through a shell on win32 only', async () => {
  const win = await runDod({}, 'win32');
  assert.strictEqual(win.calls[0].opts.shell, true);
  const posix = await runDod({}, 'linux');
  assert.notStrictEqual(posix.calls[0].opts.shell, true);
});

test('dod: a failing test run passes its status through', async () => {
  const r = await runDod({ node: { status: 1, stdout: '', stderr: '' } });
  assert.strictEqual(r.code, 1);
});
