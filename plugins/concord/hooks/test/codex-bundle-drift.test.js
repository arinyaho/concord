'use strict';
// Drift guard: the vendored Codex engine (plugins/concord-codex/engine/) must stay
// byte-identical to its source (core/ + adapters/codex/statedir.js). If core/ changes
// without re-running `node plugins/concord-codex/bin/bundle.mjs`, this fails loudly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');       // repo root
const CORE = path.join(REPO, 'plugins/concord/core');
const CODEX_ADAPTERS = path.join(REPO, 'plugins/concord/adapters/codex');
const CODEX_STATEDIR = path.join(CODEX_ADAPTERS, 'statedir.js');
const ENGINE = path.join(REPO, 'plugins/concord-codex/engine');

test('codex engine is byte-identical to core/*.js (run bin/bundle.mjs if this fails)', () => {
  const coreFiles = fs.readdirSync(CORE).filter((f) => f.endsWith('.js')).sort();
  for (const f of coreFiles) {
    const src = fs.readFileSync(path.join(CORE, f));
    const vendored = fs.readFileSync(path.join(ENGINE, f));
    assert.ok(src.equals(vendored), `engine/${f} drifted from core/${f} — re-run node plugins/concord-codex/bin/bundle.mjs`);
  }
});

test('codex engine statedir is byte-identical to adapters/codex/statedir.js', () => {
  const src = fs.readFileSync(CODEX_STATEDIR);
  const vendored = fs.readFileSync(path.join(ENGINE, 'statedir.js'));
  assert.ok(src.equals(vendored), 'engine/statedir.js drifted — re-run node plugins/concord-codex/bin/bundle.mjs');
});

test('codex engine transcript/event adapters are byte-identical to adapters/codex/', () => {
  for (const f of ['transcript.js', 'event.js']) {
    const src = fs.readFileSync(path.join(CODEX_ADAPTERS, f));
    const vendored = fs.readFileSync(path.join(ENGINE, f));
    assert.ok(src.equals(vendored), `engine/${f} drifted — re-run node plugins/concord-codex/bin/bundle.mjs`);
  }
});

test('codex engine has exactly the expected file set (no stale/missing)', () => {
  const expected = new Set(
    fs.readdirSync(CORE).filter((f) => f.endsWith('.js')).concat('statedir.js', 'transcript.js', 'event.js')
  );
  const actual = new Set(fs.readdirSync(ENGINE).filter((f) => f.endsWith('.js')));
  assert.deepStrictEqual([...actual].sort(), [...expected].sort());
});
