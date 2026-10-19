'use strict';
// Drift guard: the vendored Codex engine (plugins/concord-codex/engine/) must stay
// byte-identical to its source (core/ + adapters/codex/statedir.js). If core/ changes
// without re-running `node plugins/concord-codex/bin/bundle.mjs`, this fails loudly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const REPO = path.join(__dirname, '..', '..', '..', '..');       // repo root
const CORE = path.join(REPO, 'plugins/concord/core');
const CODEX_ADAPTERS = path.join(REPO, 'plugins/concord/adapters/codex');
const CODEX_STATEDIR = path.join(CODEX_ADAPTERS, 'statedir.js');
const ENGINE = path.join(REPO, 'plugins/concord-codex/engine');
const BUNDLE_EXCLUSIONS = path.join(REPO, 'plugins/concord-codex/bin/bundle-exclusions.mjs');

test('codex engine is byte-identical to core/*.js (run bin/bundle.mjs if this fails)', async () => {
  const { NOT_YET_WIRED } = await import(url.pathToFileURL(BUNDLE_EXCLUSIONS));
  const coreFiles = fs.readdirSync(CORE).filter((f) => f.endsWith('.js') && !NOT_YET_WIRED.has(f)).sort();
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

test('codex engine has exactly the expected file set (no stale/missing)', async () => {
  const { NOT_YET_WIRED } = await import(url.pathToFileURL(BUNDLE_EXCLUSIONS));
  const expected = new Set(
    fs.readdirSync(CORE).filter((f) => f.endsWith('.js') && !NOT_YET_WIRED.has(f)).concat('statedir.js', 'transcript.js', 'event.js')
  );
  const actual = new Set(fs.readdirSync(ENGINE).filter((f) => f.endsWith('.js')));
  assert.deepStrictEqual([...actual].sort(), [...expected].sort());
});

test('codex review-until-approve is the shared skill without its tests and finds the Codex engine', () => {
  const src = path.join(REPO, 'plugins/concord/skills/review-until-approve');
  const bundled = path.join(REPO, 'plugins/concord-codex/skills/review-until-approve');
  const list = (root) => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name))).filter((f) => !f.startsWith('test' + path.sep)).sort();
  assert.deepStrictEqual(list(bundled), list(src));
  for (const f of list(src)) assert.ok(fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(bundled, f))), `${f} drifted — re-run node plugins/concord-codex/bin/bundle.mjs`);
  assert.ok(!fs.existsSync(path.join(bundled, 'test')));
  const located = require(path.join(bundled, 'scripts/locate.js'));
  assert.strictEqual(located.core, path.join(REPO, 'plugins/concord-codex/engine'));
  assert.strictEqual(located.cli, path.join(REPO, 'plugins/concord-codex/bin/review-cli.js'));
  assert.strictEqual(typeof require(path.join(located.core, 'codex-review-runner')).runReviewUntilGreen, 'function');
});

test('codex work-report package has the exact shared file set and bytes', () => {
  const src = path.join(REPO, 'plugins/concord/skills/work-report');
  const bundled = path.join(REPO, 'plugins/concord-codex/skills/work-report');
  const list = (root, relative = '') => fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(relative, entry.name);
      return entry.isDirectory() ? list(root, child) : entry.isFile() ? [child] : [];
    })
    .sort();
  const srcFiles = list(src).filter((file) => !file.startsWith(`test${path.sep}`));
  const bundledFiles = list(bundled);
  const rerun = 're-run node plugins/concord-codex/bin/bundle.mjs';

  assert.deepStrictEqual(bundledFiles, srcFiles, `work-report package file set drifted — ${rerun}`);
  assert.ok(!fs.existsSync(path.join(bundled, 'test')), `work-report package must omit its top-level test directory — ${rerun}`);
  for (const file of srcFiles) {
    assert.ok(
      fs.readFileSync(path.join(src, file)).equals(fs.readFileSync(path.join(bundled, file))),
      `work-report/${file} drifted — ${rerun}`,
    );
  }
});
