'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../../..');

function fixture({ modules }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dod-'));
  const pkg = path.join(root, 'services/agent-team');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package-lock.json'), '{}');
  if (modules) {
    fs.mkdirSync(path.join(pkg, 'node_modules'));
    const t = new Date(Date.now() + (modules === 'stale' ? -60000 : 60000));
    fs.utimesSync(path.join(pkg, 'node_modules'), t, t);
  }
  return root;
}

async function runDod(root, results) {
  const { main } = await import(path.join(REPO, 'scripts/dod.mjs'));
  const calls = [];
  const logs = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return results[cmd] || { status: 0, stdout: '', stderr: '' };
  };
  const code = main({ root, run, env: { PATH: 'x' }, log: (s) => logs.push(s) });
  return { code, calls, logs };
}

test('dod: install is skipped when node_modules is newer than the lockfile', async () => {
  const r = await runDod(fixture({ modules: 'fresh' }), {});
  assert.deepStrictEqual(r.calls.map((c) => c.cmd), ['node']);
  assert.strictEqual(r.code, 0);
});

test('dod: install runs when node_modules is missing, then tests run with the e2e flag', async () => {
  const root = fixture({ modules: false });
  const r = await runDod(root, {});
  assert.deepStrictEqual(r.calls.map((c) => c.cmd), ['npm', 'node']);
  assert.deepStrictEqual(r.calls[0].args, ['ci', '--no-audit', '--no-fund']);
  assert.strictEqual(r.calls[0].opts.cwd, path.join(root, 'services/agent-team'));
  assert.deepStrictEqual(r.calls[1].args, ['--test']);
  assert.strictEqual(r.calls[1].opts.cwd, root);
  assert.strictEqual(r.calls[1].opts.env.CONCORD_RUN_PLUGIN_INSTALL_E2E, '1');
});

test('dod: install runs when node_modules is older than the lockfile', async () => {
  const r = await runDod(fixture({ modules: 'stale' }), {});
  assert.deepStrictEqual(r.calls.map((c) => c.cmd), ['npm', 'node']);
});

test('dod: install failure exits 78 with the environment-error line and never runs tests', async () => {
  const r = await runDod(fixture({ modules: false }), { npm: { status: 1, stdout: '', stderr: 'npm ERR! network\n' } });
  assert.strictEqual(r.code, 78);
  assert.deepStrictEqual(r.calls.map((c) => c.cmd), ['npm']);
  const text = r.logs.join('\n');
  assert.match(text, /npm ERR! network/);
  assert.match(text, /DoD environment error: .*This is not an implementation failure\./);
});

test('dod: a missing npm binary is an environment error too', async () => {
  const r = await runDod(fixture({ modules: false }), { npm: { status: null, stdout: '', stderr: '', error: new Error('spawn npm ENOENT') } });
  assert.strictEqual(r.code, 78);
  assert.match(r.logs.join('\n'), /spawn npm ENOENT/);
});

test('dod: a failing test run passes its status through', async () => {
  const r = await runDod(fixture({ modules: 'fresh' }), { node: { status: 1 } });
  assert.strictEqual(r.code, 1);
});
