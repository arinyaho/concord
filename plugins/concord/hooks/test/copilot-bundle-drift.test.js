'use strict';
// Drift guard: the vendored Copilot engine (plugins/concord-copilot/engine/) must stay
// byte-identical to its source (core/ + adapters/copilot/{event.js,statedir.js}). If
// core/ changes without re-running `node plugins/concord-copilot/bin/bundle.mjs`, this
// fails loudly. Mirrors codex-bundle-drift.test.js -- concord-copilot has its own
// bin/bundle.mjs vendoring the same core/ into its own engine/, but had no equivalent
// drift test (gate finding from the windows-support review-until-green run).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const REPO = path.join(__dirname, '..', '..', '..', '..');       // repo root
const CORE = path.join(REPO, 'plugins/concord/core');
const COPILOT_ADAPTERS = path.join(REPO, 'plugins/concord/adapters/copilot');
const ENGINE = path.join(REPO, 'plugins/concord-copilot/engine');
const BUNDLE_EXCLUSIONS = path.join(REPO, 'plugins/concord-copilot/bin/bundle-exclusions.mjs');

test('copilot engine is byte-identical to core/*.js (run bin/bundle.mjs if this fails)', async () => {
  const { NOT_YET_WIRED } = await import(url.pathToFileURL(BUNDLE_EXCLUSIONS));
  const coreFiles = fs.readdirSync(CORE).filter((f) => f.endsWith('.js') && !NOT_YET_WIRED.has(f)).sort();
  for (const f of coreFiles) {
    const src = fs.readFileSync(path.join(CORE, f));
    const vendored = fs.readFileSync(path.join(ENGINE, f));
    assert.ok(src.equals(vendored), `engine/${f} drifted from core/${f} — re-run node plugins/concord-copilot/bin/bundle.mjs`);
  }
});

test('copilot engine event/statedir adapters are byte-identical to adapters/copilot/', () => {
  for (const f of ['event.js', 'statedir.js']) {
    const src = fs.readFileSync(path.join(COPILOT_ADAPTERS, f));
    const vendored = fs.readFileSync(path.join(ENGINE, f));
    assert.ok(src.equals(vendored), `engine/${f} drifted — re-run node plugins/concord-copilot/bin/bundle.mjs`);
  }
});

test('copilot engine has exactly the expected file set (no stale/missing)', async () => {
  const { NOT_YET_WIRED } = await import(url.pathToFileURL(BUNDLE_EXCLUSIONS));
  const expected = new Set(
    fs.readdirSync(CORE).filter((f) => f.endsWith('.js') && !NOT_YET_WIRED.has(f)).concat('event.js', 'statedir.js')
  );
  const actual = new Set(fs.readdirSync(ENGINE).filter((f) => f.endsWith('.js')));
  assert.deepStrictEqual([...actual].sort(), [...expected].sort());
});
