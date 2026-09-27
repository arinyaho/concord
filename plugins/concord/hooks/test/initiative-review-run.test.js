'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openInitiativeRun, reserveLaunch } = require('../../core/initiative-review-run');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'initiative-review-run-')); }

test('keyed runs use a hashed separate ledger and atomically consume launch budget', () => {
  const dir = temp();
  const run = openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 1, maxRounds: 2 });
  assert.match(path.basename(run.path), /^initiative-review-[0-9a-f]{64}\.json$/);
  assert.ok(reserveLaunch(run, { role: 'correctness', round: 1 }));
  assert.strictEqual(reserveLaunch(run, { role: 'fix', round: 1 }), false);
  const ledger = JSON.parse(fs.readFileSync(run.path, 'utf8'));
  assert.deepStrictEqual(ledger.launches, [{ role: 'correctness', round: 1 }]);
  assert.strictEqual(ledger.key, undefined);
});

test('a keyed run cannot be reconfigured or reopened after terminal state', () => {
  const dir = temp();
  const run = openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 2, maxRounds: 1 });
  fs.writeFileSync(run.path, JSON.stringify({ ...JSON.parse(fs.readFileSync(run.path, 'utf8')), status: 'terminal' }));
  assert.throws(() => openInitiativeRun({ stateDir: dir, key: 'opaque key', maxLaunches: 3, maxRounds: 1 }), /immutable|terminal/);
});
